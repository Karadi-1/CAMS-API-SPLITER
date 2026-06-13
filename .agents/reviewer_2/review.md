# Webhook Splitter API Review Report

This report contains both the **Quality Review** and the **Adversarial Review** for the Webhook Splitter API codebase (`server.js` and `test_splitter.js`).

---

# PART 1: Quality Review

## Review Summary

**Verdict**: REQUEST_CHANGES (due to critical denial-of-service risk, process crash risks, and missing coverage for claimed test cases)

The Webhook Splitter API has been implemented with zero external dependencies using Node.js built-in `http` and `https` modules, complying with the offline and low-footprint constraints. The server successfully validates the CAMS authentication token, strips it from the payload, responds immediately, and asynchronously forwards the cleaned payload to the configured targets (BGC Sixorbit and SEMPL ERPNext) concurrently.

However, several major robustness, security, and test coverage gaps prevent immediate approval. Specifically:
1. Unhandled response stream error events can cause the server process to crash.
2. Unbounded incoming payload size creates a critical Denial of Service (DoS) vulnerability.
3. Multiple test cases claimed in `TEST_INFRA.md` are not actually implemented in `test_splitter.js`.

---

## Findings

### [Major] Finding 1: Unhandled Response Stream Error
- **What**: No listener is attached to the `'error'` event of the `IncomingMessage` (response) stream in the outgoing HTTP request client.
- **Where**: `server.js`, lines 43-55 (inside `forwardRequest`).
- **Why**: If a target server abruptly terminates the TCP connection or encounters a network interface failure while the Splitter is reading the response payload, the `res` stream will emit an `'error'` event. In Node.js, an unhandled `'error'` event on a stream propagates as an unhandled exception, which crashes the entire Node.js server process.
- **Suggestion**: Attach an `'error'` listener to the `res` object inside the `http.request`/`https.request` callback:
  ```javascript
  const req = client.request(options, (res) => {
    let responseBody = '';
    res.on('error', (err) => {
      reject(err);
    });
    // ...
  });
  ```

### [Major] Finding 2: Unbounded Webhook Request Body (DoS Vulnerability)
- **What**: The server accumulates the entire incoming request payload into memory without any size constraints.
- **Where**: `server.js`, lines 132-134.
- **Why**: An attacker could flood the `/webhook/cams` endpoint with a multi-gigabyte payload. Since the server appends every chunk to the `body` string, it will eventually exhaust the Node.js V8 heap memory limit, causing an Out-Of-Memory (OOM) crash and denying service to valid requests.
- **Suggestion**: Implement a maximum payload size threshold (e.g., 1MB). Monitor the length of the received data and destroy the connection/reject the request with HTTP 413 (Payload Too Large) if the threshold is exceeded:
  ```javascript
  let body = '';
  const MAX_SIZE = 1 * 1024 * 1024; // 1MB limit
  req.on('data', chunk => {
    body += chunk;
    if (body.length > MAX_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload Too Large' }));
      req.destroy();
    }
  });
  ```

### [Major] Finding 3: Mismatches Between claimed Test Cases and Actual Test Code
- **What**: The test suite in `test_splitter.js` does not cover several scenarios claimed in `TEST_INFRA.md` and `TEST_READY.md`.
- **Where**: `test_splitter.js` vs. `TEST_INFRA.md` and `TEST_READY.md`.
- **Why**: 
  - **Case 3.4 (All-Targets Offline Resilience)**: Claimed to verify that the Splitter handles both targets being offline, but the tests only configure single-target offline behaviors (`mockErpnext.shouldHangup = true` while `mockSixorbit` remains online).
  - **Case 4.1 & 4.2 (Success & Failure Logging)**: Claimed to assert logging of targets, but `test_splitter.js` completely ignores the spawned process stdout/stderr streams and performs no assertions on the console outputs.
  - **Case 4.3 (DNS/Network Exception Handling)**: Claimed to test behavior when Splitter is configured with invalid/malformed target URLs, but the test suite only runs against valid localhost ports.
- **Suggestion**: Expand `test_splitter.js` to implement assertions on the Splitter's stdout/stderr streams to verify logs, simulate both mock targets being offline concurrently, and test startup/forwarding behavior when the URL environment variables are malformed.

### [Minor] Finding 4: Lack of HTTP Keep-Alive for Forwarding Clients
- **What**: Forwarding clients do not reuse TCP sockets, creating new connections for every webhook event.
- **Where**: `server.js`, lines 21-72.
- **Why**: Under high webhook throughput, initiating a new TCP/TLS handshake for each forward request to Sixorbit and ERPNext causes high resource usage and socket exhaustion.
- **Suggestion**: Instantiate and use a persistent global HTTP/HTTPS Agent with `keepAlive: true` to enable connection reuse.

