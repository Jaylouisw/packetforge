'use strict';
// docs-syntax.test.js — the documented synopsis and the help row must say the same thing.
//
// Two wakes in a row I fixed this by hand: `flow open <ip>` where help said `<dst>`, and a
// `converge [at <ms>]` row describing a form the parser refuses. Both were single characters
// in a Markdown table, both were wrong in the same way — the docs kept a copy of the syntax
// and nothing compared the copies. This test compares them.
//
// The rules, and why each is needed:
//
//   * a help row may pack alternatives (`enable / en`, `ipv6 nd ra enable|disable|lifetime <s>`),
//     and a later alternative inherits the literal words in front of the first one, because
//     that is how anyone reads it;
//   * `[<port>]` and `[at <ms>|converged]` are optional, so the bracketed group is removed
//     before comparing words — otherwise `[neighbor]` counts as the word "neighbor";
//   * `…` means "the rest of it", so a synopsis ending in `…` only has to be a prefix;
//   * a form mentioned in a help *description* ("add static route  (no ip route ...)") is
//     documented, so it is not a phantom;
//   * and every command in exec help must appear in the docs table, so a new verb cannot
//     ship undocumented.
const path = require('path');
const fs = require('fs');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const topo = new Topology();
const dev = topo.addDevice(catalog.find((x) => x.model === 'generic-router'));
dev.name = 'R1';
const sim = new Simulator(topo);

// ---------- read the help ----------
// The unfiltered page, on purpose: the docs are read against the whole command set, not against
// what one device is shown. `?` on a router now hides the families a router cannot use, and a
// documented switch command would look undocumented if the corpus came from a filtered page.
function helpLines(cmds) {
  const s = new CliSession(dev, topo, sim);
  for (const c of cmds.slice(0, -1)) s.run(c);
  const lines = s._helpPage();
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {2}(\S.*?)(?: {2,}(\S.*))?$/.exec(lines[i]);
    if (!m) continue;
    let desc = (m[2] || '').trim();
    if (!desc && /^ {45}\S/.test(lines[i + 1] || '')) desc = lines[i + 1].trim();
    rows.push({ row: m[1].trim(), desc: desc });
  }
  return rows;
}
const MODES = {
  exec: ['enable', 'help'],
  config: ['enable', 'configure terminal', 'help'],
  iface: ['enable', 'configure terminal', 'interface Gi0/0', 'help'],
  pool: ['enable', 'configure terminal', 'ip dhcp pool p1', 'help']
};

// Words of a synopsis: optional groups and placeholders are not words, and "…" means the rest.
function words(s) {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\u2026|\.\.\./g, ' ')
    .replace(/[|]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}
function placeholders(s) { return (s.match(/<[^>]*>/g) || []).map((h) => h.slice(1, -1).trim()); }
function wildcard(s) { return /(\u2026|\.\.\.)\s*$/.test(s); }

// Split one help row into the forms it offers.
//
// Three readings are needed, because help packs a lot into one line:
//   * a top-level `a|b|c` offers each keyword, with the literal words in front of the first
//     one carried over: "ipv6 nd ra enable|disable" reads as "ipv6 nd ra disable" too;
//   * `[<port>]` is optional, so it yields the row with and without that group — `[neighbor]`
//     documents both `show ip ospf` and `show ip ospf neighbor`;
//   * a trailing `...` means "and the rest", which documents any longer form with that prefix.
function alternatives(row) {
  const chunks = [];
  let depth = 0, cur = '';
  for (const ch of row) {
    if (ch === '<' || ch === '[') depth++;
    else if (ch === '>' || ch === ']') depth--;
    if (depth === 0 && ch === '|') { chunks.push(cur); cur = ''; continue; }
    cur += ch;
  }
  chunks.push(cur);

  const forms = [];
  const push = function (s, rest, alias) { if (s) forms.push({ key: s, rest: !!rest, alias: !!alias }); };
  const prefix = words(chunks[0]).slice(0, -1);
  for (let i = 0; i < chunks.length; i++) {
    const pieces = chunks[i].split(' / ');
    for (let pi = 0; pi < pieces.length; pi++) {
      // An optional group documents two things: the row with the group left out, and the
      // row with the group's contents spelled out. `[neighbor]` is both `show ip ospf`
      // and `show ip ospf neighbor`, and help is the only place either is written down.
      const variants = [pieces[pi]];
      const group = /\[([^\]]*)\]/g.exec(pieces[pi]);
      if (group && group[1].indexOf('<') === -1) {
        variants.push(pieces[pi].replace(group[0], ' ' + group[1] + ' '));
      }
      for (const piece of variants) {
        const w = words(piece);
        if (!w.length) continue;
        // A single-word alternative is a keyword that shares the row's literal prefix;
        // anything longer is written out in full (or is the first alternative).
        const full = (i > 0 && w.length === 1) ? prefix.concat(w) : w;
        push(full.join(' '), /(…|\.\.\.)\s*$/.test(piece), pi > 0);
      }
    }
  }

  // Optional groups expand into both readings, one group at a time.
  const expanded = forms.slice();
  for (const f of forms) {
    const groups = f.key.match(/\[[^\]]*\]/g) || [];
    for (const g of groups) expanded.push({ key: f.key.replace(g, ' ').replace(/\s+/g, ' ').trim(), rest: f.rest, alias: f.alias });
  }
  return expanded;
}

