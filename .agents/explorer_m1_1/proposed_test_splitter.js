/**
 * test_splitter.js
 * E2E Verification Test Suite for Webhook Splitter API (Tiers 1-4)
 * Run with: node test_splitter.js
 */

const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

// Configuration
const SPLITTER_PORT = 3000;
const BGC_PORT = 8001;
const SEMPL_PORT = 8002;

const CAMS_AUTH_TOKEN = 'cams_secret_token_123';
const BGC_TOKEN = 'bgc_token_abc';
const SEMPL_KEY = 'sempl_key_xyz';
const SEMPL_SECRET = 'sempl_secret_uvw';

// State for mock target servers
let bgcRequests = [];
let semplRequests = [];
let bgcServerConfig = { delay: 0, status: 200 };
let semplServerConfig = { delay: 0, status: 200 };

// Create Mock Servers
const bgcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let parsedBody = null;
    try {
      parsedBody = body ? JSON.parse(body) : null;
    } catch (e) {
      parsedBody = body;
    }
    const requestInfo = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: parsedBody,
      timestamp: Date.now()
    };
    bgcRequests.push(requestInfo);

    setTimeout(() => {
      res.writeHead(bgcServerConfig.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success' }));
    }, bgcServerConfig.delay);
  });
});

const semplServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let parsedBody = null;
    try {
      parsedBody = body ? JSON.parse(body) : null;
    } catch (e) {
      parsedBody = body;
    }
    const requestInfo = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: parsedBody,
      timestamp: Date.now()
    };
    semplRequests.push(requestInfo);

    setTimeout(() => {
      res.writeHead(semplServerConfig.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success' }));
    }, semplServerConfig.delay);
  });
});

