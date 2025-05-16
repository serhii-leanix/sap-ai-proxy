# SAP AI Proxy

A simple proxy for SAP AI services.

## Launch

1.  Install dependencies: `npm install`
2.  Configure the proxy by setting the environment variables in a `.env` file.  See `.env.example` for the required variables.
3.  Start the proxy: `npm start`

The proxy will listen on the port specified in the `.env` file (default: 3000). You can access it at `http://localhost:<port>`.