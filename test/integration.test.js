'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createCipheriv } = require('node:crypto');
const { QueueStore } = require('../lib/store');
const { readAttendance, adapt } = require('../lib/attendance');
const { setup, fixture, sleep, until } = require('./helpers');

test('documented callbacks commit both target deliveries before done and forward correct headers/mapped payload', async t => {
  const ctx = await setup(t), [bgc, sempl] = ctx.states;
  await ctx.app.worker.stop(); // Hold workers to inspect durable state at acknowledgment.
  assert.deepEqual(await ctx.post(), { status: 200, body: { status: 'done' } });
  const independentReader = new QueueStore(ctx.env.QUEUE_DB_PATH);
  assert.equal(independentReader.summary().counts.pending, 2); independentReader.close();
  assert.equal(bgc.hits.length, 0);
  ctx.app.worker.stopping = false; ctx.app.worker.start();
  await until(() => ctx.app.store.summary().counts.delivered === 2);
  assert.equal(bgc.hits[0].headers.authorization, 'Bearer test-bgc-token');
  assert.equal(sempl.hits[0].headers.authorization, 'token test-key:test-secret');
  assert.ok(!JSON.stringify(bgc.hits[0].body).includes('AuthToken'));
  assert.equal(sempl.hits[0].body.employee_field_value, 'EMP-1');
  assert.equal(sempl.hits[0].body.timestamp, '2026-10-24 09:00:00.000000');
  assert.equal(bgc.hits[0].headers['idempotency-key'], sempl.hits[0].headers['idempotency-key']);
  const row = ctx.app.store.db.prepare("SELECT * FROM deliveries WHERE target='sempl'").get();
  assert.equal(row.record_id, 'CHECKIN-1'); assert.equal(row.payload, null); assert.equal(row.source, null);
});

test('slow BGC does not delay SEMPL delivery, success log or acknowledgment', async t => {
  const ctx = await setup(t, { DELIVERY_TIMEOUT_MS: '1000' });
  ctx.states[0].delay = 500;
  const start = performance.now(); assert.equal((await ctx.post()).status, 200);
  const ackMs = performance.now() - start;
  await until(() => ctx.logs.some(l => l.event === 'delivery_succeeded' && l.target === 'sempl'));
  assert.equal(ctx.states[0].hits.length, 1); // Receipt precedes its delayed response.
  assert.ok(!ctx.logs.some(l => l.event === 'delivery_succeeded' && l.target === 'bgc'));
  assert.ok(ackMs < 400, `Ack must not wait for 500 ms ERP response (${ackMs} ms)`);
  t.diagnostic(`Local durable acknowledgment: ${ackMs.toFixed(2)} ms (not a hosted latency guarantee)`);
  await until(() => ctx.app.store.summary().counts.delivered === 2);
});

test('failed target retries independently and successful target is never repeated', async t => {
  const ctx = await setup(t);
  const [bgc, sempl] = ctx.states; bgc.code = 503;
  await ctx.post(); await until(() => ctx.logs.some(l => l.event === 'delivery_retry_scheduled'));
  bgc.code = 200;
  await until(() => ctx.app.store.summary().counts.delivered === 2);
  assert.ok(bgc.hits.length >= 2); assert.equal(sempl.hits.length, 1);
  assert.equal(new Set(bgc.hits.map(h => h.headers['idempotency-key'])).size, 1);
});

test('duplicate resends remain suppressed after graceful restart and credentials rotate without retargeting', async t => {
  const ctx = await setup(t); await ctx.post(); await until(() => ctx.app.store.summary().counts.delivered === 2);
  await ctx.restart({ BGC_SIXORBIT_TOKEN: 'rotated-token' });
  await ctx.post(fixture({ OperationID: 'resend-operation' })); await sleep(50);
  assert.deepEqual(ctx.states.map(s => s.hits.length), [1, 1]);
  assert.equal(ctx.app.store.summary().counts.delivered, 2); assert.equal(ctx.app.counters.duplicate, 1);
});

