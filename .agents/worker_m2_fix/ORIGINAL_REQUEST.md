## 2026-06-13T13:37:46Z
You are the Worker for Milestones 2 & 3: Security & Robustness Hardening.
Your working directory is .agents/worker_m2_fix/.
You are in CODE_ONLY network mode.

Your task is to:
1. Analyze the quality and adversarial findings in `/Users/sunitj/Library/CloudStorage/OneDrive-Personal/Documents OD/WORK/Files/BGC/IT/CAMS API SPLITER/.agents/reviewer_2/review.md` and `/Users/sunitj/Library/CloudStorage/OneDrive-Personal/Documents%20OD/WORK/Files/BGC/IT/CAMS%20API%20SPLITER/.agents/challenger_1/findings.md`.
2. Edit `server.js` in the project root to implement all recommendations:
   - Attach an `'error'` event listener to the response object `res` inside `forwardRequest`.
   - Limit incoming payload size: check `Content-Length` header and length of accumulated body data (1MB limit). Return 413 and destroy the request if exceeded.
   - Use persistent global HTTP/HTTPS Agents with `keepAlive: true` to reuse connections.
   - Add an `'error'` listener on the main HTTP `server` instance to catch `EADDRINUSE` or other socket-level errors gracefully.
   - Add startup warning logs if `CAMS_AUTH_TOKEN`, `BGC_SIXORBIT_URL`, or `SEMPL_ERPNEXT_URL` environment variables are missing.
3. Edit `test_splitter.js` in the project root to:
   - Ensure all 14 test cases described in `TEST_INFRA.md` are fully implemented (including Case 3.4: All-Targets Offline, Case 4.3: DNS/Network Exception Handling with malformed URLs).
   - Implement child process stdout/stderr verification for Case 4.1 & 4.2 to ensure the splitter logs success and failure events.
4. Run the test suite with `node test_splitter.js` and verify it passes. If the command times out, document that the command timed out but verify that the JavaScript files are syntax-checked and correct.
5. Save logs to `.agents/worker_m2_fix/test_results.log`.
6. Document changes in `.agents/worker_m2_fix/changes.md` and handoff in `.agents/worker_m2_fix/handoff.md`.
7. Once complete, notify the orchestrator (conversation ID: e6b9ad55-5ce8-4ca3-978d-c4cfa10ea9b7) via send_message.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## 2026-06-13T08:08:01Z
Additional findings have been reported by Challenger 2 that must be implemented in your changes:
1. **UTF-8 Character Bleeding**: On incoming request streams (in the main server) and outgoing response streams (in `forwardRequest`), call `stream.setEncoding('utf8')` before listening to the `'data'` event. This ensures chunk boundaries do not corrupt multi-byte UTF-8 characters.
2. **Response Body Size Limit**: In `forwardRequest`, limit the response body accumulation to a sensible threshold (e.g. 1MB) and reject/destroy the stream if exceeded, preventing downstream memory exhaustion DoS.
3. **Sensitive Token Leakage**: Mask or redact the raw unauthorized token logged on console (e.g., log the length or a masked string, do not print the raw token).
4. **Adversarial Test Script Integration**: Ensure these new edge cases are also handled and tested in `test_splitter.js`.
Action: Please integrate these fixes into your implementation of `server.js` and `test_splitter.js`.
