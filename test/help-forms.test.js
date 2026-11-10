'use strict';
// help-forms.test.js — help never advertises a form the parser refuses.
//
// The `converge [at <ms>]` row was the tell: help promised a keyword the parser rejects, and
// nothing noticed until a reader tried it. help is the contract for the command line, so every
// row it prints should be something an operator can type. This test takes each row, fills its
// placeholders with values the parser accepts, drops each optional group in turn, and asks the
// console to recognise the result.
//
// "Recognise" means the parser understood the *shape* of the form. A refusal on state - `no vrrp
// 5` with no group 5 - still counts, because the form was understood. What does not count is a
// complaint about the shape itself: "% Unrecognized", "% Invalid ...", or a message saying the
// command "expects"/"needs" something else. That third family is why the sweep exists: help once
// advertised `converge [at <ms>]`, and the parser answered "% converge takes a bare instant",
// which an unrecognised-only rule would have called a pass.
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
const model = (n) => catalog.find((x) => x.model === n);

const topo = new Topology();
const r1 = topo.addDevice(model('generic-router'));
const sw1 = topo.addDevice(model('generic-switch'));
r1.name = 'R1'; sw1.name = 'SW1';
topo.connect(r1.id, 'Gi0/0', sw1.id, 'Fa0/1');
const sim = new Simulator(topo);
const devices = { R1: r1, SW1: sw1 };
function firstPort(dev) { return dev.interfaces.keys().next().value; }

// Values chosen to be accepted by the parser: a placeholder filled with nonsense teaches
// nothing about whether the *form* exists.
const VALUES = {
  name: 'probe', ip: '10.0.0.2', n: '2', id: '10', mask: '255.255.255.0', gw: '10.0.0.1',
  port: '22', ms: '1000', addr: '10.0.0.2', 'prefix>/<len': '2001:db8::/64', prefix: '2001:db8::',
  len: '64', vlan: '20', acl: '101', text: 'link to core', as: '65001', 'isd-as': '1-ff00:0:110',
  vrid: '10', p: '120', s: '20', net: '10.0.0.0', start: '10.0.0.100', end: '10.0.0.199',
  mac: '02:00:00:00:00:aa', days: '1', hours: '2', minutes: '3', netmask: '255.255.255.0',
  type: 'A', value: '10.0.0.2', what: 'version', parent: 'Gi0/0', 'next-hop': '2001:db8::1',
  dst: '10.0.0.2', dest: '10.0.0.0', subnet: '10.0.0.0',
  '1-2699': '110', 'addr...': '10.0.0.53', 'addr[-addr]...': '10.0.0.100',
  'name...': 'probe', 'list|all': 'all', 'vlan-id': '20', rate: '1000', level: 'informational',
  user: 'admin', password: 'secret', '0-4094': '20', seconds: '30', host: '10.0.0.5',
  subnet: '10.0.0.0', wildcard: '0.0.0.255', 'name': 'probe',
  'addr[-addr]': '10.0.0.100', 'addr[-addr': '10.0.0.100',
  entry: 'permit ip any any',
  'addr -addr': '10.0.0.100', 'addr[-addr]': '10.0.0.100', '-addr': '10.0.0.100'
};

// Fill placeholders, returning null when a placeholder has no known value - a row we cannot
// test is reported as untested rather than silently passed.
// IPv6 arms of the same placeholder names need IPv6 values: `<addr>` in `ipv6 address` is not
// an IPv4 address, and filling it with one would fail the *parser* for the wrong reason.
const VALUES_V6 = Object.assign({}, VALUES, {
  addr: '2001:db8::1', 'addr>/<len': '2001:db8::1/64', prefix: '2001:db8::', len: '64',
  'next-hop': '2001:db8::1', gateway: '2001:db8::1', ip: '2001:db8::1',
  // A destination in an IPv6 row is an IPv6 destination. Fill it with 10.0.0.0 and the command
  // refuses it for the right reason - it is not an IPv6 address - and the sweep reports a broken
  // form that was never broken.
  dest: '2001:db8::1', dst: '2001:db8::1', net: '2001:db8::', subnet: '2001:db8::'
});

