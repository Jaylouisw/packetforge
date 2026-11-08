'use strict';
// Issue #26: the front panel clipped port names mid-glyph in eight-wide cage groups.
//
// The panel used to pick a column count first (twelve for copper, eight for fibre) and
// hope the labels fit into whatever width that left. On a 48-port switch with eight
// SFP+ cages each cell got 27.6px, the name "Gi1/1/1" at 9px monospace needs 39px, and
// .fp-port is a fixed-height overflow:hidden box — so the overflow was cut through the
// middle of a glyph. The port read "Gi1/1/" with a sliced "1" and could not be
// identified at all, which is the one thing a faceplate exists to do.
//
// This test asserts the geometry instead of eyeballing it: for every rendered socket,
// the width the layout allots the label must be at least the width the label needs.
// A label may be shortened, but only deliberately - to the silkscreen number the
// hardware prints, or with an ellipsis - and only while the full name stays reachable
// in the tooltip and in data-port.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

// --- load the real module the way the browser will -------------------------
const sandbox = { console: console, window: {} };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'web', 'faceplate.js'), 'utf8'),
  sandbox,
  { filename: 'faceplate.js' }
);
const FP = sandbox.window.PFFaceplate;
const CSS = fs.readFileSync(path.join(__dirname, '..', 'web', 'faceplate.css'), 'utf8');
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));

// --- helpers ---------------------------------------------------------------
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}
// A serialized device, through the real engine, exactly as the inspector receives it.
function stateOf(v, m) {
  const t = new Topology();
  t.addDevice(spec(v, m));
  return JSON.parse(JSON.stringify(t.serialize())).devices[0];
}
function attr(tag, name) {
  const m = new RegExp('\\b' + name + '="([^"]*)"').exec(tag);
  return m ? m[1] : null;
}
function unesc(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
// Every <section class="fp-group"> in the panel, with the geometry it declares.
function sections(html) {
  const out = [];
  const re = /<section class="fp-group"[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    const end = html.indexOf('</section>', m.index);
    out.push({ tag: m[0], body: html.slice(m.index, end < 0 ? html.length : end) });
  }
  return out;
}
// The sockets of one group, each with the label it paints and the room it was given.
function sockets(sec, panelWidth) {
  const columns = Number(attr(sec.tag, 'data-columns'));
  const budget = FP.labelBudget(columns, panelWidth);
  const list = [];
  (sec.body.match(/<button[^>]*class="fp-port[^"]*"[\s\S]*?<\/button>/g) || []).forEach(function (cell) {
    const tag = cell.slice(0, cell.indexOf('>'));
    const label = unesc((/<span class="fp-port-name">([\s\S]*?)<\/span>/.exec(cell) || ['', ''])[1]);
    const role = /\bfp-role\b/.test(tag);
    list.push({
      port: unesc(attr(tag, 'data-port') || ''),
      title: unesc(attr(tag, 'title') || ''),
      aria: unesc(attr(tag, 'aria-label') || ''),
      truncated: /data-truncated="1"/.test(tag),
      label: label,
      columns: columns,
      budget: budget,
      // what the label needs: its glyphs, plus the flip arrow the CSS appends to a
      // dual-purpose cage
      need: FP.textWidth(label) + (role ? FP.METRICS.roleArrow : 0)
    });
  });
  return list;
}
function audit(html, panelWidth) {
  const rows = [];
  sections(html).forEach(function (sec) {
    rows.push({ tag: sec.tag, body: sec.body, sockets: sockets(sec, panelWidth) });
  });
  return rows;
}
function overflowers(groups) {
  const bad = [];
  groups.forEach(function (g) {
    g.sockets.forEach(function (s) {
      if (s.need > s.budget + 1e-9) {
        bad.push('"' + s.label + '" (' + s.port + ') needs ' + s.need.toFixed(1) +
          'px in a ' + s.columns + '-wide cell that allots ' + s.budget.toFixed(1) + 'px');
      }
    });
  });
  return bad;
}
// The CSS rule block for an exact selector, so the geometry can be read back.
function cssRule(selector) {
  const at = CSS.indexOf('\n' + selector + ' {');
  if (at < 0) return '';
  const end = CSS.indexOf('}', at);
  return CSS.slice(at, end < 0 ? CSS.length : end);
}
const W = FP.METRICS.panelWidth;

