'use strict';
// abbrev.test.js — IOS keyword abbreviation.
//
// `sh ip int br` is the most-typed line in networking, and this console refused it outright:
//
//   R1#sh ip int br
//   % Unrecognized command: sh ip int br
//
// while `conf t` and `en` worked only because they were hand-coded aliases - a list that can never be
// complete. IOS's rule is better: a keyword may be abbreviated to any prefix that identifies exactly
// one command at that point, an ambiguous prefix is refused by name, and abbreviation never touches a
// *value*.
//
// The forms are parsed out of `help`, not kept in a second list, so a command is abbreviatable
// exactly when it is documented. That is the property this suite leans on: every assertion below is
// also an assertion that help and the parser still agree.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const abbrev = require('../engine/abbrev');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')'));
}
function match(re, text, msg) {
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(String(text).slice(0, 300)) + ')'));
}
function model(name) {
  const found = loadCatalog(path.join(__dirname, '..', 'devices')).find((x) => x.model === name);
  if (!found) throw new Error('no such model: ' + name);
  return found;
}

// One lab, one session: abbreviations are only meaningful if the command they expand *to* happens to
// be the same command an operator meant, so most assertions compare the abbreviated line's output
// with the full line's output rather than checking for a substring.
function lab() {
  const t = new Topology();
  const pc = t.addDevice(model('generic-pc'));
  const r1 = t.addDevice(model('generic-router'));
  pc.name = 'PC1'; r1.name = 'R1';
  t.connect(pc.id, 'eth0', r1.id, 'Gi0/0');
  const sim = new Simulator(t);
  const session = function () {
    const s = new CliSession(r1, t, sim);
    s.run('enable');
    return s;
  };
  const run = function (lines) {
    const s = session();
    const out = [];
    for (const line of lines) out.push.apply(out, s.run(line).output);
    return out.join('\n');
  };
  return { t, sim, run, session };
}

console.log('The strings people actually type:');
{
  const l = lab();
  const pairs = [
    ['sh version', 'show version'],
    ['sh ip int br', 'show ip interface brief'],
    ['sh run', 'show running-config'],
    ['sh ip route', 'show ip route'],
    ['sh ip route summ', 'show ip route summary'],
    ['sh int trans', 'show interfaces transceiver'],
    ['sh power in', 'show power inline'],
    ['sh logging summ', 'show logging summary'],
    ['sh clock', 'show clock'],
    ['sh ipv6 int', 'show ipv6 interface'],
    ['sh ip dhcp bind', 'show ip dhcp binding']
  ];
  for (const [short, full] of pairs) {
    eq(l.run([short]), l.run([full]), '"' + short + '" answers exactly as "' + full + '"');
  }
}

console.log('\nAmbiguity is refused by name, not guessed:');
{
  const l = lab();
  const out = l.run(['sh l']);
  match(/% Ambiguous command: "sh l"/, out, 'a prefix that matches two commands is refused');
  match(/% Candidates: lldp, logging/, out, 'and the candidates are named, alphabetically');
  const i = l.run(['sh i']);
  match(/% Candidates: interfaces, ip, ipv6/, i, 'a deeper ambiguity lists all three');
  // The refusal must not be a dead end: naming the candidates is what makes the prefix fixable.
  ok(!/Unrecognized/.test(i), 'an ambiguous prefix is not reported as unrecognised - it is a different problem');
}

console.log('\nA prefix that matches nothing is left alone:');
{
  const l = lab();
  const out = l.run(['sh nosuchthing']);
  match(/% Invalid show command: nosuchthing/, out,
    'a typo still says what it is instead of being bent into a real command');
  match(/% Unrecognized command: frobnicate/, l.run(['frobnicate']),
    'a nonsense verb is still unrecognised');
  eq(l.run(['sh ip route summ']), l.run(['show ip route summary']),
    'and a real prefix is not affected by the typo path next door');
}

console.log('\nValues are never abbreviated:');
{
  const l = lab();
  // A device named after a keyword: `show logging device links` must filter on the *name* links, not
  // expand it into the `show links` command. Abbreviation is about keywords; a value is a value.
  l.t.getDevice('d1').name = 'links';
  const out = l.run(['show logging device links']);
  match(/events on links|No events/, out, 'a device name that is also a keyword is still a name');
  ok(!/^Cable/m.test(out), 'and it did not run `show links`');
  // A description containing keywords is stored, not executed.
  const desc = l.run(['configure terminal', 'interface Gi0/0', 'description route to core', 'exit', 'exit',
    'show running-config']);
  match(/description route to core/, desc, 'a description full of keywords survives verbatim');
}

console.log('\nExact matches win over longer keywords:');
{
  const l = lab();
  const int = l.run(['configure terminal', 'int Gi0/0', 'ip address 10.0.0.1 255.255.255.0']);
  match(/IP address set on Gi0\/0/, int, '`int` is the alias, not a prefix of `interface`');
  // In config mode, where both `interface` and its alias `int` exist - exec mode has neither, which
  // is the difference between an ambiguity and a missing command.
  const amb = l.run(['configure terminal', 'in Gi0/0']);
  match(/% Ambiguous command: "in Gi0\/0"/, amb, '`in` is genuinely ambiguous between interface and int');
  match(/% Candidates: int, interface/, amb, 'and both readings are named');
}

