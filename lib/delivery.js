'use strict';

const http = require('node:http');
const https = require('node:https');
const { createHmac } = require('node:crypto');

class DeliveryError extends Error {
  constructor(reason, retryable = true) { super(reason); this.retryable = retryable; }
}

function atPath(value, path) {
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

function send(target, row, config, agents, active) {
  return new Promise((resolve, reject) => {
    const url = new URL(target.url);
    const client = url.protocol === 'https:' ? https : http;
    let settled = false;
    let timer;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active.delete(req);
      if (err) reject(err); else resolve(result);
    };
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(row.payload),
      'Idempotency-Key': row.event_id };
    if (target.authMode === 'api-key-hmac') {
      headers['API-Key'] = target.apiKey;
      // Sign the exact persisted UTF-8 body sent below; reserializing a parsed object could change the signature.
      headers['X-API-Signature'] = createHmac('sha256', target.apiKey).update(row.payload, 'utf8').digest('hex');
    } else headers.Authorization = target.authorization;
    const req = client.request(url, { method: 'POST', agent: agents[url.protocol], headers }, res => {
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > config.maxBytes) {
          finish(new DeliveryError('response_too_large', false));
          res.destroy(); req.destroy();
        } else chunks.push(chunk);
      });
      res.on('error', () => finish(new DeliveryError('response_aborted')));
      res.on('end', () => {
        if (settled) return;
        const status = res.statusCode;
        if (status < 200 || status >= 300) return finish(new DeliveryError(`http_${status}`, status === 408 || status === 425 || status === 429 || status >= 500));
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return finish(new DeliveryError('invalid_response_json', false)); }
        if (!body || typeof body !== 'object' || body.success === false || body.status === 'error' || body.error || body.exc || body.exception) {
          return finish(new DeliveryError('application_rejected', false));
        }
        const value = atPath(body, target.successPath);
        if (target.mode === 'frappe-checkin') {
          if (typeof value !== 'string' || !value.trim()) return finish(new DeliveryError('missing_checkin_record', false));
          return finish(null, { recordId: value });
        }
        if (value !== target.successValue) return finish(new DeliveryError('success_contract_mismatch', false));
        finish(null, {});
      });
    });
    active.add(req);
    req.on('error', err => finish(new DeliveryError(err instanceof DeliveryError ? err.message : 'network_error')));
    // Total wall-clock deadline includes DNS, connection, headers and slow/drip-fed response bodies.
    timer = setTimeout(() => { const err = new DeliveryError('delivery_timeout'); finish(err); req.destroy(); }, config.timeoutMs);
    req.end(row.payload);
  });
}

class DeliveryWorker {
  constructor(store, config, log) {
    this.store = store; this.config = config; this.log = log;
    this.busy = new Set(); this.active = new Set(); this.tasks = new Set(); this.stopping = false;
    this.agents = { 'http:': new http.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2 }),
      'https:': new https.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2 }) };
  }

  start() { this.timer = setInterval(() => this.wake(), this.config.pollMs); this.wake(); }

  wake() {
    if (this.stopping) return;
    const tasks = this.config.targets.filter(t => !this.busy.has(t.id)).map(target => {
      this.busy.add(target.id);
      const task = this.run(target).catch(() => this.log('queue_error', { target: target.id }))
        .finally(() => { this.busy.delete(target.id); this.tasks.delete(task); });
      this.tasks.add(task);
      return task;
    });
    // Independent targets; each run logs its own outcome without waiting for its peer.
    void Promise.allSettled(tasks);
  }

  async run(target) {
    const row = this.store.claim(target.id, this.config.timeoutMs + 2000, this.config.maxAttempts);
    if (!row) return;
    try {
      if (row.fingerprint !== target.fingerprint) throw new DeliveryError('target_contract_changed', false);
      const result = await send(target, row, this.config, this.agents, this.active);
      this.store.success(row, result.recordId);
      this.log('delivery_succeeded', { target: target.id, eventId: row.event_id, attempt: row.attempts });
    } catch (err) {
      const retry = err instanceof DeliveryError && err.retryable && row.attempts < this.config.maxAttempts;
      const delay = Math.min(this.config.retryMs * 2 ** Math.min(row.attempts - 1, 20), 3600000);
      this.store.failure(row, err instanceof DeliveryError ? err.message : 'delivery_internal_error', retry,
        Date.now() + Math.ceil(delay * (1 + Math.random() * 0.2)));
      this.log(retry ? 'delivery_retry_scheduled' : 'delivery_dead', { target: target.id, eventId: row.event_id,
        attempt: row.attempts, reason: err instanceof DeliveryError ? err.message : 'delivery_internal_error' });
    }
  }

  async stop() {
    this.stopping = true; clearInterval(this.timer);
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(resolve, this.config.shutdownMs); });
    await Promise.race([Promise.allSettled([...this.tasks]), deadline]); clearTimeout(timer);
    for (const req of this.active) req.destroy(new DeliveryError('shutdown_interrupted'));
    await Promise.allSettled([...this.tasks]);
    Object.values(this.agents).forEach(a => a.destroy());
  }
}

module.exports = { DeliveryWorker };
