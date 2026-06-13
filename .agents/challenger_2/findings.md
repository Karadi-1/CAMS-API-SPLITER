# Adversarial Findings — Webhook Splitter API

This document details the vulnerabilities, edge cases, and architectural concerns identified during the adversarial review of `server.js`.

---

## Overall Risk Assessment: HIGH

While the application is clean, has zero dependencies, and functions correctly under normal conditions, it is vulnerable to **Denial of Service (DoS)**, **data corruption**, and **sensitive credentials leakage** under adversarial conditions.

---

## Major Vulnerabilities & Edge Cases

### 1. Unbounded Request Body Buffering (Denial of Service) — **CRITICAL**
- **Location**: `server.js`, lines 130-134
- **Vulnerability**: The server accumulates the request payload in memory chunk-by-chunk without any length limitations:
  ```javascript
  req.on('data', chunk => {
    body += chunk;
  });
  ```
- **Attack Scenario**: An attacker can send a continuous HTTP POST stream or a massive JSON payload (e.g., 500MB+). Since Node.js buffers this in the V8 heap, the server will rapidly run out of memory (OOM) and crash.
- **Mitigation**: Implement a strict payload size limit (e.g., 1MB) and destroy the request/socket if it is exceeded:
  ```javascript
  const MAX_PAYLOAD_SIZE = 1 * 1024 * 1024; // 1MB
  let bodySize = 0;
  req.on('data', chunk => {
    bodySize += chunk.length;
    if (bodySize > MAX_PAYLOAD_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload Too Large' }));
      req.destroy();
    } else {
      body += chunk;
    }
  });
  ```

---

### 2. Unbounded Downstream Response Buffering (Denial of Service) — **HIGH**
- **Location**: `server.js`, lines 43-48
- **Vulnerability**: When forwarding requests, the server reads the downstream response body into memory:
  ```javascript
  res.on('data', chunk => {
    responseBody += chunk;
  });
  ```
- **Attack Scenario**: If one of the downstream ERP servers is compromised or misconfigured to return a very large payload (such as a database backup file or an infinite stream), the splitter will buffer the entire payload in memory. This will cause OOM crashes.
- **Context**: The splitter server only logs the downstream HTTP status code and does not read or process the response body at all.
- **Mitigation**: Discard the downstream response body entirely to avoid memory allocation:
  ```javascript
  const req = client.request(options, (res) => {
    res.resume(); // Consume and discard the stream data immediately
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve({ statusCode: res.statusCode });
      } else {
        reject(new Error(`Server returned status code ${res.statusCode}`));
      }
    });
  });
  ```

---

### 3. UTF-8 Character Bleeding at Chunk Boundaries (Data Corruption) — **MEDIUM**
- **Location**: `server.js`, lines 43-48 and 130-134
- **Vulnerability**: Chunks (which are raw binary `Buffer` objects) are concatenated to strings using `body += chunk` and `responseBody += chunk`. This triggers an implicit `.toString('utf8')` conversion on each chunk. If a multi-byte UTF-8 character (such as an emoji, accented character, or non-ASCII name) is split across a chunk boundary, the character will be corrupted.
- **Impact**: User names, logs, or biometric punch details containing non-ASCII characters could be forwarded to downstream ERP systems with garbled or corrupted data.
- **Mitigation**: Explicitly set the stream encoding to `'utf8'` before reading:
  ```javascript
  req.setEncoding('utf8');
  ```
  Or, collect chunks as `Buffer` objects and concatenate them with `Buffer.concat(chunks).toString('utf8')` in the `'end'` event.

---

### 4. Sensitive Data Exposure in Logs (Token Leakage) — **MEDIUM**
- **Location**: `server.js`, line 156
- **Vulnerability**: When an unauthorized request is received, the server logs the exact value of the token:
  ```javascript
  console.warn(`Unauthorized access attempt. Provided token: ${incomingToken}`);
  ```
- **Impact**: If a client misconfigures their application and accidentally sends a sensitive credential (e.g., database password, API token, or SSH key) inside the `AuthToken` field, the credential will be saved in the application log files in plain text.
- **Mitigation**: Avoid logging the token itself. Log the token length, or a SHA-256 hash, or simply log that an unauthorized request occurred without the token value:
  ```javascript
  console.warn(`Unauthorized access attempt. Token length: ${incomingToken ? incomingToken.length : 0}`);
  ```

---

### 5. Lack of Startup Error Handling (Process Crash) — **LOW**
- **Location**: `server.js`, lines 178-180
- **Vulnerability**: The server calls `server.listen(PORT)` without registering an `'error'` event listener on the server instance.
- **Impact**: If the port is already in use (e.g., due to another running process) or there are privilege issues, Node.js will throw an unhandled exception and crash.
- **Mitigation**: Register an error listener:
  ```javascript
  server.on('error', (err) => {
    console.error('Server failed to start:', err.message);
    process.exit(1);
  });
  ```

---

### 6. Missing Graceful Shutdown Logic (Data Loss) — **LOW**
- **Location**: `server.js` (Entire file)
- **Vulnerability**: The application does not handle termination signals like `SIGTERM` or `SIGINT`.
- **Impact**: When the server is stopped or restarted, any active asynchronous forwarding requests in the event loop are aborted instantly, potentially causing biometric data loss (e.g., punches not reaching the ERPs).
- **Mitigation**: Add signal listeners to stop accepting new requests, wait for pending HTTP requests to complete, and then exit.
