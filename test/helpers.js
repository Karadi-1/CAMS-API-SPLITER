'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { loadConfig } = require('../lib/config');
const { createApp } = require('../server');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true');
    await sleep(10);
  }
}

function fixture(overrides = {}) {
  return { RealTime: { OperationID: 'test-op', SerialNumber: 'DEV-1', LabelName: 'Synthetic device',
    Time: '2026-10-24 03:30:00 GMT +0000', AuthToken: 'test-cams-secret',
    PunchLog: { UserId: 'EMP-1', Type: 'CheckIn', LogTime: '2026-10-24 09:00:00 GMT +0530', InputType: 'Fingerprint' }, ...overrides } };
}

function baseEnv(dbPath, bgcUrl = 'http://127.0.0.1:1/bgc', semplUrl = 'http://127.0.0.1:1/sempl') {
  return { PORT: '0', HOST: '127.0.0.1', CAMS_AUTH_TOKEN: 'test-cams-secret', QUEUE_DB_PATH: dbPath,
    BGC_SIXORBIT_URL: bgcUrl, BGC_SIXORBIT_TOKEN: 'test-bgc-token', BGC_SIXORBIT_MODE: 'cams-json',
    BGC_SIXORBIT_COMPANY: 'BGC', BGC_SIXORBIT_TIME_ZONE: 'Asia/Kolkata',
    BGC_SIXORBIT_SUCCESS_PATH: 'success', BGC_SIXORBIT_SUCCESS_VALUE: 'true',
    SEMPL_ERPNEXT_URL: semplUrl, SEMPL_ERPNEXT_API_KEY: 'test-key', SEMPL_ERPNEXT_API_SECRET: 'test-secret',
    SEMPL_ERPNEXT_MODE: 'frappe-checkin', SEMPL_ERPNEXT_COMPANY: 'SEMPL', SEMPL_ERPNEXT_TIME_ZONE: 'Asia/Kolkata',
    DELIVERY_TIMEOUT_MS: '1000', QUEUE_POLL_MS: '10', RETRY_BASE_MS: '20', DELIVERY_MAX_ATTEMPTS: '3', SHUTDOWN_TIMEOUT_MS: '100' };
}

async function setup(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cams-test-'));
  const states = [];
  for (const id of ['bgc', 'sempl']) {
    const state = { id, hits: [], delay: 0, code: 200, body: id === 'bgc' ? { success: true } : { message: { name: 'CHECKIN-1' } } };
    state.server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('error', () => {});
      req.on('end', () => {
        state.hits.push({ body: JSON.parse(Buffer.concat(chunks).toString()), headers: req.headers, at: Date.now() });
        if (state.handle) return state.handle(req, res);
        const code = state.code, body = state.body;
        const timer = setTimeout(() => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }, state.delay);
        res.on('close', () => clearTimeout(timer));
      });
    });
    state.server.listen(0, '127.0.0.1'); await once(state.server, 'listening'); states.push(state);
  }
  const env = { ...baseEnv(path.join(directory, 'queue.sqlite'), ...states.map(s => `http://127.0.0.1:${s.server.address().port}/${s.id}`)), ...overrides };
  const config = loadConfig(env);
  const logs = [];
  const ctx = { directory, states, env, config, logs, app: createApp(config, { log: (event, detail) => logs.push({ event, ...detail }) }) };
  await ctx.app.start();
  ctx.post = async (data = fixture(), headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${ctx.app.server.address().port}/webhook/cams`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }, body: typeof data === 'string' ? data : JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  ctx.restart = async (newEnv = {}) => {
    await ctx.app.stop();
    Object.assign(ctx.env, newEnv); ctx.config = loadConfig(ctx.env);
    ctx.app = createApp(ctx.config, { log: (event, detail) => logs.push({ event, ...detail }) }); await ctx.app.start();
  };
  t.after(async () => {
    await ctx.app.stop();
    for (const state of states) { state.server.closeAllConnections(); await new Promise(resolve => state.server.close(resolve)); }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return ctx;
}

module.exports = { setup, baseEnv, fixture, sleep, until };
