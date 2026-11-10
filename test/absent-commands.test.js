'use strict';
// absent-commands.test.js - the commands an operator brings from a lab guide, and what this console
// answers instead.
//
// Measured before this pass:
//   SW1#show cdp neighbors        % Invalid show command: cdp neighbors
//   SW1#show inventory            % Invalid show command: inventory
//   SW1#show processes cpu        % Invalid show command: processes cpu
//   SW1#show users                % Invalid show command: users
//   SW1#show history              % Invalid show command: history
//   SW1#show interfaces Fa0/1 switchport   <- printed the plain detail view, dropped the word
//   SW1#show interfaces counters errors    % No interface named errors on SW1
//
// A refusal that reads like a typo sends the operator looking for a fault that is not there. Each of
// these is a real IOS command with a real equivalent here, and the equivalent is one line away.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}
function match(re, haystack, msg) {
  if (haystack && Array.isArray(haystack.output)) haystack = haystack.output;
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 900)) + ')'));
}
function noMatch(re, haystack, msg) {
  if (haystack && Array.isArray(haystack)) haystack = haystack.join('\n');
  const text = String(haystack);
  ok(!re.test(text), msg + (re.test(text) ? ' (matched ' + re + ')' : ''));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

function lab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const pc = t.addDevice(PC); pc.name = 'PC1';
  const ports = Array.from(sw.interfaces.keys()).filter(function (n) {
    const i = sw.interfaces.get(n);
    return !i.svi && !i.parent;
  });
  t.connect(pc.id, 'eth0', sw.id, ports[0]);
  const sim = new Simulator(t);
  const a = new CliSession(sw, t, sim); a.run('enable');
  const cfg = function (cmds) {
    a.run('configure terminal');
    const out = [];
    for (const c of cmds) out.push.apply(out, a.run(c).output);
    a.run('end');
    return out;
  };
  return { t: t, sim: sim, sw: sw, a: a, cfg: cfg, p1: ports[0] };
}

console.log('\nCDP is answered with the protocol that is modelled:');
{
  const env = lab();
  for (const cmd of ['show cdp', 'show cdp neighbors', 'show cdp neighbors detail', 'show cdp interface']) {
    const out = env.a.run(cmd);
    match(/% CDP is not modelled/, out, '"' + cmd + '" says CDP is not modelled');
    match(/show lldp neighbors \[<port>\]/, out, 'and names the LLDP table that answers it');
    match(/show lldp neighbors detail/, out, 'including the detail form');
    noMatch(/Invalid show command/, out, 'with no "invalid command" anywhere in it');
  }
}

console.log('\nThe device facts that exist are named when a command asks for ones that do not:');
{
  const env = lab();
  match(/no inventory.*no serial numbers/s, env.a.run('show inventory'),
    'show inventory explains there is no inventory');
  match(/"show version" \(vendor, model, capabilities, port count\)/, env.a.run('show inventory'),
    'and points at the command that does name the device');
  match(/"show interfaces transceiver"/, env.a.run('show inventory'), 'and at the optics view');
  // Those pointers have to be real.
  match(/Vendor\s+: generic/, env.a.run('show version'), 'show version answers');
  match(/copper: there are no module bays|transceiver/i, env.a.run('show interfaces transceiver'),
    'so does the transceiver view');
  match(/no environmental sensors/, env.a.run('show environment'), 'show environment explains itself');
  match(/"show power inline"/, env.a.run('show environment'), 'and points at the one power view here');
  match(/no environmental sensors/, env.a.run('show power supply'),
    'show power supply takes the same answer, since it is the same absence');
  match(/No CPU and no scheduler/, env.a.run('show processes cpu'), 'show processes cpu explains itself');
  match(/line rate/, env.a.run('show processes cpu'), 'naming what the model does instead');
  match(/show interfaces counters/, env.a.run('show processes cpu'), 'and the table that has the numbers');
}

console.log('\nThere is no wall clock, and that is a sentence rather than a typo:');
{
  const env = lab();
  // `show clock` has its own answer already, and it is better than anything a table could add: it
  // states what time means in this model.
  match(/This lab has no wall clock/, env.a.run('show clock'), 'show clock says what time means here');
  match(/ping <dst> at 5000/, env.a.run('show clock'), 'and shows how an instant is asked for');
  match(/no time source to synchronise with/, env.a.run('show ntp status'),
    'show ntp says there is no time source');
  match(/append "at <ms>" or "converged"/, env.a.run('show ntp status'), 'and how instants work');
}

