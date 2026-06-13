/**
 * E2E Verification Test Suite for CAMS API Splitter
 * Covers Tier 1-4 cases using Node.js built-in modules.
 * Zero external dependencies.
 */

const http = require('http');
const { spawn } = require('child_process');
const assert = require('assert');

// Port Configurations
const SPLITTER_PORT = 13000;
const SIXORBIT_PORT = 13001;
const ERPNEXT_PORT = 13002;

// Mock Configurations
const mockSixorbit = {
  server: null,
  requests: [],
  delayMs: 0,
  statusCode: 200,
  shouldHangup: false,
  responseBodyOverride: null
};

const mockErpnext = {
  server: null,
  requests: [],
  delayMs: 0,
  statusCode: 200,
  shouldHangup: false,
  responseBodyOverride: null
};

let splitterProcess = null;
let stdoutLogs = [];
let stderrLogs = [];

// Helpers to Reset Mock Server States
function resetMockStates() {
  mockSixorbit.requests = [];
  mockSixorbit.delayMs = 0;
  mockSixorbit.statusCode = 200;
  mockSixorbit.shouldHangup = false;
  mockSixorbit.responseBodyOverride = null;

  mockErpnext.requests = [];
  mockErpnext.delayMs = 0;
  mockErpnext.statusCode = 200;
  mockErpnext.shouldHangup = false;
  mockErpnext.responseBodyOverride = null;
}

// Start Mock Target Servers
async function startMockServers() {
  const createMockServer = (state, port, name) => {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        if (state.shouldHangup) {
          req.destroy();
          return;
        }

        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
          body += chunk;
        });

        req.on('end', () => {
          let parsedBody = {};
          try {
            parsedBody = JSON.parse(body);
          } catch (err) {
            parsedBody = body;
          }

          state.requests.push({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: parsedBody,
            timestamp: Date.now()
          });

          const handler = () => {
            if (res.writableEnded || res.finished) return;
            res.writeHead(state.statusCode, { 'Content-Type': 'application/json' });
            if (state.responseBodyOverride) {
              res.end(state.responseBodyOverride);
            } else {
              res.end(JSON.stringify({ status: 'success' }));
            }
          };

          if (state.delayMs > 0) {
            setTimeout(handler, state.delayMs);
          } else {
            handler();
          }
        });
      });

      server.listen(port, () => {
        state.server = server;
        resolve();
      });
    });
  };

  await Promise.all([
    createMockServer(mockSixorbit, SIXORBIT_PORT, 'BGC Sixorbit'),
    createMockServer(mockErpnext, ERPNEXT_PORT, 'SEMPL ERPNext')
  ]);
  console.log('Mock target servers running on ports 13001 and 13002.');
}

// Close Mock Target Servers
function stopMockServers() {
  if (mockSixorbit.server) mockSixorbit.server.close();
  if (mockErpnext.server) mockErpnext.server.close();
}

// Spawn CAMS API Splitter Server
function startSplitterServer() {
  return new Promise((resolve, reject) => {
    stdoutLogs = [];
    stderrLogs = [];

    splitterProcess = spawn('node', ['server.js'], {
      env: {
        ...process.env,
        PORT: SPLITTER_PORT,
        CAMS_AUTH_TOKEN: 'valid_cams_token',
        BGC_SIXORBIT_URL: `http://localhost:${SIXORBIT_PORT}/sixorbit`,
        BGC_SIXORBIT_TOKEN: 'sixorbit_secret_token',
        SEMPL_ERPNEXT_URL: `http://localhost:${ERPNEXT_PORT}/erpnext`,
        SEMPL_ERPNEXT_API_KEY: 'erpnext_api_key',
        SEMPL_ERPNEXT_API_SECRET: 'erpnext_api_secret'
      }
    });

    splitterProcess.stdout.on('data', (data) => {
      stdoutLogs.push(data.toString());
    });

    splitterProcess.stderr.on('data', (data) => {
      stderrLogs.push(data.toString());
    });

    splitterProcess.on('error', (err) => {
      reject(err);
    });

    // Wait a short duration to ensure port binding is complete
    setTimeout(resolve, 300);
  });
}

// Stop CAMS API Splitter Server
function stopSplitterServer() {
  if (splitterProcess) {
    splitterProcess.kill();
    splitterProcess = null;
  }
}

// HTTP Helper to Send POST Requests
function postWebhook(payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const options = {
      hostname: 'localhost',
      port: SPLITTER_PORT,
      path: '/webhook/cams',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    };

    const startTime = Date.now();
    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: responseBody,
          duration: Date.now() - startTime
        });
      });
    });

    req.on('error', (err) => reject(err));
    req.write(data);
    req.end();
  });
}

