'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const { setup, fixture, sleep, until } = require('./helpers');

test('wrong/missing/object tokens, null and arrays are acknowledged without forwarding or crashing', async t => {
  const ctx = await setup(t);
  for (const data of [fixture({ AuthToken: 'wrong' }), fixture({ AuthToken: { toString: null } }), fixture({ AuthToken: null }), null, [], {}]) {
    assert.deepEqual(await ctx.post(data), { status: 200, body: { status: 'done' } });
  }
  await sleep(30); assert.deepEqual(ctx.states.map(s => s.hits.length), [0, 0]);
  assert.equal((await ctx.post()).status, 200); await until(() => ctx.app.store.summary().counts.delivered === 2);
});

test('ambiguous envelopes and invalid JSON are rejected; non-attendance events are observed and discarded', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.post({ ...fixture(), AuthToken: 'test-cams-secret' })).status, 400);
  assert.equal((await ctx.post('{"bad":')).status, 400);
  assert.equal((await ctx.post(fixture({ PunchLog: null }))).status, 422);
  assert.equal((await ctx.post(fixture(), { 'Content-Type': 'text/plain' })).status, 415);
  const event = fixture(); delete event.RealTime.PunchLog; event.RealTime.Template = [{ Data: 'private-biometric' }];
  assert.equal((await ctx.post(event)).status, 200);
  assert.ok(ctx.logs.some(l => l.reason === 'unsupported_event')); assert.equal(ctx.app.store.summary().counts.pending, 0);
});

test('deep unknown subtrees, prototype keys, credentials and biometrics never survive allowlisting', async t => {
  const ctx = await setup(t);
  let nested = 'nested-auth-secret';
  for (let i = 0; i < 10000; i++) nested = `[${nested.startsWith('[') ? nested : JSON.stringify(nested)}]`;
  const payload = JSON.stringify(fixture()).replace('"PunchLog":', `"__proto__":{"polluted":true},"Templates":${nested},"PunchLog":`);
  assert.equal((await ctx.post(payload)).status, 200);
  await until(() => ctx.app.store.summary().counts.delivered === 2);
  assert.equal({}.polluted, undefined);
  const logs = JSON.stringify(ctx.logs), bodies = JSON.stringify(ctx.states.map(s => s.hits));
  for (const value of ['nested-auth-secret', 'AuthToken', 'polluted', 'Templates', 'test-cams-secret']) {
    assert.ok(!logs.includes(value)); assert.ok(!bodies.includes(value));
  }
  // Successful payloads are removed; even SQLite/WAL pages must never have contained the CAMS token.
  for (const file of fs.readdirSync(ctx.directory)) assert.ok(!fs.readFileSync(require('node:path').join(ctx.directory, file)).includes('test-cams-secret'));
});

test('declared and chunked multibyte bodies enforce received bytes rather than string length', async t => {
  const ctx = await setup(t, { MAX_PAYLOAD_BYTES: '1024' });
  const data = JSON.stringify(fixture({ LabelName: '界'.repeat(400) }));
  assert.ok(data.length < 1024 && Buffer.byteLength(data) > 1024);
  assert.equal((await ctx.post(data)).status, 413);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ctx.app.server.address().port, path: '/webhook/cams', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); const bytes = Buffer.from(data); req.write(bytes.subarray(0, 20)); req.end(bytes.subarray(20));
  });
  assert.equal(status, 413); assert.equal(ctx.app.store.summary().counts.pending, 0);
});

test('abrupt upload disconnect cannot enqueue a partial event or kill the process', async t => {
  const ctx = await setup(t);
  const socket = net.connect(ctx.app.server.address().port, '127.0.0.1'); await new Promise(resolve => socket.once('connect', resolve));
  socket.write('POST /webhook/cams HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 10000\r\n\r\n{"RealTime":');
  socket.destroy(); await sleep(30); assert.equal(ctx.app.store.summary().counts.pending, 0);
  assert.equal((await ctx.post()).status, 200); await until(() => ctx.app.store.summary().counts.delivered === 2);
});

