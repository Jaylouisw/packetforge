'use strict';
// event-types.test.js - the event vocabulary is known, so a typo and a quiet type are different answers.
//
//   SW1#show logging dchp
//   % No event of type "dchp" has happened here
//   % Types with events so far: arp-request, drop, frame, lldp, ping
//   % A type is named after what happened (drop, acl-deny, dhcp, stp-block, ...), so this is
//   %   either a type that has not happened yet or a typo - "show logging" lists them all
//
// The console admitted it could not tell the difference, because nothing in the model knew the
// vocabulary - `drop` in a lab with no drops and `dchp` were the same answer, and the sentence then
// guessed at examples ("... so this is either ..."). It is now a closed set (`EVENT_TYPES` in
// engine/simulator.js), so:
//
//   * a word outside it can never appear  -> refused as a typo, with the count and the nearest names;
//   * a word inside it has not happened yet -> said so, and named as a type the console records;
//   * `show logging types` is the vocabulary itself, with how many of each have happened here.
//
// The guard this suite really is: the set is derived from the sources and from what scenarios
// actually produce, so a new event type added anywhere in engine/ fails here until it is declared,
// and a declared type that nothing emits fails here too.
const fs = require('fs');
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const { EVENT_TYPES } = require('../engine/simulator');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function lab() {
  const t = new Topology();
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const pc = t.addDevice(find('generic-pc')); pc.name = 'PC1';
  const sp = Array.from(sw.interfaces.values());
  const rp = Array.from(r.interfaces.values());
  const pp = Array.from(pc.interfaces.values())[0];
  t.connect(sw.id, sp[0].name, r.id, rp[0].name);
  t.connect(sw.id, sp[1].name, pc.id, pp.name);
  const sim = new Simulator(t);
  const ss = new CliSession(sw, t, sim); ss.run('enable');
  const rs = new CliSession(r, t, sim); rs.run('enable');
  const ps = new CliSession(pc, t, sim); ps.run('enable');
  ps.run('configure terminal'); ps.run('interface ' + pp.name);
  ps.run('ip address 10.0.0.2 255.255.255.0'); ps.run('end');
  rs.run('configure terminal'); rs.run('interface ' + rp[0].name);
  rs.run('ip address 10.0.0.1 255.255.255.0'); rs.run('end');
  return { t: t, sim: sim, ss: ss, rs: rs, ps: ps };
}

console.log('A word outside the vocabulary can never happen:');
{
  const env = lab();
  env.ps.run('ping 10.0.0.1');
  const out = text(env.ss.run('show logging dchp'));
  ok(/^%.*"dchp" is not a type this console records/.test(out), 'dchp is refused as a type that does not exist');
  ok(/so no event of it can ever appear/.test(out), 'and says why that is final');
  ok(/lists the \d+ types this console does record/.test(out), 'and points at the vocabulary');
  ok(/Types with events so far/.test(out), 'and still reports what is present');
  ok(!/either a type that has not happened yet or a typo/.test(out), 'the shrug is gone');
  const near = text(env.ss.run('show logging dnsx'));
  ok(/Closest:/.test(near), 'a near miss names the type it is probably meant to be');
}

console.log('\nA word inside the vocabulary has simply not happened yet:');
{
  const env = lab();
  env.ps.run('ping 10.0.0.1');
  const out = text(env.ss.run('show logging dns'));
  ok(/No event of type "dns" has happened here yet/.test(out), 'dns is quiet, not unknown');
  ok(/it is a type this console records/.test(out), 'and is named as a recorded type');
  // Abbreviation resolves against the vocabulary, not only against what has happened.
  ok(/No event of type "drop" has happened here yet/.test(text(env.ss.run('show logging dro'))),
    'an abbreviation of a quiet type resolves to the type');
  ok(/No event of type "dhcp" has happened here yet/.test(text(env.ss.run('show logging dh'))),
    'and so does a shorter one');
  // A type that has happened still filters.
  ok(/^Event log \(/.test(text(env.ss.run('show logging ping'))), 'a type with events filters the log');
}

console.log('\nThe vocabulary is a view, not a sentence:');
{
  const env = lab();
  env.ps.run('ping 10.0.0.1');
  const out = text(env.ss.run('show logging types'));
  ok(/^Event types this console records \(\d+\), and how many have happened here:/.test(out),
    'show logging types answers');
  ok(/^\s*Type\s+Events/m.test(out), 'as a table of type and count');
  for (const t of ['drop', 'acl-deny', 'dhcp', 'dns', 'stp-block', 'frame', 'ping']) {
    ok(new RegExp('^ {2}' + t.replace('-', '\\-') + '\\s', 'm').test(out), 'it lists ' + t);
  }
  ok(/^\s+ping\s+\d+/m.test(out), 'a type with events carries its count');
  ok(/have not happened in this lab yet/.test(out), 'and the quiet ones are explained');
  ok(/'`-' is a type|a `-` is a type/.test(out), 'a dash is a type, not a typo');
}

console.log('\nThe set is the code: nothing emits a type it does not declare:');
{
  // Derived from the emission sites, the same way a reader would: the `type:` field of an event
  // object. Inner protocol fields (`{ type: 'na' }` inside an ICMPv6 body) are not event types, so
  // the sweep below - what scenarios actually produce - is the authority; this is the pointer.
  const engineDir = path.join(__dirname, '..', 'engine');
  const found = new Set();
  for (const f of fs.readdirSync(engineDir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(engineDir, f), 'utf8');
    for (const m of src.matchAll(/type: '([a-z0-9-]+)'/g)) found.add(m[1]);
  }
  const declared = Array.from(EVENT_TYPES);
  ok(declared.length >= 40, 'the vocabulary is declared (' + declared.length + ' types)');
  // Every declared type appears somewhere in the sources: a declaration nothing emits is a type the
  // console would offer and never produce.
  const orphan = declared.filter(function (t) { return !found.has(t); });
  ok(orphan.length === 0, 'every declared type is emitted somewhere in engine/'
    + (orphan.length ? ' - orphans: ' + orphan.join(', ') : ''));

  // And the other direction, from a run: every type a scenario produces is declared.
  const env = lab();
  env.ps.run('ping 10.0.0.1');
  env.ps.run('ping 10.9.9.9');
  env.ss.run('converge');
  const produced = new Set((env.sim.events || []).map(function (e) { return e.type; }));
  const undeclared = Array.from(produced).filter(function (t) { return !EVENT_TYPES.has(t); });
  ok(undeclared.length === 0, 'every type the lab produced is declared'
    + (undeclared.length ? ' - undeclared: ' + undeclared.join(', ') : ''));
  ok(produced.size >= 3, 'and the lab produced several (' + produced.size + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
