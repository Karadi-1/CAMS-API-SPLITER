/**
 * CAMS Webhook Splitter Server
 * Acts as a middleware between Camsunit Biometric Gateway and ERP systems.
 * Designed with zero external dependencies using the Node.js built-in 'http' and 'https' modules.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Environment Variables
const PORT = process.env.PORT || 3000;
const CAMS_AUTH_TOKEN = process.env.CAMS_AUTH_TOKEN;
const BGC_SIXORBIT_URL = process.env.BGC_SIXORBIT_URL;
const BGC_SIXORBIT_TOKEN = process.env.BGC_SIXORBIT_TOKEN;
const SEMPL_ERPNEXT_URL = process.env.SEMPL_ERPNEXT_URL;
const SEMPL_ERPNEXT_API_KEY = process.env.SEMPL_ERPNEXT_API_KEY;
const SEMPL_ERPNEXT_API_SECRET = process.env.SEMPL_ERPNEXT_API_SECRET;

// Helper function to send POST requests asynchronously
function forwardRequest(urlString, headers, payload) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlString);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const bodyData = JSON.stringify(payload);

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyData),
          ...headers
        },
        timeout: 10000 // 10 seconds timeout limit
      };

      const req = client.request(options, (res) => {
        let responseBody = '';
        res.on('data', chunk => {
          responseBody += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, body: responseBody });
          } else {
            reject(new Error(`Server returned status code ${res.statusCode}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(bodyData);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Function to handle forwarding payload concurrently
function processForwarding(cleanedPayload) {
  const forwards = [];

  // BGC Sixorbit Forwarding Configuration
  if (BGC_SIXORBIT_URL) {
    const headers = {};
    if (BGC_SIXORBIT_TOKEN) {
      headers['Authorization'] = `Bearer ${BGC_SIXORBIT_TOKEN}`;
    }
    forwards.push({
      name: 'BGC Sixorbit',
      promise: forwardRequest(BGC_SIXORBIT_URL, headers, cleanedPayload)
    });
  } else {
    console.log('[Splitter] BGC Sixorbit URL is not configured. Forwarding skipped.');
  }

  // SEMPL ERPNext Forwarding Configuration
  if (SEMPL_ERPNEXT_URL) {
    const headers = {};
    if (SEMPL_ERPNEXT_API_KEY && SEMPL_ERPNEXT_API_SECRET) {
      headers['Authorization'] = `token ${SEMPL_ERPNEXT_API_KEY}:${SEMPL_ERPNEXT_API_SECRET}`;
    }
    forwards.push({
      name: 'SEMPL ERPNext',
      promise: forwardRequest(SEMPL_ERPNEXT_URL, headers, cleanedPayload)
    });
  } else {
    console.log('[Splitter] SEMPL ERPNext URL is not configured. Forwarding skipped.');
  }

  if (forwards.length === 0) {
    console.log('[Splitter] No target servers configured for forwarding.');
    return;
  }

  // Forward to all systems concurrently
  Promise.allSettled(forwards.map(f => f.promise)).then((results) => {
    results.forEach((result, index) => {
      const targetName = forwards[index].name;
      if (result.status === 'fulfilled') {
        console.log(`Successfully forwarded payload to ${targetName}. Status code: ${result.value.statusCode}`);
      } else {
        console.error(`Failed to forward payload to ${targetName}. Error: ${result.reason.message}`);
      }
    });
  }).catch((err) => {
    console.error('[Splitter] Unexpected error in forwarding operation:', err);
  });
}

// Main HTTP Server
const server = http.createServer((req, res) => {
  // Only accept POST requests on /webhook/cams
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
        console.error('Failed to parse JSON payload:', err.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'done' }));
        return;
      }

      // Check Authentication Token
      const incomingToken = (payload && typeof payload === 'object') ? payload.AuthToken : undefined;
      const isAuthorized = CAMS_AUTH_TOKEN && incomingToken === CAMS_AUTH_TOKEN;

      // Always return 200 OK immediately with {"status": "done"}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'done' }));

      if (!isAuthorized) {
        console.warn(`Unauthorized access attempt. Provided token: ${incomingToken}`);
        return;
      }

      // Strip AuthToken from payload for authorized request
      let cleanedPayload = payload;
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const { AuthToken, ...rest } = payload;
        cleanedPayload = rest;
      }

      // Trigger forwarding asynchronously
      processForwarding(cleanedPayload);
    });
  } else {
    // 404 for other endpoints
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

// Start Server
server.listen(PORT, () => {
  console.log(`Splitter server listening on port ${PORT}`);
});
