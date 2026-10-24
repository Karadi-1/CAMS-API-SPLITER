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

function requestJson(target, url, method, payload, eventId, config, agents, active) {
  return new Promise((resolve, reject) => {
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
    const headers = { 'Content-Type': 'application/json' };
    if (payload !== undefined) headers['Content-Length'] = Buffer.byteLength(payload);
    if (eventId) headers['Idempotency-Key'] = eventId;
    if (target.authMode === 'api-key-hmac') {
      headers['API-Key'] = target.apiKey;
      // Sign the exact persisted UTF-8 body sent below; reserializing a parsed object could change the signature.
      headers['X-API-Signature'] = createHmac('sha256', target.apiKey).update(payload, 'utf8').digest('hex');
    } else headers.Authorization = target.authorization;
    const req = client.request(url, { method, agent: agents[url.protocol], headers }, res => {
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
        finish(null, body);
      });
    });
    active.add(req);
    req.on('error', err => finish(new DeliveryError(err instanceof DeliveryError ? err.message : 'network_error')));
    // Total wall-clock deadline includes DNS, connection, headers and slow/drip-fed response bodies.
    timer = setTimeout(() => { const err = new DeliveryError('delivery_timeout'); finish(err); req.destroy(); }, config.timeoutMs);
    req.end(payload);
  });
}

async function send(target, row, config, agents, active) {
  const body = await requestJson(target, new URL(target.url), 'POST', row.payload, row.event_id, config, agents, active);
  const value = atPath(body, target.successPath);
  if (target.mode === 'frappe-checkin') {
    if (typeof value !== 'string' || !value.trim()) throw new DeliveryError('missing_checkin_record', false);
    return { recordId: value };
  }
  if (value !== target.successValue) throw new DeliveryError('success_contract_mismatch', false);
  return {};
}

// Frappe serializes zero microseconds without a fraction. Preserve nonzero precision;
// treating two distinct fractional timestamps as equal could acknowledge the wrong punch.
function canonicalTime(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  return match ? `${match[1]}.${(match[2] || '').padEnd(6, '0')}` : null;
}

async function reconcileFrappe(target, row, config, agents, active) {
  const punch = JSON.parse(row.payload);
  const list = async (doctype, fields, filters) => {
    // Read only the configured receiver origin. Never follow a redirect with credentials.
    const url = new URL(`/api/resource/${encodeURIComponent(doctype)}`, target.url);
    url.searchParams.set('fields', JSON.stringify(fields));
    url.searchParams.set('filters', JSON.stringify(filters));
    url.searchParams.set('limit_page_length', '2');
    let body;
    try { body = await requestJson(target, url, 'GET', undefined, undefined, config, agents, active); }
    catch (err) {
      const reason = err instanceof DeliveryError ? err.message : 'internal_error';
      throw new DeliveryError(`reconciliation_${reason}`, err instanceof DeliveryError && err.retryable);
    }
    if (!Array.isArray(body.data)) throw new DeliveryError('reconciliation_invalid_response', true);
    return body.data;
  };
  const employees = await list('Employee', ['name', 'company', 'attendance_device_id'],
    { attendance_device_id: punch.employee_field_value });
  // Native lookup is not company scoped. Refuse duplicate device IDs, including IDs
  // shared with another company, rather than guessing which employee received the POST.
  if (employees.length === 0) return null;
  if (employees.length !== 1 || typeof employees[0].name !== 'string' || !employees[0].name ||
      employees[0].company !== target.company || employees[0].attendance_device_id !== punch.employee_field_value) {
    throw new DeliveryError('reconciliation_employee_mismatch', false);
  }
  const employee = employees[0].name;
  const records = await list('Employee Checkin', ['name', 'employee', 'time', 'device_id', 'log_type', 'skip_auto_attendance'],
    { employee, time: punch.timestamp, device_id: punch.device_id, log_type: punch.log_type });
  if (records.length === 0) return null;
  const record = records[0];
  if (records.length !== 1 || typeof record.name !== 'string' || !record.name.trim() ||
      record.employee !== employee || record.device_id !== punch.device_id || record.log_type !== punch.log_type ||
      !canonicalTime(punch.timestamp) || canonicalTime(record.time) !== canonicalTime(punch.timestamp) ||
      ![0, 1, '0', '1'].includes(record.skip_auto_attendance) ||
      Number(record.skip_auto_attendance) !== (punch.skip_auto_attendance || 0)) {
    throw new DeliveryError('reconciliation_checkin_mismatch', false);
  }
  return { recordId: record.name, reconciled: true };
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
    // Native reconciliation may require a POST followed by two bounded GETs.
    const row = this.store.claim(target.id, this.config.timeoutMs * (target.mode === 'frappe-checkin' ? 3 : 1) + 2000, this.config.maxAttempts);
    if (!row) return;
    try {
      if (row.fingerprint !== target.fingerprint) throw new DeliveryError('target_contract_changed', false);
      let result;
      try { result = await send(target, row, this.config, this.agents, this.active); }
      catch (err) {
        if (target.mode !== 'frappe-checkin' || this.stopping) throw err;
        result = await reconcileFrappe(target, row, this.config, this.agents, this.active);
        if (!result) throw err;
      }
      this.store.success(row, result.recordId);
      this.log('delivery_succeeded', { target: target.id, eventId: row.event_id, attempt: row.attempts,
        ...(result.reconciled ? { reconciled: true } : {}) });
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
