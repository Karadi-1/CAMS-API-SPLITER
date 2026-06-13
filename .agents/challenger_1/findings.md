# Adversarial Verification Findings — Webhook Splitter API

This document details the findings from the adversarial security and robustness verification of `server.js`.

---

## 1. Summary of Vulnerabilities & Robustness Issues

| Issue ID | Severity | Category | Description |
| :--- | :--- | :--- | :--- |
| **VULN-01** | **CRITICAL** | Error Handling | Downstream response stream `res` lacks an `'error'` listener, causing process crash on abrupt downstream disconnects. |
| **VULN-02** | **HIGH** | Security / DoS | No request payload size limit, making the server vulnerable to Out-of-Memory (OOM) Denial of Service attacks. |
| **VULN-03** | **MEDIUM** | Error Handling | Unhandled `'error'` event on the server's listening socket (port conflict) leading to uncaught exception and crash. |
| **VULN-04** | **LOW** | Configuration | Missing startup validation for environment variables (`CAMS_AUTH_TOKEN`, target URLs), causing silent failures. |

---

## 2. Detailed Breakdown of Findings

### 🔴 VULN-01: Process Crash on Downstream Response Stream Error
*   **Location**: `server.js`, lines 43–55
*   **Code Snippet**:
    ```javascript
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
    ```
*   **Vulnerability**: The response object `res` (an instance of `http.IncomingMessage`) is a readable stream. If the downstream server (e.g., BGC Sixorbit or ERPNext) drops the connection abruptly *after* sending headers but *before* finishing the body response, the `res` stream will emit an `'error'` event. Because there is no listener for `'error'` on `res`, this event bubbles up as an uncaught exception, crashing the entire Webhook Splitter process.
*   **Attack Scenario**: A malicious or unstable downstream target returns headers, then closes the connection abruptly. The splitter crashes, failing to handle any further webhook traffic.
*   **Mitigation**: Add an `'error'` listener on `res` to reject the promise gracefully:
    ```javascript
    const req = client.request(options, (res) => {
      res.on('error', (err) => {
        reject(err);
      });
      // ... rest of the handlers
    });
    ```

---

### 🟡 VULN-02: Heap Exhaustion via Unbounded Request Bodies (Denial of Service)
*   **Location**: `server.js`, lines 132–134
*   **Code Snippet**:
    ```javascript
    req.on('data', chunk => {
      body += chunk;
    });
    ```
*   **Vulnerability**: The server continuously appends data chunks to the `body` string without checking the size. An attacker can send an infinitely long HTTP POST request, consuming memory until the V8 engine hits its memory limit (e.g., ~1.4GB) and crashes with an Out-of-Memory (OOM) error.
*   **Attack Scenario**: An attacker sends a 2GB request to `/webhook/cams`. The splitter attempts to load the entire payload into RAM, running out of memory and crashing.
*   **Mitigation**: 
    1. Check the `Content-Length` header on incoming requests and reject immediately if it exceeds a sensible limit (e.g., 1MB).
    2. Monitor the accumulated string length during stream consumption and destroy the request if it exceeds the limit:
    ```javascript
    const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_PAYLOAD_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload Too Large' }));
        req.destroy();
      }
    });
    ```

---

### 🟡 VULN-03: Process Crash on Server Port Conflict
*   **Location**: `server.js`, lines 177–180
*   **Code Snippet**:
    ```javascript
    // Start Server
    server.listen(PORT, () => {
      console.log(`Splitter server listening on port ${PORT}`);
    });
    ```
*   **Robustness Issue**: If the configured port is already bound by another application, the `server.listen()` call emits an `'error'` event on the server instance. Since there is no listener for `'error'` on `server`, the process throws an unhandled exception and crashes.
*   **Mitigation**: Implement a handler on the server instance:
    ```javascript
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[Error] Port ${PORT} is already in use.`);
      } else {
        console.error('[Error] Server exception:', err);
      }
      process.exit(1);
    });
    ```

---

### 🔵 VULN-04: Lack of Startup Validation for Crucial Environment Variables
*   **Location**: `server.js`, lines 11–18
*   **Robustness Issue**: If the `CAMS_AUTH_TOKEN` environment variable is not defined, all incoming webhook requests will fail validation (since `isAuthorized` becomes falsy). The server continues to boot up without warning that it is in an unauthenticated or unusable state.
*   **Mitigation**: Validate the environment variables during startup and log clear warnings or exit if required values are missing:
    ```javascript
    if (!process.env.CAMS_AUTH_TOKEN) {
      console.warn('[Warning] CAMS_AUTH_TOKEN environment variable is not set. All incoming requests will be rejected as unauthorized.');
    }
    ```
