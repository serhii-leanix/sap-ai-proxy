// proxy.js  –  local OpenAI-compatible proxy → SAP AI Core
import express from 'express';
import axios   from 'axios';
import dotenv  from 'dotenv';

dotenv.config();
const app  = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '4mb' }));

/* ----------------------------------------------------------------------------
   OAuth token cache
---------------------------------------------------------------------------- */
let token     = null;
let expiresAt = 0;

async function getToken () {
  const now = Date.now();
  if (token && now < expiresAt - 60_000) return token; 

  const res = await axios.post(
    `${process.env.AUTH_URL}/oauth/token`,
    new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  token     = res.data.access_token;
  expiresAt = now + (res.data.expires_in * 1000);
  return token;
}

/* ----------------------------------------------------------------------------
   Build SAP AI Core request body
   ‣ does not discard assistant replies
   ‣ supports OpenAI and "cline-messages" {type,text} styles
---------------------------------------------------------------------------- */
function buildSAPBody (body) {
  let prompt = '';

  // Helper function for safe string conversion
  const safeStringify = (value) => {
    if (typeof value === 'string') {
      return value;
    }
    if (value === null || value === undefined) {
      return '';
    }
    // If object - convert to JSON, otherwise - just to string
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  };

  if (Array.isArray(body.messages)) {
    /* OpenAI-chat формат (role/content) */
    if (body.messages.some(m => 'role' in m)) {
      prompt = body.messages
        .map(m =>
             `${m.role.toUpperCase()}: ${safeStringify(m.content ?? m.text ?? '')}`)
        .join('\n\n'); // Use double newline for separation
    }
    /* Cline-Plan/Act  [{type:'text',text:'...'}] */
    else {
      prompt = body.messages
        .map(m => safeStringify(m.text ?? m.content ?? ''))
        .join('\n\n'); // Use double newline for separation
    }
  } else if (typeof body.prompt === 'string') {
    prompt = body.prompt;
  }

  /* fallback */
  if (!prompt.trim()) prompt = '[empty prompt]';

  const model = body.model || 'gpt-4o';

  return {
    orchestration_config: {
      module_configurations: {
        templating_module_config: {
          template: [
            { role: 'user', content: '{{?text}}' }
          ]
        },
        llm_module_config: {
          model_name:    model,
          model_version: 'latest',
          model_params: {
            max_tokens:  body.max_tokens  ?? 512,
            temperature: body.temperature ?? 0.7,
            top_p:       body.top_p       ?? 1
          }
        }
      }
    },
    input_params: { text: prompt }
  };
}

/* ----------------------------------------------------------------------------
   Convert SAP answer → OpenAI format
---------------------------------------------------------------------------- */
function toOpenAI (sapJson) {
  const text = sapJson.orchestration_result?.choices?.[0]?.message?.content
            ?? sapJson.orchestration_result?.text
            ?? '[no content]';

  return {
    id: sapJson.request_id || 'sap-ai-core',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: sapJson.model_name || 'sap-ai-core',
    choices: [
      { index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop' }
    ]
  };
}

/* ----------------------------------------------------------------------------
   Helpers: streaming OpenAI-style
---------------------------------------------------------------------------- */
function streamOpenAI (res, fullText) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  /* very naive tokenizer - by words */
  const words = fullText.split(/\s+/);

  for (let i = 0; i < words.length; i++) {
    const delta = { id: 'sap-ai-core',
                    choices: [{
                      delta: { content: (i ? ' ' : '') + words[i] },
                      index: 0,
                      finish_reason: null
                    }] };
    res.write(`data: ${JSON.stringify(delta)}\n\n`);
  }

  /* final marker [DONE] */
  res.write('data: [DONE]\n\n');
  res.end();
}

/* ----------------------------------------------------------------------------
   Main route  (/v1/chat/completions)  + alias without /v1
---------------------------------------------------------------------------- */
async function handler (req, res) {
  try {
    const sapBody = buildSAPBody(req.body);
    const bearer  = await getToken();

    const sapRes = await axios.post(
      `${process.env.ORCH_URL}/completion`,
      sapBody,
      {
        headers: {
          'Authorization':     `Bearer ${bearer}`,
          'AI-Resource-Group':  process.env.RESOURCE_GROUP,
          'Content-Type':      'application/json'
        },
        timeout: 120_000
      }
    );

    /* streaming */
    if (req.body.stream) {
      const text =
        sapRes.data.orchestration_result?.choices?.[0]?.message?.content
        ?? sapRes.data.orchestration_result?.text
        ?? '';
      streamOpenAI(res, text);
      return;
    }

    res.json( toOpenAI(sapRes.data) );

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'proxy_error',
                           detail: err.response?.data || err.message });
  }
}

app.post('/v1/chat/completions', handler);
app.post('/chat/completions',    handler);       // so that /v1 is not mandatory

app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(port, () =>
  console.log(`SAP AI Core proxy listening on http://localhost:${port}`) );
