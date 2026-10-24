'use strict';

const http = require('node:http');
const { loadConfig } = require('./lib/config');
const { InputError, decodeBody, readAttendance, adapt } = require('./lib/attendance');
const { QueueStore } = require('./lib/store');
const { DeliveryWorker } = require('./lib/delivery');

function createApp(config, options = {}) {
  const log = options.log || ((event, details = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details })));
  const store = options.store || new QueueStore(config.dbPath);
  const worker = new DeliveryWorker(store, config, log);
  const counters = { accepted: 0, duplicate: 0, rejected: 0, storageFailures: 0 };
  let stopping = false;
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const done = res => json(res, 200, { status: 'done' });
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, { status: 'ok' });
    if (req.method === 'GET' && req.url === '/readyz') {
      try {
        const queue = store.summary();
        return json(res, stopping || queue.counts.dead || queue.counts.pending + queue.counts.inflight >= config.maxQueue ? 503 : 200,
          { status: stopping ? 'stopping' : queue.counts.dead ? 'attention_required' : 'ready', queue, counters });
      } catch { return json(res, 503, { status: 'storage_unavailable' }); }
    }
    if (req.method !== 'POST' || req.url !== '/webhook/cams') return json(res, 404, { error: 'not_found' });
    if (stopping) return json(res, 503, { error: 'stopping' });
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!config.encryptionKey && contentType !== 'application/json') return json(res, 415, { error: 'application_json_required' });
    if (Number(req.headers['content-length']) > config.maxBytes) {
      json(res, 413, { error: 'payload_too_large' }); req.resume(); return;
    }
    let bytes = 0, overLimit = false;
    const chunks = [];
    req.on('error', () => { /* Aborted uploads do not enter the durable queue. */ });
    req.on('data', chunk => {
      if (overLimit) return;
      bytes += chunk.length;
      if (bytes > config.maxBytes) { overLimit = true; chunks.length = 0; json(res, 413, { error: 'payload_too_large' }); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (overLimit) return;
      if (stopping) return json(res, 503, { error: 'stopping' });
      let event;
      try {
        event = readAttendance(decodeBody(Buffer.concat(chunks), config), config);
        if (event.rejected) {
          counters.rejected++; log('callback_rejected', { reason: event.rejected }); done(res); return;
        }
      } catch (err) {
        counters.rejected++; log('callback_rejected', { reason: err instanceof InputError ? err.message : 'invalid_payload' });
        return json(res, err instanceof InputError ? err.status : 400, { error: err instanceof InputError ? err.message : 'invalid_payload' });
      }
      try {
        const deliveries = config.targets.filter(t => event.targets.includes(t.id)).map(t => {
          try { return { target: t.id, fingerprint: t.fingerprint, payload: adapt(event, t), source: event }; }
          catch (err) {
            // Keep the source event for repair/replay without losing the independently valid peer delivery.
            if (!(err instanceof InputError)) throw err;
            return { target: t.id, fingerprint: t.fingerprint, payload: null, source: event, error: err.message };
          }
        });
        // FULL synchronous SQLite transaction commits both intended deliveries before acknowledging CAMS.
        const inserted = store.enqueue(event.id, deliveries, config.maxQueue);
        counters[inserted ? 'accepted' : 'duplicate']++;
        done(res);
        log(inserted ? 'callback_accepted' : 'callback_duplicate', { eventId: event.id, targets: event.targets });
        setImmediate(() => worker.wake());
      } catch {
        counters.storageFailures++; log('callback_not_persisted', { eventId: event.id });
        json(res, 503, { error: 'durable_acceptance_failed' });
      }
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxConnections = 256;
  server.setTimeout(15000, socket => socket.destroy());

  async function start() {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
    worker.start(); return server.address();
  }
  async function stop() {
    if (stopping) return;
    stopping = true;
    const closed = new Promise(resolve => server.close(resolve));
    server.closeIdleConnections();
    const timer = setTimeout(() => server.closeAllConnections(), config.shutdownMs);
    await Promise.all([closed, worker.stop()]); clearTimeout(timer); store.close();
  }
  return { server, store, worker, counters, start, stop };
}

if (require.main === module) {
  process.umask(0o077);
  let app;
  try {
    app = createApp(loadConfig());
    app.start().then(address => console.log(JSON.stringify({ event: 'listening', port: address.port }))).catch(() => {
      console.error('Server startup failed (check port binding)'); app.store.close(); process.exitCode = 1;
    });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
      app.stop().catch(() => { console.error('Graceful shutdown failed'); process.exitCode = 1; });
    });
  } catch (err) { console.error(`Configuration/startup failed: ${err.code ? 'storage_unavailable' : err.message}`); process.exitCode = 1; }
}

module.exports = { createApp };