---

## Verified Claims

- **Zero External Dependencies** → verified via inspecting `server.js` imports (only imports `http`, `https`, and `url`) → **PASS**
- **Authentication Headers Conformance** → verified via inspecting `test_splitter.js` lines 287 and 295, where BGC Sixorbit receives `Bearer <token>` and ERPNext receives `token <key>:<secret>` → **PASS**
- **Immediate Response Implementation** → verified via inspecting `server.js` lines 152-153 where `res.end()` is invoked immediately before calling `processForwarding` → **PASS**

---

## Coverage Gaps

- **Logging verification** — risk level: **Medium** — recommendation: Investigate how to test stdout/stderr in `test_splitter.js` or accept the risk if logging is considered a non-critical feature.
- **All-targets offline resilience** — risk level: **Medium** — recommendation: Implement a test case in `test_splitter.js` that disables both mock servers to ensure the splitter does not crash when both targets are unreachable.
- **Malformed URL environment variables** — risk level: **Medium** — recommendation: Implement a test case in `test_splitter.js` that verifies process survival when `BGC_SIXORBIT_URL` is configured with a malformed string.

---

## Unverified Items

- **Running the E2E verification test suite** — reason not verified: Attempting to run `node test_splitter.js` in the sandbox environment resulted in a permission prompt timeout (`Permission prompt for action 'command' on target 'node test_splitter.js' timed out waiting for user response. The user was not able to provide permission on time`).

---
---

# PART 2: Adversarial Review

## Challenge Summary

**Overall risk assessment**: HIGH

The primary adversarial risk is that while the Webhook Splitter API is designed to be highly concurrent and non-blocking, it lacks protection against malicious inputs (huge payload sizes) and unstable remote connections (causing unhandled stream errors). This can lead to service outages (DoS) due to simple runtime errors or resource exhaustion.

---

## Challenges

### [High] Challenge 1: Denial of Service via Memory Exhaustion
- **Assumption challenged**: Webhook requests will always contain small biometric punch payloads.
- **Attack scenario**: A malicious agent sends a large payload (e.g. 500MB JSON payload) to `/webhook/cams`.
- **Blast radius**: The server attempts to buffer the entire body in memory. V8 runs out of memory, crash logs are generated, and the Node.js process terminates, dropping all in-flight and future punch webhooks.
- **Mitigation**: Add incoming stream size limits in `server.js` and terminate requests immediately if they exceed 1MB.

### [High] Challenge 2: Process Crash via Connection Drops during Response
- **Assumption challenged**: The target servers will always return well-formed HTTP responses or clean TCP disconnects that only trigger request-level errors.
- **Attack scenario**: The remote target accepts the headers, starts sending the response, but abruptly drops the socket mid-transmission. This triggers a stream `'error'` on the response IncomingMessage object.
- **Blast radius**: Since there is no listener for `'error'` on the response object, the error bubbles up, causing the node process to crash.
- **Mitigation**: Bind an error handler to `res` object inside `forwardRequest`.

### [Medium] Challenge 3: Port Exhaustion under High Concurrent Traffic
- **Assumption challenged**: The server handles concurrency seamlessly using `Promise.allSettled`.
- **Attack scenario**: Hundreds of punches arrive per second. The server opens two new TCP connections per punch (one for Sixorbit, one for ERPNext) without connection reuse.
- **Blast radius**: The server quickly exhausts all ephemeral ports on the host system, leading to outbound connection failures (`EADDRINUSE` or `ETIMEDOUT`) for subsequent forwarding attempts.
- **Mitigation**: Enable keep-alive agents to reuse existing TCP connections.

---

## Stress Test Results

- **Scenario: Mock Target Slow Response (200ms delay)** → Expected: Splitter responds in < 50ms, forwards resolve later → Predicted Behavior: **PASS** (verified via code inspection of `test_splitter.js` Tier 1).
- **Scenario: Mock Target Socket Hangup** → Expected: Splitter does not crash, continues forwarding to other targets → Predicted Behavior: **FAIL** (if the connection drops during response body download, it will crash due to unhandled stream error. If the connection drops during request phase, it will pass due to `req.on('error')`).

---

## Unchallenged Areas

- **HTTPS TLS Certificate Validation** — reason not challenged: The test suite uses HTTP localhost servers (`http://localhost:${PORT}`). In production, HTTPS will be used (`https:`), and how the splitter handles self-signed or invalid certificates remains unchallenged.
