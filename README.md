# SAP AI Proxy

A simple proxy for SAP AI services.

## Launch

1.  Install dependencies: `npm install`
2.  Configure the proxy by setting the environment variables in a `.env` file. See below for configuration options.
3.  Start the proxy: `npm start`

The proxy will listen on the port specified in the `.env` file (default: 3000). You can access it at `http://localhost:<port>`.

## Configuration

You can configure the proxy using two different methods:

### Method 1: Individual Environment Variables

Set the following environment variables in your `.env` file:

```
PORT=3000
AUTH_URL=https://****-ai-playbox-***.authentication.**.hana.ondemand.com
CLIENT_ID='sb-****'
CLIENT_SECRET='9a4***'
RESOURCE_GROUP=default
ORCH_URL=https://api.ai.intprod-***.eu-central-1.aws.ml.hana.ondemand.com/v2/inference/deployments/***
```

### Method 2: Using AICORE_SERVICE_KEY

Alternatively, you can use the `AICORE_SERVICE_KEY` environment variable with a JSON service key:

```
PORT=3000
AICORE_SERVICE_KEY='{
    "clientid": "sb-****",
    "clientsecret": "9a4***",
    "url": "https://****-ai-playbox-***.authentication.**.hana.ondemand.com",
    "identityzone": "****-ai-playbox-***",
    "identityzoneid": "****",
    "appname": "****",
    "credential-type": "binding-secret",
    "serviceurls": {
        "AI_API_URL": "https://api.ai.intprod-***.eu-central-1.aws.ml.hana.ondemand.com"
    }
}'
AICORE_RESOURCE_GROUP=default
AICORE_DEPLOYMENT_ID=*** # Required if ORCH_URL is not provided
```

If both `AICORE_SERVICE_KEY` and individual variables are provided, the service key will take precedence and a warning will be displayed.