// --- 1. the module publishes the geometry it lays out with ----------------
console.log('The module publishes the geometry it lays out with:');
ok(!!FP && !!FP.METRICS, 'PFFaceplate.METRICS is exposed');
ok(typeof FP.textWidth === 'function' && typeof FP.labelBudget === 'function' &&
  typeof FP.columnsThatFit === 'function' && typeof FP.clip === 'function',
  'textWidth / labelBudget / columnsThatFit / clip are exposed');
ok(FP.METRICS.panelWidth > 0 && FP.METRICS.fontSize > 0 && FP.METRICS.charRatio > 0,
  'the panel width, font size and glyph ratio are all positive numbers');
ok(FP.textWidth('12345') > FP.textWidth('1234'), 'a longer label measures wider');
ok(Math.abs(FP.textWidth('Gi1/1/1') - (7 * FP.METRICS.fontSize * FP.METRICS.charRatio)) < 1e-9,
  'a monospace label is chars x font-size x ratio, not a guess (' + FP.textWidth('Gi1/1/1').toFixed(2) + 'px for "Gi1/1/1")');
ok(FP.labelBudget(12) < FP.labelBudget(8) && FP.labelBudget(8) < FP.labelBudget(4) &&
  FP.labelBudget(4) < FP.labelBudget(1),
  'fewer columns means more room per label (' + [12, 8, 4, 1].map(function (c) { return c + ':' + FP.labelBudget(c).toFixed(1); }).join('px, ') + 'px)');
ok(Math.abs(12 * FP.labelBudget(12) + 11 * FP.METRICS.gap +
  2 * 12 * (FP.METRICS.cellPadX + FP.METRICS.cellBorder) -
  (W - 2 * FP.METRICS.panelPadX - 2 * FP.METRICS.panelBorder)) < 1e-9,
  'the budget is the panel minus padding, borders and gaps, and nothing else');
ok(FP.columnsThatFit(48, 12, FP.labelBudget(8)) === 8,
  'a label that exactly fills an eight-wide cell keeps its eight columns');
ok(FP.columnsThatFit(48, 12, FP.labelBudget(8) + 1) === 7,
  'and one that overruns it by a pixel drops to seven rather than overflow');
ok(FP.columnsThatFit(5, 12, 0) === 5, 'a short group is never widened past its socket count');
ok(FP.columnsThatFit(4, 12, 9999) === 1, 'and the last column is never given up');
const clipped = FP.clip('GigabitEthernet0/0/0/0/12.4095', 60);
ok(clipped.truncated && /\u2026$/.test(clipped.text) && FP.textWidth(clipped.text) <= 60,
  'clip() ends an over-long label in an ellipsis that itself fits (' + clipped.text + ')');
ok(!FP.clip('48', 60).truncated, 'and leaves a label that fits untouched');

// --- 2. the stylesheet agrees with the numbers the layout uses ------------
console.log('\nThe stylesheet agrees with the numbers the layout uses:');
const panelRule = cssRule('.faceplate');
const portRule = cssRule('.fp-port');
const nameRule = cssRule('.fp-port-name');
ok(/--fp-gap:\s*3px/.test(panelRule) && FP.METRICS.gap === 3,
  'the row gap is the 3px the estimate subtracts');
ok(/padding:\s*10px 12px/.test(panelRule) && FP.METRICS.panelPadX === 12,
  'the panel padding is the 12px a side the estimate subtracts');
ok(/border:\s*1px/.test(panelRule) && FP.METRICS.panelBorder === 1, 'the panel border is 1px');
ok(/font-size:\s*9px/.test(portRule) && FP.METRICS.fontSize === 9,
  'labels are drawn at the 9px the estimate assumes');
