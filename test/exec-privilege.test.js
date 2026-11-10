'use strict';
// exec-privilege.test.js - a page that lists a command the mode refuses reads as if it works there.
//
// Exec and enable share one command set in this console, so the page cannot hide the privileged half
// without lying about the other one. What it did instead was list it silently:
//
//   SW1>clear arp        % clear arp needs enable mode - type "enable" first
//   SW1>write memory     % write memory needs enable mode - type "enable" first
//
// Both rows were on the page the operator was reading when they typed them. The page now names the
// privileged half after the rows, and this suite checks the list BOTH ways: every verb it names must
// refuse in user exec, and every row that refuses must be named - so the list cannot drift as verbs
// are added.
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

function lab(model, name) {
  const t = new Topology();
  const d = t.addDevice(find(model)); d.name = name;
  const s = new CliSession(d, t, new Simulator(t));
  return { t: t, d: d, s: s };
}

const VALUES = { port: 'Fa0/1', id: '10', ip: '10.0.0.1', address: '10.0.0.1', addr: '10.0.0.1',
  mac: '00:11:22:33:44:55', vlan: '10', dst: '9.9.9.9', count: '1', n: '1', ms: '1' };
function fill(line) {
  return line.split(/\s+/).map(function (t) {
    if (t.indexOf('|') !== -1) t = t.split('|')[0];
    return t.replace(/<([a-z0-9-]+)>/gi, function (m, k) { return VALUES[k] || '10'; });
  }).join(' ').trim();
}
// The command rows of a page: the synopsis column, up to the privileged-commands legend.
function rowsOf(pageText) {
  const rows = [];
  for (const raw of pageText.split('\n')) {
    if (/Privileged commands/i.test(raw)) break;
    const l = raw.trim();
    // Ordinary control flow, not an exemption: a section header, a blank line or a refusal is not a
    // command row, so it is skipped rather than typed.
    if (!l || l.startsWith('%') || /^[A-Z].*:$/.test(l) || /^Available commands:/.test(l)) continue;
    const syn = l.split(/\s{2,}/)[0];
    if (/^[a-z]/.test(syn)) rows.push(syn);
  }
  return rows;
}
// Every spelling a row offers, with optional parts removed so the line is the shortest form.
function commandsOf(syn) {
  return syn.split(' / ').map(function (alt) {
    return fill(alt.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim());
  }).filter(Boolean);
}

for (const model of ['generic-switch', 'generic-router']) {
  console.log('\n' + model + ': the page names the half it cannot run here:');
  const env = lab(model, 'X1');
  const page = text(env.s.run('?'));
  ok(/Privileged commands/.test(page), 'user exec names the privileged commands');
  // The legend runs from its header to the next blank line - the page's next section is not part of
  // it, and reading past the blank line turned "For config commands: configure terminal" into a
  // privileged verb.
  const legendLines = [];
  let inLegend = false;
  for (const raw of page.split('\n')) {
    if (/Privileged commands/i.test(raw)) { inLegend = true; continue; }
    if (!inLegend) continue;
    if (!raw.trim()) break;
    legendLines.push(raw.replace(/^\s+/, ''));
  }
  const named = legendLines.join(' ').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  ok(named.length >= 6, 'it names ' + named.length + ' verbs');

  // Forward: every verb the legend names refuses in user exec. Each line is typed at a *fresh*
  // session: one of the rows on this page is `configure terminal`, so a single session walks out of
  // exec mode part-way through the page and every later line is answered by the config parser.
  for (const cmd of named) {
    const out = text(lab(model, 'X1').s.run(cmd));
    // The *first* line only: `help` prints the whole page, and the page now contains the phrase
    // "needs enable mode" in its own legend - matching anywhere would read a help page as a refusal.
    ok(/needs enable mode/.test(out.split('\n')[0] || ''), 'named and refused: "' + cmd + '"');
  }

  // Backward: every row on the page that refuses is named.
  let walked = 0, refusing = 0;
  for (const syn of rowsOf(page)) {
    for (const cmd of commandsOf(syn)) {
      // Ordinary control flow, not an exemption: session and lab verbs have nothing to say about
      // privilege, and this suite is about privilege.
      if (/^(help|exit|logout|quit|enable|converge|link|links)/.test(cmd)) continue;
      const out = text(lab(model, 'X1').s.run(cmd));
      walked++;
      // First line only, for the reason above: a help page is not a refusal. Ordinary control flow:
      // a command that ran is simply not one of the refusals being counted.
      if (!/needs enable mode/.test(out.split('\n')[0] || '')) continue;
      refusing++;
      const verb = cmd.split(/\s+/).slice(0, 2).join(' ');
      const covered = named.some(function (n) { return cmd === n || cmd.indexOf(n) === 0 || n.indexOf(verb) === 0; });
      ok(covered, 'the page names it before you type it: "' + cmd + '"');
    }
  }
  ok(walked >= 12, 'the walk typed ' + walked + ' exec commands');
  ok(refusing >= 5, 'and ' + refusing + ' of them refused for privilege');
}

console.log('\nEnable mode is not told about its own commands:');
{
  const env = lab('generic-switch', 'SW1');
  env.s.run('enable');
  const page = text(env.s.run('?'));
  ok(!/Privileged commands/.test(page), 'the legend is gone once it applies to nothing');
  ok(/clear arp/.test(page), 'while the privileged rows themselves are still listed');
  ok(/ARP cache/.test(text(env.s.run('clear arp'))), 'and now run');
  ok(!/needs enable mode/.test(text(env.s.run('write memory'))), 'as does write memory');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