console.log('\nOne session, and `show history` is a view of it:');
{
  const env = lab();
  // A fresh console has typed nothing, and must say so rather than print an empty table.
  const t2 = new Topology();
  const sw2 = t2.addDevice(SWITCH); sw2.name = 'SW2';
  const fresh = new CliSession(sw2, t2, new Simulator(t2));
  match(/No commands in this session yet/, fresh.run('show history'),
    'a fresh session has no history and says so');
  // Now type something and ask again.
  fresh.run('enable');
  fresh.run('configure terminal');
  fresh.run('hostname SW2');
  fresh.run('end');
  const h = fresh.run('show history');
  match(/Last \d+ commands? in this session/, h, 'the history is a list');
  match(/hostname SW2/, h, 'the commands typed are in it');
  match(/configure terminal/, h, 'all of them');
  // The question must not change the answer.
  const again = fresh.run('show history');
  eq(again.output.length, h.output.length, '"show history" is not itself recorded');
  // Bounded, because a long run types thousands of lines.
  for (let i = 0; i < 30; i++) fresh.run('show version');
  const capped = fresh.run('show history');
  match(/IOS keeps the last 10 by default/, capped, 'the window is IOS\'s 10, and the total is stated');
  ok(capped.output.filter(function (l) { return /show version/.test(l); }).length === 10,
    'with exactly ten lines shown');
  match(/Unexpected argument "extra"/, fresh.run('show history extra'), 'a trailing word is refused');
}

console.log('\nshow users / sessions / line say what the session model is:');
{
  const env = lab();
  for (const cmd of ['show users', 'show sessions', 'show line']) {
    match(/One session: this console/, env.a.run(cmd), '"' + cmd + '" explains there is one session');
    match(/"show history"/, env.a.run(cmd), 'and points at the record of it');
  }
}

console.log('\n`show interfaces <port> switchport` is the L2 view, not the counters again:');
{
  const env = lab();
  env.cfg(['vlan 20 name users', 'interface ' + env.p1, 'switchport mode access',
    'switchport access vlan 20', 'description uplink to floor 2']);
  const out = env.a.run('show interfaces ' + env.p1 + ' switchport');
  match(/Name: Fa0\/1/, out, 'it names the port');
  match(/Administrative Mode: static access/, out, 'the administrative mode');
  match(/Access Mode VLAN: 20 \(users\)/, out, 'the access VLAN and its name');
  match(/Port Security: Disabled/, out, 'port security state');
  match(/Description: uplink to floor 2/, out, 'and the description');
  noMatch(/input :|output:|packets/, out, 'and none of the counter lines: this is the other view');
  // A trunk answers with trunking, and the allowed list is what was configured.
  env.cfg(['interface ' + env.p1, 'switchport mode trunk', 'switchport trunk native vlan 20',
    'switchport trunk allowed vlan 10,20,30']);
  const trunk = env.a.run('show interfaces ' + env.p1 + ' switchport');
  match(/Administrative Mode: trunk/, trunk, 'a trunk reads trunk');
  match(/Trunking Native Mode VLAN: 20/, trunk, 'its native VLAN');
  match(/Trunking VLANs Enabled: 10,20,30/, trunk, 'and its allowed list, sorted');
  noMatch(/Access Mode VLAN/, trunk, 'with no access VLAN line, because it is not an access port');
  // A shut port says so on the mode line rather than silently looking healthy.
  env.cfg(['interface ' + env.p1, 'shutdown']);
  match(/Administrative Mode: trunk \(administratively down\)/,
    env.a.run('show interfaces ' + env.p1 + ' switchport'), 'a shut port is marked administratively down');
  env.cfg(['interface ' + env.p1, 'no shutdown']);
  // Port security appears in this view when it is on, and its state is the one the other view gives.
  // (Port security is an access-port feature here, so the trunk is turned back into an access port -
  // that refusal is its own test, in port-security.test.js.)
  env.cfg(['interface ' + env.p1, 'switchport mode access', 'switchport access vlan 20',
    'switchport port-security', 'switchport port-security maximum 2',
    'switchport port-security violation restrict']);
  const sec = env.a.run('show interfaces ' + env.p1 + ' switchport');
  match(/Port Security: Enabled/, sec, 'port security shows as enabled');
  match(/Maximum MAC Addresses: 2/, sec, 'with its limit');
  match(/Violation Mode: restrict/, sec, 'and its violation mode');
  match(/Status: Secure-up/, sec, 'and the port\'s security state');
  // A logical interface has no switchport state, and the refusal says why.
  env.cfg(['interface vlan 20', 'ip address 10.0.0.2 255.255.255.0']);
  match(/is a logical interface: it has no switchport state/, env.a.run('show interfaces vlan 20 switchport'),
    'an SVI is refused by name');
  match(/Vlan20/, env.a.run('show interfaces vlan 20'), 'and `show interfaces vlan 20` resolves the SVI');
  match(/Unexpected argument/, env.a.run('show interfaces ' + env.p1 + ' switchport extra'),
    'a trailing word is refused');
}