ok(/padding:\s*0 2px/.test(portRule) && FP.METRICS.cellPadX === 2, 'the cell padding is 2px a side');
ok(/border:\s*1px/.test(portRule) && FP.METRICS.cellBorder === 1, 'the cell border is 1px');
// Belt to the layout's braces: without nowrap+ellipsis a too-long label wraps and the
// fixed cell height slices the second line - the exact corruption in issue #26.
ok(/white-space:\s*nowrap/.test(nameRule), '.fp-port-name cannot wrap onto a second line');
ok(/text-overflow:\s*ellipsis/.test(nameRule) && /overflow:\s*hidden/.test(nameRule),
  'so an over-long label is ellipsised, never cut mid-glyph');
ok(/height:\s*var\(--fp-cell-h\)/.test(portRule), 'the cell height is fixed, which is why wrapping was fatal');
ok(FP.METRICS.roleArrow >= 5, 'the flip arrow the CSS appends is budgeted for (' + FP.METRICS.roleArrow + 'px)');

// --- 3. the failure this fixes was real ----------------------------------
console.log('\nThe geometry the old layout used could not fit an eight-wide cage group:');
ok(FP.textWidth('Gi1/1/1') > FP.labelBudget(8),
  '"Gi1/1/1" needs ' + FP.textWidth('Gi1/1/1').toFixed(1) + 'px but an eight-wide cell allots ' +
  FP.labelBudget(8).toFixed(1) + 'px - which is the clip in issue #26');
ok(FP.textWidth('1/1/49') > FP.labelBudget(8),
  'so does "1/1/49" on a 48-port switch (' + FP.textWidth('1/1/49').toFixed(1) + 'px)');
ok(FP.textWidth('48') <= FP.labelBudget(12),
  'while the silkscreen number does fit twelve wide (' + FP.textWidth('48').toFixed(1) + 'px)');

// --- 4. a 48-port switch with eight cages: the reported shape -------------
console.log('\nA 48-port switch with eight SFP+ cages (Cisco C9300-48P):');
const c9300 = stateOf('cisco', 'C9300-48P');
const c9300Html = FP.render(c9300, { fullNames: true, topology: null });
const c9300Groups = audit(c9300Html, W);
const cageGroup = c9300Groups.filter(function (g) { return attr(g.tag, 'data-cage') === 'sfp+'; })[0];
ok(c9300Groups.length === 2, 'the panel has the RJ45 block and the cage block');
ok(cageGroup && Number(attr(cageGroup.tag, 'data-columns')) === 8,
  'the cage block is still eight wide - the fix keeps the density, it does not just widen everything');
ok(cageGroup && cageGroup.sockets.length === 8, 'all eight cages are drawn');
ok(overflowers(c9300Groups).length === 0,
  'every one of the ' + c9300Groups.reduce(function (n, g) { return n + g.sockets.length; }, 0) +
  ' labels fits the width its cell allots' +
  (overflowers(c9300Groups).length ? ': ' + overflowers(c9300Groups).slice(0, 3).join('; ') : ''));
ok(cageGroup && cageGroup.sockets.every(function (s) { return s.label.length <= FP.METRICS.panelWidth; }) &&
  cageGroup.sockets.every(function (s) { return s.need <= s.budget; }),
  'the cage labels are short, whole tokens, not truncated fragments');
ok(cageGroup && cageGroup.sockets.every(function (s) { return !s.truncated; }),
  'nothing in the cage group had to be ellipsised');
ok(cageGroup && cageGroup.sockets.some(function (s) { return /^1$/.test(s.label) && s.port === 'Gi1/1/1'; }),
  'the panel prints the silkscreen number ("1") for Gi1/1/1, as the hardware does');
ok(cageGroup && cageGroup.sockets.every(function (s) { return s.title.indexOf(s.port) === 0; }),
  'and every tooltip still opens with the full interface name');
ok(attr(cageGroup.tag, 'data-label') === 'silkscreen',
  'the group declares that it shows silkscreen numbers, not that it silently dropped the name');