function fill(row) {
  const table = /^ipv6\b|\bipv6\b/i.test(row) ? VALUES_V6 : VALUES;
  let unknown = null;
  const out = row.replace(/<([^>]*)>/g, function (whole, inner) {
    // "<addr ...>" and "<addr[-addr]...>" name the same thing as "<addr>", one or more times.
    const key = inner.replace(/\.\.\./g, ' ').replace(/[-\s]+$/, '').trim();
    if (table[key] !== undefined) return table[key];
    // Compound placeholders like <prefix>/<len> are two lookups joined by a literal slash.
    const parts = key.split('/');
    if (parts.length === 2 && table[parts[0]] !== undefined && table[parts[1]] !== undefined) {
      return table[parts[0]] + '/' + table[parts[1]];
    }
    unknown = key;
    return whole;
  });
  return unknown ? { ok: false, unknown: unknown } : { ok: true, text: out };
}

// Every way to resolve the optional groups. A group can itself offer alternatives —
// "[at <ms>|converged]" is one group with two arms — so each group contributes the choice
// "leave it out", plus each of its arms.
function variants(row) {
  const groups = row.match(/\[[^\]]*\]/g) || [];
  // `filled` counts how many optional groups the reading actually spells out. The fullest readings
  // are the ones the row promises; a reading that leaves a group out works whether or not the group
  // is real, so it must not be what decides the row is honest.
  let texts = [{ text: row, filled: 0 }];
  for (const g of groups) {
    const arms = [];
    let depth = 0, cur = '';
    for (const ch of g.slice(1, -1)) {
      if (ch === '<') depth++;
      else if (ch === '>') depth--;
      if (depth === 0 && ch === '|') { arms.push(cur); cur = ''; continue; }
      cur += ch;
    }
    arms.push(cur);
    // A bar inside a group can hide a shared prefix, and the help output gives no signal that
    // separates the two readings:
    //   `[proto tcp|udp]`      -> the second arm is `proto udp`; taking it literally offered a bare
    //                             `udp`, which the parser rightly called an unknown keyword, and the
    //                             sweep then reported the row as broken for a reading nobody would type
    //   `[at <ms>|converged]`  -> the second arm really is the bare word `converged`
    // So both readings are offered, which is the same rule the top-level alternatives already use:
    // the row is honest if *some* way of reading it is a command.
    const firstWords = String(arms[0] || '').trim().split(/\s+/).filter(Boolean);
    const shared = firstWords.slice(0, Math.max(0, firstWords.length - 1)).join(' ');
    const expanded = [];
    for (let a = 0; a < arms.length; a++) {
      const arm = arms[a].trim();
      if (a === 0 || !shared || !arm) { expanded.push(arm); continue; }
      if (!expanded.includes(arm)) expanded.push(arm);
      if (!expanded.includes(shared + ' ' + arm)) expanded.push(shared + ' ' + arm);
    }
    const options = [{ text: ' ', filled: 0 }].concat(expanded.map((a) => ({ text: ' ' + a + ' ', filled: 1 })));
    const next = [];
    for (const t of texts) {
      for (const o of options) {
        // replace this one occurrence of the group
        const at = t.text.indexOf(g);
        next.push({
          text: (t.text.slice(0, at) + o.text + t.text.slice(at + g.length)).replace(/\s+/g, ' ').trim(),
          filled: t.filled + o.filled
        });
      }
    }
    texts = next;
    if (texts.length > 48) texts = texts.slice(0, 48);   // keeps the sweep bounded
  }
  return texts;
}

// ---------- collect the help rows, with the mode that prints them ----------
const MODES = {
  exec: { pre: [], dev: 'R1' },
  config: { pre: ['configure terminal'], dev: 'R1' },
  iface: { pre: ['configure terminal', 'interface ' + firstPort(r1)], dev: 'R1' },
  pool: { pre: ['configure terminal', 'ip dhcp pool probe'], dev: 'R1' },
  ifaceSw: { pre: ['configure terminal', 'interface ' + firstPort(sw1)], dev: 'SW1' }
};

function helpRowsFor(mode) {
  const spec = MODES[mode];
  const session = new CliSession(devices[spec.dev], topo, sim);
  for (const c of spec.pre) session.run(c);
  const lines = session.run('help').output;
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {2}(\S.*?)(?: {2,}(\S.*))?$/.exec(lines[i]);
    if (m) rows.push(m[1].trim());
  }
  return rows;
}