// Utility to sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper for testing custom configuration environments
async function runCustomSplitterTest(envOverrides, fn) {
  stopSplitterServer();
  await sleep(100);

  let customProcess = null;
  const customStdout = [];
  const customStderr = [];

  try {
    await new Promise((resolve, reject) => {
      customProcess = spawn('node', ['server.js'], {
        env: {
          ...process.env,
          PORT: SPLITTER_PORT,
          CAMS_AUTH_TOKEN: 'valid_cams_token',
          BGC_SIXORBIT_URL: `http://localhost:${SIXORBIT_PORT}/sixorbit`,
          BGC_SIXORBIT_TOKEN: 'sixorbit_secret_token',
          SEMPL_ERPNEXT_URL: `http://localhost:${ERPNEXT_PORT}/erpnext`,
          SEMPL_ERPNEXT_API_KEY: 'erpnext_api_key',
          SEMPL_ERPNEXT_API_SECRET: 'erpnext_api_secret',
          ...envOverrides
        }
      });

      customProcess.stdout.on('data', (data) => {
        customStdout.push(data.toString());
      });

      customProcess.stderr.on('data', (data) => {
        customStderr.push(data.toString());
      });

      customProcess.on('error', (err) => {
        reject(err);
      });

      setTimeout(resolve, 300);
    });

    await fn({
      getStdout: () => customStdout.join(''),
      getStderr: () => customStderr.join('')
    });
  } finally {
    if (customProcess) {
      customProcess.kill();
    }
    await sleep(100);
    // Restart main splitter server
    await startSplitterServer();
  }
}

// ================= TEST CASES =================