// Helper to make HTTP POST requests to Splitter
function postWebhook(payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
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
          parsedBody = body ? JSON.parse(body) : null;
        } catch (e) {
          parsedBody = body;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsedBody
        });
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Helper to wait
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Run tests
async function runTests() {
  console.log('Starting Mock Target Servers...');
  await new Promise(resolve => bgcServer.listen(BGC_PORT, resolve));
  await new Promise(resolve => semplServer.listen(SEMPL_PORT, resolve));
  console.log(`BGC Mock listening on port ${BGC_PORT}`);
  console.log(`SEMPL Mock listening on port ${SEMPL_PORT}`);

  console.log('Spawning Splitter Server...');
  const splitterEnv = {
    ...process.env,
    PORT: String(SPLITTER_PORT),
    CAMS_AUTH_TOKEN: CAMS_AUTH_TOKEN,
    BGC_SIXORBIT_URL: `http://localhost:${BGC_PORT}/sixorbit`,
    BGC_SIXORBIT_TOKEN: BGC_TOKEN,
    SEMPL_ERPNEXT_URL: `http://localhost:${SEMPL_PORT}/erpnext`,
    SEMPL_ERPNEXT_API_KEY: SEMPL_KEY,
    SEMPL_ERPNEXT_API_SECRET: SEMPL_SECRET
  };

  const splitterProcess = spawn('node', ['server.js'], { env: splitterEnv });
  let splitterLogs = '';
  splitterProcess.stdout.on('data', data => {
    splitterLogs += data.toString();
  });
  splitterProcess.stderr.on('data', data => {
    splitterLogs += data.toString();
  });

  // Give server time to start up
  await sleep(1000);

  let passed = 0;
  let failed = 0;

  async function testCase(name, fn) {
    console.log(`\n--- Running Test: ${name} ---`);
    bgcRequests = [];
    semplRequests = [];
    bgcServerConfig = { delay: 0, status: 200 };
    semplServerConfig = { delay: 0, status: 200 };
    try {
      await fn();
      console.log(`✅ PASSED: ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ FAILED: ${name}`);
      console.error(err);
      failed++;
    }
  }

  try {
    // ==========================================
    // TIER 1: Basic Endpoint & Immediate Response
    // ==========================================

    await testCase('Tier 1 - Unauthorized Access (Invalid Token)', async () => {
      const startTime = Date.now();
      const response = await postWebhook({
        AuthToken: 'wrong_token',
        data: { value: 42 }
      });
      const duration = Date.now() - startTime;

      assert.strictEqual(response.statusCode, 200);
      assert.deepStrictEqual(response.body, { status: 'done' });
      assert.ok(duration < 50, `Response took ${duration}ms, should be < 50ms`);

      // Allow async processing time to see if anything gets forwarded
      await sleep(200);
      assert.strictEqual(bgcRequests.length, 0, 'Should not forward to BGC on invalid auth');
      assert.strictEqual(semplRequests.length, 0, 'Should not forward to SEMPL on invalid auth');

      // Verify that logs contain warning
      assert.ok(
        splitterLogs.includes('Unauthorized') || splitterLogs.toLowerCase().includes('invalid'),
        'Logs should indicate an unauthorized or invalid token request'
      );
    });

    await testCase('Tier 1 - Unauthorized Access (Missing Token)', async () => {
      const startTime = Date.now();
      const response = await postWebhook({
        data: { value: 42 }
      });
      const duration = Date.now() - startTime;

      assert.strictEqual(response.statusCode, 200);
      assert.deepStrictEqual(response.body, { status: 'done' });
      assert.ok(duration < 50, `Response took ${duration}ms, should be < 50ms`);

      await sleep(200);
      assert.strictEqual(bgcRequests.length, 0);
      assert.strictEqual(semplRequests.length, 0);
    });

    // ==========================================
    // TIER 2 & 3: Authorized Split Forwarding & Payload Cleaning
    // ==========================================

    await testCase('Tier 2 & 3 - Authorized Split Forwarding & Payload Cleaning', async () => {
      const startTime = Date.now();
      const response = await postWebhook({
        AuthToken: CAMS_AUTH_TOKEN,
        data: { metric: 'temperature', reading: 22 }
      });
      const duration = Date.now() - startTime;

      assert.strictEqual(response.statusCode, 200);
      assert.deepStrictEqual(response.body, { status: 'done' });
      assert.ok(duration < 50, `Response took ${duration}ms, should be < 50ms`);

      // Wait for forwarders to complete
      await sleep(200);

      // Verify BGC Sixorbit forward
      assert.strictEqual(bgcRequests.length, 1);
      const bgcReq = bgcRequests[0];
      assert.strictEqual(bgcReq.method, 'POST');
      assert.strictEqual(bgcReq.url, '/sixorbit');
      assert.strictEqual(bgcReq.headers['authorization'], `Bearer ${BGC_TOKEN}`);
      assert.strictEqual(bgcReq.headers['content-type'], 'application/json');
      assert.strictEqual(bgcReq.body.AuthToken, undefined, 'AuthToken must be stripped');
      assert.deepStrictEqual(bgcReq.body.data, { metric: 'temperature', reading: 22 });

      // Verify SEMPL ERPNext forward
      assert.strictEqual(semplRequests.length, 1);
      const semplReq = semplRequests[0];
      assert.strictEqual(semplReq.method, 'POST');
      assert.strictEqual(semplReq.url, '/erpnext');
      assert.strictEqual(semplReq.headers['authorization'], `token ${SEMPL_KEY}:${SEMPL_SECRET}`);
      assert.strictEqual(semplReq.headers['content-type'], 'application/json');
      assert.strictEqual(semplReq.body.AuthToken, undefined, 'AuthToken must be stripped');
      assert.deepStrictEqual(semplReq.body.data, { metric: 'temperature', reading: 22 });

      // Check success logs
      assert.ok(splitterLogs.includes('Sixorbit'), 'Logs should contain "Sixorbit" success');
      assert.ok(splitterLogs.includes('ERPNext') || splitterLogs.includes('SEMPL'), 'Logs should contain "SEMPL/ERPNext" success');
    });

    // ==========================================
    // TIER 4: Concurrency Isolation & Resilient Error Handling
    // ==========================================

    await testCase('Tier 4 - Concurrency Isolation (One target slow)', async () => {
      bgcServerConfig.delay = 1000; // BGC is slow (1s delay)
      semplServerConfig.delay = 0;   // SEMPL is fast

      const startTime = Date.now();
      const response = await postWebhook({
        AuthToken: CAMS_AUTH_TOKEN,
        data: { test: 'isolation' }
      });
      const duration = Date.now() - startTime;

      assert.strictEqual(response.statusCode, 200);
      assert.ok(duration < 50, `Immediate response took ${duration}ms, should be < 50ms`);

      // Wait a short duration, check if SEMPL got it immediately
      await sleep(100);
      assert.strictEqual(semplRequests.length, 1, 'SEMPL should have received the payload immediately');
      assert.strictEqual(bgcRequests.length, 0, 'BGC should not have received it yet due to delay');

      // Wait for BGC to receive and respond
      await sleep(1000);
      assert.strictEqual(bgcRequests.length, 1, 'BGC should receive it after delay');
    });

    await testCase('Tier 4 - Concurrency Isolation & Error Handling (One target offline/error)', async () => {
      bgcServerConfig.status = 500; // BGC returns 500
      semplServerConfig.status = 200; // SEMPL returns 200

      // Reset logs for clean verification
      const logStartIndex = splitterLogs.length;

      const startTime = Date.now();
      const response = await postWebhook({
        AuthToken: CAMS_AUTH_TOKEN,
        data: { test: 'error_resilience' }
      });
      const duration = Date.now() - startTime;

      assert.strictEqual(response.statusCode, 200);
      assert.ok(duration < 50);

      // Wait for forward attempts
      await sleep(300);

      assert.strictEqual(bgcRequests.length, 1, 'BGC forward should be attempted');
      assert.strictEqual(semplRequests.length, 1, 'SEMPL forward should be attempted and succeed');

      // Get new logs
      const newLogs = splitterLogs.substring(logStartIndex);

      // Verify failure of BGC and success of SEMPL are logged
      assert.ok(
        newLogs.includes('Sixorbit') && (newLogs.toLowerCase().includes('fail') || newLogs.includes('500')),
        'Logs should contain BGC Sixorbit failure/error message'
      );
      assert.ok(
        newLogs.includes('ERPNext') || newLogs.includes('SEMPL'),
        'Logs should contain SEMPL/ERPNext success message'
      );

      // Verify splitter remains healthy and didn't crash
      const checkResponse = await postWebhook({
        AuthToken: CAMS_AUTH_TOKEN,
        data: { test: 'still_alive' }
      });
      assert.strictEqual(checkResponse.statusCode, 200);
    });

  } finally {
    console.log('\n--- Shutting Down ---');
    splitterProcess.kill();
    bgcServer.close();
    semplServer.close();
    console.log('Cleanup complete.');
  }

  console.log(`\nTest Summary: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Fatal error during test run:', err);
  process.exit(1);
});