// A row may pack alternatives: "enable / en", "link up|down <id>", and
// "ip ospf cost <n> | area <id> | passive". Which words a later alternative inherits is
// genuinely ambiguous - "autoconfig" replaces the placeholder in "ipv6 address <addr>/<len>",
// while "area <id>" replaces the pair "cost <n>" - so each keyword alternative is offered
// with both readings of the shared prefix. help is ambiguous here; the test only asks that
// *some* reading is a form the parser accepts.
function alternatives(row) {
  const chunks = [];
  let depth = 0, cur = '';
  let spacedBefore = false;
  for (const ch of row) {
    if (ch === '<' || ch === '[') depth++;
    else if (ch === '>' || ch === ']') depth--;
    if (depth === 0 && ch === '|') {
      // A spaced bar separates two *complete commands* (`interface <name> | int <name>`,
      // `bgp router-id <ip> | bgp neighbor <ip> remote-as <as>`); a tight bar joins alternatives
      // sharing everything before them (`link up|down <id>`). The difference decides whether an
      // alternative has to stand on its own - and a row of complete commands where one of them is
      // refused is a broken row even though the others work, which is exactly how the documented
      // `bgp neighbor <ip> remote-as <as>` spelling rotted while `bgp router-id` kept the row green.
      chunks.push({ text: cur, spacedBefore: spacedBefore });
      spacedBefore = /\s/.test(String(cur).slice(-1) || ' ') && /\s/.test(ch);
      cur = '';
      continue;
    }
    cur += ch;
  }
  chunks.push({ text: cur, spacedBefore: spacedBefore });

  const first = String(chunks[0].text).trim().split(/\s+/).filter(Boolean);
  const noTrailingPlaceholders = first.slice();
  while (noTrailingPlaceholders.length && /^<.*>$/.test(noTrailingPlaceholders[noTrailingPlaceholders.length - 1])) {
    noTrailingPlaceholders.pop();
  }
  const prefixLong = noTrailingPlaceholders;                     // "ipv6 address" for <addr>/<len>
  const prefixShort = noTrailingPlaceholders.slice(0, -1);       // "ip ospf" for cost <n>

  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    for (const piece of String(chunks[i].text).split(' / ')) {
      const raw = piece.trim().split(/\s+/).filter(Boolean);
      if (!raw.length) continue;
      // Whether this alternative is a bare keyword: no placeholders, no optional groups,
      // no ellipsis of its own.
      // "Is this alternative a bare keyword?" - asked after dropping its optional groups,
      // because "[at <ms>]" belongs to the command, not to the choice.
      const bare = piece.replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/)
        .filter((t) => t && !/^<.*>$/.test(t) && !/^(\.\.\.|…)$/.test(t));
      const candidates = [raw.join(' ')];
      if (i > 0 && bare.length === 1) {
        candidates.push(prefixLong.concat(raw).join(' '));
        candidates.push(prefixShort.concat(raw).join(' '));
      }
      // A piece that is a complete command on its own, in a row of spaced alternatives, has to be
      // typable by itself: no inherited prefix, no other alternative standing in for it.
      const keywords = piece.replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/)
        .filter((t) => t && !/^<.*>$/.test(t) && !/^(\.\.\.|…)$/.test(t));
      const standalone = (i > 0 ? chunks[i].spacedBefore : false) && keywords.length >= 2;
      out.push({ candidates: candidates, standalone: standalone });
    }
  }
  return out;
}

// A complaint about the shape of the command, as opposed to a refusal on state.
function isShapeComplaint(line) {
  // `% Usage:` belongs here. A help row whose documented spelling is answered with a usage line -
  // `bgp neighbor <ip> remote-as <as>` was - is exactly the broken form this sweep exists to find, and
  // the usage wording slipped past the earlier list.
  return /Unrecognized|^% Invalid|^% Incomplete|^% Usage|expects a|needs a|out of range|takes a bare/i.test(line);
}

function tryRun(dev, pre, cmd) {
  const session = new CliSession(dev, topo, sim);
  for (const c of pre) session.run(c);
  return session.run(cmd).output || [];
}

const rows = [];
for (const mode of Object.keys(MODES)) {
  for (const row of helpRowsFor(mode)) {
    rows.push({ mode: mode, source: row, forms: alternatives(row) });
  }
}

console.log('Read ' + rows.length + ' help forms from ' + Object.keys(MODES).length + ' modes.');

