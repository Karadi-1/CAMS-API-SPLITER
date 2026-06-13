/**
 * Adversarial and Stress Tests for CAMS API Splitter
 * Verifies edge cases, memory limits, and protocol validation.
 */

const http = require('http');
const { spawn } = require('child_process');
const assert = require('assert');

const SPLITTER_PORT = 14000;
const SIXORBIT_PORT = 14001;
const ERPNEXT_PORT = 14002;

const mockSixorbit = {
  server: null,
  requests: [],
  responseSize: 0, // if > 0, return large response body
  statusCode: 200,
};

const mockErpnext = {
  server: null,
  requests: [],
  statusCode: 200,
};

let splitterProcess = null;

function resetMockStates() {
  mockSixorbit.requests = [];
  mockSixorbit.responseSize = 0;
  mockSixorbit.statusCode = 200;

  mockErpnext.requests = [];
  mockErpnext.statusCode = 200;
}

async function startMockServers() {
  const createMockServer = (state, port) => {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let body = '';
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
            body: parsedBody
          });

          res.writeHead(state.statusCode, { 'Content-Type': 'application/json' });
          if (state.responseSize > 0) {
            // Generate a large dummy response string
            const largeData = 'A'.repeat(state.responseSize);
            res.end(JSON.stringify({ status: 'success', data: largeData }));
          } else {
            res.end(JSON.stringify({ status: 'success' }));
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
    createMockServer(mockSixorbit, SIXORBIT_PORT),
    createMockServer(mockErpnext, ERPNEXT_PORT)
  ]);
}

function stopMockServers() {
  if (mockSixorbit.server) mockSixorbit.server.close();
  if (mockErpnext.server) mockErpnext.server.close();
}

function startSplitterServer(envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: SPLITTER_PORT,
      CAMS_AUTH_TOKEN: 'valid_cams_token',
      BGC_SIXORBIT_URL: `http://localhost:${SIXORBIT_PORT}/sixorbit`,
      BGC_SIXORBIT_TOKEN: 'sixorbit_secret_token',
      SEMPL_ERPNEXT_URL: `http://localhost:${ERPNEXT_PORT}/erpnext`,
      SEMPL_ERPNEXT_API_KEY: 'erpnext_api_key',
      SEMPL_ERPNEXT_API_SECRET: 'erpnext_api_secret',
      ...envOverrides
    };

    splitterProcess = spawn('node', ['server.js'], { env });

    splitterProcess.stdout.on('data', (data) => {
      // console.log(`[Splitter STDOUT]: ${data}`);
    });

    splitterProcess.stderr.on('data', (data) => {
      // console.error(`[Splitter STDERR]: ${data}`);
    });

    splitterProcess.on('error', (err) => {
      reject(err);
    });

    setTimeout(resolve, 300);
  });
}

function stopSplitterServer() {
  if (splitterProcess) {
    splitterProcess.kill();
    splitterProcess = null;
  }
}

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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runAdversarialTests() {
  console.log('\n=== Starting Adversarial & Stress Tests ===\n');

  // Test 1: Memory / Large Payload (DoS check)
  console.log('Test 1: Sending large payload (10MB)...');
  resetMockStates();
  const largePayload = {
    AuthToken: 'valid_cams_token',
    data: {
      event: 'biometric_punch',
      largeField: 'B'.repeat(10 * 1024 * 1024) // 10MB
    }
  };
  const startMem = process.memoryUsage().heapUsed;
  const res1 = await postWebhook(largePayload);
  const endMem = process.memoryUsage().heapUsed;
  assert.strictEqual(res1.statusCode, 200);
  console.log(`  -> Large payload accepted. Memory delta in runner: ${Math.round((endMem - startMem) / 1024 / 1024)} MB`);
  await sleep(500);
  assert.strictEqual(mockSixorbit.requests.length, 1);
  assert.strictEqual(mockSixorbit.requests[0].body.data.largeField.length, 10 * 1024 * 1024);
  console.log('✅ Test 1 Passed (Server accepted and forwarded large payload, but memory buffering is unbounded!)\n');

  // Test 2: Unbounded Downstream Response Buffering
  console.log('Test 2: Mock server returning large response (10MB)...');
  resetMockStates();
  mockSixorbit.responseSize = 10 * 1024 * 1024; // 10MB response size
  const res2 = await postWebhook({
    AuthToken: 'valid_cams_token',
    data: { check: 'large_response' }
  });
  assert.strictEqual(res2.statusCode, 200);
  await sleep(1000); // Allow time for forward and response reading
  assert.strictEqual(mockSixorbit.requests.length, 1);
  console.log('✅ Test 2 Passed (Server handles large downstream responses, but buffers it entirely in memory!)\n');

  // Test 3: Invalid Protocol Configuration
  console.log('Test 3: Rejecting / handling invalid protocols (ftp://) gracefully...');
  stopSplitterServer();
  await startSplitterServer({
    BGC_SIXORBIT_URL: 'ftp://localhost:14001/sixorbit' // Invalid protocol
  });
  resetMockStates();
  const res3 = await postWebhook({
    AuthToken: 'valid_cams_token',
    data: { check: 'ftp_protocol' }
  });
  assert.strictEqual(res3.statusCode, 200);
  await sleep(200);
  // ERPNext should still receive the request successfully
  assert.strictEqual(mockErpnext.requests.length, 1);
  console.log('✅ Test 3 Passed (Splitter did not crash and successfully forwarded to ERPNext)\n');

  // Test 4: Missing CAMS_AUTH_TOKEN in environment
  console.log('Test 4: Behavior when CAMS_AUTH_TOKEN is not set in environment...');
  stopSplitterServer();
  await startSplitterServer({
    CAMS_AUTH_TOKEN: '' // Not set
  });
  resetMockStates();
  const res4 = await postWebhook({
    AuthToken: 'valid_cams_token',
    data: { check: 'no_auth_env' }
  });
  assert.strictEqual(res4.statusCode, 200);
  await sleep(200);
  // Should NOT forward since no token matches
  assert.strictEqual(mockSixorbit.requests.length, 0);
  assert.strictEqual(mockErpnext.requests.length, 0);
  console.log('✅ Test 4 Passed (Requests blocked when token env is missing)\n');

  // Test 5: Concurrency and Load Stress (50 concurrent requests)
  console.log('Test 5: Sending 50 concurrent requests...');
  stopSplitterServer();
  await startSplitterServer(); // Reset normal env
  resetMockStates();
  
  const promises = [];
  for (let i = 0; i < 50; i++) {
    promises.push(postWebhook({
      AuthToken: 'valid_cams_token',
      data: { index: i }
    }));
  }

  const responses = await Promise.all(promises);
  responses.forEach(r => {
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { status: 'done' });
  });

  await sleep(1000); // Wait for all forwards to finish
  assert.strictEqual(mockSixorbit.requests.length, 50);
  assert.strictEqual(mockErpnext.requests.length, 50);
  console.log('✅ Test 5 Passed (Concurrency handled correctly)\n');

  console.log('🎉 All Adversarial and Stress Tests Completed!');
}

(async () => {
  try {
    await startMockServers();
    await startSplitterServer();
    await runAdversarialTests();
  } catch (error) {
    console.error('❌ Adversarial Tests Failed:', error);
    process.exitCode = 1;
  } finally {
    stopSplitterServer();
    stopMockServers();
  }
})();
