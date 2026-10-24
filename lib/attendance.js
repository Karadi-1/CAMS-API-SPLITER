'use strict';

const { createHash, timingSafeEqual, createDecipheriv } = require('node:crypto');
const { object } = require('./config');

class InputError extends Error {
  constructor(reason, status = 422) { super(reason); this.status = status; }
}

function equalToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a.isWellFormed() || !b.isWellFormed()) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function decodeBody(buffer, config) {
  try {
    if (config.encryptionKey) {
      const encoded = buffer.toString('utf8').trim();
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) || !encoded) throw new Error();
      const decipher = createDecipheriv('aes-256-ecb', Buffer.from(config.encryptionKey, 'hex'), null);
      buffer = Buffer.concat([decipher.update(Buffer.from(encoded, 'base64')), decipher.final()]);
    }
    // Reject invalid UTF-8, rather than introducing replacement characters into employee IDs.
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch { throw new InputError('invalid_payload_encoding', 400); }
}

function scalar(value, name, max = 256) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new InputError(`invalid_${name}`);
  return value;
}

function parseTime(value) {
  scalar(value, 'log_time', 64);
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))? GMT ([+-])(\d{2})(\d{2})$/.exec(value);
  if (!match) throw new InputError('invalid_log_time');
  const [, y, mo, d, h, mi, s, frac = '', sign, oh, om] = match;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${frac.padEnd(3, '0')}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== `${y}-${mo}-${d}T${h}:${mi}:${s}` ||
      +oh > 14 || +om > 59 || (+oh === 14 && +om !== 0)) throw new InputError('invalid_log_time');
  return new Date(date.getTime() - (sign === '+' ? 1 : -1) * (+oh * 60 + +om) * 60000).toISOString();
}

function readAttendance(payload, config) {
  if (!object(payload)) return { rejected: 'unauthorized' };
  const wrapped = Object.hasOwn(payload, 'RealTime');
  if (wrapped && Object.hasOwn(payload, 'AuthToken')) throw new InputError('ambiguous_envelope', 400);
  if (!wrapped && !config.allowFlat) return { rejected: 'unsupported_envelope' };
  const event = wrapped ? payload.RealTime : payload;
  if (!object(event)) return { rejected: 'unauthorized' };
  const device = config.devices?.find(d => d.serialNumber === event.SerialNumber);
  if (!equalToken(event.AuthToken, config.devices ? device?.authToken : config.authToken)) return { rejected: 'unauthorized' };
  if (!Object.hasOwn(event, 'PunchLog')) return { rejected: 'unsupported_event' };
  if (!object(event.PunchLog)) throw new InputError('invalid_punch_log');
  const punch = event.PunchLog;
  const deviceId = scalar(event.SerialNumber, 'device');
  const userId = scalar(punch.UserId, 'user');
  const punchType = scalar(punch.Type, 'punch_type', 32);
  if (!['CheckIn', 'CheckOut', 'BreakIn', 'BreakOut', 'OverTimeIn', 'OverTimeOut', 'MealIn', 'MealOut'].includes(punchType)) throw new InputError('unsupported_punch_type');
  const occurredAt = parseTime(punch.LogTime);
  // A resend may assign a new OperationID. The physical punch identity is independent of that operation.
  const id = createHash('sha256').update(JSON.stringify([deviceId, userId, occurredAt, punchType])).digest('hex');
  const clean = { SerialNumber: deviceId, PunchLog: { UserId: userId, Type: punchType, LogTime: punch.LogTime } };
  for (const key of ['OperationID', 'LabelName', 'Time']) {
    if (event[key] !== undefined) clean[key] = scalar(event[key], key);
  }
  if (punch.InputType !== undefined) clean.PunchLog.InputType = scalar(punch.InputType, 'input_type', 64);
  // Reconstruct scalar attendance fields. Unknown subtrees, photos, templates and all credential copies disappear.
  return { id, deviceId, userId, occurredAt, punchType,
    logType: punchType.endsWith('In') ? 'IN' : 'OUT',
    cleaned: wrapped ? { RealTime: clean } : clean,
    targets: device?.targets || ['bgc', 'sempl'] };
}

function localTimestamp(iso, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.${iso.slice(20, 23)}000`;
}

function adapt(event, target) {
  const mappingKey = `${encodeURIComponent(event.deviceId)}:${encodeURIComponent(event.userId)}`;
  const employeeId = Object.hasOwn(target.employeeMap, mappingKey) ? target.employeeMap[mappingKey] : event.userId;
  const fields = { employeeId, userId: event.userId, deviceId: event.deviceId, occurredAt: event.occurredAt,
    timestamp: localTimestamp(event.occurredAt, target.timeZone), logType: event.logType,
    punchType: event.punchType, eventId: event.id, company: target.company };
  if (target.mode === 'cams-json') return event.cleaned;
  if (target.mode === 'frappe-checkin') {
    if (!Object.hasOwn(target.punchMap, event.punchType)) throw new InputError('unmapped_punch_type');
    return { employee_field_value: employeeId, timestamp: fields.timestamp,
      device_id: event.deviceId, log_type: target.punchMap[event.punchType], employee_fieldname: 'attendance_device_id' };
  }
  return Object.fromEntries(Object.entries(target.fieldMap).map(([key, value]) => [key, fields[value]]));
}

module.exports = { InputError, decodeBody, readAttendance, adapt, parseTime };
