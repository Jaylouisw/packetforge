'use strict';
// dhcp-excluded-and-clear.test.js - the two halves of a DHCP server an operator reaches for next.
//
//   R1(config-dhcp)#excluded-address 10.9.0.1 10.9.0.5
//   R1#show ip dhcp pool
//     Excluded   : [object Object], [object Object], [object Object]
//   PC1#show ip interface brief
//   eth0       10.9.0.2/24  YES  DHCP  up  up          <- inside the excluded range
//
// Two things were wrong with that line. `excluded-address <low> <high>` is ONE range on a router, and
// it was stored as two separate single addresses, so the addresses between them stayed leaseable and
// a client was handed one from the middle of a range the operator had excluded. And the pool view
// printed the exclusion records raw, so `[object Object]` was the only thing the exclusion ever
// looked like from the console. The second half is `clear ip dhcp binding`, which did not exist: the
// binding table could fill up and never be emptied.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function lab(clients) {
  const t = new Topology();
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const swp = Array.from(sw.interfaces.values()).filter(function (i) { return !i.svi; }).map(function (i) { return i.name; });
  t.connect(r.id, 'Gi0/0', sw.id, swp[0]);
  const pcs = [];
  for (let i = 0; i < (clients || 1); i++) {
    const pc = t.addDevice(find('generic-pc')); pc.name = 'PC' + (i + 1);
    t.connect(sw.id, swp[i + 1], pc.id, Array.from(pc.interfaces.values())[0].name);
    pcs.push(pc);
  }
  const sim = new Simulator(t);
  const s = new CliSession(r, t, sim); s.run('enable');
  s.run('configure terminal', 'interface Gi0/0', 'ip address 10.9.0.1 255.255.255.0', 'no shutdown', 'exit', 'end');
  const clis = pcs.map(function (pc) {
    const c = new CliSession(pc, t, sim); c.run('enable');
    c.run('configure terminal', 'interface eth0', 'ip address dhcp', 'end');
    c.run('show ip interface brief');            // drives the exchange
    return c;
  });
  return { t: t, sim: sim, r: r, sw: sw, s: s, clis: clis };
}

console.log('excluded-address <low> <high> is one range:');
{
  const env = lab(2);
  env.s.run('configure terminal', 'ip dhcp pool LAN', 'network 10.9.0.0 255.255.255.0',
    'default-router 10.9.0.1', 'excluded-address 10.9.0.1 10.9.0.5', 'exit', 'end');
  // A fresh pair of clients, so the exchange sees the exclusions.
  const env2 = lab(2);
  env2.s.run('configure terminal', 'ip dhcp pool LAN', 'network 10.9.0.0 255.255.255.0',
    'default-router 10.9.0.1', 'excluded-address 10.9.0.1 10.9.0.5', 'exit', 'end');
  env2.clis.forEach(function (c) { c.run('renew dhcp'); });
  const ips = env2.clis.map(function (c) {
    const m = /10\.9\.0\.(\d+)\/24/.exec(text(c.run('show ip interface brief')));
    return m ? Number(m[1]) : null;
  });
  ok(ips[0] === 6, 'the first client is given .6, past the whole excluded range (got ' + ips[0] + ')');
  ok(ips[1] === 7, 'and the second is given .7 (got ' + ips[1] + ')');
  const pools = text(env.s.run('show ip dhcp pool'));
  ok(/Excluded\s+: 10\.9\.0\.1-10\.9\.0\.5/.test(pools), 'the pool view prints the range as a range');
  ok(!/\[object Object\]/.test(pools), 'and never prints a record as [object Object]');
  // 10.9.0.1-10.9.0.254 is 254 addresses; the excluded 10.9.0.1-10.9.0.5 takes five of them, so 249.
  ok(/In use\s+: \d+ of 249/.test(pools), 'the excluded addresses are not counted as leaseable');
}

console.log('\na single excluded address is still a single address:');
{
  const env = lab();
  env.s.run('configure terminal', 'ip dhcp pool LAN', 'network 10.9.0.0 255.255.255.0',
    'excluded-address 10.9.0.2', 'exit', 'end');
  env.clis[0].run('renew dhcp');
  const brief = text(env.clis[0].run('show ip interface brief'));
  ok(/10\.9\.0\.3\/24/.test(brief), 'the client skips the one excluded address and takes the next');
  ok(/Excluded\s+: 10\.9\.0\.2$/.test(text(env.s.run('show ip dhcp pool')).trim()) ||
     /Excluded\s+: 10\.9\.0\.2/.test(text(env.s.run('show ip dhcp pool'))), 'the view shows the single address');
}

console.log('\nthe exclusion survives a save and a reload without doubling:');
{
  const env = lab();
  env.s.run('configure terminal', 'ip dhcp pool LAN', 'network 10.9.0.0 255.255.255.0',
    'excluded-address 10.9.0.1 10.9.0.5', 'exit', 'end');
  const run = text(env.s.run('show running-config'));
  ok(/^  excluded-address 10\.9\.0\.1-10\.9\.0\.5$/m.test(run), 'it is dumped in the form it is stored');
  env.s.run('write memory');
  env.s.run('copy startup-config running-config');
  const again = text(env.s.run('show ip dhcp pool'));
  ok((again.match(/10\.9\.0\.1-10\.9\.0\.5/g) || []).length === 1, 'a paste does not double the exclusion');
}

console.log('\nclear ip dhcp binding empties the table it is named after:');
{
  const env = lab();
  env.s.run('configure terminal', 'ip dhcp pool LAN', 'network 10.9.0.0 255.255.255.0',
    'default-router 10.9.0.1', 'exit', 'end');
  ok(/02:00:00:00:02:00\s+10\.9\.0\.2/.test(text(env.s.run('show ip dhcp binding'))),
    'the binding is in the table');
  const bare = text(env.s.run('clear ip dhcp binding'));
  ok(/Incomplete command/.test(bare), 'a bare clear names the two spellings rather than emptying anything');
  ok(/02:00:00:00:02:00\s+10\.9\.0\.2/.test(text(env.s.run('show ip dhcp binding'))),
    'and the table is untouched by it');
  const wrong = text(env.s.run('clear ip dhcp binding 10.9.0.99'));
  ok(/No binding for 10\.9\.0\.99/.test(wrong), 'an address that is not held is refused by name');
  ok(/10\.9\.0\.2/.test(wrong), 'and the refusal lists what is held');
  const cleared = text(env.s.run('clear ip dhcp binding *'));
  ok(/Cleared 1 binding: 10\.9\.0\.2/.test(cleared), 'the clear reports what it removed');
  ok(/keep the addresses they hold until they renew/.test(cleared),
    'and says the client is not reached out to');
  ok(/no client has completed an exchange/.test(text(env.s.run('show ip dhcp binding'))),
    'the table is empty, and says why it is empty');
  ok(/In use\s+: 0 of 253/.test(text(env.s.run('show ip dhcp pool'))), 'the pool agrees it is serving nobody');
  ok(/10\.9\.0\.2\/24/.test(text(env.clis[0].run('show ip interface brief'))),
    'and the client still holds its address, as the sentence said');
}

console.log('\na device that is not a DHCP server says so:');
{
  const env = lab();
  const sw = new CliSession(env.sw, env.t, env.sim); sw.run('enable');
  const out = text(sw.run('clear ip dhcp binding *'));
  ok(/is not a DHCP server/.test(out), 'the switch refuses the command and names what it is not');
  ok(!/Cleared/.test(out), 'and does not claim to have cleared anything');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
