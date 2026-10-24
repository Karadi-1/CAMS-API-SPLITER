'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, until, sleep } = require('./helpers');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
}

function receiver(ctx, { employee = {}, record = {}, employeeCount = 1, recordCount = 1 } = {}) {
  const state = ctx.states[1];
  state.handle = (req, res) => req.socket.destroy(); // ERP committed but its response is lost.
  state.readHandle = (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(req.headers.authorization, 'token test-key:test-secret');
    assert.equal(req.headers['api-key'], undefined);
    assert.equal(url.searchParams.get('limit_page_length'), '2');
    if (decodeURIComponent(url.pathname).endsWith('/Employee')) {
      assert.deepEqual(JSON.parse(url.searchParams.get('filters')), { attendance_device_id: 'EMP-1' });
      return json(res, 200, { data: Array.from({ length: employeeCount }, () =>
        ({ name: 'HR-EMP-1', company: 'SEMPL', attendance_device_id: 'EMP-1', ...employee })) });
    }
    assert.deepEqual(JSON.parse(url.searchParams.get('filters')),
      { employee: 'HR-EMP-1', time: '2026-10-24 09:00:00.000000', device_id: 'DEV-1', log_type: 'IN' });
    json(res, 200, { data: Array.from({ length: recordCount }, () => ({ name: 'CHECKIN-EXISTING',
      employee: 'HR-EMP-1', time: '2026-10-24 09:00:00', device_id: 'DEV-1', log_type: 'IN', skip_auto_attendance: 0, ...record })) });
  };
  return state;
}

test('lost response reconciles the exact native check-in even on the final allowed attempt', async t => {
  const ctx = await setup(t, { DELIVERY_MAX_ATTEMPTS: '1' }); const state = receiver(ctx);
  await ctx.post(); await until(() => ctx.app.store.summary().counts.delivered === 2);
  assert.equal(state.hits.length, 1); assert.equal(state.reads.length, 2);
  const row = ctx.app.store.db.prepare("SELECT * FROM deliveries WHERE target='sempl'").get();
  assert.equal(row.record_id, 'CHECKIN-EXISTING'); assert.equal(row.payload, null); assert.equal(row.attempts, 1);
  assert.ok(ctx.logs.some(l => l.event === 'delivery_succeeded' && l.target === 'sempl' && l.reconciled));
  assert.equal(ctx.states[0].hits.length, 1);
});

test('a native duplicate 417 is reconciled from independent record read-back', async t => {
  const ctx = await setup(t); const state = receiver(ctx);
  state.handle = (req, res) => json(res, 417, { exc_type: 'ValidationError' });
  await ctx.post(); await until(() => ctx.app.store.summary().counts.delivered === 2);
  assert.equal(state.hits.length, 1); assert.equal(state.reads.length, 2);
});

test('unavailable reconciliation retries after restart and never repeats the completed peer', async t => {
  const ctx = await setup(t, { RETRY_BASE_MS: '300' }); const state = receiver(ctx);
  const healthy = state.readHandle;
  state.readHandle = (req, res) => json(res, 503, {});
  await ctx.post(); await until(() => ctx.app.store.summary().counts.pending === 1 && ctx.app.store.summary().counts.delivered === 1);
  assert.ok(ctx.logs.some(l => l.reason === 'reconciliation_http_503'));
  state.handle = (req, res) => json(res, 417, { exc_type: 'ValidationError' }); state.readHandle = healthy;
  await ctx.restart(); await until(() => ctx.app.store.summary().counts.delivered === 2);
  assert.equal(state.hits.length, 2); assert.equal(ctx.states[0].hits.length, 1);
});

for (const [label, options, reason] of [
  ['another company', { employee: { company: 'BGC' } }, 'employee'],
  ['duplicate employee device IDs', { employeeCount: 2 }, 'employee'],
  ['different employee device ID', { employee: { attendance_device_id: 'OTHER' } }, 'employee'],
  ['another employee', { record: { employee: 'HR-EMP-2' } }, 'checkin'],
  ['different device', { record: { device_id: 'DEV-2' } }, 'checkin'],
  ['different direction', { record: { log_type: 'OUT' } }, 'checkin'],
  ['different fractional timestamp', { record: { time: '2026-10-24 09:00:00.000001' } }, 'checkin'],
  ['different auto-attendance behavior', { record: { skip_auto_attendance: 1 } }, 'checkin'],
  ['multiple check-ins', { recordCount: 2 }, 'checkin']
]) test(`reconciliation fails closed for ${label}`, async t => {
  const ctx = await setup(t); receiver(ctx, options); await ctx.post();
  await until(() => ctx.app.store.summary().counts.dead === 1);
  assert.equal(ctx.app.store.dead()[0].error, `reconciliation_${reason}_mismatch`);
  assert.equal(ctx.app.store.summary().counts.delivered, 1);
});

test('zero matches never turn a missing-employee validation error into success', async t => {
  const ctx = await setup(t); const state = receiver(ctx, { employeeCount: 0 });
  state.handle = (req, res) => json(res, 417, { exc_type: 'ValidationError' });
  await ctx.post(); await until(() => ctx.app.store.summary().counts.dead === 1);
  assert.equal(ctx.app.store.dead()[0].error, 'http_417');
});

test('lookup permissions fail visibly without inventing a delivered record', async t => {
  const ctx = await setup(t); const state = receiver(ctx);
  state.readHandle = (req, res) => json(res, 403, {});
  await ctx.post(); await until(() => ctx.app.store.summary().counts.dead === 1);
  assert.equal(ctx.app.store.dead()[0].error, 'reconciliation_http_403');
});

test('reconciliation retains the outbound deadline', async t => {
  const ctx = await setup(t, { DELIVERY_TIMEOUT_MS: '50', DELIVERY_MAX_ATTEMPTS: '1', MAX_PAYLOAD_BYTES: '1024' });
  const state = receiver(ctx); state.readHandle = () => {};
  await ctx.post(); await until(() => ctx.app.store.summary().counts.dead === 1);
  assert.equal(ctx.app.store.dead()[0].error, 'reconciliation_delivery_timeout');
  await sleep(20); assert.equal(ctx.app.worker.active.size, 0);
});

test('oversized lookup responses fail closed under the outbound byte cap', async t => {
  const ctx = await setup(t, { MAX_PAYLOAD_BYTES: '1024' }); const state = receiver(ctx);
  state.readHandle = (req, res) => json(res, 200, { data: [], padding: 'x'.repeat(2048) });
  await ctx.post(); await until(() => ctx.app.store.summary().counts.dead === 1);
  assert.equal(ctx.app.store.dead()[0].error, 'reconciliation_response_too_large');
  assert.equal(ctx.app.store.summary().counts.delivered, 1);
});

test('a timed-out POST whose record was committed is reconciled', async t => {
  const ctx = await setup(t, { DELIVERY_TIMEOUT_MS: '50', DELIVERY_MAX_ATTEMPTS: '1' });
  const state = receiver(ctx); state.handle = () => {};
  await ctx.post(); await until(() => ctx.app.store.summary().counts.delivered === 2);
  assert.equal(state.hits.length, 1); assert.equal(state.reads.length, 2);
  assert.ok(ctx.logs.some(l => l.reconciled));
});
