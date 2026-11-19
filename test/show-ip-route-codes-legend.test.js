'use strict';
// The `Codes:` legend above `show ip route`: nine lines of the image's text, not one line of this console's codes.
//
// A box prints its whole legend on every `show ip route`, whatever the table holds - the same rule the
// `show etherchannel summary` flags follow. This console printed one 76-column line naming only the codes its
// own table can emit, which is a shape no capture of the command produces. The captures, the column the
// continuations start at and the two other variants of the block (IOS XE 16/17 inserts OMP, four NAT codes and
// three NHRP codes) are in research/show-ip-route-codes-legend.md.
//
// What this suite pins is the shape a reader compares against a paste: the count, the alignment, and the fact
// that every code the table can print is defined somewhere in the block.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const pick = function (model) { return catalog.filter(function (s) { return s.model === model; })[0]; };
const ROUTER = pick('generic-router');
const L2SWITCH = pick('Catalyst2960');

// The first line is the one carrying the label; the block ends where the gateway sentence begins.
const LABEL = 'Codes: ';
function legend(out) {
  const start = out.indexOf(out.filter(function (l) { return l.indexOf(LABEL) === 0; })[0]);
  if (start === -1) return [];
  const block = [];
  for (let i = start; i < out.length; i++) {
    if (i > start && out[i].indexOf('       ') !== 0) break;
    block.push(out[i]);
  }
  return block;
}

function show(spec, setup) {
  const t = new Topology();
  const dev = t.addDevice(spec, 'd1');
  if (setup) setup(dev, t);
  const cli = new CliSession(dev, t, new Simulator(t));
  return { dev: dev, out: (cli.run('show ip route').output || []).map(String) };
}

const ports = function (d) { return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; }); };

console.log('A routing box prints the whole nine-line legend:');
{
  const r = show(ROUTER, function (dev) {
    const p = ports(dev)[0];
    p.ip = '10.1.1.1'; p.mask = '255.255.255.0';
  });
  const block = legend(r.out);
  ok(block.length === 9, 'the legend is nine lines, as the 15.2E capture prints it', String(block.length));
  ok(block[0] === 'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
    'the label line is the capture\'s, character for character', block[0]);
  ok(block[8] === '       + - replicated route, % - next hop override, p - overrides from PfR',
    'and so is the last line of the block', block[8]);
  // Every continuation aligns its code under the `L` of `L - local`, which is column 7 because `Codes: ` is
  // seven characters. The 7 spaces are measured off ntc-templates' raw capture, not chosen here.
  const misaligned = block.slice(1).filter(function (l) { return l.slice(0, 7) !== '       '; });
  ok(misaligned.length === 0, 'each continuation starts at column 7, under the first code', misaligned.join(' | '));
  ok(block.every(function (l) { return l.length <= 80; }),
    'no line of the block is wider than the 80-column terminal it is printed on',
    String(Math.max.apply(null, block.map(function (l) { return l.length; }))));
}

console.log('');
console.log('The block names every code this table can print:');
{
  // routesTable() emits L, C, S, O and B, and marks a candidate default with `*`. A code in the table that the
  // legend does not define is the defect the one-line legend was written to avoid (#1234) - the nine-line block
  // must keep that property while it gains the codes the model does not use.
  const codes = ['L', 'C', 'S', 'O', 'B'];
  const r = show(ROUTER, function (dev) {
    const p = ports(dev)[0];
    p.ip = '10.1.1.1'; p.mask = '255.255.255.0';
  });
  const block = legend(r.out).join('\n');
  for (const c of codes) {
    ok(block.indexOf(c + ' - ') !== -1, 'the legend defines ' + c, c);
  }
  ok(block.indexOf('* - candidate default') !== -1, 'the asterisk the table prints is defined too');
  ok(r.out.some(function (l) { return /^C\s/.test(l); }), 'and the table still prints a row with one of them');
}

console.log('');
console.log('The gateway sentence sits under the block, and the rows under that:');
{
  const r = show(ROUTER, function (dev) {
    const p = ports(dev)[0];
    p.ip = '10.1.1.1'; p.mask = '255.255.255.0';
  });
  const block = legend(r.out);
  const after = r.out[block.length];
  ok(after === 'Gateway of last resort is not set', 'the router sentence follows the ninth line', after);
  const firstRow = r.out.slice(block.length + 1).filter(function (l) { return /^[A-Z]\*?\s/.test(l); })[0];
  ok(!!firstRow && /^C\s/.test(firstRow), 'and the table starts under it', firstRow);
  // No blank line between the block and the sentence: IOS prints them contiguously, and a gap here would be a
  // line the box does not print.
  ok(r.out.slice(0, block.length + 1).indexOf('') === -1, 'nothing in the block is a blank line');
}

console.log('');
console.log('A box that does not route prints no legend at all:');
{
  // The legend belongs to the routing table, so the host/redirect-cache shape must not gain it.
  const r = show(L2SWITCH);
  ok(!r.out.some(function (l) { return l.indexOf(LABEL) === 0; }),
    'a switch with ip routing off names no codes', r.out.join(' | '));
  ok(r.out.some(function (l) { return /Default gateway is not set/.test(l); }),
    'it answers with the gateway/cache shape instead');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
