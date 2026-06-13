/**
 * Adversarial Test Suite for CAMS API Splitter
 * Focuses on edge cases, race conditions, error handling, and robustness.
 * Zero external dependencies.
 */

const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const assert = require('assert');

// Port Configurations
const SPLITTER_PORT = 14000;
const SIXORBIT_PORT = 14001;
const ERPNEXT_PORT = 14002;

// Mock Configurations
const mockSixorbit = {
  server: null,
  requests: [],
  onReceive: null,
};

const mockErpnext = {
  server: null,
  requests: [],
  onReceive: null,
};

let splitterProcess = null;
let splitterLogs = [];

function resetMockStates() {
  mockSixorbit.requests = [];
  mockSixorbit.onReceive = null;
  mockErpnext.requests = [];
  mockErpnext.onReceive = null;
  splitterLogs = [];
}

// Start Mock Target Servers
function startMockServers() {
  return new Promise((resolve) => {
    const createServer = (state, port) => {
      return http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          let parsedBody = body;
          try { parsedBody = JSON.parse(body); } catch (e) {}

          state.requests.push({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: parsedBody
          });

          if (state.onReceive) {
            state.onReceive(req, res, parsedBody);
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          }
        });
      });
    };

    mockSixorbit.server = createServer(mockSixorbit, SIXORBIT_PORT);
    mockErpnext.server = createServer(mockErpnext, ERPNEXT_PORT);

    mockSixorbit.server.listen(SIXORBIT_PORT, () => {
      mockErpnext.server.listen(ERPNEXT_PORT, () => {
        resolve();
      });
    });
  });
}

function stopMockServers() {
  if (mockSixorbit.server) mockSixorbit.server.close();
  if (mockErpnext.server) mockErpnext.server.close();
}

// Spawn Splitter Server
function startSplitterServer() {
  return new Promise((resolve, reject) => {
    splitterProcess = spawn('node', ['server.js'], {
      env: {
        ...process.env,
        PORT: SPLITTER_PORT,
        CAMS_AUTH_TOKEN: 'adversarial_cams_token',
        BGC_SIXORBIT_URL: `http://localhost:${SIXORBIT_PORT}/sixorbit`,
        BGC_SIXORBIT_TOKEN: 'sixorbit_secret',
        SEMPL_ERPNEXT_URL: `http://localhost:${ERPNEXT_PORT}/erpnext`,
        SEMPL_ERPNEXT_API_KEY: 'erpnext_key',
        SEMPL_ERPNEXT_API_SECRET: 'erpnext_secret'
      }
    });

    splitterProcess.stdout.on('data', (data) => {
      const log = data.toString();
      splitterLogs.push(log);
      // console.log(`[Splitter STDOUT]: ${log.trim()}`);
    });

    splitterProcess.stderr.on('data', (data) => {
      const log = data.toString();
      splitterLogs.push(log);
      console.error(`[Splitter STDERR]: ${log.trim()}`);
    });

    splitterProcess.on('error', reject);
    setTimeout(resolve, 500);
  });
}

function stopSplitterServer() {
  if (splitterProcess) {
    splitterProcess.kill();
  }
}

