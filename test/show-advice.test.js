'use strict';
// show-advice.test.js - advice printed by a view has to be advice somebody can take.
//
// This is the "no pointer to a command that does not exist" rule applied to *every* view rather than
// to the absent-show table: every quoted command a `show` prints is typed back at the session it was
// printed in, and must not come back as "unrecognized" or as a capability refusal. It found
// `show port-security interface Vlan20` telling the operator to type a command the same console
// refuses on an SVI, one prompt away from working.
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

// The verbs a quoted string may start with. Anything else in quotes is prose ("no cable attached"),
// and typing prose proves nothing.
const VERBS = ['show', 'clear', 'ping', 'traceroute', 'flow', 'write', 'copy', 'reload', 'converge',
  'help', 'enable', 'ip', 'ipv6', 'interface', 'switchport', 'vlan', 'spanning-tree', 'power', 'lldp',
  'hostname', 'arp', 'no', 'shutdown', 'speed', 'duplex', 'mtu', 'channel-group', 'vrrp', 'dhcp',
  'acl', 'firewall', 'nat', 'router', 'network', 'bgp', 'ospf', 'description', 'encapsulation',
  'link', 'clear'];
const FILL = { port: 'Fa0/1', id: '10', ip: '10.0.0.1', mask: '255.255.255.0', addr: '10.0.0.1',
  address: '10.0.0.1', vlan: '10', name: 'TEST', n: '2', mac: '00:11:22:33:44:55', pid: '1',
  'process-id': '1', as: '65001', vrid: '1', group: '1', prefix: '10.9.0.0/24', ms: '100',
  seconds: '60', count: '2', dst: '9.9.9.9', wildcard: '0.0.0.255', net: '10.0.0.0', area: '0' };

function fill(cmd) {
  let missing = null;
  const out = cmd.split(/\s+/).map(function (t) {
    if (/^\[.*\]$/.test(t)) t = t.replace(/[\[\]]/g, '').split('|')[0];
    if (t.indexOf('|') !== -1) t = t.split('|')[0];
    return t.replace(/<([a-z0-9-]+)>/gi, function (m, k) {
      if (FILL[k] === undefined) { missing = k; return ''; }
      return FILL[k];
    });
  }).join(' ').replace(/\s+/g, ' ').trim();
  return { cmd: out, missing: missing };
}

// A switch with an SVI, a trunk, a tagged subinterface and a secured port; and a router to compare.
function labs() {
  const out = [];
  const t = new Topology();
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const pc = t.addDevice(find('generic-pc')); pc.name = 'PC1';
  const swPort = Array.from(sw.interfaces.values()).filter(function (i) { return !i.svi; })[0].name;
  t.connect(sw.id, swPort, pc.id, Array.from(pc.interfaces.values())[0].name);
  const s = new CliSession(sw, t, new Simulator(t));
  s.run('enable'); s.run('configure terminal');
  s.run('interface vlan 20'); s.run('ip address 10.0.20.1 255.255.255.0'); s.run('exit');
  s.run('interface ' + swPort);
  s.run('switchport mode trunk'); s.run('switchport trunk allowed vlan 10,20,30');
  s.run('switchport port-security'); s.run('exit');
  s.run('interface ' + swPort + '.30'); s.run('ip address 10.0.30.1 255.255.255.0'); s.run('exit');
  s.run('end');
  out.push({ name: 'switch exec', s: s, dev: sw, where: 'exec' });
  out.push({ name: 'switch config', s: s, dev: sw, where: 'config' });
  out.push({ name: 'switch SVI block', s: s, dev: sw, where: 'iface', iface: 'Vlan20' });
  out.push({ name: 'switch subif block', s: s, dev: sw, where: 'iface', iface: swPort + '.30' });
  out.push({ name: 'switch port block', s: s, dev: sw, where: 'iface', iface: swPort });
  const r = new Topology();
  const r1 = r.addDevice(find('generic-router')); r1.name = 'R1';
  const rs = new CliSession(r1, r, new Simulator(r1));
  rs.run('enable'); rs.run('configure terminal');
  rs.run('interface Gi0/0'); rs.run('ip address 10.1.1.1 255.255.255.0'); rs.run('exit');
  rs.run('end');
  out.push({ name: 'router exec', s: rs, dev: r1, where: 'exec' });
  return out;
}

function enter(env) {
  const s = env.s;
  // Get the session to the state this view was printed in, without re-running config.
  if (env.where === 'exec') { s.run('end'); return; }
  if (env.where === 'config') { s.run('end'); s.run('configure terminal'); return; }
  s.run('end'); s.run('configure terminal'); s.run('interface ' + env.iface);
}
function leaves(env) { env.s.run('end'); }

