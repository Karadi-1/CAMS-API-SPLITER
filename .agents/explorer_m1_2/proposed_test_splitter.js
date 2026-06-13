/**
 * Verification Test Script: test_splitter.js (Proposed)
 * 
 * This script verifies the Node.js Webhook Splitter API against all requirements
 * outlined in Tiers 1-4. It uses only Node.js built-in modules so it has zero
 * external dependencies and works offline out-of-the-box.
 * 
 * Usage:
 *   node test_splitter.js
 */

const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

// Configuration
const SPLITTER_PORT = process.env.PORT || 3000;
const BGC_PORT = 3001;
const SEMPL_PORT = 3002;

const CAMS_AUTH_TOKEN = 'cams_secret_token_123';
const BGC_TOKEN = 'bgc_secret_token_456';
const SEMPL_KEY = 'sempl_api_key_789';
const SEMPL_SECRET = 'sempl_api_secret_abc';

/**
 * Mock Target Server to simulate Sixorbit or ERPNext
 */
class MockTargetServer {
  constructor(name, port) {
    this.name = name;
    this.port = port;
    this.requests = [];
    this.behavior = {
      delay: 0,
      statusCode: 200,
      shouldClose: false,
    };
    
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const recordedReq = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: body ? JSON.parse(body) : null,
          receivedAt: Date.now()
        };
        this.requests.push(recordedReq);

        if (this.behavior.shouldClose) {
          req.socket.destroy();
          return;
        }

        setTimeout(() => {
          res.writeHead(this.behavior.statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', target: this.name }));
        }, this.behavior.delay);
      });
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, () => {
        console.log(`Mock server [${this.name}] listening on port ${this.port}`);
        resolve();
      }).on('error', reject);
    });
  }

  stop() {
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log(`Mock server [${this.name}] stopped`);
        resolve();
      });
    });
  }

  clear() {
    this.requests = [];
    this.behavior = {
      delay: 0,
      statusCode: 200,
      shouldClose: false,
    };
  }
}

