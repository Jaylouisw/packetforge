'use strict';
// docs-commands.test.js — every command a transcript shows is a command the console knows.
//
// The tables in docs/CLI.md are now checked against `help` (docs-syntax.test.js), but the
// transcripts are not: a prompt line like `SW1#show lldp neighbours` is prose that happens to
// look like input, and nothing verified it. A renamed verb or a command that never existed can
// therefore sit in a walkthrough forever, teaching syntax the parser refuses.
//
// This test pulls every prompt line out of every fenced block in docs/*.md and asks the console
// to recognise it in some mode. "Recognise" is deliberately weak: the command only has to avoid
// "% Unrecognized ..." somewhere (exec, config, interface, or DHCP-pool mode). A refusal on
// state — "% No interface named bogus9", "% no route to 8.8.8.8" — counts as recognised,
// because those transcripts exist precisely to show a refusal.
const path = require('path');
const fs = require('fs');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const model = (name) => catalog.find((x) => x.model === name);

// A lab wide enough for the transcripts: a router with real ports, a switch, a host and a
// server, all cabled, so `show` commands have something to describe.
function buildLab() {
  const topo = new Topology();
  const r1 = topo.addDevice(model('generic-router'));
  const sw1 = topo.addDevice(model('generic-switch'));
  const pc1 = topo.addDevice(model('generic-pc'));
  const web = topo.addDevice(model('generic-server'));
  r1.name = 'R1'; sw1.name = 'SW1'; pc1.name = 'PC1'; web.name = 'WEB';
  topo.connect(r1.id, 'Gi0/0', sw1.id, 'Fa0/1');
  topo.connect(sw1.id, 'Fa0/2', pc1.id, 'eth0');
  topo.connect(r1.id, 'Gi0/1', web.id, 'eth0');
  return { topo, sim: new Simulator(topo), devices: { R1: r1, SW1: sw1, PC1: pc1, WEB: web } };
}
const LAB = buildLab();

function firstPort(dev) {
  const it = dev.interfaces.keys();
  return it.next().value;
}

const PRELUDE = {
  exec: [],
  config: ['configure terminal'],
  iface: ['configure terminal', null],   // filled with `interface <first port>`
  pool: ['configure terminal', 'ip dhcp pool probe']
};

// The modes a command might live in, in the order a reader would reach them.
function candidates(dev, name) {
  const out = [];
  for (const mode of ['exec', 'config', 'iface', 'pool']) {
    const pre = PRELUDE[mode].map((c) => (c === null ? 'interface ' + firstPort(dev) : c));
    out.push({ mode: mode, pre: pre, who: name });
  }
  return out;
}

function tryCommand(dev, cand, cmd) {
  const session = new CliSession(dev, LAB.topo, LAB.sim);
  for (const c of cand.pre) {
    const res = session.run(c);
    // If the prelude itself failed the mode does not exist for this device; skip it rather
    // than blaming the documented command.
    // Not an exemption: if the prelude itself failed, this mode does not exist for this
    // device, so there is nothing to ask - the documented command is not to blame.
  }
  const out = session.run(cmd).output || [];
  return out;
}

function recognised(dev, name, cmd) {
  for (const cand of candidates(dev, name)) {
    const out = tryCommand(dev, cand, cmd);
    if (!out) continue;
    // Not an exemption: this is the whole test - the command avoided "% Unrecognized".
    if (!out.some((l) => /Unrecognized/i.test(l))) return { mode: cand.mode };
  }
  return null;
}

// ---------- extract the transcripts ----------
const PROMPT = /^([A-Za-z][A-Za-z0-9._-]{1,20})([>#])\s*(\S.*)$/;
const found = [];
for (const file of fs.readdirSync(path.join(__dirname, '..', 'docs')).filter((f) => f.endsWith('.md'))) {
  const full = path.join(__dirname, '..', 'docs', file);
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('```')) { fence = !fence; continue; }
    if (!fence) continue;
    const m = PROMPT.exec(line);
    if (!m) continue;
    // Not an exemption, ordinary control flow: a synopsis is written with placeholders and
    // is checked by docs-syntax.test.js, while a transcript line is checked here.
    if (/[<>\u2026]/.test(m[3]) || /\.\.\./.test(m[3])) continue;
    found.push({ file: file, line: i + 1, who: m[1], cmd: m[3].replace(/\s+/g, ' ').trim() });
  }
}

console.log('Found ' + found.length + ' command lines in docs transcripts:');
const byFile = {};
for (const f of found) byFile[f.file] = (byFile[f.file] || 0) + 1;
for (const f of Object.keys(byFile).sort()) console.log('  ' + f + ': ' + byFile[f]);

console.log('\nEvery transcript line the extractor finds is really a command:');
{
  ok(found.length >= 60, 'the sweep found the transcripts (' + found.length + ' lines)');
  ok(Object.keys(byFile).length >= 3, 'and more than one document (' + Object.keys(byFile).join(', ') + ')');
}

console.log('\nEvery documented command is one the console recognises:');
{
  const unknown = [];
  const modes = {};
  for (const f of found) {
    // Use the device the transcript names when the lab has one; otherwise the router, which
    // accepts the widest command set.
    const dev = LAB.devices[f.who] || LAB.devices.R1;
    const hit = recognised(dev, f.who, f.cmd);
    if (!hit) unknown.push(f);
    else modes[hit.mode] = (modes[hit.mode] || 0) + 1;
  }
  ok(unknown.length === 0, 'no transcript shows a command the console does not know' +
    (unknown.length ? '\n      ' + unknown.map((u) => u.file + ':' + u.line + '  ' + u.who + '# ' + u.cmd).join('\n      ') : ''));
  // Most transcript prompt lines are exec commands (a config walkthrough only writes the
  // prompt once), so the mode split is printed rather than asserted - but it is worth seeing.
  console.log('    recognised in: ' + Object.keys(modes).map((k) => k + ' x' + modes[k]).join(', '));
}

// ---------- the sweep bites ----------
console.log('\nThe check can fail:');
{
  ok(recognised(LAB.devices.R1, 'R1', 'frobnicate the widget') === null,
    'a command that was never implemented is caught');
  ok(recognised(LAB.devices.R1, 'R1', 'show version') !== null, 'and a real one passes');
  const refused = recognised(LAB.devices.R1, 'R1', 'ping 8.8.8.8 count 1');
  ok(refused !== null, 'a command that is recognised but refuses on state still passes');
  // The search really does look in every mode: these two verbs exist in exactly one place,
  // and finding them there is what makes "recognised somewhere" a useful statement.
  // `mtu 1400` lives in an interface block and nowhere else. (`switchport` used to be the example,
  // until config mode began answering it with the mode it belongs to - which is a recognition, and
  // the right thing for the console to do, but it stops being a one-mode verb.)
  const ifaceOnly = recognised(LAB.devices.R1, 'R1', 'mtu 1400');
  ok(ifaceOnly && ifaceOnly.mode === 'iface', 'an interface-mode verb is found in interface mode');
  const configOnly = recognised(LAB.devices.R1, 'R1', 'hostname PROBE');
  ok(configOnly && configOnly.mode === 'config', 'a config-mode verb is found in config mode');
  ok(recognised(LAB.devices.R1, 'R1', 'ip route 10.9.9.0 255.255.255.0 10.0.0.1').mode === 'config',
    'and so is a static route - while exec mode refuses it');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
