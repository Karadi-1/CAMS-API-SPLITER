'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCipheriv } = require('node:crypto');
const { loadConfig } = require('../lib/config');
const { decodeBody, readAttendance, adapt, parseTime } = require('../lib/attendance');
const { baseEnv, fixture } = require('./helpers');
const config = () => loadConfig(baseEnv('/tmp/synthetic-cams-unit.sqlite'));

test('documented envelope authenticates; allowlist retains attendance and strips every credential/template subtree', () => {
  const payload = fixture();
  payload.RealTime.PunchLog.extra = { AuthToken: 'nested-secret', Template: ['biometric-data'] };
  payload.RealTime.User = { Password: 'private-pin', Template: { Face: 'private-photo' } };
  const event = readAttendance(payload, config());
  assert.equal(event.userId, 'EMP-1');
  const output = JSON.stringify(event);
  for (const secret of ['test-cams-secret', 'nested-secret', 'private-pin', 'private-photo', 'biometric-data', 'AuthToken']) assert.ok(!output.includes(secret));
  assert.equal(event.cleaned.RealTime.PunchLog.InputType, 'Fingerprint');
});

test('token values are strict strings, never coerced; tokens at arbitrary depth cannot authenticate', () => {
  for (const token of [null, 2, [], { toString: null }, { valueOf: 'test-cams-secret' }, 'wrong']) {
    assert.equal(readAttendance(fixture({ AuthToken: token }), config()).rejected, 'unauthorized');
  }
  assert.equal(readAttendance({ wrapper: fixture() }, config()).rejected, 'unsupported_envelope');
  assert.throws(() => readAttendance({ ...fixture(), AuthToken: 'test-cams-secret' }, config()), /ambiguous/);
});

test('flat attendance is an explicit compatibility mode; arbitrary data is never an attendance event', () => {
  const flat = fixture().RealTime;
  assert.equal(readAttendance(flat, config()).rejected, 'unsupported_envelope');
  const cfg = loadConfig({ ...baseEnv('/tmp/synthetic.sqlite'), CAMS_ALLOW_LEGACY_FLAT: 'true' });
  assert.equal(readAttendance(flat, cfg).userId, 'EMP-1');
  assert.equal(readAttendance({ AuthToken: 'test-cams-secret', data: { arbitrary: true } }, cfg).rejected, 'unsupported_event');
});

test('resends deduplicate independently of OperationID and timezone representation', () => {
  const a = readAttendance(fixture(), config());
  const b = fixture({ OperationID: 'new-operation' }); b.RealTime.PunchLog.LogTime = '2026-10-24 03:30:00 GMT +0000';
  assert.equal(readAttendance(b, config()).id, a.id);
  b.RealTime.SerialNumber = 'DEV-2'; assert.notEqual(readAttendance(b, config()).id, a.id);
});

test('timestamps validate real calendar dates, explicit offsets, milliseconds and midnight', () => {
  assert.equal(parseTime('2026-10-24 09:00:00.125 GMT +0530'), '2026-10-24T03:30:00.125Z');
  for (const input of ['2026-02-30 09:00:00 GMT +0530', '2026-10-24 25:00:00 GMT +0530',
    '2026-10-24 09:00:00', '2026-10-24 09:00:00 GMT +1460']) assert.throws(() => parseTime(input));
  const event = readAttendance(fixture(), config());
  assert.equal(adapt(event, config().targets[1]).timestamp, '2026-10-24 09:00:00.000000');
  event.occurredAt = '2026-10-23T18:30:00.000Z';
  assert.equal(adapt(event, config().targets[1]).timestamp, '2026-10-24 00:00:00.000000');
});

test('native Frappe and configurable mapped adapter use device-scoped employee mapping', () => {
  const env = { ...baseEnv('/tmp/synthetic.sqlite'), SEMPL_ERPNEXT_EMPLOYEE_MAP_JSON: '{"DEV-1:EMP-1":"SEMPL-42"}',
    BGC_SIXORBIT_MODE: 'mapped-json', BGC_SIXORBIT_FIELD_MAP_JSON: '{"employee":"employeeId","punch_time":"occurredAt","company":"company"}' };
  const cfg = loadConfig(env), event = readAttendance(fixture(), cfg);
  assert.deepEqual(adapt(event, cfg.targets[1]), { employee_field_value: 'SEMPL-42', timestamp: '2026-10-24 09:00:00.000000',
    device_id: 'DEV-1', log_type: 'IN', employee_fieldname: 'attendance_device_id' });
  assert.deepEqual(adapt(event, cfg.targets[0]), { employee: 'EMP-1', punch_time: '2026-10-24T03:30:00.000Z', company: 'BGC' });
});