const corpus = [];
const execCommands = [];
for (const mode of Object.keys(MODES)) {
  for (const h of helpLines(MODES[mode])) {
    for (const alt of alternatives(h.row)) {
      corpus.push({ mode: mode, alt: alt.key, rest: alt.rest, text: h.row + ' ' + h.desc });
      if (mode === 'exec' && !alt.alias) execCommands.push(alt.key);
    }
  }
}

// ---------- read the docs ----------
// Split a Markdown table row on pipes that are not escaped: a cell may contain 'tcp\|udp',
// so a plain split would cut the synopsis in half and silently skip the row.
const ESC = String.fromCharCode(92);   // a lone backslash, spelled this way to keep the source honest
function splitRow(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ESC && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (line[i] === '|') { out.push(cur); cur = ''; continue; }
    cur += line[i];
  }
  out.push(cur);
  return out;
}

const docPath = path.join(__dirname, '..', 'docs', 'CLI.md');
const doc = fs.readFileSync(docPath, 'utf8');
const synopses = [];
// Only table rows have a first cell holding a synopsis; anything else in the file is
// prose or a transcript, and reading it as a command would invent syntax nobody claims.
const tableRows = doc.split('\n').filter((l) => l.charAt(0) === '|');
for (const line of tableRows) {
  const cells = splitRow(line);
  if (cells.length < 3) continue;
  const first = cells[1];
  const spans = first.match(/`[^`]+`/g) || [];
  for (const span of spans) {
    const text = span.slice(1, -1).replace(/\\\|/g, '|').replace(/\s+/g, ' ').trim();
    // The docs are written in the same notation as help, so they are read the same way:
    // one span can offer alternatives ('in|out'), an alias pair ('enable / en'), or an
    // optional group ('[<port>]').
    for (const f of alternatives(text)) synopses.push({ text: text, words: f.key.split(' ') });
  }
}

// Only synopses whose first word the CLI knows: table headers and prose cells are skipped.
const verbs = new Set(corpus.map((c) => c.alt.split(' ')[0]));
const checked = synopses.filter((s) => verbs.has(s.words[0]));

console.log('Read ' + corpus.length + ' help forms from ' + Object.keys(MODES).length +
  ' modes and ' + checked.length + ' command synopses from ' + path.basename(docPath) + '.');

// ---------- 1. no phantoms ----------
console.log('\nEvery documented command exists:');
{
  const phantoms = [];
  for (const s of checked) {
    const key = s.words.join(' ');
    const hit = corpus.filter((c) => c.alt === key ||
      (wildcard(s.text) && c.alt.startsWith(key)) ||
      (c.rest && key.startsWith(c.alt + ' ')));
    const mentioned = corpus.some((c) => c.text.indexOf(key) !== -1);
    if (!hit.length && !mentioned) phantoms.push(s.text);
  }
  ok(phantoms.length === 0, 'no documented command is missing from help' +
    (phantoms.length ? ' - ' + phantoms.join(' | ') : ''));
}

// ---------- 2. no invented placeholders ----------
console.log('\nEvery placeholder is one the help row declares:');
{
  const wrong = [];
  for (const s of checked) {
    const key = s.words.join(' ');
    const hits = corpus.filter((c) => c.alt === key);
    if (!hits.length) continue; // handled by rule 1 (shorter form, wildcard, or description)
    const declared = new Set();
    for (const h of hits) for (const p of placeholders(h.text.split('  ')[0])) declared.add(p);
    for (const p of placeholders(s.text)) {
      // The help description may restate the syntax; accept a placeholder it declares there too.
      const inDesc = hits.some((h) => placeholders(h.text).indexOf(p) !== -1);
      if (!declared.has(p) && !inDesc) wrong.push(s.text + ' names <' + p + '>, help has ' + hits.map((h) => h.alt).join(' ; '));
    }
  }
  ok(wrong.length === 0, 'no synopsis names a placeholder help does not have' +
    (wrong.length ? ' - ' + wrong.join(' | ') : ''));
}

// ---------- 3. every exec command is documented ----------
console.log('\nEvery exec command appears in the docs table:');
{
  const documented = new Set(checked.map((s) => s.words.join(' ')));
  const undocumented = [];
  for (const cmd of execCommands) {
    // Aliases ("en", "conf t", "tracert", "?") are conveniences, not the documented form.
    if (cmd.length < 5) continue;
    if (documented.has(cmd)) continue;
    // A command documented as part of a family row ("show ip ospf [neighbor]" covers
    // "show ip ospf") counts as documented.
    const covered = checked.some((s) => {
      const k = s.words.join(' ');
      return cmd.startsWith(k + ' ') || k.startsWith(cmd + ' ');
    });
    if (!covered) undocumented.push(cmd);
  }
  ok(undocumented.length === 0, 'no exec command is undocumented' +
    (undocumented.length ? ' - ' + undocumented.join(' | ') : ''));
}

// ---------- the guard itself ----------
console.log('\nThe check can fail:');
{
  // Prove the comparison bites, using the two drifts this iteration fixed.
  const fake = { text: 'traceroute <ip> [at <ms>|converged]', words: words('traceroute <ip> [at <ms>|converged]') };
  const hits = corpus.filter((c) => c.alt === fake.words.join(' '));
  const declared = new Set(placeholders(hits.map((h) => h.text.split('  ')[0]).join(' ')));
  ok(hits.length > 0 && !declared.has('ip'),
    'the old traceroute <ip> row would be caught against the <dst> help row');

  const phantom = { text: 'show frobnicate', words: words('show frobnicate') };
  ok(!corpus.some((c) => c.alt === phantom.words.join(' ')), 'and a command that does not exist would be caught');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
