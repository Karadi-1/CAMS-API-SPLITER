'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class QueueStore {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    // Open/create privately before SQLite creates its WAL/SHM sidecars.
    fs.closeSync(fs.openSync(filename, 'a', 0o600));
    fs.chmodSync(filename, 0o600);
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL REFERENCES events(id),
        target TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT, source TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','inflight','delivered','dead')),
        attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER NOT NULL, lease_ms INTEGER NOT NULL DEFAULT 0,
        error TEXT, record_id TEXT, updated_ms INTEGER NOT NULL, UNIQUE(event_id,target));
      CREATE INDEX IF NOT EXISTS delivery_queue ON deliveries(target,status,seq);`);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  enqueue(eventId, deliveries, maxQueue) {
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM events WHERE id=?').get(eventId)) return false;
      const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status!='delivered'").get();
      if (n + deliveries.length > maxQueue) throw new Error('queue_full');
      const now = Date.now();
      this.db.prepare('INSERT INTO events VALUES (?,?)').run(eventId, now);
      const insert = this.db.prepare('INSERT INTO deliveries(event_id,target,fingerprint,payload,source,status,next_ms,updated_ms,error) VALUES (?,?,?,?,?,?,?,?,?)');
      for (const d of deliveries) insert.run(eventId, d.target, d.fingerprint, d.payload === null ? null : JSON.stringify(d.payload),
        JSON.stringify(d.source), d.error ? 'dead' : 'pending', now, now, d.error || null);
      return true;
    });
  }

  claim(target, leaseMs, maxAttempts) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM deliveries WHERE target=? AND status IN ('pending','inflight') ORDER BY seq LIMIT 1").get(target);
      const now = Date.now();
      if (!row || row.next_ms > now || (row.status === 'inflight' && row.lease_ms > now)) return null;
      if (row.attempts >= maxAttempts) {
        this.db.prepare("UPDATE deliveries SET status='dead',error='attempts_exhausted_after_restart',updated_ms=? WHERE seq=?").run(now, row.seq);
        return null;
      }
      this.db.prepare("UPDATE deliveries SET status='inflight',attempts=attempts+1,lease_ms=?,updated_ms=? WHERE seq=?").run(now + leaseMs, now, row.seq);
      return { ...row, attempts: row.attempts + 1, status: 'inflight' };
    });
  }

  success(row, recordId) {
    this.db.prepare("UPDATE deliveries SET status='delivered',payload=NULL,source=NULL,error=NULL,record_id=?,lease_ms=0,updated_ms=? WHERE seq=? AND status='inflight' AND attempts=?")
      .run(recordId || null, Date.now(), row.seq, row.attempts);
  }

  failure(row, reason, retry, nextMs) {
    this.db.prepare('UPDATE deliveries SET status=?,error=?,next_ms=?,lease_ms=0,updated_ms=? WHERE seq=? AND status=\'inflight\' AND attempts=?')
      .run(retry ? 'pending' : 'dead', reason, nextMs, Date.now(), row.seq, row.attempts);
  }

  summary() {
    this.db.prepare('SELECT 1').get();
    const counts = { pending: 0, inflight: 0, delivered: 0, dead: 0 };
    for (const row of this.db.prepare('SELECT status,COUNT(*) AS n FROM deliveries GROUP BY status').all()) counts[row.status] = row.n;
    const oldest = this.db.prepare("SELECT MIN(e.created_ms) AS time FROM events e JOIN deliveries d ON d.event_id=e.id WHERE d.status IN ('pending','inflight')").get().time;
    return { counts, oldestPendingAgeMs: oldest === null ? 0 : Date.now() - oldest };
  }

  dead() {
    return this.db.prepare("SELECT event_id,target,fingerprint,error,attempts,updated_ms FROM deliveries WHERE status='dead' ORDER BY seq LIMIT 100").all();
  }

  replay(eventId, target, fingerprint, rebuild) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM deliveries WHERE event_id=? AND target=? AND status='dead' AND source IS NOT NULL").get(eventId, target);
      if (!row || (!rebuild && row.fingerprint !== fingerprint)) return false;
      const payload = rebuild ? JSON.stringify(rebuild(JSON.parse(row.source))) : row.payload;
      if (payload === null || (!rebuild && row.error === 'unmapped_punch_type')) return false;
      this.db.prepare("UPDATE deliveries SET status='pending',attempts=0,next_ms=?,lease_ms=0,error=NULL,updated_ms=?,payload=?,fingerprint=? WHERE seq=?")
        .run(Date.now(), Date.now(), payload, fingerprint, row.seq);
      return true;
    });
  }

  close() { this.db.close(); }
}

module.exports = { QueueStore };