// --- 5. the two switches named in the issue ------------------------------
console.log('\nThe switches from the report, with full names on (as the inspector asks):');
[['aruba', '2930F 24G 4SFP+'], ['aruba', 'CX 6000 48G 4SFP']].forEach(function (target) {
  const name = target[0] + ' ' + target[1];
  const st = stateOf(target[0], target[1]);
  const groups = audit(FP.render(st, { fullNames: true }), W);
  const over = overflowers(groups);
  const socketsAll = groups.reduce(function (n, g) { return n + g.sockets.length; }, 0);
  ok(socketsAll === st.interfaces.length, name + ': all ' + socketsAll + ' sockets drawn');
  ok(over.length === 0,
    name + ': every label fits its cell' + (over.length ? ' - ' + over.slice(0, 2).join('; ') : ''));
  ok(groups.every(function (g) { return g.sockets.every(function (s) { return !!s.label; }); }),
    name + ': no cell is left blank by the layout');
});
// Twelve wide is still twelve wide when the numbers fit: the fix must not shrink the
// common case into a tall ladder.
const cu48 = audit(FP.render(stateOf('aruba', 'CX 6000 48G 4SFP')), W)
  .filter(function (g) { return attr(g.tag, 'data-cage') === 'rj45'; })[0];
ok(Number(attr(cu48.tag, 'data-columns')) === 12 && cu48.sockets.length === 48,
  'a 48-port copper block keeps its four rows of twelve');
ok(/^1$/.test(cu48.sockets[0].label) && /^48$/.test(cu48.sockets[47].label),
  'numbered 1..48 across the rows, like the silkscreen');
const cu24 = audit(FP.render(stateOf('aruba', '2930F 24G 4SFP+')), W)
  .filter(function (g) { return attr(g.tag, 'data-cage') === 'rj45'; })[0];
ok(Number(attr(cu24.tag, 'data-columns')) === 12 && cu24.sockets.length === 24,
  'and a 24-port block keeps its two rows of twelve');

// --- 6. a label is shortened on purpose, never by the browser ------------
console.log('\nWhen nothing fits, the layout shortens deliberately:');
const tiny = FP.render({
  id: 'tiny', name: 'TINY',
  interfaces: [{ name: 'GigabitEthernet0/0/0/0/12.4095', cage: 'rj45', enabled: true }]
}, { fullNames: true, width: 90 });
const tinySock = audit(tiny, 90)[0].sockets[0];
ok(tinySock.need <= tinySock.budget,
  'on a 90px panel a 32-glyph name is cut down until it fits (' + tinySock.label + ')');
ok(/\u2026$/.test(tinySock.label), 'the short version ends in an ellipsis, so it is obviously short');
ok(tinySock.title.indexOf('GigabitEthernet0/0/0/0/12.4095') === 0,
  'the tooltip keeps the whole name - the cut label is a summary, not the record');
ok(tinySock.truncated, 'and the cell is marked data-truncated, so nothing downstream trusts the ellipsis');
ok(tinySock.aria.indexOf('GigabitEthernet0/0/0/0/12.4095') === 0, 'the aria-label keeps it too');
ok(attr(audit(tiny, 90)[0].tag, 'data-label') === 'truncated',
  'the group reports that it had to truncate');

// --- 7. long names buy room by giving up columns -------------------------
console.log('\nUnshortenable names buy room by giving up columns, not by overflowing:');
const ethernet = {
  id: 'e', name: 'E',
  interfaces: ['49', '50', '51', '52', '53', '54', '55', '56'].map(function (n) {
    return { name: 'Ethernet' + n, cage: 'qsfp28', enabled: true };
  })
};
const ethHtml = FP.render(ethernet, { fullNames: true });
const ethGroups = audit(ethHtml, W);
const ethSock = ethGroups[0].sockets;
ok(Number(attr(ethGroups[0].tag, 'data-columns')) < 8,
  'the eight cages drop below eight wide (' + attr(ethGroups[0].tag, 'data-columns') + ')');
ok(overflowers(ethGroups).length === 0, 'because that is what makes "Ethernet49" fit');
ok(ethSock.every(function (s) { return /^Ethernet5[0-9]?$|^Ethernet49$/.test(s.label); }),
  'and every label is still the whole name, not a fragment of one');
