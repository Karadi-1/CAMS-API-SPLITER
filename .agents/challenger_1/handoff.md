# Handoff Report — Challenger 1

This document provides a self-contained handoff detailing the adversarial verification findings of the CAMS Webhook Splitter API.

---

## 1. Observation

Direct observations from `/Users/sunitj/Library/CloudStorage/OneDrive-Personal/Documents OD/WORK/Files/BGC/IT/CAMS API SPLITER/server.js`:

### Observation 1.1: Downstream Forwarding Response Stream Error Handling
In `server.js` (lines 43-55), when creating a client request to a downstream service, the response callback does not configure an `'error'` event handler on the readable response stream `res`:
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
Only `'data'` and `'end'` handlers are attached. No `res.on('error', ...)` handler exists.

### Observation 1.2: Server Incoming Request Body Buffering
In `server.js` (lines 132-135), the webhook input body is read without any size constraints:
```javascript
    req.on('data', chunk => {
      body += chunk;
    });
```
There is no check on `body.length` or `Content-Length` header bounds.

### Observation 1.3: Server Listen Error Handling
In `server.js` (lines 177-180), the server starts listening without error event subscription:
```javascript
// Start Server
server.listen(PORT, () => {
  console.log(`Splitter server listening on port ${PORT}`);
});
```

---

## 2. Logic Chain

1. **Vulnerability VULN-01 (Uncaught Exception on target disconnection)**:
   - According to **Observation 1.1**, the response stream `res` (an instance of `http.IncomingMessage`) is created on connection.
   - In Node.js, `IncomingMessage` is a readable stream. If a readable stream emits an `'error'` event (such as due to socket closure/reset mid-transmission of the response body) and does not have an `'error'` listener attached, the error propagates as an uncaught exception.
   - An uncaught exception in Node.js immediately crashes the process.
   - Therefore, a downstream server dropping the socket mid-response will crash the entire CAMS Webhook Splitter API.

2. **Vulnerability VULN-02 (Heap Exhaustion / DoS)**:
   - According to **Observation 1.2**, the webhook endpoint accepts data and appends it to a local string variable `body` indefinitely.
   - If an attacker sends a very large request body (e.g., several gigabytes of random bytes) or continues to send data forever, the memory consumption of the Node process will grow until it reaches the V8 heap limits.
   - Node.js will crash with an Out-of-Memory (OOM) error.
   - Therefore, the server is vulnerable to Denial of Service (DoS) attacks.

3. **Vulnerability VULN-03 (Server Port Conflict crash)**:
   - According to **Observation 1.3**, the server calls `listen()` directly.
   - If the port is already bound by another service, the net/http server will emit an `'error'` event with code `EADDRINUSE`.
   - Without an `'error'` event listener on the `server` instance, the event becomes an uncaught exception and crashes the process.

---

## 3. Caveats

- Operating system commands could not be run directly during this turn due to user permission timeouts in the CODE_ONLY environment (making execution of `node test_splitter.js` and the adversarial tests impossible to perform locally).
- The behavior of Node.js stream errors and memory limits was analyzed statically based on standard Node.js runtime behavior.

---

## 4. Conclusion

The implementation of `server.js` contains a critical robustness vulnerability (**VULN-01**: unhandled response stream errors) that allows downstream server stability issues to crash the splitter. It also lacks basic DoS protection (**VULN-02**: unbounded request buffering) and clean error handling for port conflicts (**VULN-03**). 

---

## 5. Verification Method

To verify these issues once the application is running:
1. **To verify VULN-01 (Downstream crash)**:
   - Configure a mock target server that sends `HTTP/1.1 200 OK` headers followed by partial body data, and then immediately destroys its socket using `socket.destroy()`.
   - Send a valid webhook to the Splitter.
   - Observe if the Splitter process terminates with an uncaught exception.
2. **To verify VULN-02 (DoS)**:
   - Send a large POST request (e.g., 50MB+) to `/webhook/cams`.
   - Observe memory footprint or verify that there are no restrictions on content size.
3. **To verify VULN-03 (Port conflict)**:
   - Run another process listening on the same port (e.g. `3000`), then attempt to start the splitter.
   - Verify that it crashes with `EADDRINUSE`.
