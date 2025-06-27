// proxy-claude.js - OpenAI-compatible proxy for Claude via SAP AI Core
import express from 'express';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();
const app = express();
const port = process.env.PORT || 3000; // Default to port 3000

// Parse AICORE_SERVICE_KEY if it exists
let serviceKey = null;
let authUrl, clientId, clientSecret, resourceGroup, baseUrl;

if (process.env.AICORE_SERVICE_KEY) {
  try {
    serviceKey = JSON.parse(process.env.AICORE_SERVICE_KEY);
    console.warn('Using AICORE_SERVICE_KEY for authentication. Individual environment variables will be ignored.');
    
    // Extract values from service key
    authUrl = serviceKey.url;
    clientId = serviceKey.clientid;
    clientSecret = serviceKey.clientsecret;
    resourceGroup = process.env.AICORE_RESOURCE_GROUP || 'default';
    baseUrl = serviceKey.serviceurls.AI_API_URL;
  } catch (error) {
    console.error('Error parsing AICORE_SERVICE_KEY:', error);
    console.warn('Falling back to individual environment variables.');
    serviceKey = null;
  }
}

// Use individual environment variables if service key is not available
if (!serviceKey) {
  authUrl = process.env.AUTH_URL;
  clientId = process.env.CLIENT_ID;
  clientSecret = process.env.CLIENT_SECRET;
  resourceGroup = process.env.RESOURCE_GROUP || 'default';
}

// Set the deployment URL
// If we have a service key but no explicit deployment URL, we need to construct it
let DEPLOYMENT_URL;
if (serviceKey && !process.env.ORCH_URL && process.env.AICORE_DEPLOYMENT_ID) {
  // Construct URL from service key base URL and deployment ID
  DEPLOYMENT_URL = `${baseUrl}/v2/inference/deployments/${process.env.AICORE_DEPLOYMENT_ID}`;
  console.log(`Using deployment URL constructed from service key: ${DEPLOYMENT_URL}`);
} else {
  // Use the explicit ORCH_URL environment variable
  DEPLOYMENT_URL = process.env.ORCH_URL;
}

app.use(express.json({ limit: '4mb' }));

/* ----------------------------------------------------------------------------
   OAuth token cache
---------------------------------------------------------------------------- */
let token = null;
let expiresAt = 0;