console.log('\nEvery mode gets it, from one place:');
{
  const l = lab();
  const cfg = l.run(['configure terminal', 'ip rou 0.0.0.0 0.0.0.0 10.0.0.254', 'exit',
    'show ip route']);
  match(/S\*? +0\.0\.0\.0\/0/, cfg, 'config mode: `ip rou` is `ip route`');
  const pool = l.run(['configure terminal', 'ip dhcp pool lan', 'net 10.9.9.0 255.255.255.0',
    'ran 10.9.9.100 10.9.9.110', 'def 10.9.9.1', 'lease 0 0 10', 'exit', 'exit',
    'show ip dhcp pool']);
  match(/Network +: 10\.9\.9\.0/, pool, 'dhcp pool mode: `net` is `network`');
  match(/Router +: 10\.9\.9\.1/, pool, 'and `def` is `default-router`');
  match(/600s/, pool, 'the lease length came through too');
  const iface = l.run(['configure terminal', 'interface Gi0/1', 'ip add 10.1.1.1 255.255.255.0',
    'ip hel 10.1.1.9', 'of 1', 'exit', 'exit', 'show running-config']);
  match(/ip address 10\.1\.1\.1 255\.255\.255\.0/, iface, 'interface mode: `ip add` is `ip address`');
  match(/ip helper-address 10\.1\.1\.9/, iface, 'and `ip hel` is `ip helper-address`');
  // `do` inside configuration defers to the exec tree - including for abbreviations, which is the
  // part a naive implementation gets wrong (it would expand `do` and leave the tail alone).
  const doShow = l.run(['configure terminal', 'do sh ip int br', 'exit']);
  match(/Interface +IP-Address/, doShow, '`do sh ip int br` reaches the exec command abbreviated');
}

console.log('\nThe executable commands are unchanged by abbreviation:');
{
  const l = lab();
  // `ping`'s target is a value and its keywords come after it: both must survive one pass.
  const ping = l.run(['ping 10.0.0.1 cou 1']);
  match(/Sending 1, 100-byte ICMP Echos/, ping, 'a keyword after a value is expanded (`cou` -> `count`)');
  const trace = l.run(['trac 10.0.0.1']);
  match(/Tracing the route/, trace, '`trac` is `traceroute`');
  const nsl = l.run(['nsl web.lab.test']);
  match(/web\.lab\.test/, nsl, 'a name that is not a keyword passes through untouched');
  match(/no DNS server in this lab hosts a zone/, nsl,
    'and the answer is the honest one for a lab with no zones, not an abbreviation artefact');
}

console.log('\nThe forms come from help, so the two cannot disagree:');
{
  const l = lab();
  const forms = l.session()._helpForms('enable');
  ok(forms.length > 80, 'the exec tree is built from help (' + forms.length + ' forms)');
  const has = (prefix) => forms.some((f) => f.map((t) => (typeof t === 'object' ? '<>' : t)).join(' ')
    .indexOf(prefix) === 0);
  ok(has('show running-config'), 'and it contains the commands help documents');
  ok(has('show ip route'), 'including the long ones');
  // The parse has to survive the shapes the help output actually uses, or commands vanish silently.
  const cases = {
    'ipv6 nd ra enable|disable': ['ipv6 nd ra enable', 'ipv6 nd ra disable'],
    'link up|down <id> [at <ms>]': ['link up <id> at <ms>', 'link up <id>', 'link down <id> at <ms>', 'link down <id>'],
    'interface <name> | int <name>': ['interface <name>', 'int <name>'],
    'enable / en': ['enable', 'en'],
    'show flows [<id> | counters]': ['show flows <id>', 'show flows counters', 'show flows']
  };
  for (const [synopsis, wanted] of Object.entries(cases)) {
    const got = abbrev.expandSynopsis(synopsis)
      .map((f) => f.map((t) => (typeof t === 'object' ? '<' + t.placeholder + '>' : t)).join(' '));
    eq(got.slice().sort().join(' | '), wanted.slice().sort().join(' | '),
      'synopsis "' + synopsis + '" reads as ' + wanted.length + ' forms');
  }
}

console.log('\nA long synopsis keeps its tail:');
{
  // The regression that made this suite necessary twice: the synopsis was being cut at the help
  // padding column, so `show ip route [<dest>|…|summary]` parsed as `show ip route os`. A truncation
  // looks like a missing feature rather than a parsing bug.
  const forms = abbrev.expandSynopsis('show ip route [<dest>|connected|static|ospf|bgp|summary] [at <ms>|converged]')
    .map((f) => f.map((t) => (typeof t === 'object' ? '<' + t.placeholder + '>' : t)).join(' '));
  for (const want of ['show ip route summary', 'show ip route bgp', 'show ip route ospf at <ms>']) {
    ok(forms.indexOf(want) !== -1, '"' + want + '" survives the parse');
  }
  const l = lab();
  const parsed = l.session()._helpForms('enable')
    .map((f) => f.map((t) => (typeof t === 'object' ? '<>' : t)).join(' '));
  ok(parsed.indexOf('show ip route summary') !== -1,
    'and the help row itself is not truncated at the padding column');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