test('employee mapping keys cannot collide across colon-containing identities; malformed surrogate IDs fail', () => {
  const cfg = loadConfig({ ...baseEnv('/tmp/synthetic.sqlite'), SEMPL_ERPNEXT_EMPLOYEE_MAP_JSON: '{"DEV%3A1:EMP-1":"correct","DEV:1%3AEMP-1":"other"}' });
  const event = readAttendance(fixture({ SerialNumber: 'DEV:1' }), cfg);
  assert.equal(adapt(event, cfg.targets[1]).employee_field_value, 'correct');
  const bad = fixture(); bad.RealTime.PunchLog.UserId = '\ud800';
  assert.throws(() => readAttendance(bad, cfg), /invalid_user/);
});

test('staging check-ins can explicitly skip auto attendance without changing the production default', () => {
  const base = config(), staging = loadConfig({ ...baseEnv('/tmp/synthetic.sqlite'), SEMPL_ERPNEXT_SKIP_AUTO_ATTENDANCE: 'true' });
  const event = readAttendance(fixture(), staging);
  assert.equal(adapt(event, staging.targets[1]).skip_auto_attendance, 1);
  assert.equal(adapt(event, base.targets[1]).skip_auto_attendance, undefined);
  assert.equal(adapt(event, staging.targets[0]).RealTime.PunchLog.UserId, 'EMP-1');
  assert.throws(() => loadConfig({ ...baseEnv('/tmp/synthetic.sqlite'), SEMPL_ERPNEXT_SKIP_AUTO_ATTENDANCE: 'yes' }));
});

test('optional AES-256-ECB callbacks decode before authentication; wrong keys and invalid UTF-8 fail closed', () => {
  const cfg = config(); cfg.encryptionKey = '01'.repeat(32);
  const cipher = createCipheriv('aes-256-ecb', Buffer.from(cfg.encryptionKey, 'hex'), null);
  const data = Buffer.concat([cipher.update(JSON.stringify(fixture())), cipher.final()]).toString('base64');
  assert.equal(readAttendance(decodeBody(Buffer.from(data), cfg), cfg).userId, 'EMP-1');
  cfg.encryptionKey = '02'.repeat(32); assert.throws(() => decodeBody(Buffer.from(data), cfg));
  assert.throws(() => decodeBody(Buffer.from([0xff]), config()));
});

test('device registry binds token and route to its serial; unknown and mismatched devices cannot authenticate', () => {
  const cfg = loadConfig({ ...baseEnv('/tmp/synthetic.sqlite'), CAMS_DEVICES_JSON: JSON.stringify([
    { serialNumber: 'DEV-1', authToken: 'test-cams-secret', targets: ['sempl'] },
    { serialNumber: 'DEV-2', authToken: 'other-token' }]) });
  assert.deepEqual(readAttendance(fixture(), cfg).targets, ['sempl']);
  assert.equal(readAttendance(fixture({ SerialNumber: 'DEV-2' }), cfg).rejected, 'unauthorized');
  assert.equal(readAttendance(fixture({ SerialNumber: 'UNKNOWN' }), cfg).rejected, 'unauthorized');
});

test('startup fails closed for incomplete or unsafe contracts and storage settings', () => {
  const env = baseEnv('/tmp/synthetic.sqlite');
  for (const key of ['CAMS_AUTH_TOKEN', 'QUEUE_DB_PATH', 'BGC_SIXORBIT_TOKEN', 'BGC_SIXORBIT_URL',
    'SEMPL_ERPNEXT_API_SECRET', 'SEMPL_ERPNEXT_URL', 'BGC_SIXORBIT_MODE', 'BGC_SIXORBIT_SUCCESS_PATH', 'BGC_SIXORBIT_SUCCESS_VALUE']) {
    const copy = { ...env }; delete copy[key]; assert.throws(() => loadConfig(copy), undefined, key);
  }
  for (const overrides of [{ BGC_SIXORBIT_URL: 'ftp://example.test' }, { BGC_SIXORBIT_URL: 'https://user:secret@example.test' },
    { NODE_ENV: 'production' }, { QUEUE_DB_PATH: ':memory:' }, { QUEUE_DB_PATH: './relative' },
    { CAMS_ENCRYPTION_KEY_HEX: 'bad' }, { CAMS_DEVICES_JSON: '[]' }, { BGC_SIXORBIT_SUCCESS_PATH: '__proto__.polluted' },
    { BGC_SIXORBIT_TIME_ZONE: 'invalid' }, { DELIVERY_TIMEOUT_MS: 'NaN' }]) assert.throws(() => loadConfig({ ...env, ...overrides }));
});