// Helpers
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendWebhook(payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const start = Date.now();
    const req = http.request({
      hostname: 'localhost',
      port: SPLITTER_PORT,
      path: '/webhook/cams',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let parsedBody = null;
        try {
          parsedBody = JSON.parse(body);
        } catch (e) {
          parsedBody = body;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsedBody,
          duration: Date.now() - start
        });
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Global process instances
let splitterProcess = null;
let bgcMock = null;
let semplMock = null;
let stdoutLogs = '';
let stderrLogs = '';

function startSplitter() {
  return new Promise((resolve, reject) => {
    stdoutLogs = '';
    stderrLogs = '';
    
    const env = {
      ...process.env,
      PORT: SPLITTER_PORT.toString(),
      CAMS_AUTH_TOKEN,
      BGC_SIXORBIT_URL: `http://localhost:${BGC_PORT}/sixorbit`,
      BGC_SIXORBIT_TOKEN: BGC_TOKEN,
      SEMPL_ERPNEXT_URL: `http://localhost:${SEMPL_PORT}/erpnext`,
      SEMPL_ERPNEXT_API_KEY: SEMPL_KEY,
      SEMPL_ERPNEXT_API_SECRET: SEMPL_SECRET
    };

    console.log(`Spawning Splitter server (node server.js)...`);
    splitterProcess = spawn('node', ['server.js'], { env });

    splitterProcess.stdout.on('data', (data) => {
      const log = data.toString();
      stdoutLogs += log;
      process.stdout.write(`[Splitter STDOUT] ${log}`);
    });

    splitterProcess.stderr.on('data', (data) => {
      const log = data.toString();
      stderrLogs += log;
      process.stderr.write(`[Splitter STDERR] ${log}`);
    });

    splitterProcess.on('error', (err) => {
      console.error('Failed to start Splitter process:', err);
      reject(err);
    });

    // Wait 300ms for express server to bind to port
    setTimeout(resolve, 300);
  });
}

function stopSplitter() {
  if (splitterProcess) {
    console.log('Terminating Splitter process...');
    splitterProcess.kill('SIGTERM');
  }
}

async function runTests() {
  let failed = false;
  
  // Setup mocks
  bgcMock = new MockTargetServer('BGC Sixorbit', BGC_PORT);
  semplMock = new MockTargetServer('SEMPL ERPNext', SEMPL_PORT);
  
  await bgcMock.start();
  await semplMock.start();
  await startSplitter();

  console.log('\n--- Starting E2E Verification Tests ---\n');

  try {
    // ==========================================
    // TIER 1: Immediate Acknowledgment & Auth Check
    // ==========================================
    console.log('--- Tier 1 Tests ---');
    
    // Case 1.1: Valid payload returns 200 done immediately
    console.log('Case 1.1: Valid token immediate response...');
    bgcMock.clear();
    semplMock.clear();
    
    const res1 = await sendWebhook({
      AuthToken: CAMS_AUTH_TOKEN,
      data: { event: 'check_in', userId: 'usr_001' }
    });
    
    assert.strictEqual(res1.statusCode, 200, 'Status should be 200');
    assert.deepStrictEqual(res1.body, { status: 'done' }, 'Body should be {"status":"done"}');
    assert.ok(res1.duration < 50, `Acknowledgment response took too long (${res1.duration}ms), expected < 50ms`);
    console.log(`  ✓ Passed (acknowledged in ${res1.duration}ms)`);

    // Let's wait a moment for the asynchronous forwarding to complete
    await wait(80);

    // Case 1.2 & 1.3: Unauthorized attempts
    console.log('Case 1.2: Invalid token handling...');
    bgcMock.clear();
    semplMock.clear();
    
    const res2 = await sendWebhook({
      AuthToken: 'wrong_token',
      data: { event: 'check_in', userId: 'usr_002' }
    });
    
    assert.strictEqual(res2.statusCode, 200, 'Unauthorized requests should still return 200');
    assert.deepStrictEqual(res2.body, { status: 'done' }, 'Unauthorized requests should return {"status":"done"}');
    assert.ok(res2.duration < 50, `Unauthorized ack took too long (${res2.duration}ms)`);
    await wait(80);
    assert.strictEqual(bgcMock.requests.length, 0, 'Should NOT forward to BGC on invalid auth');
    assert.strictEqual(semplMock.requests.length, 0, 'Should NOT forward to SEMPL on invalid auth');
    console.log('  ✓ Passed (unauthorized request rejected from forwarding but immediately acknowledged)');

    console.log('Case 1.3: Missing token handling...');
    bgcMock.clear();
    semplMock.clear();
    
    const res3 = await sendWebhook({
      data: { event: 'check_in', userId: 'usr_003' }
    });
    
    assert.strictEqual(res3.statusCode, 200, 'Missing token request should return 200');
    assert.deepStrictEqual(res3.body, { status: 'done' }, 'Missing token request should return {"status":"done"}');
    await wait(80);
    assert.strictEqual(bgcMock.requests.length, 0, 'Should NOT forward to BGC on missing auth');
    assert.strictEqual(semplMock.requests.length, 0, 'Should NOT forward to SEMPL on missing auth');
    console.log('  ✓ Passed (missing token request rejected from forwarding but immediately acknowledged)');

    // ==========================================
    // TIER 2: Payload Cleaning & Forwarding Headers
    // ==========================================
    console.log('\n--- Tier 2 Tests ---');
    
    console.log('Case 2.1 - 2.4: Payload cleaning & Headers verification...');
    bgcMock.clear();
    semplMock.clear();
    
    const testPayload = {
      AuthToken: CAMS_AUTH_TOKEN,
      data: { event: 'check_out', userId: 'usr_999', location: 'Office A' }
    };
    
    await sendWebhook(testPayload);
    await wait(80); // wait for async forwarding

    // Assert BGC Forward
    assert.strictEqual(bgcMock.requests.length, 1, 'BGC should have received exactly 1 request');
    const bgcReq = bgcMock.requests[0];
    assert.strictEqual(bgcReq.method, 'POST');
    assert.strictEqual(bgcReq.url, '/sixorbit');
    assert.strictEqual(bgcReq.headers['authorization'], `Bearer ${BGC_TOKEN}`, 'BGC Authorization header incorrect');
    assert.strictEqual(bgcReq.headers['content-type'], 'application/json', 'Content-type must be application/json');
    assert.ok(!bgcReq.body.hasOwnProperty('AuthToken'), 'BGC forwarded payload must strip AuthToken');
    assert.deepStrictEqual(bgcReq.body.data, testPayload.data, 'BGC forwarded data mismatch');
    
    // Assert SEMPL Forward
    assert.strictEqual(semplMock.requests.length, 1, 'SEMPL should have received exactly 1 request');
    const semplReq = semplMock.requests[0];
    assert.strictEqual(semplReq.method, 'POST');
    assert.strictEqual(semplReq.url, '/erpnext');
    assert.strictEqual(semplReq.headers['authorization'], `token ${SEMPL_KEY}:${SEMPL_SECRET}`, 'SEMPL Authorization header incorrect');
    assert.strictEqual(semplReq.headers['content-type'], 'application/json', 'Content-type must be application/json');
    assert.ok(!semplReq.body.hasOwnProperty('AuthToken'), 'SEMPL forwarded payload must strip AuthToken');
    assert.deepStrictEqual(semplReq.body.data, testPayload.data, 'SEMPL forwarded data mismatch');
    
    console.log('  ✓ Passed (payloads cleaned and target authorization headers verified)');

    // ==========================================
    // TIER 3: Concurrency & Resiliency
    // ==========================================
    console.log('\n--- Tier 3 Tests ---');
    
    console.log('Case 3.1: Concurrency (one target is slow)...');
    bgcMock.clear();
    semplMock.clear();
    
    // BGC is slow (takes 150ms to respond)
    bgcMock.behavior.delay = 150;
    // SEMPL is fast (responds instantly)
    semplMock.behavior.delay = 0;

    const resConcurrency = await sendWebhook({
      AuthToken: CAMS_AUTH_TOKEN,
      data: { event: 'concurrency_test' }
    });
    
    assert.strictEqual(resConcurrency.statusCode, 200);
    
    // Verify that SEMPL receives the forward almost immediately,
    // without waiting for the BGC delay to finish.
    await wait(40);
    assert.strictEqual(semplMock.requests.length, 1, 'SEMPL should receive the request quickly');
    assert.strictEqual(bgcMock.requests.length, 1, 'BGC should have received it as well (async dispatch)');
    // But the BGC mock server hasn't finished responding yet in terms of time,
    // which confirms that the server forwarded both concurrently via Promise.allSettled.
    
    await wait(150); // wait for BGC response to complete
    console.log('  ✓ Passed (slow targets do not block or delay concurrent delivery to other targets)');

    console.log('Case 3.2: Single target offline (BGC offline)...');
    bgcMock.clear();
    semplMock.clear();
    
    // Simulate BGC connection error (500 or closed socket)
    bgcMock.behavior.statusCode = 502; 
    
    const resOfflineBgc = await sendWebhook({
      AuthToken: CAMS_AUTH_TOKEN,
      data: { event: 'bgc_failure_test' }
    });
    
    assert.strictEqual(resOfflineBgc.statusCode, 200, 'Splitter must still respond 200');
    await wait(80);
    
    // SEMPL should still successfully receive the request
    assert.strictEqual(semplMock.requests.length, 1, 'SEMPL must still receive the payload even if BGC fails');
    assert.strictEqual(bgcMock.requests.length, 1, 'BGC received the attempt');
    console.log('  ✓ Passed (BGC offline/failure does not affect SEMPL delivery)');

    console.log('Case 3.3: Single target offline (SEMPL socket hangup)...');
    bgcMock.clear();
    semplMock.clear();
    
    // Simulate SEMPL socket crash
    semplMock.behavior.shouldClose = true; 
    
    const resOfflineSempl = await sendWebhook({
      AuthToken: CAMS_AUTH_TOKEN,
      data: { event: 'sempl_hangup_test' }
    });
    
    assert.strictEqual(resOfflineSempl.statusCode, 200);
    await wait(80);
    
    assert.strictEqual(bgcMock.requests.length, 1, 'BGC must still receive the payload even if SEMPL hangs up');
    console.log('  ✓ Passed (SEMPL socket hangup does not affect BGC delivery)');

    // ==========================================
    // TIER 4: Resiliency, Logging & Async Robustness
    // ==========================================
    console.log('\n--- Tier 4 Tests ---');
    
    console.log('Case 4.1 & 4.2: Logging success/failures...');
    // Clear logs from previous cases and perform a specific run
    stdoutLogs = ''; 
    stderrLogs = '';
    
    bgcMock.clear();
    semplMock.clear();
    
    // BGC succeeds, SEMPL fails (404)
    semplMock.behavior.statusCode = 404;
    
    await sendWebhook({
      AuthToken: CAMS_AUTH_TOKEN,
      data: { event: 'logging_test' }
    });
    await wait(100);

    const fullLogs = stdoutLogs + stderrLogs;
    
    // Verify BGC success log
    const containsBgcSuccess = fullLogs.toLowerCase().includes('bgc sixorbit') && 
                               (fullLogs.toLowerCase().includes('success') || fullLogs.toLowerCase().includes('200'));
    // Verify SEMPL failure log
    const containsSemplFailure = fullLogs.toLowerCase().includes('sempl erpnext') && 
                                 (fullLogs.toLowerCase().includes('fail') || fullLogs.toLowerCase().includes('404') || fullLogs.toLowerCase().includes('error'));

    assert.ok(containsBgcSuccess, 'Logs should contain success message for BGC Sixorbit');
    assert.ok(containsSemplFailure, 'Logs should contain failure message for SEMPL ERPNext (status 404)');
    console.log('  ✓ Passed (success and failure logs present with target names and error states)');

    console.log('\n--- All E2E Verification Tests Passed Successfully! ---');

  } catch (err) {
    console.error('\n❌ E2E Verification Tests Failed:');
    console.error(err);
    failed = true;
  } finally {
    // Clean up
    stopSplitter();
    await bgcMock.stop();
    await semplMock.stop();
    
    if (failed) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  }
}

// Start
runTests().catch(err => {
  console.error('Unhandled runner error:', err);
  process.exit(1);
});