// Every quoted span in a view that looks like a command.
function quotedCommands(body) {
  const out = [];
  const re = /"([a-z][^"]{2,60})"/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const word = m[1].split(/\s+/)[0].toLowerCase();
    if (VERBS.indexOf(word) === -1) continue;
    if (word === 'no') {
      const second = (m[1].split(/\s+/)[1] || '').toLowerCase();
      if (VERBS.indexOf(second) === -1 && second.length < 3) continue;
    }
    out.push(m[1]);
  }
  return out;
}

console.log('Every quoted command in a view runs where it was printed:');
{
  const envs = labs();
  let views = 0, quotes = 0, excused = 0;
  const broken = [];
  for (const env of envs) {
    const page = text(env.s.run('?'));
    const showRows = page.split('\n').map(function (l) { return l.trim(); })
      .filter(function (l) { return /^show /.test(l); })
      .map(function (l) { return l.split(/\s{2,}/)[0]; });
    for (const row of new Set(showRows)) {
      const cmd = fill(row).cmd;
      enter(env);
      const body = text(env.s.run(cmd));
      views++;
      for (const quote of quotedCommands(body)) {
        const filled = fill(quote);
        if (!filled.cmd || filled.missing) { excused++; continue; }
        quotes++;
        // The advice is typed where it says to type it: exec for a show/write/copy, an interface
        // block for anything else it names - so try the current state and then the other two.
        let refusedAs = null;
        // The contexts an operator could be in: where the view was printed, global config, exec, and
        // - when the view named a port - that port's own block, which is where an interface-mode verb
        // belongs. Without the last one the sweep called `no lldp transmit` (correctly advised by
        // `show lldp interface <port>`) a broken pointer, because it never typed it in a port.
        const named = cmd.split(/\s+/).filter(function (w) {
          return env.dev.interfaces.has(w) || env.dev.interfaces.has(w.replace(/,+$/, ''));
        })[0];
        const trials = [env.where, 'config', 'exec'].concat(named ? ['iface:' + named] : []);
        let worked = false;
        for (const where of trials) {
          const probe = where.indexOf('iface:') === 0
            ? { s: env.s, where: 'iface', iface: where.slice(6) }
            : { s: env.s, where: where, iface: env.iface };
          enter(probe);
          const answer = text(env.s.run(filled.cmd)).split('\n')[0];
          if (!/% Unrecognized|does not switch|logical interface|is not a switchport|only valid on/.test(answer)) {
            worked = true; break;
          }
          refusedAs = answer;
        }
        if (!worked) broken.push({ view: env.name + ': ' + cmd, advice: filled.cmd, answer: refusedAs });
      }
    }
    leaves(env);
  }
  console.log('  (' + views + ' views, ' + quotes + ' quoted commands typed, ' + excused + ' skipped)');
  ok(views > 40, 'the sweep walked ' + views + ' views');
  ok(quotes > 40, 'and typed ' + quotes + ' quoted commands');
  for (const b of broken.slice(0, 8)) {
    ok(false, b.view + ' -> "' + b.advice + '": ' + String(b.answer).slice(0, 90));
  }
  ok(broken.length === 0, 'no view advises a command that is refused where it would be typed (' +
    broken.length + ' found)');
}

console.log('\nThe case the sweep found, pinned directly:');
{
  const env = labs()[2];   // the switch, parked in its SVI block
  env.s.run('end');
  const svi = text(env.s.run('show port-security interface Vlan20'));
  ok(/logical interface/.test(svi), 'an SVI has no port security, and the view says so');
  ok(/A secured port is one that learns addresses/.test(svi), 'and says what port security is');
  ok(!/Enable it with/.test(svi), 'it no longer advises a command this interface refuses');
  // Port security lives on an access port, not on the trunk the lab's Fa0/1 became.
  env.s.run('configure terminal'); env.s.run('interface Fa0/2');
  env.s.run('switchport port-security'); env.s.run('exit'); env.s.run('end');
  const port = text(env.s.run('show port-security interface Fa0/2'));
  ok(/Port Security\s+: Enabled/.test(port), 'a real secured port still reports its state');
  const idle = text(env.s.run('show port-security interface Fa0/3'));
  ok(/Enable it with "switchport port-security"/.test(idle),
    'and an unsecured physical port keeps the advice, because there it works');
  ok(/not enabled/.test(text(env.s.run('switchport port-security')).slice(0, 80)) === false,
    'the advised command runs in that port\'s block');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
