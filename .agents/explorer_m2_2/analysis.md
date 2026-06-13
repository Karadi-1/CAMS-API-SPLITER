# Milestone 2 Analysis: Basic Server & Auth Setup

## 1. Investigation of Express Availability
During the environment investigation, a check for Express availability was attempted using:
`node -e "require('express')"`

- **Observation**: The command execution timed out waiting for user approval. The verbatim log returned was:
  > `Encountered error in step execution: Permission prompt for action 'command' on target 'node -e "require('express')"' timed out waiting for user response. The user was not able to provide permission on time.`
- **Directory Audit**: Inspecting the root directory of the workspace `/Users/sunitj/Library/CloudStorage/OneDrive-Personal/Documents OD/WORK/Files/BGC/IT/CAMS API SPLITER` reveals that:
  - No `package.json` is present in the workspace root.
  - No `node_modules` directory is present in the workspace root.
- **Decision**: Since Express is not locally installed and external packages cannot be downloaded under the strict `CODE_ONLY` network mode, the server must be designed using the Node.js built-in `http` module to avoid dependency issues. This also aligns with the design principles in `TEST_INFRA.md` which uses only Node.js standard libraries.

---

## 2. Proposed server.js Structure and Code

The proposed code is designed with high fault tolerance and zero external dependencies. It uses Node.js standard libraries (`http` and `https`), properly handles route checking, parses payload asynchronously, performs immediate response, and runs the downstream concurrent forwarding in a non-blocking macro-task event queue (`setImmediate`).

### Proposed Implementation Code for `server.js`

```javascript
/**
 * server.js
 * Node.js Webhook Splitter API
 * Built using native Node.js HTTP and HTTPS modules.
 * Zero external dependencies.
 */

const http = require('http');
const https = require('https');

// Helper function to forward POST requests using built-in http/https client
function postRequest(urlStr, headers, payload) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlStr);
      const client = url.protocol === 'https:' ? https : http;
      const data = JSON.stringify(payload);

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      };

      const req = client.request(options, (res) => {
        let responseBody = '';
        res.on('data', chunk => responseBody += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, body: responseBody });
          } else {
            reject(new Error(`HTTP status ${res.statusCode}`));
          }
        });
      });

      req.on('error', err => reject(err));
      req.write(data);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Asynchronous forwarding runner using Promise.allSettled
async function performForwarding(payload) {
  const targets = [];

  // BGC Sixorbit Target
  if (process.env.BGC_SIXORBIT_URL) {
    targets.push({
      name: 'BGC Sixorbit',
      url: process.env.BGC_SIXORBIT_URL,
      headers: {
        'Authorization': `Bearer ${process.env.BGC_SIXORBIT_TOKEN || ''}`
      }
    });
  } else {
    console.warn('Warning: BGC_SIXORBIT_URL environment variable is not defined.');
  }

  // SEMPL ERPNext Target
  if (process.env.SEMPL_ERPNEXT_URL) {
    const key = process.env.SEMPL_ERPNEXT_API_KEY || '';
    const secret = process.env.SEMPL_ERPNEXT_API_SECRET || '';
    targets.push({
      name: 'SEMPL ERPNext',
      url: process.env.SEMPL_ERPNEXT_URL,
      headers: {
        'Authorization': `token ${key}:${secret}`
      }
    });
  } else {
    console.warn('Warning: SEMPL_ERPNEXT_URL environment variable is not defined.');
  }

  // Forward concurrently to avoid blocking
  const promises = targets.map(target =>
    postRequest(target.url, target.headers, payload)
      .then((res) => {
        console.log(`[Forward Success] [${target.name}] Status: ${res.statusCode}`);
      })
      .catch((err) => {
        console.error(`[Forward Failure] [${target.name}] Error: ${err.message}`);
      })
  );

  await Promise.allSettled(promises);
}

// Create HTTP server
const server = http.createServer((req, res) => {
  // 1. Route Validation: Only POST /webhook/cams
  if (req.method !== 'POST' || req.url !== '/webhook/cams') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk;
  });

  req.on('end', () => {
    // 2. Parse JSON Payload
    let parsedPayload;
    try {
      parsedPayload = JSON.parse(body);
    } catch (err) {
      console.error('JSON Parse Error:', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const clientToken = parsedPayload?.AuthToken;
    const serverToken = process.env.CAMS_AUTH_TOKEN;

    // 3. Auth Validation
    if (!clientToken || clientToken !== serverToken) {
      console.warn(`Unauthorized attempt logged. Provided Token: ${clientToken ? 'invalid' : 'missing'}`);
      // Return 200 OK with {"status": "done"} and do NOT forward anything
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'done' }));
      return;
    }

    // 4. Return immediate 200 OK before starting/waiting for forwarding operations
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'done' }));

    // 5. Strip AuthToken from payload
    const { AuthToken, ...cleanedPayload } = parsedPayload;

    // 6. Asynchronously forward to targets
    setImmediate(() => {
      performForwarding(cleanedPayload);
    });
  });
});

// Port configuration (defaults to 3000, customizable via PORT env var)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`CAMS API Splitter Server running on port ${PORT}`);
});
```

---

## 3. Analysis of Architecture Decisions
- **Non-blocking Response**: Responding with `res.writeHead(200)` and `res.end()` immediately closes the connection to the CAMS client. The forwarding is scheduled inside `setImmediate()`, so it executes on the next turn of the event loop and runs completely asynchronously without keeping the webhook client waiting.
- **Payload Redaction**: Utilizing the modern JavaScript rest operator `const { AuthToken, ...cleanedPayload } = parsedPayload;` ensures the `AuthToken` property is stripped safely, while the rest of the payload structure is perfectly preserved and forwarded.
- **Dependency-Free HTTP/HTTPS**: By extracting protocol from the target URLs, the helper chooses `http` or `https` dynamically, ensuring full standard compatibility without requiring any third-party HTTP client libraries like `axios` or `undici`.
- **Fault-Tolerant Forwarding**: Forwarding operations are executed using `Promise.allSettled` to make sure one target's failure (e.g. timeout or socket crash) does not prevent the other target from receiving the request.
