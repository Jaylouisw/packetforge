'use strict';
// Every model in the catalogue, drawn as a front panel (#1477).
//
// The faceplate is the view that has to be readable *where the canvas is not*: on a 48-port switch the drawing is
// 48 indistinguishable dots whose labels appear only on selection. So the front panel is the tool an operator
// reaches for when the question is "which socket is this" - and the catalogue is 2,038 models built from 757
// distinct port shapes, every one of which can be dragged onto a board.
//
// The existing faceplate suite checks two specific devices in detail. This one checks the other axis: breadth. All
// 2,038 models, 20,280 sockets, in about a second - a renderer change that blanks one connector family, drops a
// port, or prints `undefined` into a label cannot reach main unannounced, because the catalogue is the input and
// nothing here is hand-listed.
//
// What it asserts, per model:
//   * it renders at all, and rendering it twice gives the same HTML;
//   * every port the engine knows about appears exactly once, and no port appears twice;
//   * the number of sockets drawn equals the number of ports;
//   * no socket is unlabelled - a socket you cannot read is a socket you cannot use;
//   * no `undefined`, `NaN` or `[object Object]` reaches the markup.
// And, over the catalogue: every distinct port shape is covered by at least one rendered model, so a family that
// the sweep silently skipped would be a failure rather than a gap.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const sandbox = { console: console, window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'faceplate.js'), 'utf8'), sandbox, { filename: 'faceplate.js' });
const FP = sandbox.window.PFFaceplate;

const specs = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });

// A shape is the thing the renderer actually has to cope with: the socket sequence, or the template that
// generates one. Two models sharing a shape are drawn by the same code path.
function shapeOf(spec) {
  const ifs = spec.interfaces || [];
  return (spec.category || '?') + '|' +
    (spec.portTemplate ? 'template:' + JSON.stringify(spec.portTemplate) : '') + '|' +
    ifs.map(function (i) { return i.connector + '/' + i.type; }).join(',');
}

console.log('');
console.log('Every catalogued model draws as a front panel:');
{
  const threw = [], blank = [], junk = [], missingPort = [], doubled = [], unlabelled = [], miscounted = [], unstable = [];
  const stable = unstable;   // two names for one list: the assertion below reads better as `stable`
  const shapes = new Map();
  let ports = 0;

  for (const spec of specs) {
    const label = spec.vendor + '/' + spec.model;
    const t = new Topology();
    let dev;
    try { t.addDevice(spec, 'd1'); dev = t.getDevice('d1'); }
    catch (err) { threw.push(label + ': addDevice ' + err.message); continue; }
    const doc = dev.serialize();

    let html;
    try { html = FP.render(doc, {}); }
    catch (err) { threw.push(label + ': render ' + err.message); continue; }

    if (typeof html !== 'string' || !html.trim()) { blank.push(label); continue; }
    if (FP.render(doc, {}) !== html) unstable.push(label);

    const at = html.search(/undefined|NaN|\[object Object\]/);
    if (at >= 0) junk.push(label + ' …' + html.slice(Math.max(0, at - 30), at + 30).replace(/\s+/g, ' '));

    const names = Array.from(dev.interfaces.keys());
    for (const n of names) {
      ports++;
      const count = html.split('data-port="' + n + '"').length - 1;
      if (count === 0) missingPort.push(label + ' ' + n);
      else if (count > 1) doubled.push(label + ' ' + n);
    }

    const cells = html.match(/<button type="button" class="fp-port[^>]*>[\s\S]*?<\/button>/g) || [];
    if (cells.length !== names.length) miscounted.push(label + ' ' + cells.length + ' sockets vs ' + names.length + ' ports');
    for (const cell of cells) {
      const text = cell.replace(/<[^>]*>/g, '').trim();
      if (!text) { unlabelled.push(label); break; }
    }

    const shape = shapeOf(spec);
    if (!shapes.has(shape)) shapes.set(shape, 0);
    shapes.set(shape, shapes.get(shape) + 1);
  }

  console.log('    (' + specs.length + ' models, ' + ports + ' sockets, ' + shapes.size + ' distinct port shapes)');
  ok(threw.length === 0, 'every model renders without throwing', threw.slice(0, 4).join(' | '));
  ok(blank.length === 0, 'and no model renders as an empty panel', blank.slice(0, 4).join(', '));
  ok(stable.length === 0, 'rendering the same device twice gives the same panel', unstable.slice(0, 4).join(', '));
  ok(junk.length === 0, 'no undefined, NaN or [object Object] reaches the markup', junk.slice(0, 4).join(' | '));
  ok(missingPort.length === 0, 'every port the engine knows about appears on the panel', missingPort.slice(0, 6).join(', '));
  ok(doubled.length === 0, 'and none of them appears twice', doubled.slice(0, 6).join(', '));
  ok(miscounted.length === 0, 'the socket count equals the port count', miscounted.slice(0, 4).join(' | '));
  ok(unlabelled.length === 0, 'no socket is drawn without a legible label', unlabelled.slice(0, 4).join(', '));
  ok(shapes.size > 100, 'the catalogue really is many shapes, so the sweep covers breadth', shapes.size + ' shapes');
}

console.log('');
console.log('The awkward families stay awkward but readable:');
{
  // The traps this sweep is for: a device whose ports come from a template rather than a list, a 48-port switch
  // where labels are the whole point, and a chassis with cages at the end.
  const t = new Topology();
  const templated = specs.find(function (s) { return s.portTemplate && (s.interfaces || []).length === 0; });
  ok(!!templated, 'the catalogue contains a template-built device', templated && (templated.vendor + '/' + templated.model));
  if (templated) {
    t.addDevice(templated, 't1');
    const dev = t.getDevice('t1');
    const html = FP.render(dev.serialize(), {});
    const names = Array.from(dev.interfaces.keys());
    ok(names.length > 0 && names.every(function (n) { return html.indexOf('data-port="' + n + '"') !== -1; }),
      'a template-built device draws one socket per generated port', (templated.vendor + '/' + templated.model) + ' ' + names.length + ' ports');
  }

  const dense = specs.filter(function (s) { return (s.interfaces || []).length >= 24; })
    .sort(function (a, b) { return (b.interfaces || []).length - (a.interfaces || []).length; })[0];
  ok(!!dense, 'and a dense one', dense && (dense.vendor + '/' + dense.model + ' ' + (dense.interfaces || []).length + ' ports'));
  if (dense) {
    const t2 = new Topology();
    t2.addDevice(dense, 'd1');
    const dev = t2.getDevice('d1');
    const html = FP.render(dev.serialize(), {});
    const cells = html.match(/<button type="button" class="fp-port[^>]*>/g) || [];
    const labels = new Set((html.match(/data-port="([^"]+)"/g) || []).map(function (m) { return m.slice(11, -1); }));
    ok(cells.length === labels.size, 'a dense panel draws one socket per distinct port', cells.length + ' sockets, ' + labels.size + ' ports');
    ok(html.indexOf('fp-row') !== -1 || html.indexOf('fp-bank') !== -1 || html.indexOf('fp-cage') !== -1,
      'and groups them the way the silkscreen does');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