test('acknowledged pending work survives restart; completed peer delivery is not repeated', async t => {
  const ctx = await setup(t, { RETRY_BASE_MS: '300' });
  ctx.states[0].code = 503; await ctx.post();
  await until(() => ctx.app.store.summary().counts.pending === 1 && ctx.app.store.summary().counts.delivered === 1);
  ctx.states[0].code = 200; await ctx.restart();
  await until(() => ctx.app.store.summary().counts.delivered === 2);
  assert.equal(ctx.states[1].hits.length, 1); assert.ok(ctx.states[0].hits.length >= 2);
  assert.equal(new Set(ctx.states[0].hits.map(h => h.headers['idempotency-key'])).size, 1);
});

test('hard process death after acknowledgment recovers an expired durable claim', async t => {
  const ctx = await setup(t); await ctx.app.stop();
  const child = spawn(process.execPath, ['server.js'], { cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...ctx.env, DELIVERY_TIMEOUT_MS: '500', QUEUE_POLL_MS: '10' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child startup timeout')), 3000);
    child.stdout.on('data', data => { for (const line of String(data).trim().split('\n')) {
      const item = JSON.parse(line); if (item.event === 'listening') { clearTimeout(timer); resolve(item.port); }
    } }); child.on('error', reject);
  });
  const port = await listening;
  ctx.states[0].handle = () => {}; // Keep BGC ambiguous/inflight until the process is killed.
  const response = await fetch(`http://127.0.0.1:${port}/webhook/cams`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fixture()) });
  assert.equal(response.status, 200); await response.text();
  await until(() => ctx.states[0].hits.length === 1 && ctx.states[1].hits.length === 1);
  const reader = new QueueStore(ctx.env.QUEUE_DB_PATH);
  await until(() => reader.summary().counts.delivered === 1);
  child.kill('SIGKILL'); await once(child, 'exit'); reader.close(); ctx.states[0].handle = undefined;
  await ctx.restart();
  await until(() => ctx.app.store.summary().counts.delivered === 2, 5000);
  assert.equal(ctx.states[1].hits.length, 1); assert.equal(ctx.states[0].hits.length, 2);
});

test('durable storage failure returns 503, never done or any ERP forward', async t => {
  const ctx = await setup(t);
  ctx.app.store.enqueue = () => { throw new Error('simulated disk failure with secret diagnostic'); };
  assert.deepEqual(await ctx.post(), { status: 503, body: { error: 'durable_acceptance_failed' } });
  await sleep(40); assert.deepEqual(ctx.states.map(s => s.hits.length), [0, 0]);
  assert.equal(ctx.app.counters.storageFailures, 1); assert.ok(!JSON.stringify(ctx.logs).includes('secret diagnostic'));
});

test('retry exhaustion becomes visible dead work; replay only the failed target', async t => {
  const ctx = await setup(t); ctx.states[0].code = 500; await ctx.post();
  await until(() => ctx.app.store.summary().counts.dead === 1);
  assert.equal(ctx.states[0].hits.length, 3); assert.equal(ctx.states[1].hits.length, 1);
  const [dead] = ctx.app.store.dead();
  ctx.states[0].code = 200;
  assert.equal(ctx.app.store.replay(dead.event_id, 'bgc', ctx.config.targets[0].fingerprint), true);
  assert.equal(ctx.app.store.replay(dead.event_id, 'sempl', ctx.config.targets[1].fingerprint), false);
  await until(() => ctx.app.store.summary().counts.delivered === 2);
  assert.equal(ctx.states[1].hits.length, 1);
});

test('configuration changes cannot redirect previously queued work without explicit rebuild confirmation', async t => {
  const ctx = await setup(t, { RETRY_BASE_MS: '200' }); ctx.states[0].code = 500;
  await ctx.post(); await until(() => ctx.app.store.summary().counts.pending === 1 && ctx.app.store.summary().counts.delivered === 1);
  ctx.states[0].code = 200; await ctx.restart({ BGC_SIXORBIT_COMPANY: 'Different company' });
  await until(() => ctx.app.store.summary().counts.dead === 1);
  assert.equal(ctx.states[0].hits.length, 1);
  const [row] = ctx.app.store.dead(); assert.equal(row.error, 'target_contract_changed');
  assert.equal(ctx.app.store.replay(row.event_id, 'bgc', ctx.config.targets[0].fingerprint), false);
  assert.equal(ctx.app.store.replay(row.event_id, 'bgc', ctx.config.targets[0].fingerprint,
    event => adapt(event, ctx.config.targets[0])), true);
  await until(() => ctx.app.store.summary().counts.delivered === 2);
});