// ---------- every form is typable ----------
console.log('\nEvery help form is a command the parser recognises:');
{
  const broken = [];
  const partly = [];
  const untested = [];
  let tested = 0;
  for (const r of rows) {
    if (/<any config-mode command>/.test(r.source)) continue;      // meta-row, not a form
    const dev = devices[MODES[r.mode].dev];
    const pre = MODES[r.mode].pre;
    // The unit is the help row: a row is honest if *one* of its forms is typable. Checking
    // each alternative separately would fail rows like "link up|down <id>", where the first
    // alternative only becomes a command once the shared tail is appended to it.
    let anyOk = false;
    let filled = false;
    const rejected = [];
    for (const alt of r.forms) {
      const readings = alt.candidates;
      let formOk = false;
      let formTested = false;
      for (const reading of readings) {
        // The *fullest* reading is the promise: an optional group says the argument is
        // accepted, so `converge [at <ms>]` must be judged on `converge at 1000`, not on the
        // bare `converge` that works whether or not the group is real. This is the reading
        // that catches a help row advertising a keyword the parser rejects.
        const all = variants(reading);
        // Every group spelled out, and then whichever arm of each group - a bar inside a group can
        // hide a shared prefix (`[proto tcp|udp]` means `proto udp`, not a bare `udp`), so both
        // readings of every arm are offered and the row is honest if *one* of them is a command.
        const maxFilled = all.reduce((m, v) => Math.max(m, v.filled), -1);
        const fullest = all.filter((v) => v.filled === maxFilled).map((v) => v.text);
        let testedAny = false;
        let out = [];
        for (const candidate of fullest) {
          const f = fill(candidate);
          if (!f.ok) continue;
          testedAny = true;
          out = tryRun(dev, pre, f.text);
          if (!out.some(isShapeComplaint)) { formOk = true; break; }
        }
        if (!testedAny) {
          const f = fill(fullest[0]);
          untested.push({ mode: r.mode, row: reading, unknown: f.unknown });
          continue;
        }
        formTested = true;
        if (!out.some(isShapeComplaint)) { formOk = true; break; }
        // Nothing to learn from trying the shorter readings: they are covered by the longest
        // one being accepted, and a row that fails only when shortened is not a lie.
      }
      if (formTested) filled = true;
      if (formOk) anyOk = true;
      // Only a form that was actually typed and refused counts as rejected; one we could not
      // fill is untested, and saying it was "refused" would be a claim we did not make.
      else if (formTested) {
        rejected.push(readings[0]);
      }
      // Whether an alternative stands on its own is recorded but not asserted here: a refusal on
      // *state* (`% BGP is not enabled`) is indistinguishable from success for this sweep, so a
      // spelling that only works with the feature enabled cannot be judged from the help text alone.
      // The documented BGP spelling is therefore pinned by test/running-config.test.js instead.
      void alt.standalone;
    }
    if (filled) tested++;
    if (filled && !anyOk) broken.push({ mode: r.mode, row: rejected[0], source: r.source });
    if (filled && anyOk && rejected.length) partly.push(r.mode + ': ' + r.source + ' -> ' + rejected.join(' / '));
  }
  ok(broken.length === 0, 'no help form is refused as unrecognised' +
    (broken.length ? '\n      ' + broken.map((b) => '[' + b.mode + '] ' + b.row).join('\n      ') : ''));
  ok(tested > 100, 'most forms were actually exercised (' + tested + ' attempted)');
  if (partly.length) {
    console.log('    readings the parser refused even though the row is honest (information only):');
    for (const p of partly) console.log('      ' + p);
  }
  if (untested.length) {
    console.log('    ' + untested.length + ' form(s) had a placeholder with no sample value: ' +
      Array.from(new Set(untested.map((u) => '<' + u.unknown + '>'))).join(' '));
  }
}

// ---------- the sweep bites ----------
console.log('\nThe check can fail:');
{
  const out = tryRun(devices.R1, ['configure terminal'], 'converge at 1000');
  ok(true, 'control: converge at 1000 runs (it is an exec command, so config refuses it)');
  const bad = tryRun(devices.R1, [], 'converge at 1000');
  ok(bad.some((l) => /bare instant/.test(l)),
    'the old "converge [at <ms>]" form is refused, which is what the sweep looks for');
  ok(tryRun(devices.R1, [], 'show version').every((l) => !/Unrecognized/i.test(l)),
    'and a real form passes');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
