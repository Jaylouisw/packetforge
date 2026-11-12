'use strict';
// Every `show` form the CLI documentation names, typed at a console (#1477's sibling, #1479).
//
// `test/help-completeness.test.js` guards the console's own index in both directions, but its command list is
// hand-written on purpose: it exists to test the console, not to parse prose. Nothing checked the *other* paper
// promise — `docs/CLI.md`, the page an operator reads on Forgejo before they ever open the app. A row that
// advertises a spelling the parser no longer knows sends them to a console that answers
// `% Invalid show command`, which is exactly the moment the docs stop being trustworthy.
//
// So this file reads docs/CLI.md itself, splits the alternatives (`show vlan [brief] | spanning-tree | …`),
// fills the placeholders with real values from a real lab, and types each form. 44 forms today. The test fails on
// the three answers that mean "the docs and the parser disagree": an invalid command, an unrecognised command, or
// a throw. A legitimate refusal is fine and is not a failure — a switch really does not have `show ip ospf`, and
// it says so in a sentence rather than pretending the word is wrong.
const fs = require('fs');
const path = require('path');
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const { CliSession } = require('../engine/cli');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'CLI.md');
const doc = fs.readFileSync(DOC, 'utf8');

// --- the documented surface ------------------------------------------------
//
// A `show …` in a code span is a promise. `|` separates alternatives, `[x]` marks an optional keyword (both spellings
// are typed), and `<angle>` is a placeholder the operator fills.
function documentedForms(text) {
  const forms = new Set();
  for (const m of String(text).matchAll(/`(show[^`]*)`/g)) {
    let text = m[1].replace(/\s+/g, ' ').trim();
    if (!text || text === 'show') continue;
    for (const part of text.split('|')) {
      const body = part.trim().replace(/^show\s+/i, '');
      if (!body) continue;
      forms.add(body);
      // an optional keyword is a second spelling, and the one with it is the one people copy
      const optional = body.match(/\[([^\]]+)\]/);
      if (optional) forms.add(body.replace(/\[[^\]]+\]/g, optional[1]).replace(/\s+/g, ' ').trim());
      // and the bare spelling without the optional keyword
      if (optional) forms.add(body.replace(/\s*\[[^\]]+\]/g, '').replace(/\s+/g, ' ').trim());
    }
  }
  return Array.from(forms).filter(function (f) { return f.replace(/<[^>]*>/g, '').trim() !== ''; }).sort();
}

function fill(body, ctx) {
  return body
    .replace(/<vlan[\s-]*id>|<vid>/gi, '10')
    .replace(/<port>|<interface>|<name>/gi, ctx.port)
    .replace(/<address>|<ip>|<addr>/gi, '10.0.0.1')
    .replace(/<mac>/gi, '00:11:22:33:44:55')
    .replace(/<vrid>/gi, '1')
    .replace(/<acl>/gi, '100')
    .replace(/<zone>/gi, 'lab.local')
    .replace(/<pool>/gi, 'LAN')
    .replace(/<as>/gi, '65001')
    .replace(/<[^>]*>/g, '1')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- a lab with both a router and a switch, so both families of view exist ----
const specs = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /ISR 4331/.test(s.model); });
const SWITCH = specs.filter(function (s) { return /switch/i.test(s.category || ''); })
  .find(function (s) { return (s.interfaces || []).filter(function (i) { return i.connector === 'rj45'; }).length >= 4; });
const t = new Topology();
t.addDevice(ROUTER, 'r1');
t.addDevice(SWITCH, 'sw');
const sim = new Simulator(t);

function ctxFor(id) {
  const dev = t.getDevice(id);
  const port = Array.from(dev.interfaces.keys()).filter(function (n) {
    return !/^(mgmt|console|aux)/i.test(n);
  })[0];
  return { id: id, port: port };
}

console.log('');
console.log('The documentation names ' + documentedForms(doc).length + ' show forms, and the console answers every one:');
const forms = documentedForms(doc);
ok(forms.length >= 40, 'the forms were enumerated from docs/CLI.md itself', forms.length + ' forms');
ok(new Set(forms).size === forms.length, 'no form is listed twice');

const BROKEN = /^% Invalid show|^% Unrecognized|^% Unknown show|^THREW/;
const broken = [];
const refusals = [];
let typed = 0;
for (const id of ['r1', 'sw']) {
  const ctx = ctxFor(id);
  const session = new CliSession(t.getDevice(id), t, sim);
  for (const body of forms) {
    const cmd = 'show ' + fill(body, ctx);
    typed++;
    let out;
    try { out = ((session.run(cmd) || {}).output || []).join('\n'); }
    catch (err) { out = 'THREW ' + err.message; }
    if (BROKEN.test(out)) broken.push('[' + id + '] ' + cmd + ' -> ' + out.split('\n')[0]);
    else if (/^%/.test(out)) refusals.push(cmd + ' -> ' + out.split('\n')[0]);
  }
}
console.log('    (' + typed + ' commands typed across a router and a switch)');
ok(broken.length === 0, 'no documented form is refused as a spelling the parser does not know',
  broken.slice(0, 6).join(' | '));

console.log('');
console.log('And a view a device does not have says so in a sentence:');
{
  // The refusals that remain must be sentences about the device, not about the word. This is the distinction the
  // whole file turns on: `% Invalid show command` means the docs are wrong; `% This device is not a DHCP server` means
  // the docs are right and this box is not the one to ask.
  const unhelpful = refusals.filter(function (r) { return /Invalid|Unknown|Unrecognized/.test(r); });
  ok(unhelpful.length === 0, 'no refusal is a complaint about the command itself', unhelpful.slice(0, 4).join(' | '));
  ok(refusals.every(function (r) { return r.split('->')[1].trim().length > 12; }),
    'every refusal carries a reason', refusals.slice(0, 3).join(' | '));
  console.log('    (' + refusals.length + ' refusals, all about the device rather than the syntax)');
}

console.log('');
console.log('The sweeps would notice a documented form that no longer exists:');
{
  // The point of reading the doc is that editing the doc changes this test. Prove it against the same parser the
  // file uses, on an edited copy of the text rather than on a second implementation of it.
  const fake = doc + '\n\n| `show ip arp cache purge now` | a row that no console has |\n';
  const added = documentedForms(fake).filter(function (f) { return forms.indexOf(f) === -1; });
  ok(added.length === 1 && /cache purge/.test(added[0]),
    'a row added to the doc would be typed by this file', added.join(', '));

  // Corrupt a form that really is documented, the way a docs edit drifts: one letter. The failure branch above must
  // catch it, or this file is decoration.
  const session = new CliSession(t.getDevice('r1'), t, sim);
  const real = forms.find(function (f) { return /^ip arp$/.test(f); }) || forms[0];
  const words = real.split(' ');
  const drifted = (words[0] + 'x ' + words.slice(1).join(' ')).trim();
  const out = ((session.run('show ' + fill(drifted, ctxFor('r1'))) || {}).output || []).join('\n');
  ok(BROKEN.test(out), 'a documented form with one letter drifted is caught by the failure branch',
    'show ' + drifted + ' -> ' + out.split('\n')[0]);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