test('drip-fed response exceeds total deadline, retries exhaust, and peer still succeeds', async t => {
  const ctx = await setup(t, { DELIVERY_TIMEOUT_MS: '80' });
  ctx.states[0].handle = (req, res) => {
    res.writeHead(200); res.write(' '); const timer = setInterval(() => res.write(' '), 15); res.on('close', () => clearInterval(timer));
  };
  const start = Date.now(); await ctx.post(); await until(() => ctx.app.store.summary().counts.dead === 1);
  assert.ok(Date.now() - start < 1500); assert.equal(ctx.states[0].hits.length, 3); assert.equal(ctx.states[1].hits.length, 1);
  assert.equal(ctx.app.store.dead()[0].error, 'delivery_timeout');
});

test('aborted downstream response retries and cannot block the peer', async t => {
  const ctx = await setup(t);
  ctx.states[0].handle = (req, res) => { res.writeHead(200, { 'Content-Length': '100' }); res.write('{'); setTimeout(() => res.destroy(), 5); };
  await ctx.post(); await until(() => ctx.app.store.summary().counts.dead === 1);
  assert.equal(ctx.states[1].hits.length, 1); assert.equal(ctx.states[0].hits.length, 3);
});

test('HTTP application errors, redirects, malformed JSON and oversized responses cannot be logged as success', async t => {
  const ctx = await setup(t, { MAX_PAYLOAD_BYTES: '1024' });
  const cases = [
    { code: 200, body: { success: false }, error: 'application_rejected' },
    { code: 200, body: { success: true, exception: 'sensitive error text' }, error: 'application_rejected' },
    { code: 200, body: { success: 'true' }, error: 'success_contract_mismatch' },
    { code: 302, body: {}, error: 'http_302' },
    { code: 401, body: {}, error: 'http_401' },
    { code: 200, body: { success: true, padding: '界'.repeat(400) }, error: 'response_too_large' }
  ];
  for (const [i, item] of cases.entries()) {
    Object.assign(ctx.states[0], { code: item.code, body: item.body });
    const data = fixture(); data.RealTime.PunchLog.UserId = `CASE-${i}`; await ctx.post(data);
    await until(() => ctx.app.store.summary().counts.dead === i + 1);
    assert.equal(ctx.app.store.dead()[i].error, item.error);
  }
  assert.equal(ctx.logs.filter(l => l.event === 'delivery_succeeded' && l.target === 'bgc').length, 0);
  assert.ok(!JSON.stringify(ctx.logs).includes('sensitive error text'));
  assert.equal(ctx.states[0].hits.length, cases.length);
});

test('native Frappe success requires a created Employee Checkin name, not HTTP 200 alone', async t => {
  const ctx = await setup(t); ctx.states[1].body = { message: { employee: 'EMP-1' } };
  await ctx.post(); await until(() => ctx.app.store.summary().counts.dead === 1);
  assert.equal(ctx.app.store.dead()[0].error, 'missing_checkin_record'); assert.equal(ctx.states[0].hits.length, 1);
});

test('malformed downstream JSON is retained as dead work rather than counted successful', async t => {
  const ctx = await setup(t);
  ctx.states[0].handle = (req, res) => { res.writeHead(200); res.end('not JSON'); };
  await ctx.post(); await until(() => ctx.app.store.summary().counts.dead === 1);
  assert.equal(ctx.app.store.dead()[0].error, 'invalid_response_json');
  assert.equal(ctx.states[0].hits.length, 1); assert.equal(ctx.states[1].hits.length, 1);
});

test('connection refusal retries without blocking the healthy target', async t => {
  const ctx = await setup(t);
  ctx.states[0].server.closeAllConnections(); await new Promise(resolve => ctx.states[0].server.close(resolve));
  await ctx.post(); await until(() => ctx.app.store.summary().counts.dead === 1);
  assert.equal(ctx.app.store.dead()[0].error, 'network_error'); assert.equal(ctx.app.store.dead()[0].attempts, 3);
  assert.equal(ctx.states[1].hits.length, 1);
});
