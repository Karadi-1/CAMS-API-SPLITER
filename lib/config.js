'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadConfig(env = process.env) {
  const required = name => {
    if (typeof env[name] !== 'string' || !env[name].trim()) throw new Error(`Missing ${name}`);
    return env[name];
  };
  const integer = (name, fallback, min, max) => {
    const n = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
    return n;
  };
  const bool = (name, fallback = false) => {
    if (env[name] === undefined) return fallback;
    if (!['true', 'false'].includes(env[name])) throw new Error(`Invalid ${name}`);
    return env[name] === 'true';
  };
  const json = (name, fallback) => {
    try { return env[name] === undefined ? fallback : JSON.parse(env[name]); }
    catch { throw new Error(`Invalid JSON in ${name}`); }
  };
  const production = env.NODE_ENV === 'production';
  const targets = ['bgc', 'sempl'].map(id => {
    const prefix = id === 'bgc' ? 'BGC_SIXORBIT' : 'SEMPL_ERPNEXT';
    const rawUrl = required(`${prefix}_URL`);
    let url;
    try { url = new URL(rawUrl); } catch { throw new Error(`Invalid ${prefix}_URL`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error(`Invalid ${prefix}_URL`);
    }
    if (production && url.protocol !== 'https:') throw new Error(`${prefix}_URL requires HTTPS in production`);
    const mode = required(`${prefix}_MODE`);
    if (!['cams-json', 'mapped-json', ...(id === 'sempl' ? ['frappe-checkin'] : [])].includes(mode)) {
      throw new Error(`Invalid ${prefix}_MODE`);
    }
    const authMode = id === 'bgc' ? env.BGC_SIXORBIT_AUTH_MODE || 'bearer' : 'frappe-token';
    if (id === 'bgc' && !['bearer', 'api-key-hmac'].includes(authMode)) throw new Error('Invalid BGC_SIXORBIT_AUTH_MODE');
    const apiKey = authMode === 'api-key-hmac' ? required('BGC_SIXORBIT_API_KEY') : undefined;
    const authorization = authMode === 'api-key-hmac' ? undefined : id === 'bgc'
      ? `Bearer ${required(`${prefix}_TOKEN`)}`
      : `token ${required(`${prefix}_API_KEY`)}:${required(`${prefix}_API_SECRET`)}`;
    if (/[\r\n]/.test(authorization || apiKey)) throw new Error(`Invalid ${prefix} credentials`);
    const company = required(`${prefix}_COMPANY`);
    const timeZone = required(`${prefix}_TIME_ZONE`);
    try { new Intl.DateTimeFormat('en', { timeZone }).format(); }
    catch { throw new Error(`Invalid ${prefix}_TIME_ZONE`); }
    const employeeMap = json(`${prefix}_EMPLOYEE_MAP_JSON`, {});
    if (!object(employeeMap) || Object.values(employeeMap).some(x => typeof x !== 'string' || !x.trim())) {
      throw new Error(`Invalid ${prefix}_EMPLOYEE_MAP_JSON`);
    }
    const punchMap = json(`${prefix}_PUNCH_TYPE_MAP_JSON`, { CheckIn: 'IN', CheckOut: 'OUT' });
    if (!object(punchMap) || Object.values(punchMap).some(x => !['IN', 'OUT'].includes(x))) throw new Error(`Invalid ${prefix}_PUNCH_TYPE_MAP_JSON`);
    const skipAutoAttendance = id === 'sempl' ? bool('SEMPL_ERPNEXT_SKIP_AUTO_ATTENDANCE') : false;
    const fieldMap = json(`${prefix}_FIELD_MAP_JSON`, {});
    const fields = ['employeeId', 'userId', 'deviceId', 'occurredAt', 'timestamp', 'logType', 'punchType', 'eventId', 'company'];
    if (!object(fieldMap) || Object.entries(fieldMap).some(([key, value]) =>
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key) || !fields.includes(value))) {
      throw new Error(`Invalid ${prefix}_FIELD_MAP_JSON`);
    }
    if (mode === 'mapped-json' && !Object.keys(fieldMap).length) throw new Error(`Missing ${prefix}_FIELD_MAP_JSON`);
    const successPath = mode === 'frappe-checkin' ? 'message.name' : required(`${prefix}_SUCCESS_PATH`);
    if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(successPath) || successPath.split('.').some(x => ['__proto__', 'constructor', 'prototype'].includes(x))) {
      throw new Error(`Invalid ${prefix}_SUCCESS_PATH`);
    }
    const successValue = mode === 'frappe-checkin' ? undefined : json(`${prefix}_SUCCESS_VALUE`, undefined);
    if (mode !== 'frappe-checkin' && (successValue === undefined || object(successValue) || Array.isArray(successValue) || successValue === null)) {
      throw new Error(`Missing or invalid ${prefix}_SUCCESS_VALUE (JSON scalar required)`);
    }
    const target = { id, url: url.href, mode, authMode, authorization, apiKey, company, timeZone, employeeMap, punchMap, skipAutoAttendance, fieldMap, successPath, successValue };
    // Credential rotation is safe; changing company, URL or adapter cannot retarget queued records silently.
    const { authorization: ignored, apiKey: ignoredKey, ...contract } = target;
    target.fingerprint = createHash('sha256').update(JSON.stringify(contract)).digest('hex');
    return target;
  });
  const devices = json('CAMS_DEVICES_JSON', null);
  if (devices !== null) {
    if (!Array.isArray(devices) || !devices.length) throw new Error('CAMS_DEVICES_JSON must be a nonempty array');
    const serials = new Set();
    for (const device of devices) {
      if (!object(device) || typeof device.serialNumber !== 'string' || !device.serialNumber.trim() ||
          typeof device.authToken !== 'string' || !device.authToken || serials.has(device.serialNumber) ||
          (device.targets !== undefined && (!Array.isArray(device.targets) || !device.targets.length ||
            new Set(device.targets).size !== device.targets.length || device.targets.some(x => !['bgc', 'sempl'].includes(x))))) {
        throw new Error('Invalid CAMS_DEVICES_JSON device');
      }
      serials.add(device.serialNumber);
    }
  }
  const authToken = devices ? undefined : required('CAMS_AUTH_TOKEN');
  const encryptionKey = env.CAMS_ENCRYPTION_KEY_HEX;
  if (encryptionKey !== undefined && !/^[a-fA-F0-9]{64}$/.test(encryptionKey)) throw new Error('CAMS_ENCRYPTION_KEY_HEX must contain 64 hex characters');
  const dbPath = required('QUEUE_DB_PATH');
  if (!path.isAbsolute(dbPath) || dbPath === ':memory:') throw new Error('QUEUE_DB_PATH must be an absolute persistent file path');
  return {
    targets, devices, authToken, encryptionKey, dbPath, allowFlat: bool('CAMS_ALLOW_LEGACY_FLAT'),
    host: env.HOST || '0.0.0.0', port: integer('PORT', 3000, 0, 65535),
    maxBytes: integer('MAX_PAYLOAD_BYTES', 1048576, 1024, 10485760),
    timeoutMs: integer('DELIVERY_TIMEOUT_MS', 10000, 50, 120000),
    pollMs: integer('QUEUE_POLL_MS', 100, 10, 60000),
    retryMs: integer('RETRY_BASE_MS', 1000, 10, 3600000),
    maxAttempts: integer('DELIVERY_MAX_ATTEMPTS', 8, 1, 100),
    maxQueue: integer('MAX_PENDING_DELIVERIES', 100000, 2, 10000000),
    shutdownMs: integer('SHUTDOWN_TIMEOUT_MS', 15000, 50, 180000)
  };
}

module.exports = { loadConfig, object };