// Helper: Post to Splitter
function postToSplitter(payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
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
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function runAdversarialTests() {
  console.log('\n=== Starting Adversarial Verification Suite ===\n');

  let passed = 0;
  let failed = 0;

  const runTest = async (name, testFn) => {
    console.log(`Running: ${name}...`);
    try {
      resetMockStates();
      await testFn();
      console.log(`  -> Pass ✅`);
      passed++;
    } catch (err) {
      console.error(`  -> Fail ❌`);
      console.error(err);
      failed++;
    }
    console.log();
  };

  // Test 1: Malformed JSON inputs
  await runTest('Malformed JSON Payload', async () => {
    const res = await postToSplitter('{"AuthToken": "adversarial_cams_token", "invalid_json": ');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { status: 'done' });
    await sleep(100);
    assert.strictEqual(mockSixorbit.requests.length, 0, 'Should not forward malformed payload');
  });

  // Test 2: Primitive JSON values (null)
  await runTest('Null Payload', async () => {
    const res = await postToSplitter('null');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { status: 'done' });
    await sleep(100);
    assert.strictEqual(mockSixorbit.requests.length, 0);
  });

  // Test 3: Array JSON payload
  await runTest('Array JSON Payload', async () => {
    // Array doesn't have AuthToken, so it is unauthorized. Should not forward.
    const res = await postToSplitter('[1, 2, 3]');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { status: 'done' });
    await sleep(100);
    assert.strictEqual(mockSixorbit.requests.length, 0);
  });

  // Test 4: Array JSON payload with fake structure
  await runTest('Array Payload bypass attempt', async () => {
    // If we send an array, it has no AuthToken, so unauthorized.
    // What if CAMS_AUTH_TOKEN is not configured? (tested in separate spawn test)
    const res = await postToSplitter('[{"AuthToken": "adversarial_cams_token"}]');
    assert.strictEqual(res.statusCode, 200);
    await sleep(100);
    assert.strictEqual(mockSixorbit.requests.length, 0);
  });

  // Test 5: Client abrupt socket destruction during post request body transfer
  await runTest('Client Abrupt Disconnect during Body Transfer', async () => {
    const client = net.connect({ port: SPLITTER_PORT, host: 'localhost' }, () => {
      client.write('POST /webhook/cams HTTP/1.1\r\n');
      client.write('Host: localhost\r\n');
      client.write('Content-Length: 1000\r\n');
      client.write('Content-Type: application/json\r\n\r\n');
      client.write('{"AuthToken": "adversarial_cams_t');
      // Abruptly destroy socket
      setTimeout(() => {
        client.destroy();
      }, 50);
    });

    await sleep(200);
    // Verify splitter is still alive by making a normal request
    const res = await postToSplitter({ AuthToken: 'adversarial_cams_token', data: { alive: true } });
    assert.strictEqual(res.statusCode, 200);
  });

  // Test 6: Target Server Abrupt Disconnect (Mid-Response Error Handling)
  await runTest('Target Server Abrupt Disconnect mid-response', async () => {
    mockSixorbit.onReceive = (req, res, body) => {
      // Send partial headers and destroy socket abruptly
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('{"partial":');
      setTimeout(() => {
        req.socket.destroy();
      }, 50);
    };

    const res = await postToSplitter({ AuthToken: 'adversarial_cams_token', data: { test: 'abrupt_target' } });
    assert.strictEqual(res.statusCode, 200);
    
    // Wait for async forwarding to execute and finish
    await sleep(300);

    // Verify SEMPL ERPNext still got the message and splitter is still running
    assert.strictEqual(mockErpnext.requests.length, 1);
    const normalRes = await postToSplitter({ AuthToken: 'adversarial_cams_token', data: { test: 'still_alive' } });
    assert.strictEqual(normalRes.statusCode, 200);
  });

  // Test 7: Target Server Timeout Handling
  await runTest('Target Server Timeout Handling', async () => {
    // Sixorbit does not respond at all
    mockSixorbit.onReceive = (req, res, body) => {
      // Hang, do not respond. Let timeout handle it.
    };

    const startTime = Date.now();
    const res = await postToSplitter({ AuthToken: 'adversarial_cams_token', data: { test: 'timeout_test' } });
    assert.strictEqual(res.statusCode, 200);
    const duration = Date.now() - startTime;
    assert.ok(duration < 100, `Splitter response should be immediate (was ${duration}ms)`);

    // Let's verify that the splitter doesn't crash.
    await sleep(200);
    // Splitter should still be alive
    const normalRes = await postToSplitter({ AuthToken: 'adversarial_cams_token', data: { test: 'still_alive' } });
    assert.strictEqual(normalRes.statusCode, 200);
  });

  // Test 8: Large payload size (DoS risk verification)
  await runTest('Large Payload DoS Risk', async () => {
    // Generate 5MB payload
    const largeString = 'a'.repeat(5 * 1024 * 1024);
    const payload = {
      AuthToken: 'adversarial_cams_token',
      data: { largeString }
    };

    const startTime = Date.now();
    const res = await postToSplitter(payload);
    const duration = Date.now() - startTime;
    console.log(`  -> Handled 5MB payload in ${duration}ms`);
    assert.strictEqual(res.statusCode, 200);
    await sleep(500);
    // Verify target received it
    assert.strictEqual(mockSixorbit.requests.length, 1);
    assert.strictEqual(mockSixorbit.requests[0].body.data.largeString.length, 5 * 1024 * 1024);
  });

  // Test 9: No Port Conflict handling test
  await runTest('Splitter Port Conflict behavior', async () => {
    // Start another process on same port
    const duplicateProcess = spawn('node', ['server.js'], {
      env: { ...process.env, PORT: SPLITTER_PORT }
    });

    let hadError = false;
    await new Promise((resolve) => {
      duplicateProcess.on('error', () => {
        hadError = true;
        resolve();
      });
      duplicateProcess.stderr.on('data', (data) => {
        hadError = true;
        resolve();
      });
      setTimeout(resolve, 500);
    });

    duplicateProcess.kill();
    assert.ok(hadError, 'Should log error or throw when port is in use');
  });

  console.log(`\n=== Adversarial Suite Completed: ${passed} Passed, ${failed} Failed ===\n`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

// Main Execution
(async () => {
  try {
    await startMockServers();
    await startSplitterServer();
    await runAdversarialTests();
  } catch (err) {
    console.error('Test infrastructure setup failed:', err);
    process.exitCode = 1;
  } finally {
    stopSplitterServer();
    stopMockServers();
  }
})();