console.log('\nThe show interfaces family names the three tables that answer:');
{
  const env = lab();
  for (const cmd of ['show interfaces switchport', 'show interfaces counters errors', 'show interfaces summary']) {
    const out = env.a.run(cmd);
    noMatch(/No interface named/, out, '"' + cmd + '" is not read as a port name');
    match(/show interfaces status|show interfaces counters/, out,
      '"' + cmd + '" points at the tables that do answer');
  }
  match(/is not a command here/, env.a.run('show interfaces summary'),
    'a word with no view of its own is refused as a command');
  match(/No per-port error counters are kept/, env.a.run('show interfaces counters errors'),
    'the error-counter form says why there are none');
  match(/show interfaces counters/, env.a.run('show interfaces counters errors'),
    'and where the drop totals are');
  match(/show interfaces <port> switchport/, env.a.run('show interfaces switchport'),
    'including the view this pass added');
  // `show switchport` alone is answered too.
  match(/no "show switchport"/, env.a.run('show switchport'), 'show switchport explains the split');
  match(/show interfaces status/, env.a.run('show switchport interface ' + env.p1),
    'and points at the tables, even with a port named');
}

console.log('\nThe hardware the model does not have is a sentence, not an "invalid command":');
{
  const env = lab();
  // `show tech-support` is what an operator types when something is wrong. A model with no memory
  // image, no registers and no log file cannot collect one - but it can say what it *does* answer.
  match(/no tech-support bundle/, env.a.run('show tech-support'), 'show tech-support explains itself');
  match(/show running-config/, env.a.run('show tech-support'), 'and names the configuration view');
  match(/show ip route \/ show ip ospf \/ show ip bgp summary/, env.a.run('show tech-support'),
    'and the forwarding views, in one line');
  match(/show logging \/ show history/, env.a.run('show tech-support'), 'and what happened');
  for (const [cmd, re, why] of [
    ['show memory', /no memory, buffers or controller registers/i, 'no RAM'],
    ['show buffers', /no memory, buffers or controller registers/i, 'no buffer pools'],
    ['show controllers', /no memory, buffers or controller registers/i, 'no registers'],
    ['show diagnostics', /no on-board diagnostics/i, 'no self-tests'],
    ['show flash', /no filesystem/i, 'no flash'],
    ['show filesystems', /no filesystem/i, 'no filesystems'],
    ['show license', /no licence/i, 'no licence'],
    ['show boot', /no boot image/i, 'no boot variables'],
    ['show module', /one fixed chassis/i, 'no modules'],
    ['show stack', /one fixed chassis/i, 'no stacking']
  ]) {
    noMatch(/% Invalid show command/, env.a.run(cmd), cmd + ' is not called a typo');
    match(re, env.a.run(cmd), cmd + ' names the absence (' + why + ')');
  }
  match(/write memory/, env.a.run('show flash'), 'show flash names where configuration actually lives');
}

console.log('\nEvery command a refusal points at is really a command:');
{
  const env = lab();
  // The rule the older families were held to, applied mechanically: take the pointers out of the
  // refusal text and run them. A pointer to a command that does not exist is worse than no pointer.
  const absent = ['show tech-support', 'show memory', 'show flash', 'show module', 'show inventory',
    'show environment', 'show processes cpu', 'show switchport', 'show interfaces switchport'];
  let checked = 0;
  for (const cmd of absent) {
    const out = env.a.run(cmd).output || [];
    const lines = out.filter(function (l) { return /^\s*%\s{2,}(show|write|copy)\s/.test(l); })
      .concat(out.filter(function (l) { return /^\s*%/.test(l) && /"(show|write|copy) /.test(l); }));
    for (const line of lines) {
      const segments = line.split(' / ');
      for (const seg of segments) {
        const m = seg.match(/\b((?:show|write|copy)\s+[a-z0-9][a-z0-9\-]*(?:\s+[a-z0-9<>\[\]\-]+)*)/i);
        if (!m) continue;
        // Try the longest candidate, then shorten - a pointer may name an argument too.
        const words = m[1].trim().split(/\s+/);
        let answered = false;
        for (let n = words.length; n >= 2 && !answered; n--) {
          const candidate = words.slice(0, n).join(' ');
          const res = (env.a.run(candidate).output || []).join('\n');
          if (!/% (Invalid|Unrecognized)/i.test(res)) answered = true;
        }
        ok(answered, '"' + m[1].trim() + '" (offered by "' + cmd + '") is a command that answers');
        checked++;
      }
    }
  }
  ok(checked >= 8, 'the sweep itself found pointers to check (' + checked + ' found)');
}

console.log('\nA genuinely unknown command is still refused as one:');
{
  const env = lab();
  match(/% Invalid show command: bogus/, env.a.run('show bogus'), 'an invented word is not dressed up');
  match(/% Invalid show command: ip bogus/, env.a.run('show ip bogus'), 'nor is a wrong sub-word');
  // And the absent table does not swallow a real command that happens to share a word.
  match(/Protocol\s+Address\s+Age/, env.a.run('show arp'), 'show arp still answers');
  match(/MAC|mac/i, env.a.run('show mac address-table'), 'the MAC table still answers');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
