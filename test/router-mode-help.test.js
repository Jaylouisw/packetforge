'use strict';
// router-mode-help.test.js - two processes, one prompt, and a page that belonged to only one of them.
//
// `router ospf 1` and `router bgp 65001` both say (config-router)#, which is deliberate. The help
// page was OSPF's for both, so a BGP process was shown:
//
//   R1(config-router)#?
//     network <net> <wildcard> area <id>     <- OSPF's verb, refused in a BGP process
//     no network <net> <wildcard> area <id>
//     router-id <ip>                         <- refused here too ("not a router bgp command")
//
// and was not shown `neighbor <ip> remote-as <as>`, the one verb BGP has. The page and the parser
// disagreed in both directions at once, which is why this suite asserts the property rather than the
// rows: **every row a mode shows is accepted in that mode, and every row it hides is refused there**
// with the mode's own words.
//
// Probing also found `bgp router-id <ip>` refused in global config mode, although this console's own
// usage text named it as a config-mode command, and `ospf router-id` accepted on a PC.
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
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ', wanted ' + JSON.stringify(expected) + ')'));
}
function saw(re, haystack, msg) {
  const text = (haystack && haystack.output) ? haystack.output.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (in ' + JSON.stringify(text.slice(0, 500)) + ')'));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const model = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function session(kind, name) {
  const t = new Topology();
  const d = t.addDevice(model(kind)); d.name = name || 'R1';
  const s = new CliSession(d, t, new Simulator(t)); s.run('enable'); s.run('configure terminal');
  return { t: t, d: d, s: s };
}
function rows(s) {
  return s.run('?').output.filter(function (l) { return /^ {2}\S/.test(l); })
    .map(function (l) { return l.trim().split(/\s{2,}/)[0]; });
}
// A row is a synopsis with placeholders; this fills them with values a router accepts.
const VALUES = {
  '<ip>': '10.10.0.9', '<as>': '65010', '<net>': '10.10.0.0', '<wildcard>': '0.0.0.255',
  '<id>': '0', '<process-id>': '1', '<mask>': '255.255.255.0', '<name>': 'core',
  '<port>': null, '<addr>': '10.10.0.9', '<vlan>': '10', '<vrid>': '1', '<n>': '10',
  '<prefix>': '192.168.0.0', '<len>': '24', '<dest>': null
};
function fill(row, port) {
  return row.replace(/<[a-z-]+(-\[[^\]]*\])?>/g, function (m) {
    const key = m.replace(/-\[[^\]]*\]$/, '');
    if (key === '<port>') return port || 'Gi0/0';
    const v = VALUES[key];
    return v === undefined || v === null ? 'x' : v;
  }).split(/\s*\|\s*/)[0];
}

console.log('\nA BGP process shows BGP verbs - and only verbs it accepts:');
{
  const env = session('generic-router');
  env.s.run('router bgp 65001');
  const page = rows(env.s);
  ok(page.length > 3, 'the page has rows (' + page.length + ')');
  ok(page.some(function (r) { return /^neighbor <ip> remote-as <as>$/.test(r); }),
    'it offers neighbor <ip> remote-as <as>');
  ok(page.some(function (r) { return /^no neighbor <ip>$/.test(r); }), 'and its removal');
  ok(page.some(function (r) { return /^bgp router-id <ip>$/.test(r); }), 'and bgp router-id');
  ok(!page.some(function (r) { return /area/.test(r); }),
    'it does not offer OSPF\'s network <net> <wildcard> area <id>');
  ok(!page.some(function (r) { return /^router-id <ip>$/.test(r); }),
    'nor a bare router-id, which a BGP process refuses');
  // The property: every row it shows, it takes.
  const port = Array.from(env.d.interfaces.keys())[0];
  for (const row of page) {
    const line = fill(row, port);
    const out = (env.s.run(line).output || []).join('\n');
    ok(!/not a router bgp command|Unrecognized|Invalid input/.test(out),
      'BGP mode accepts what it shows: "' + line + '"' + (/not a router|Unrecognized/.test(out) ? ' [' + out.slice(0, 120) + ']' : ''));
  }
}