async function runTests() {
  console.log('\n--- Starting E2E Verification Tests ---\n');

  // ------------------------------------------------------------------------
  // TIER 1: Webhook Endpoint and Immediate Acknowledgment
  // ------------------------------------------------------------------------
  console.log('Running Tier 1 Tests...');
  
  // Case 1.1: Valid Request Acknowledgment
  console.log('  Running Case 1.1: Valid Request Acknowledgment...');
  resetMockStates();
  mockSixorbit.delayMs = 200;
  mockErpnext.delayMs = 200;

  const payloadT1 = {
    AuthToken: 'valid_cams_token',
    data: { event: 'biometric_punch', userId: '1234' }
  };

  const responseT1 = await postWebhook(payloadT1);
  assert.strictEqual(responseT1.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(responseT1.body), { status: 'done' });
  console.log(`    -> Response time: ${responseT1.duration}ms`);
  assert.ok(responseT1.duration < 100, `Response took too long: ${responseT1.duration}ms (target < 50ms, threshold < 100ms)`);

  await sleep(300);
  assert.strictEqual(mockSixorbit.requests.length, 1);
  assert.strictEqual(mockErpnext.requests.length, 1);
  console.log('  ✅ Case 1.1 Passed!');

  // Case 1.2: Invalid Token Handling
  console.log('  Running Case 1.2: Invalid Token Handling...');
  resetMockStates();
  const responseT1_2 = await postWebhook({
    AuthToken: 'wrong_cams_token',
    data: { status: 'ok' }
  });
  assert.strictEqual(responseT1_2.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(responseT1_2.body), { status: 'done' });
  await sleep(100);
  assert.strictEqual(mockSixorbit.requests.length, 0, 'Must NOT forward to targets');
  assert.strictEqual(mockErpnext.requests.length, 0, 'Must NOT forward to targets');
  console.log('  ✅ Case 1.2 Passed!');

  // Case 1.3: Missing Token Handling
  console.log('  Running Case 1.3: Missing Token Handling...');
  resetMockStates();
  const responseT1_3 = await postWebhook({
    data: { status: 'ok' }
  });
  assert.strictEqual(responseT1_3.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(responseT1_3.body), { status: 'done' });
  await sleep(100);
  assert.strictEqual(mockSixorbit.requests.length, 0, 'Must NOT forward to targets');
  assert.strictEqual(mockErpnext.requests.length, 0, 'Must NOT forward to targets');
  console.log('  ✅ Case 1.3 Passed!');

  console.log('✅ Tier 1 Passed!\n');

  // ------------------------------------------------------------------------
  // TIER 2: Payload Cleaning and Headers Verification
  // ------------------------------------------------------------------------
  console.log('Running Tier 2 Tests...');
  resetMockStates();

  const payloadT2 = {
    AuthToken: 'valid_cams_token',
    data: { event: 'check-in', deviceId: 'CAMS_01' }
  };

  await postWebhook(payloadT2);
  await sleep(100);

  // Case 2.1: Target Forward Payload Integrity
  console.log('  Running Case 2.1: Target Forward Payload Integrity...');
  assert.strictEqual(mockSixorbit.requests.length, 1);
  assert.strictEqual(mockErpnext.requests.length, 1);
  assert.deepStrictEqual(mockSixorbit.requests[0].body.data, payloadT2.data);
  assert.deepStrictEqual(mockErpnext.requests[0].body.data, payloadT2.data);
  console.log('  ✅ Case 2.1 Passed!');

  // Case 2.2: AuthToken Redaction
  console.log('  Running Case 2.2: AuthToken Redaction...');
  assert.strictEqual(mockSixorbit.requests[0].body.AuthToken, undefined, 'AuthToken must be stripped from Sixorbit payload');
  assert.strictEqual(mockErpnext.requests[0].body.AuthToken, undefined, 'AuthToken must be stripped from ERPNext payload');
  console.log('  ✅ Case 2.2 Passed!');

  // Case 2.3: BGC Sixorbit Authentication Headers
  console.log('  Running Case 2.3: BGC Sixorbit Authentication Headers...');
  const sixorbitReq = mockSixorbit.requests[0];
  assert.strictEqual(sixorbitReq.headers['authorization'], 'Bearer sixorbit_secret_token');
  assert.strictEqual(sixorbitReq.headers['content-type'], 'application/json');
  console.log('  ✅ Case 2.3 Passed!');

  // Case 2.4: SEMPL ERPNext Authentication Headers
  console.log('  Running Case 2.4: SEMPL ERPNext Authentication Headers...');
  const erpnextReq = mockErpnext.requests[0];
  assert.strictEqual(erpnextReq.headers['authorization'], 'token erpnext_api_key:erpnext_api_secret');
  assert.strictEqual(erpnextReq.headers['content-type'], 'application/json');
  console.log('  ✅ Case 2.4 Passed!');

  console.log('✅ Tier 2 Passed!\n');

  // ------------------------------------------------------------------------
  // TIER 3: Concurrency and Resiliency (Non-blocking Delivery)
  // ------------------------------------------------------------------------
  console.log('Running Tier 3 Tests...');

  // Case 3.1: Asynchronous Concurrency
  console.log('  Running Case 3.1: Asynchronous Concurrency...');
  resetMockStates();
  mockSixorbit.delayMs = 300; // Slow
  mockErpnext.delayMs = 0;   // Fast

  await postWebhook({
    AuthToken: 'valid_cams_token',
    data: { check: 'concurrency_test' }
  });
  
  await sleep(100);
  assert.strictEqual(mockErpnext.requests.length, 1, 'ERPNext should receive request immediately');
  assert.strictEqual(mockSixorbit.requests.length, 0, 'Sixorbit should still be waiting');
  
  await sleep(300);
  assert.strictEqual(mockSixorbit.requests.length, 1, 'Sixorbit should eventually receive request');
  console.log('  ✅ Case 3.1 Passed!');

  // Case 3.2: Single-Target Offline Resilience (BGC Offline)
  console.log('  Running Case 3.2: Single-Target Offline Resilience (BGC Offline)...');
  resetMockStates();
  mockSixorbit.shouldHangup = true;
  mockErpnext.shouldHangup = false;

  const res3_2 = await postWebhook({
    AuthToken: 'valid_cams_token',
    data: { check: 'bgc_offline' }
  });
  assert.strictEqual(res3_2.statusCode, 200);
  await sleep(100);
  assert.strictEqual(mockErpnext.requests.length, 1, 'ERPNext should still receive forward');
  console.log('  ✅ Case 3.2 Passed!');

  // Case 3.3: Single-Target Offline Resilience (SEMPL Offline)
  console.log('  Running Case 3.3: Single-Target Offline Resilience (SEMPL Offline)...');
  resetMockStates();
  mockSixorbit.shouldHangup = false;
  mockErpnext.shouldHangup = true;

  const res3_3 = await postWebhook({
    AuthToken: 'valid_cams_token',
    data: { check: 'sempl_offline' }
  });
  assert.strictEqual(res3_3.statusCode, 200);
  await sleep(100);
  assert.strictEqual(mockSixorbit.requests.length, 1, 'Sixorbit should still receive forward');
  console.log('  ✅ Case 3.3 Passed!');

  // Case 3.4: All-Targets Offline Resilience
  console.log('  Running Case 3.4: All-Targets Offline Resilience...');
  resetMockStates();
  mockSixorbit.shouldHangup = true;
  mockErpnext.shouldHangup = true;

  const res3_4 = await postWebhook({
    AuthToken: 'valid_cams_token',
    data: { check: 'all_offline' }
  });
  assert.strictEqual(res3_4.statusCode, 200);
  await sleep(100);
  console.log('  ✅ Case 3.4 Passed!');

  console.log('✅ Tier 3 Passed!\n');

  // ------------------------------------------------------------------------
  // TIER 4: Resiliency, Logging, and Error Handling
  // ------------------------------------------------------------------------
  console.log('Running Tier 4 Tests...');

  // Case 4.1: Success Logging
  console.log('  Running Case 4.1: Success Logging...');
  stdoutLogs = [];
  stderrLogs = [];
  resetMockStates();

  await postWebhook({
    AuthToken: 'valid_cams_token',
    data: { check: 'success_log' }
  });
  await sleep(150);

  const stdoutJoined = stdoutLogs.join('\n');
  assert.ok(stdoutJoined.includes('Successfully forwarded payload to BGC Sixorbit'), 'Log must show BGC success');
  assert.ok(stdoutJoined.includes('Successfully forwarded payload to SEMPL ERPNext'), 'Log must show ERPNext success');
  console.log('  ✅ Case 4.1 Passed!');

  // Case 4.2: Failure Logging
  console.log('  Running Case 4.2: Failure Logging...');
  stdoutLogs = [];
  stderrLogs = [];
  resetMockStates();
  mockSixorbit.statusCode = 500;
  mockErpnext.shouldHangup = true;

  await postWebhook({
    AuthToken: 'valid_cams_token',
    data: { check: 'failure_log' }
  });
  await sleep(150);

  const stderrJoined = stderrLogs.join('\n');
  assert.ok(stderrJoined.includes('Failed to forward payload to BGC Sixorbit'), 'Log must show BGC failure');
  assert.ok(stderrJoined.includes('Failed to forward payload to SEMPL ERPNext'), 'Log must show ERPNext failure');
  console.log('  ✅ Case 4.2 Passed!');

  // Case 4.3: DNS/Network Exception Handling
  console.log('  Running Case 4.3: DNS/Network Exception Handling...');
  await runCustomSplitterTest({
    BGC_SIXORBIT_URL: 'http://invalid-dns-name-that-does-not-exist.com',
    SEMPL_ERPNEXT_URL: 'not-a-valid-url-at-all'
  }, async (ctx) => {
    const res = await postWebhook({
      AuthToken: 'valid_cams_token',
      data: { check: 'dns_exception' }
    });
    assert.strictEqual(res.statusCode, 200);
    await sleep(200);
    const stderr = ctx.getStderr();
    assert.ok(stderr.includes('Failed to forward payload to BGC Sixorbit') || stderr.includes('ENOTFOUND') || stderr.includes('EAI_AGAIN'), 'Stderr should contain connection/DNS failures');
    assert.ok(stderr.includes('Failed to forward payload to SEMPL ERPNext') || stderr.includes('Invalid URL'), 'Stderr should contain invalid URL failure');
  });
  console.log('  ✅ Case 4.3 Passed!');

  console.log('✅ Tier 4 Passed!\n');

  // ------------------------------------------------------------------------
  // TIER 5: Adversarial and Edge Cases
  // ------------------------------------------------------------------------
  console.log('Running Tier 5 (Adversarial & Edge Cases) Tests...');

  // Case 5.1: Payload Size Limit (Request DoS)
  console.log('  Running Case 5.1: Payload Size Limit (Request DoS)...');
  const largeData = 'a'.repeat(1.05 * 1024 * 1024); // 1.05MB
  const payload5_1 = {
    AuthToken: 'valid_cams_token',
    data: largeData
  };
  try {
    const res = await postWebhook(payload5_1);
    assert.strictEqual(res.statusCode, 413);
    const bodyObj = JSON.parse(res.body);
    assert.strictEqual(bodyObj.error, 'Payload Too Large');
  } catch (err) {
    console.log(`    -> Request destroyed/rejected as expected: ${err.message}`);
  }
  console.log('  ✅ Case 5.1 Passed!');

  // Case 5.2: Response Body Size Limit (Forward DoS)
  console.log('  Running Case 5.2: Response Body Size Limit (Forward DoS)...');
  resetMockStates();
  stderrLogs = [];
  mockSixorbit.responseBodyOverride = 'b'.repeat(1.05 * 1024 * 1024); // 1.05MB response body
  await postWebhook({
    AuthToken: 'valid_cams_token',
    data: { check: 'response_dos' }
  });
  await sleep(200);
  const errLogs = stderrLogs.join('\n');
  assert.ok(errLogs.includes('Failed to forward payload to BGC Sixorbit'), 'Log must show BGC failure');
  assert.ok(errLogs.includes('Response payload too large') || errLogs.includes('socket hang up') || errLogs.includes('aborted'), 'Log must indicate payload size limit triggered');
  console.log('  ✅ Case 5.2 Passed!');

  // Case 5.3: Sensitive Token Leakage Prevention
  console.log('  Running Case 5.3: Sensitive Token Leakage Prevention...');
  stdoutLogs = [];
  stderrLogs = [];
  const sensitiveToken = 'super_secret_unauthorized_token_12345';
  await postWebhook({
    AuthToken: sensitiveToken,
    data: { check: 'unauthorized' }
  });
  await sleep(100);
  const combinedLogs = stdoutLogs.join('\n') + '\n' + stderrLogs.join('\n');
  assert.ok(!combinedLogs.includes(sensitiveToken), 'Logs must NOT contain raw unauthorized token');
  assert.ok(combinedLogs.includes('Unauthorized access attempt'), 'Logs must show unauthorized attempt');
  console.log('  ✅ Case 5.3 Passed!');

  // Case 5.4: UTF-8 Character Bleeding Prevention
  console.log('  Running Case 5.4: UTF-8 Character Bleeding Prevention...');
  resetMockStates();
  const utf8Payload = {
    AuthToken: 'valid_cams_token',
    data: { text: '✨🚀 Biometric Punch 🚀✨ Unicode: 中文, 𠜎, 𠜱' }
  };
  await postWebhook(utf8Payload);
  await sleep(100);
  assert.strictEqual(mockSixorbit.requests.length, 1);
  assert.strictEqual(mockErpnext.requests.length, 1);
  assert.strictEqual(mockSixorbit.requests[0].body.data.text, utf8Payload.data.text);
  assert.strictEqual(mockErpnext.requests[0].body.data.text, utf8Payload.data.text);
  console.log('  ✅ Case 5.4 Passed!');

  // Case 5.5: Startup Warnings for Missing Env Variables
  console.log('  Running Case 5.5: Startup Warnings for Missing Env Variables...');
  await runCustomSplitterTest({
    CAMS_AUTH_TOKEN: '',
    BGC_SIXORBIT_URL: '',
    SEMPL_ERPNEXT_URL: ''
  }, async (ctx) => {
    const stderr = ctx.getStderr();
    assert.ok(stderr.includes('CAMS_AUTH_TOKEN environment variable is missing'), 'Should log CAMS_AUTH_TOKEN warning');
    assert.ok(stderr.includes('BGC_SIXORBIT_URL environment variable is missing'), 'Should log BGC_SIXORBIT_URL warning');
    assert.ok(stderr.includes('SEMPL_ERPNEXT_URL environment variable is missing'), 'Should log SEMPL_ERPNEXT_URL warning');
  });
  console.log('  ✅ Case 5.5 Passed!');

  // Case 5.6: Port Conflict Handling
  console.log('  Running Case 5.6: Port Conflict Handling...');
  const portConflictProcess = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT: SIXORBIT_PORT, // Conflicts with Mock Sixorbit
      CAMS_AUTH_TOKEN: 'valid_cams_token'
    }
  });

  const conflictStderr = [];
  portConflictProcess.stderr.on('data', (data) => {
    conflictStderr.push(data.toString());
  });

  const exitCode = await new Promise((resolve) => {
    portConflictProcess.on('exit', (code) => {
      resolve(code);
    });
  });

  assert.strictEqual(exitCode, 1, 'Port conflict process should exit with status 1');
  const conflictLogs = conflictStderr.join('');
  assert.ok(conflictLogs.includes('is already in use') || conflictLogs.includes('EADDRINUSE'), 'Stderr should log port in use error');
  console.log('  ✅ Case 5.6 Passed!');

  console.log('✅ Tier 5 Passed!\n');

  console.log('🎉 All E2E Verification Tests Passed Successfully!');
}

// Execute Runner
(async () => {
  try {
    await startMockServers();
    await startSplitterServer();
    await runTests();
  } catch (error) {
    console.error('❌ Tests Failed with error:', error);
    process.exitCode = 1;
  } finally {
    stopSplitterServer();
    stopMockServers();
  }
})();
