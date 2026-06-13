/**
 * Node.js Webhook Splitter API
 * Implements Milestone 2: Basic Server & Auth Setup
 * Designed with zero external dependencies using Node.js built-in modules.
 */

const http = require('http');
const https = require('https');

// Retrieve Configurations from Environment Variables
const PORT = process.env.PORT || 3000;
const CAMS_AUTH_TOKEN = process.env.CAMS_AUTH_TOKEN;
const BGC_SIXORBIT_URL = process.env.BGC_SIXORBIT_URL;
const BGC_SIXORBIT_TOKEN = process.env.BGC_SIXORBIT_TOKEN;
const SEMPL_ERPNEXT_URL = process.env.SEMPL_ERPNEXT_URL;
const SEMPL_ERPNEXT_API_KEY = process.env.SEMPL_ERPNEXT_API_KEY;
const SEMPL_ERPNEXT_API_SECRET = process.env.SEMPL_ERPNEXT_API_SECRET;

// Dynamically select http or https module based on protocol
function getHttpClient(urlStr) {
  return urlStr.startsWith('https') ? https : http;
}

/**
 * Asynchronously forwards the cleaned payload to a target webhook.
 * @param {string} targetName Name of the target (e.g. 'BGC Sixorbit')
 * @param {string} urlStr Target webhook URL
 * @param {string|null} authHeader Header value for Authorization
 * @param {object} payload The cleaned payload (AuthToken stripped)
 */
function forwardToTarget(targetName, urlStr, authHeader, payload) {
  if (!urlStr) {
    console.warn(`[Splitter] URL for target "${targetName}" is not configured. Skipping.`);
    return;
  }

  try {
    const parsedUrl = new URL(urlStr);
    const client = getHttpClient(urlStr);
    const bodyData = JSON.stringify(payload);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyData)
      }
    };

    if (authHeader) {
      options.headers['Authorization'] = authHeader;
    }

    const req = client.request(options, (res) => {
      let resBody = '';
      res.on('data', chunk => { resBody += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[Splitter] Success forwarding to ${targetName}. Status: ${res.statusCode}`);
        } else {
          console.error(`[Splitter] Error response from ${targetName}. Status: ${res.statusCode}. Body: ${resBody}`);
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[Splitter] Connection/Network error to ${targetName}: ${err.message}`);
    });

    req.write(bodyData);
    req.end();
  } catch (err) {
    console.error(`[Splitter] Failed to initiate request to ${targetName}: ${err.message}`);
  }
}

// Instantiate server
const server = http.createServer((req, res) => {
  // Only route POST requests to /webhook/cams
  if (req.method === 'POST' && req.url === '/webhook/cams') {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (err) {
        console.error(`[Splitter] JSON parse error: ${err.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        return;
      }

      const incomingToken = payload.AuthToken;
      const isAuthorized = CAMS_AUTH_TOKEN && incomingToken === CAMS_AUTH_TOKEN;

      // Return immediate response before starting or waiting for the forwarding operations
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'done' }));

      // If authorized, proceed with concurrent async forwarding
      if (isAuthorized) {
        // Strip AuthToken from payload body
        const cleanedPayload = { ...payload };
        delete cleanedPayload.AuthToken;

        // Asynchronously forward to BGC Sixorbit
        const sixorbitAuthHeader = BGC_SIXORBIT_TOKEN ? `Bearer ${BGC_SIXORBIT_TOKEN}` : null;
        setImmediate(() => {
          forwardToTarget('BGC Sixorbit', BGC_SIXORBIT_URL, sixorbitAuthHeader, cleanedPayload);
        });

        // Asynchronously forward to SEMPL ERPNext
        const erpnextAuthHeader = (SEMPL_ERPNEXT_API_KEY && SEMPL_ERPNEXT_API_SECRET)
          ? `token ${SEMPL_ERPNEXT_API_KEY}:${SEMPL_ERPNEXT_API_SECRET}`
          : null;
        setImmediate(() => {
          forwardToTarget('SEMPL ERPNext', SEMPL_ERPNEXT_URL, erpnextAuthHeader, cleanedPayload);
        });
      } else {
        console.warn(`[Splitter] Unauthorized webhook attempt: Token mismatched or missing. Received: ${incomingToken}`);
      }
    });
  } else {
    // Route not supported
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

// Bind to port
server.listen(PORT, () => {
  console.log(`[Splitter] Server successfully started and listening on port ${PORT}`);
});
