'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { setup, fixture, until } = require('./helpers');

function cli(ctx, args) {
  return spawnSync(process.execPath, ['queue.js', ...args], { cwd: path.resolve(__dirname, '..'), env: ctx.env, encoding: 'utf8' });
}

test('operator CLI reports safe state, requires explicit dead target, and never replays completed work', async t => {
  const ctx = await setup(t); ctx.states[0].code = 401; await ctx.post();
  await until(() => ctx.app.store.summary().counts.dead === 1 && ctx.app.store.summary().counts.delivered === 1);
  const status = cli(ctx, ['status']); assert.equal(status.status, 0, status.stderr);
  const output = JSON.parse(status.stdout), eventId = output.dead[0].event_id;
  assert.equal(output.counts.dead, 1);
  for (const secret of ['test-cams-secret', 'test-bgc-token', 'EMP-1', 'test-secret']) assert.ok(!status.stdout.includes(secret));
  assert.equal(cli(ctx, ['replay', '--event', eventId, '--target', 'sempl']).status, 1);
  assert.equal(cli(ctx, ['replay', '--event', eventId, '--target', 'bgc', '--rebuild-for-contract', 'wrong-hash']).status, 1);
  ctx.states[0].code = 200;
  const replay = cli(ctx, ['replay', '--event', eventId, '--target', 'bgc']); assert.equal(replay.status, 0, replay.stderr);
  await until(() => ctx.app.store.summary().counts.delivered === 2);
  assert.equal(ctx.states[1].hits.length, 1);
});

test('CLI requires exact current contract fingerprint to rebuild after an approved mapping change', async t => {
  const ctx = await setup(t); const payload = fixture(); payload.RealTime.PunchLog.Type = 'MealOut';
  await ctx.post(payload); await until(() => ctx.app.store.summary().counts.delivered === 1);
  const [row] = ctx.app.store.dead();
  await ctx.restart({ SEMPL_ERPNEXT_PUNCH_TYPE_MAP_JSON: '{"CheckIn":"IN","CheckOut":"OUT","MealOut":"OUT"}' });
  assert.equal(cli(ctx, ['replay', '--event', row.event_id, '--target', 'sempl']).status, 1);
  const result = cli(ctx, ['replay', '--event', row.event_id, '--target', 'sempl', '--rebuild-for-contract', ctx.config.targets[1].fingerprint]);
  assert.equal(result.status, 0, result.stderr);
  await until(() => ctx.app.store.summary().counts.delivered === 2); assert.equal(ctx.states[0].hits.length, 1);
});

test('queue file stays private and partial enqueue transactions roll back without an accepted event', async t => {
  const ctx = await setup(t);
  assert.equal(fs.statSync(ctx.env.QUEUE_DB_PATH).mode & 0o777, 0o600);
  const eventId = 'a'.repeat(64);
  assert.throws(() => ctx.app.store.enqueue(eventId, [
    { target: 'bgc', fingerprint: 'f', payload: {}, source: {} },
    { target: 'bgc', fingerprint: 'f', payload: {}, source: {} }
  ], 10));
  assert.equal(ctx.app.store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE id=?').get(eventId).n, 0);
  assert.equal(ctx.app.store.summary().counts.pending, 0);
});