async function getToken() {
  const now = Date.now();
  if (token && now < expiresAt - 60_000) return token;

  const res = await axios.post(
    `${authUrl}/oauth/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  token = res.data.access_token;
  expiresAt = now + (res.data.expires_in * 1000);
  return token;
}

/* ----------------------------------------------------------------------------
   Convert OpenAI format to Claude format
---------------------------------------------------------------------------- */
function openAIToClaudeMessages(body) {
  
  // Extract messages from OpenAI format with fallbacks
  const messages = body.messages || [];
  
  // Convert messages, handling tool messages and function calls
  const convertedMessages = messages.map(msg => {
    if (msg.role === 'tool') {
      // Convert tool message to user message with tool result
      return {
        role: 'user',
        content: [
          {
            text: `Tool result for ${msg.name}: ${msg.content}`
          }
        ]
      };
    } else if (msg.role === 'assistant' && msg.function_call) {
      // Convert assistant message with function call to assistant message with text
      return {
        role: 'assistant',
        content: [
          {
            text: msg.content || `I need to call the ${msg.function_call.name} function with arguments: ${msg.function_call.arguments}`
          }
        ]
      };
    } else {
      return {
        role: msg.role === 'system' ? 'user' : msg.role,
        content: [
          {
            text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
          }
        ]
      };
    }
  });
  
  // Convert to format for /converse-stream endpoint
  // This format works with anthropic--claude-3.7-sonnet
  const result = {
    messages: convertedMessages,
    inferenceConfig: {
      maxTokens: body.max_tokens || body.maxTokens || 4096,
      // Only set temperature if explicitly provided, otherwise don't set it
      // This ensures we don't override the default with 0.7 when temperature is 0
      ...(body.temperature !== undefined && { temperature: body.temperature }),
      ...(body.top_p !== undefined && { topP: body.top_p }),
      ...(body.topP !== undefined && { topP: body.topP })
    }
  };
  
  // Add tools if functions are provided
  if (body.functions && Array.isArray(body.functions)) {
    result.toolConfig = {
      tools: body.functions.map(func => ({
        toolSpec: {
          name: func.name,
          description: func.description || '',
          inputSchema: {
            json: func.parameters || { type: 'object', properties: {} }
          }
        }
      }))
    };
    
    // Handle tool_choice
    if (body.tool_choice) {
      if (body.tool_choice === 'none') {
        // Don't include toolConfig if tools are disabled
        delete result.toolConfig;
      } else if (body.tool_choice === 'auto') {
        result.toolConfig.toolChoice = { auto: {} };
      } else if (typeof body.tool_choice === 'object' && body.tool_choice.function) {
        result.toolConfig.toolChoice = {
          tool: { name: body.tool_choice.function.name }
        };
      }
    } else {
      // Default to auto
      result.toolConfig.toolChoice = { auto: {} };
    }
  }
  
  // Include any stream options if provided
  if (body.stream_options) {
    result.stream_options = body.stream_options;
  }
  
  return result;
}

/* ----------------------------------------------------------------------------
   Convert Claude response to OpenAI format
---------------------------------------------------------------------------- */
function claudeToOpenAI(claudeResponse) {
  let content = '';
  let functionCall = null;
  let finishReason = 'stop';
  
  // Safely extract content from Claude response
  try {
    // For /invoke endpoint
    if (claudeResponse.content && Array.isArray(claudeResponse.content)) {
      // Check for tool use in content
      const toolUse = claudeResponse.content.find(item => item.type === 'tool_use');
      if (toolUse) {
        functionCall = {
          name: toolUse.name,
          arguments: JSON.stringify(toolUse.input || {})
        };
        finishReason = 'function_call';
      }
      
      content = claudeResponse.content
        .filter(item => item.type === 'text')
        .map(item => item.text)
        .join('\n');
    }
    // For /converse endpoint
    else if (claudeResponse.output?.message?.content) {
      // Check for tool use in converse response
      const toolUse = claudeResponse.output.message.content.find(item => item.toolUse);
      if (toolUse?.toolUse) {
        functionCall = {
          name: toolUse.toolUse.name,
          arguments: JSON.stringify(toolUse.toolUse.input || {})
        };
        finishReason = 'function_call';
      }
      
      content = claudeResponse.output.message.content
        .filter(item => item.text)
        .map(item => item.text)
        .join('\n');
    }
    // Fallback
    else {
      content = "[No content found in response]";
    }
  } catch (err) {
    console.error("Error extracting content from Claude response:", err);
    content = "[Error extracting content]";
  }

  const message = { role: 'assistant', content };
  if (functionCall) {
    message.function_call = functionCall;
  }

  return {
    id: 'claude-response-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'claude-3.7-sonnet',
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason
      }
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

/* ----------------------------------------------------------------------------
   Handle streaming responses
---------------------------------------------------------------------------- */
function streamClaudeToOpenAI(res, stream) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let buffer = '';
  let functionCallBuffer = { name: '', arguments: '' };
  let isCollectingFunctionCall = false;
  
  stream.on('data', (chunk) => {
    const data = chunk.toString();
    
    try {
      // Log raw data for debugging
      
      // Parse and convert Claude streaming format to OpenAI streaming format
      const lines = data.split('\n');
      for (const line of lines) {
        if (line.startsWith('data:')) {
          const content = line.slice(5).trim();
          
          // If it's the [DONE] marker, pass it through
          if (content === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }
          
          
          // Try to parse as JSON, handling both single and double quotes
          try {
            // Try to handle potential single quotes in JSON
            let jsonContent = content;
            if (content.startsWith("'") || content.includes("': '")) {
              // Replace single quotes with double quotes, but be careful with nested quotes
              jsonContent = content
                .replace(/'/g, '"')
                .replace(/"([^"]+)":/g, '"$1":')  // Fix potential double-quoted keys
                .replace(/:"([^"]+)"/g, ':"$1"');  // Fix potential double-quoted values
            }
            
            let eventData;
            try {
              eventData = JSON.parse(jsonContent);
            } catch (e) {
              // If that fails, try eval as a last resort (for single-quoted objects)
              // This is safe in this context since we're only parsing data from Claude API
              const evalFn = new Function('return ' + content);
              eventData = evalFn();
            }
            
            // Now process the event data
            if (!eventData) continue;
            
            // Extract text content if available
            let textContent = null;
            let stopReason = null;
            
            // Store usage information when we receive it
            let usage = null;
            
            // Handle different Claude streaming event types
            if (eventData.contentBlockDelta?.delta?.text) {
              // Content block delta with text
              textContent = eventData.contentBlockDelta.delta.text;
            } else if (eventData.contentBlockStart?.start?.type === 'tool_use') {
              // Tool use start - begin collecting function call
              isCollectingFunctionCall = true;
              functionCallBuffer.name = eventData.contentBlockStart.start.name || '';
              functionCallBuffer.arguments = '';
              
              // Send function call start
              const chunk = {
                id: 'claude-stream-' + Date.now(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: 'claude-3.7-sonnet',
                choices: [{
                  index: 0,
                  delta: {
                    function_call: { name: functionCallBuffer.name }
                  },
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              continue;
            } else if (eventData.contentBlockDelta?.delta?.partial_json && isCollectingFunctionCall) {
              // Tool use input delta - accumulate function arguments
              const argFragment = eventData.contentBlockDelta.delta.partial_json;
              functionCallBuffer.arguments += argFragment;
              
              // Send function call arguments fragment
              const chunk = {
                id: 'claude-stream-' + Date.now(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: 'claude-3.7-sonnet',
                choices: [{
                  index: 0,
                  delta: {
                    function_call: { arguments: argFragment }
                  },
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              continue;
            } else if (eventData.contentBlockStop && isCollectingFunctionCall) {
              // Tool use end - finish function call
              isCollectingFunctionCall = false;
              stopReason = 'function_call';
            } else if (eventData.messageStart) {
              // Message start event - send an empty delta to start
              const chunk = {
                id: 'claude-stream-' + Date.now(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: 'claude-3.7-sonnet',
                choices: [{
                  index: 0,
                  delta: { role: 'assistant' },
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              continue;
            } else if (eventData.messageStop) {
              // Message stop event
              if (!isCollectingFunctionCall) {
                stopReason = 'stop';
              }
            } else if (eventData.metadata && eventData.metadata.usage) {
              // Metadata event with usage info
              usage = {
                prompt_tokens: eventData.metadata.usage.inputTokens,
                completion_tokens: eventData.metadata.usage.outputTokens,
                total_tokens: eventData.metadata.usage.totalTokens
              };
              
              // Send usage information in OpenAI format
              const usageChunk = {
                id: 'claude-stream-' + Date.now(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: 'claude-3.7-sonnet',
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: null
                }],
                usage: usage
              };
              
              res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
              continue;
            }
            
            // If we found text content, send it in OpenAI format
            if (textContent) {
              const chunk = {
                id: 'claude-stream-' + Date.now(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: 'claude-3.7-sonnet',
                choices: [{
                  index: 0,
                  delta: { content: textContent },
                  finish_reason: null
                }]
              };
              
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              buffer += textContent;
            }
            
            // If we have a stop reason, send a final chunk
            if (stopReason) {
              const finalChunk = {
                id: 'claude-stream-' + Date.now(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: 'claude-3.7-sonnet',
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: stopReason
                }]
              };
              
              res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            }
          } catch (jsonError) {
            // Not valid JSON - log and send as raw text
            console.error('Error parsing stream content:', jsonError.message);
            console.error('Problematic content:', content);
            
            // As a fallback, send raw text in OpenAI format
            if (content && content !== '{}' && content !== "''") {
              const chunk = {
                id: 'claude-stream-' + Date.now(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: 'claude-3.7-sonnet',
                choices: [{
                  index: 0,
                  delta: { content: content },
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error processing stream chunk:', error);
    }
  });

  stream.on('end', () => {
    res.write('data: [DONE]\n\n');
    res.end();
  });

  stream.on('error', (err) => {
    console.error('Stream error:', err);
    res.end();
  });
}

/* ----------------------------------------------------------------------------
   Main route handler for chat completions
---------------------------------------------------------------------------- */
async function handleChatCompletions(req, res) {
  try {
    const bearer = await getToken();
    
    // Check if streaming is requested
    const isStreaming = req.body.stream === true;
    const endpoint = isStreaming ? '/converse-stream' : '/converse';
    
    // Use the deployment URL defined at the top of the file
    if (!DEPLOYMENT_URL) {
      return res.status(400).send('Missing deployment URL. Set ORCH_URL in .env file.');
    }

    // Convert OpenAI request format to Claude format
    const claudeBody = openAIToClaudeMessages(req.body);
    
    if (isStreaming) {
      // Handle streaming response
      try {
        const streamResponse = await axios({
          method: 'post',
          url: `${DEPLOYMENT_URL}${endpoint}`,
          data: claudeBody,
          headers: {
            'Authorization': `Bearer ${bearer}`,
            'AI-Resource-Group': resourceGroup,
            'Content-Type': 'application/json'
          },
          responseType: 'stream'
        });
        
        streamClaudeToOpenAI(res, streamResponse.data);
      } catch (streamError) {
        console.error("Streaming error:", streamError.message);
        
        // Try to get more detailed error information
        if (streamError.response) {
          console.error("Response status:", streamError.response.status);
          console.error("Response headers:", JSON.stringify(streamError.response.headers, null, 2));
          
          // Log request that caused the error
          console.error("Request URL:", `${DEPLOYMENT_URL}${endpoint}`);
          console.error("Request data:", JSON.stringify(claudeBody, null, 2));
          
          if (streamError.response.data) {
            // Try to read the response data
            if (typeof streamError.response.data === 'string') {
              console.error("Response data:", streamError.response.data);
            } else {
              try {
                const chunks = [];
                streamError.response.data.on('data', chunk => chunks.push(chunk));
                streamError.response.data.on('end', () => {
                  const buffer = Buffer.concat(chunks);
                  console.error("Response data:", buffer.toString());
                });
              } catch (e) {
                console.error("Could not read response data:", e.message);
              }
            }
          }
        }
        res.status(500).send('Error in streaming: ' + streamError.message);
      }
    } else {
      // Handle non-streaming response
      try {
        const response = await axios({
          method: 'post',
          url: `${DEPLOYMENT_URL}${endpoint}`,
          data: claudeBody,
          headers: {
            'Authorization': `Bearer ${bearer}`,
            'AI-Resource-Group': resourceGroup,
            'Content-Type': 'application/json'
          }
        });
        
        // Convert Claude response to OpenAI format
        const openAIResponse = claudeToOpenAI(response.data);
        res.json(openAIResponse);
      } catch (nonStreamError) {
        console.error("Non-streaming error:", nonStreamError.message);
        
        // Try to get more detailed error information
        if (nonStreamError.response) {
          console.error("Response status:", nonStreamError.response.status);
          console.error("Response headers:", JSON.stringify(nonStreamError.response.headers, null, 2));
          console.error("Response data:", nonStreamError.response.data);
          
          // Log request that caused the error
          console.error("Request URL:", `${DEPLOYMENT_URL}${endpoint}`);
          console.error("Request data:", JSON.stringify(claudeBody, null, 2));
        }
        res.status(500).send('Error in non-streaming: ' + nonStreamError.message);
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).send('Proxy error: ' + err.message);
  }
}

/* ----------------------------------------------------------------------------
   Routes
---------------------------------------------------------------------------- */
app.post('/v1/chat/completions', handleChatCompletions);
app.post('/chat/completions', handleChatCompletions);

// Health check endpoint
app.get('/health', (_, res) => res.send('OK'));

// Start the server
app.listen(port, () => {
  console.log(`Claude proxy (OpenAI-compatible) listening on http://localhost:${port}`);
});