test('unmapped Frappe punch types are retained for repair while BGC still receives attendance', async t => {
  const ctx = await setup(t); const payload = fixture(); payload.RealTime.PunchLog.Type = 'BreakIn';
  await ctx.post(payload); await until(() => ctx.app.store.summary().counts.delivered === 1);
  assert.equal(ctx.app.store.summary().counts.dead, 1); assert.equal(ctx.states[1].hits.length, 0);
  const [row] = ctx.app.store.dead(); assert.equal(row.error, 'unmapped_punch_type');
  assert.equal(ctx.app.store.replay(row.event_id, 'sempl', ctx.config.targets[1].fingerprint), false);
  await ctx.restart({ SEMPL_ERPNEXT_PUNCH_TYPE_MAP_JSON: '{"CheckIn":"IN","CheckOut":"OUT","BreakIn":"IN"}' });
  ctx.app.store.replay(row.event_id, 'sempl', ctx.config.targets[1].fingerprint, event => adapt(event, ctx.config.targets[1]));
  await until(() => ctx.app.store.summary().counts.delivered === 2);
  assert.equal(ctx.states[1].hits[0].body.log_type, 'IN'); assert.equal(ctx.states[0].hits.length, 1);
});

test('device routing is explicit; a SEMPL-only device never reaches BGC', async t => {
  const ctx = await setup(t, { CAMS_DEVICES_JSON: '[{"serialNumber":"DEV-1","authToken":"test-cams-secret","targets":["sempl"]}]' });
  await ctx.post(); await until(() => ctx.app.store.summary().counts.delivered === 1);
  assert.equal(ctx.states[0].hits.length, 0); assert.equal(ctx.states[1].hits.length, 1);
});

test('queue capacity rejects new work with 503 but still acknowledges durable duplicates', async t => {
  const ctx = await setup(t, { MAX_PENDING_DELIVERIES: '2', RETRY_BASE_MS: '500' });
  ctx.states.forEach(s => { s.code = 503; }); await ctx.post();
  const second = fixture(); second.RealTime.PunchLog.UserId = 'EMP-2';
  assert.equal((await ctx.post(second)).status, 503); assert.equal((await ctx.post()).status, 200);
  assert.equal(ctx.app.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
});

test('optional encrypted callbacks are accepted end to end', async t => {
  const key = '03'.repeat(32), ctx = await setup(t, { CAMS_ENCRYPTION_KEY_HEX: key });
  const cipher = createCipheriv('aes-256-ecb', Buffer.from(key, 'hex'), null);
  const body = Buffer.concat([cipher.update(JSON.stringify(fixture())), cipher.final()]).toString('base64');
  assert.equal((await ctx.post(body, { 'Content-Type': 'text/plain' })).status, 200);
  await until(() => ctx.app.store.summary().counts.delivered === 2);
});

test('health and readiness expose counts without employee data or credentials; dead work requires attention', async t => {
  const ctx = await setup(t); ctx.states[0].body = { success: false }; await ctx.post();
  await until(() => ctx.app.store.summary().counts.dead === 1);
  const base = `http://127.0.0.1:${ctx.app.server.address().port}`;
  assert.equal((await fetch(base + '/healthz')).status, 200);
  const response = await fetch(base + '/readyz'); assert.equal(response.status, 503);
  const text = await response.text(); assert.ok(text.includes('attention_required'));
  for (const secret of ['EMP-1', 'test-cams-secret', 'test-secret']) assert.ok(!text.includes(secret));
});

test('50 concurrent unique callbacks persist and each destination receives every event once', async t => {
  const ctx = await setup(t);
  await Promise.all(Array.from({ length: 50 }, (_, i) => { const data = fixture(); data.RealTime.PunchLog.UserId = `EMP-${i}`; return ctx.post(data).then(r => assert.equal(r.status, 200)); }));
  await until(() => ctx.app.store.summary().counts.delivered === 100);
  assert.deepEqual(ctx.states.map(s => s.hits.length), [50, 50]);
  assert.equal(ctx.app.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 50);
});