console.log('\nAn OSPF process keeps its own page:');
{
  const env = session('generic-router');
  env.s.run('router ospf 1');
  const page = rows(env.s);
  ok(page.some(function (r) { return /^network <net> <wildcard> area <id>$/.test(r); }),
    'it offers the network/area shorthand');
  ok(page.some(function (r) { return /^router-id <ip>$/.test(r); }), 'and router-id, which it accepts');
  ok(!page.some(function (r) { return /^neighbor/.test(r); }), 'and does not offer BGP\'s neighbor');
  ok(!page.some(function (r) { return /^bgp router-id/.test(r); }), 'nor bgp router-id');
  const port = Array.from(env.d.interfaces.keys())[0];
  for (const row of page) {
    const line = fill(row, port);
    const out = (env.s.run(line).output || []).join('\n');
    ok(!/is not a router ospf command|Unrecognized|Invalid input/.test(out),
      'OSPF mode accepts what it shows: "' + line + '"' + (/not a router ospf|Unrecognized/.test(out) ? ' [' + out.slice(0, 120) + ']' : ''));
  }
}

console.log('\nThe modes keep their vocabulary apart:');
{
  const env = session('generic-router');
  env.s.run('router bgp 65001');
  const o = env.s.run('network 10.10.0.0 0.0.0.255 area 0');
  ok(/not modelled|not a router bgp command/.test((o.output || []).join('\n')),
    'an OSPF statement inside BGP is refused in BGP terms');
  // `network` is a verb BGP knows and declines to model, so that refusal is about the statement; a
  // verb BGP does not know at all gets the mode's vocabulary instead.
  saw(/In this mode: neighbor <ip> remote-as <as>, bgp router-id <ip>, exit, end/,
    env.s.run('router-id 1.1.1.1'), 'a foreign verb names the ones that do work there');
  env.s.run('exit');
  env.s.run('router ospf 1');
  const o2 = env.s.run('neighbor 10.10.0.2 remote-as 65002');
  saw(/not a router ospf command/, o2, 'a BGP statement inside OSPF is refused in OSPF terms');
}

console.log('\nThe process verbs work from global config, because the console said they did:');
{
  const env = session('generic-router');
  env.s.run('router bgp 65001');
  const a = env.s.run('bgp router-id 2.2.2.2');
  saw(/BGP router-id 2\.2\.2\.2/, a, 'bgp router-id works inside the process');
  env.s.run('end');
  env.s.run('configure terminal');
  const b = env.s.run('bgp router-id 2.2.2.2');
  saw(/already configured/, b, 'and from global config, where it is already set');
  const c = env.s.run('bgp neighbor 10.10.0.4 remote-as 65004');
  saw(/BGP neighbor 10\.10\.0\.4 remote-as 65004/, c, 'as does bgp neighbor <ip> remote-as <as>');
  const dump = env.s.run('show running-config').output.join('\n');
  saw(/router bgp 65001/, dump, 'the dump opens the process');
  saw(/bgp router-id 2\.2\.2\.2/, dump, 'and carries the identifier inside it');
  saw(/neighbor 10\.10\.0\.4 remote-as 65004/, dump, 'and each peer');
}

console.log('\nThe same line twice is the same configuration:');
{
  const env = session('generic-router');
  env.s.run('router bgp 65001');
  env.s.run('neighbor 10.10.0.2 remote-as 65002');
  const again = env.s.run('neighbor 10.10.0.2 remote-as 65002');
  saw(/already configured/, again, 'a repeated neighbor line says nothing changed');
  eq((env.d.config.bgp.neighbors || []).length, 1, 'and there is still one peer');
  const changed = env.s.run('neighbor 10.10.0.2 remote-as 65009');
  saw(/was 65002/, changed, 'changing the AS says what it was');
  eq(env.d.config.bgp.neighbors[0].remoteAs, 65009, 'and the peer holds the new AS');
  const rid = env.s.run('bgp router-id 3.3.3.3');
  saw(/BGP router-id 3\.3\.3\.3/, rid, 'the identifier is set');
  const rid2 = env.s.run('bgp router-id 3.3.3.3');
  saw(/already configured/, rid2, 'and setting it twice says so');
}

console.log('\nA device that cannot route is refused every spelling of a routing protocol:');
{
  for (const kind of ['generic-switch', 'generic-pc']) {
    const env = session(kind, 'D');
    for (const line of ['ospf router-id 1.1.1.1', 'ospf area 0']) {
      const o = env.s.run(line);
      saw(/is not a router/, o, kind + ' is refused "' + line + '"');
    }
    const page = rows(env.s);
    ok(!page.some(function (r) { return /ospf|bgp/.test(r); }),
      kind + ' is offered no routing-protocol row at all (page: ' + page.length + ' rows)');
    const rbgp = env.s.run('router bgp 65001');
    saw(/cannot run BGP|is not a router/, rbgp, kind + ' is refused a BGP process');
    const brid = env.s.run('bgp router-id 1.1.1.1');
    saw(/cannot run BGP|is not a router/, brid, kind + ' is refused bgp router-id');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
