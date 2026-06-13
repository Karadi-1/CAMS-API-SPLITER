# Analysis Report — Milestone 2: Basic Server & Auth Setup

## Executive Summary
This report presents the environment investigation regarding the availability of Express and proposes the architectural structure and complete source code for `server.js`. The splitter server is designed using only Node.js built-in modules (`http`, `https`, `url`), ensuring zero external dependencies, robust and fast handling of the webhook endpoint, and 100% offline compatibility with the project constraints.

---

## 1. Environment Investigation (Express Availability)

### Investigation Method
1. Checked for local package files using a file-system search. No `package.json` or `node_modules` directory was found in the workspace root `/Users/sunitj/Library/CloudStorage/OneDrive-Personal/Documents OD/WORK/Files/BGC/IT/CAMS API SPLITER`.
2. Attempted running `node -e "require('express')"` to verify if Express is installed globally or in parent directories. The run command timed out waiting for user permission under the `CODE_ONLY` network mode constraint.
3. Examined the E2E verification test suite (`test_splitter.js`) and its documentation (`TEST_INFRA.md`). It explicitly states:
   > "To satisfy the CODE_ONLY network mode constraint, the test suite is designed with zero external dependencies, utilizing only Node.js built-in modules (`node:http`, `node:assert`, `node:child_process`, `node:test`)."

### Conclusion on Express
Express is **not available** in the sandboxed local workspace, and there is no dependency configuration (`package.json`) defined.
**Decision**: We will design and implement `server.js` using Node.js's built-in `http` and `https` modules. This ensures the service runs instantly without requiring the user to execute `npm install` and completely avoids potential dependency resolution issues.

---

## 2. Proposed Structure and Code for `server.js`

The proposed `server.js` acts as a highly resilient middleware. It includes:
1. **An HTTP Server Listener** on a configurable `PORT` (defaults to `3000` or `13000` during test execution).
2. **A Webhook Endpoint Handler** for `POST /webhook/cams`.
3. **An Auth Checker** comparing the payload's `AuthToken` to the `CAMS_AUTH_TOKEN` environment variable.
4. **An Immediate Acknowledger** responding with `200 OK` and `{"status": "done"}` before starting the forwarding promises.
5. **A Concurrent Forwarder** implementing `Promise.allSettled` with error handling, logging, and timeouts using `http`/`https` requests.

### Complete Proposed Code (`server.js`)
```javascript
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
```

---

## 3. Detailed Requirements Compliance Mapping

| Requirement | Code Location / Implementation Detail | Verification/Assertion Mechanism |
|---|---|---|
| **R1. POST /webhook/cams** | `server.js` lines 129-130: Checks `req.method === 'POST' && req.url === '/webhook/cams'`. | Checked by E2E test client sending HTTP POST request to `/webhook/cams`. |
| **R1. Parse JSON payloads** | `server.js` lines 132-143: Accumulates chunks on `req.on('data')`, parses on `req.on('end')` with a try/catch handler. | Checked by E2E test client with valid and malformed payload scenarios. |
| **R1. Immediate 200 OK Response** | `server.js` lines 150-151: Calls `res.writeHead(200)` and `res.end()` immediately after JSON parsing and authorization check. | Checked by E2E test verifying response duration is < 50ms even when target servers have 200ms processing delay. |
| **R2. Webhook Authentication** | `server.js` lines 146-147: Compares `incomingToken` against `CAMS_AUTH_TOKEN` environment variable. | Checked by E2E test case sending correct token, wrong token, and missing token. |
| **R2. Log & Return OK on Failure** | `server.js` lines 153-156: Warns on console if unauthorized, does not forward, returns `200 OK` with `{"status": "done"}`. | Checked by E2E test client asserting 200 OK is received and target servers receive 0 requests. |
| **R3. Payload Cleansing** | `server.js` lines 159-163: Destructures payload to strip `AuthToken` from request body. | Checked by E2E mock targets asserting the body they receive does not contain `AuthToken` but contains other fields. |
| **R3. Concurrent Forwarding** | `server.js` lines 114-123: Maps targets to forwarding promises and resolves them concurrently using `Promise.allSettled`. | Checked by E2E test with one slow server and one fast server showing the fast server completes without waiting for the slow one. |
| **R4. Resiliency and Logging** | `server.js` lines 50-61 (request timeout/handling) and lines 115-121 (result reporting). | Checked by E2E test cases simulating 500 error status codes, socket hang-up, and malformed URLs. |

---

## 4. Evidence Chain

*   **Observation**: The workspace contains `test_splitter.js` which configures ports and asserts the server's output and network responses.
*   **Source**: Workspace directory contents returned by `list_dir` and `find_by_name`.
*   **Verification**: `view_file` was used to inspect `test_splitter.js` and determine exactly how it configures the Splitter Server (spawning it using environment variables) and what it expects (returns immediate response, strips AuthToken, sets auth headers, runs concurrently).
