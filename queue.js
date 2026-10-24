'use strict';

const { loadConfig } = require('./lib/config');
const { QueueStore } = require('./lib/store');
const { adapt } = require('./lib/attendance');

function main(args = process.argv.slice(2)) {
  const config = loadConfig();
  const store = new QueueStore(config.dbPath);
  try {
    if (args.length === 1 && args[0] === 'status') {
      console.log(JSON.stringify({ ...store.summary(), dead: store.dead(),
        activeContracts: config.targets.map(t => ({ target: t.id, company: t.company, fingerprint: t.fingerprint })) }, null, 2)); return;
    }
    if ([5, 7].includes(args.length) && args[0] === 'replay' && args[1] === '--event' && /^[a-f0-9]{64}$/.test(args[2]) && args[3] === '--target') {
      const target = config.targets.find(t => t.id === args[4]);
      const rebuild = args.length === 7;
      if (!target || (rebuild && (args[5] !== '--rebuild-for-contract' || args[6] !== target.fingerprint)) ||
          !store.replay(args[2], target.id, target.fingerprint, rebuild ? event => adapt(event, target) : null)) {
        throw new Error('Replay refused: target/event must be dead, retain its payload and match the original target contract');
      }
      console.log('Failed delivery requeued; completed destinations remain unchanged.'); return;
    }
    throw new Error('Usage: node queue.js status | replay --event <event-id> --target bgc|sempl [--rebuild-for-contract <current-fingerprint>]');
  } finally { store.close(); }
}

if (require.main === module) {
  process.umask(0o077);
  try { main(); } catch (err) { console.error(err.code ? 'Queue command failed' : err.message); process.exitCode = 1; }
}

module.exports = { main };
