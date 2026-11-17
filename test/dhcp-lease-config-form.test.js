'use strict';
// `show running-config` printed a lease line no box prints (#fidelity: lease config form).
//
// `lease {days [hours [minutes]] | infinite}` takes three optional fields, and a box prints back only the ones the
// duration needs: a 12-hour pool reads `lease 0 12`, a 20-minute one `lease 0 0 20`, a one-day one `lease 1`.
// This printer wrote all three every time, so the 12-hour pool was saved as `lease 0 12 0` - a line that replays
// but that no IOS-like device produces (research/dhcp-lease-running-config-form.md).
//
// What is asserted: the three canonical shapes, that the leading zeros are kept when a later field is set, that a
// hand-edited sub-minute duration keeps the old form rather than a bare `lease 0`, and that every printed line is
// accepted back and yields the same duration.
const path = require('path');
const { Device } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /^ISR 4331$/.test(s.model); })[0] ||
  catalog.filter(function (s) { return /ISR 4331/.test(s.model); })[0];

function session() {
  const dev = new Device('r1', ROUTER);
  const cli = new CliSession(dev, null, null);
  return {
    dev: dev,
    run: function (cmds) {
      const out = [];
      for (const c of cmds) {
        let r;
        try { r = cli.run(c); } catch (e) { out.push('% EXCEPTION: ' + e.message); continue; }
        for (const l of ((r && r.output) || [])) out.push(String(l));
      }
      return out;
    }
  };
}

const POOL = function (leaseLine) {
  return ['enable', 'configure terminal', 'ip dhcp pool lan', 'network 192.168.10.0 255.255.255.0',
    'range 192.168.10.100 192.168.10.200', leaseLine, 'exit', 'end'];
};
const leaseLineIn = function (lines) {
  return (lines.filter(function (l) { return /^\s+lease\s/.test(l); })[0] || '').trim();
};
const leaseOf = function (dev) {
  const pool = (dev.config.dhcpPools || []).filter(function (p) { return p.name === 'lan'; })[0];
  if (!pool) return null;
  return (typeof pool.leaseSec === 'string' && pool.leaseSec.toLowerCase() === 'infinite')
    ? 'infinite' : Number(pool.leaseSec);
};

console.log('A twelve-hour lease prints two fields, not three:');
{
  const s = session();
  s.run(POOL('lease 0 12 0'));
  const cfg = s.run(['show running-config']);
  ok(leaseLineIn(cfg) === 'lease 0 12', 'the pool reads back as `lease 0 12`', leaseLineIn(cfg));
  ok(cfg.indexOf('lease 0 12 0') === -1, 'and the invented third field is gone');
  ok(leaseOf(s.dev) === 43200, 'the stored duration is unchanged (43200 s)', String(leaseOf(s.dev)));
}

console.log('\nA one-day lease prints one field:');
{
  const s = session();
  s.run(POOL('lease 1'));
  ok(leaseLineIn(s.run(['show running-config'])) === 'lease 1', 'the pool reads back as `lease 1`',
    leaseLineIn(s.run(['show running-config'])));
}

console.log('\nA days-and-hours lease keeps the hours, drops the minutes:');
{
  const s = session();
  s.run(POOL('lease 1 6 0'));
  ok(leaseLineIn(s.run(['show running-config'])) === 'lease 1 6', 'the pool reads back as `lease 1 6`',
    leaseLineIn(s.run(['show running-config'])));
}

console.log('\nMinutes cannot stand alone, so the leading zeros stay:');
{
  const s = session();
  s.run(POOL('lease 0 0 20'));
  ok(leaseLineIn(s.run(['show running-config'])) === 'lease 0 0 20', 'the pool reads back as `lease 0 0 20`',
    leaseLineIn(s.run(['show running-config'])));

  const h = session();
  h.run(POOL('lease 0 3 20'));
  ok(leaseLineIn(h.run(['show running-config'])) === 'lease 0 3 20',
    'an hours-and-minutes lease keeps all three fields', leaseLineIn(h.run(['show running-config'])));
}

console.log('\nA duration no command can express keeps the old form:');
{
  // 30 seconds: only reachable by hand-editing a lab file, since `lease` takes whole minutes. Printing `lease 0`
  // would be a line no box accepts and that would not replay, so the three-field form is kept.
  const s = session();
  s.dev.config.dhcpPools = [{ name: 'lan', network: '192.168.10.0', mask: '255.255.255.0',
    rangeStart: '192.168.10.100', rangeEnd: '192.168.10.200', leaseSec: 30 }];
  const line = leaseLineIn(s.run(['show running-config']));
  ok(line === 'lease 0 0 0', 'a sub-minute duration still prints three fields rather than a bare `lease 0`', line);
}

console.log('\nEvery printed form replays to the same duration:');
{
  for (const line of ['lease 0 12 0', 'lease 1', 'lease 1 6 0', 'lease 0 0 20', 'lease 0 3 20', 'lease infinite']) {
    const a = session();
    a.run(POOL(line));
    const printed = a.run(['show running-config']);
    const b = session();
    const rejected = b.run(['configure terminal'].concat(printed).concat(['end']))
      .filter(function (l) { return /^%/.test(l); });
    ok(rejected.length === 0, '`' + leaseLineIn(printed) + '` is accepted back', rejected.slice(0, 2).join(' | '));
    ok(leaseOf(b.dev) === leaseOf(a.dev), 'and yields the same duration for ' + leaseLineIn(printed),
      String(leaseOf(a.dev)) + ' vs ' + String(leaseOf(b.dev)));
    ok(leaseLineIn(b.run(['show running-config'])) === leaseLineIn(printed),
      'and prints the same form the second time');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