ok(ethSock.every(function (s) { return !s.truncated; }), 'nothing was ellipsised to get there');
ok((ethHtml.match(/class="fp-row /g) || []).length > 1, 'the extra width costs rows, which the panel can afford');

// --- 8. the row class and the declared geometry never disagree ------------
console.log('\nThe width the CSS applies is the width the layout assumed:');
const c9Rows = (cageGroup.body.match(/<div class="fp-row ([^"]*)">/g) || []);
ok(c9Rows.length === 1 && c9Rows.every(function (r) {
  return /fp-cols-8/.test(r);
}), 'the cage row carries fp-cols-8, the hook that actually splits the width eight ways');
const cuRows = (cu48.body.match(/<div class="fp-row fp-cols-(\d+)">/g) || []);
ok(cuRows.length === 4 && cuRows.every(function (r) { return /fp-cols-12/.test(r); }),
  'and the copper rows carry fp-cols-12');
ok((cu48.body.split('<div class="fp-row ').slice(1)).every(function (chunk) {
  return (chunk.match(/<button /g) || []).length === 12;
}), 'four rows of twelve sockets, so on screen it splits exactly as the estimate assumed');
let mismatched = 0, checked = 0;
catalog.slice(0, 200).forEach(function (sp) {
  let st;
  try {
    const t = new Topology();
    t.addDevice(sp);
    st = JSON.parse(JSON.stringify(t.serialize())).devices[0];
  } catch (e) { return; }
  audit(FP.render(st, { fullNames: true }), W).forEach(function (g) {
    const cols = Number(attr(g.tag, 'data-columns'));
    const rows = g.body.match(/<div class="fp-row fp-cols-(\d+)">/g) || [];
    rows.forEach(function (r) {
      checked++;
      if (Number(/fp-cols-(\d+)/.exec(r)[1]) !== cols) mismatched++;
    });
    // a row never holds more sockets than it has columns
    g.body.split('<div class="fp-row ').slice(1).forEach(function (chunk) {
      const n = (chunk.match(/<button /g) || []).length;
      if (n > cols) mismatched++;
    });
  });
});
ok(mismatched === 0 && checked > 50,
  'fp-cols-N always matches data-columns, across ' + checked + ' rows of the first 200 devices');

// --- 9. nothing in the catalogue overflows -------------------------------
console.log('\nNot one label in the whole catalogue overflows its cell:');
let devices = 0, badLabels = 0, truncatedLabels = 0, widest = { need: 0, label: '' };
const offenders = [];
catalog.forEach(function (sp) {
  let st;
  try {
    const t = new Topology();
    t.addDevice(sp);
    st = JSON.parse(JSON.stringify(t.serialize())).devices[0];
  } catch (e) { return; }
  devices++;
  [true, false].forEach(function (fullNames) {
    const groups = audit(FP.render(st, { fullNames: fullNames }), W);
    groups.forEach(function (g) {
      g.sockets.forEach(function (s) {
        if (s.need > s.budget + 1e-9) {
          badLabels++;
          if (offenders.length < 3) offenders.push(sp.vendor + ' ' + sp.model + ': ' + s.label);
        }
        if (s.truncated) truncatedLabels++;
        if (s.label.length > widest.label.length) widest = { need: s.need, label: s.label };
      });
    });
  });
});
ok(devices > 800, devices + ' devices rendered, both naming modes');
ok(badLabels === 0, 'no label overflows its cell' + (badLabels ? ' (' + offenders.join('; ') + ')' : ''));
ok(widest.need <= FP.labelBudget(1),
  'the longest label anywhere is "' + widest.label + '" at ' + widest.need.toFixed(1) +
  'px, inside the ' + FP.labelBudget(1).toFixed(1) + 'px a single column allots');
ok(truncatedLabels <= 2,
  'ellipsis is the exception, not the layout (' + truncatedLabels + ' labels in the catalogue)');

// --- 10. a narrower host column is still honest --------------------------
console.log('\nThe layout holds at other widths a host might give it:');
[280, 240, 200, 140].forEach(function (width) {
  const st = stateOf('cisco', 'C9300-48P');
  const groups = audit(FP.render(st, { fullNames: true, width: width }), width);
  const over = overflowers(groups);
  ok(over.length === 0,
    'at ' + width + 'px every label still fits its cell' + (over.length ? ' - ' + over[0] : ''));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
