'use strict';
// Every SFP+ uplink on an Aruba 2930F runs at 1G as well as 10G, because the cage takes an SFP module.
//
// HPE states the uplink group as one object per model - "4 SFP/SFP+ 1G/10G ports" - and the "SFP/SFP+"
// spelling is the claim: an SFP+ cage that accepts an SFP module trains at 1G. The QuickSpecs say it for
// JL253A, JL254A, JL255A and JL256A (four ports each), for JL258A and JL693A (two each), and the product
// catalogue page repeats it as "(4) SFP+ 1/10GbE ports":
//
//   https://www.hpe.com/psnow/downloadDoc/HPE+Aruba+Networking+2930F+Switch+Series+QuickSpecs-c05052929.pdf
//   https://www.hpe.com/uk/en/product-catalog/options/pip.specifications.aruba-2930f-24g-poeplus-4sfpplus-switch.1008995332.html
//
// The catalogue had that right on the first uplink of each model and wrong on the rest: port 49 of the
// JL256A, port 25 of the JL253A and port 9 of the JL258A carried speedCaps [1000, 10000] while their
// identical siblings carried [10000]. That is not a vendor distinction, it is the residue of a fix that
// patched the one port an audit named (#994) and left the class alone - so a 10G peer could be cabled to
// port 49 but not to port 50, and a 1G SFP was refused by three of the four uplinks. Issue #1066 is the
// JL256A half of it; this pins the whole family. research/aruba-2930f-sfp-uplink-speeds.md records the
// evidence and the two 1G-only SFP models this leaves alone.
const path = require('path');
const { Topology } = require('../engine');
const media = require('../engine/media');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK ' + msg); }
  else { failed++; console.error('  FAIL ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) {
  const s = catalog.filter(function (x) { return x.vendor === 'aruba' && x.model === model; })[0];
  if (!s) throw new Error('missing spec ' + model);
  return s;
}

const TEN_G_ROWS = {
  '2930F 24G 4SFP+': ['25', '26', '27', '28'],
  '2930F 48G PoE+ 4SFP+': ['49', '50', '51', '52'],
  '2930F 8G PoE+ 2SFP+': ['9', '10'],
  '2930F 12G PoE+ 2G/2SFP+ (JL693A)': ['15', '16']
};

section('Every 10G SFP+ uplink on the 2930F family trains at 1G and 10G');
for (const [model, ports] of Object.entries(TEN_G_ROWS)) {
  const t = new Topology();
  const sw = t.addDevice(spec(model), 'SW');
  const badCage = [], badCaps = [], badMedia = [];
  for (const n of ports) {
    const p = sw.interfaces.get(n);
    if (!p || p.cage !== 'sfp+') badCage.push(n + '=' + (p && p.cage));
    const caps = (p && p.hardware && p.hardware.speedCaps) || [];
    if (!(caps.indexOf(1000) !== -1 && caps.indexOf(10000) !== -1)) badCaps.push(n + '=' + JSON.stringify(caps));
    const offered = (p && p.hardware && p.hardware.media) || [];
    if (offered.indexOf('1000base-sx') === -1) badMedia.push(n);
  }
  ok(badCage.length === 0, model + ': ' + ports.length + ' uplinks are SFP+ cages' +
    (badCage.length ? ' (' + badCage.join(', ') + ')' : ''));
  ok(badCaps.length === 0, model + ': each trains at 1G and 10G' +
    (badCaps.length ? ' (' + badCaps.join(', ') + ')' : ''));
  ok(badMedia.length === 0, model + ': each offers a 1000BASE-SX optic' +
    (badMedia.length ? ' (' + badMedia.join(', ') + ')' : ''));
}

section('The JL256A uplinks are interchangeable, which is what #1066 asked for');
{
  const t = new Topology();
  const sw = t.addDevice(spec('2930F 48G PoE+ 4SFP+'), 'JL256A');
  const ten = media.canMate(sw.interfaces.get('50').hardware, sw.interfaces.get('51').hardware,
    { mediaId: '10gbase-sr' });
  ok(ten.ok === true, 'ports 50 and 51 meet over a 10GBASE-SR optic', ten.code + ': ' + ten.message);
  ok(ten.speedMbps === 10000, 'at 10G', String(ten.speedMbps));
  const dac = media.canMate(sw.interfaces.get('49').hardware, sw.interfaces.get('52').hardware,
    { mediaId: 'dac-10g' });
  ok(dac.ok === true, 'ports 49 and 52 meet over a 10G DAC', dac.code + ': ' + dac.message);
  const one = media.canMate(sw.interfaces.get('50').hardware, sw.interfaces.get('52').hardware,
    { mediaId: '1000base-sx' });
  ok(one.ok === true, 'a 1G SFP is accepted on port 50 as on port 49', one.code + ': ' + one.message);
  const media50 = sw.interfaces.get('50').hardware.media;
  ok(media50.indexOf('10gbase-t') === -1, 'no bare 10GBASE-T medium is offered: the cage takes a module, not a plug',
    JSON.stringify(media50));
}

section('The 1G-only SFP rows are left alone');
{
  for (const model of ['2930F 48G 4SFP (JL260A)', '2930F 48G PoE+ 4SFP 740W (JL557A)']) {
    const t = new Topology();
    const sw = t.addDevice(spec(model), 'SFP1G');
    const wrong = [];
    for (let n = 49; n <= 52; n++) {
      const p = sw.interfaces.get(String(n));
      const caps = (p && p.hardware && p.hardware.speedCaps) || [];
      if (p.cage !== 'sfp' || caps.indexOf(10000) !== -1) wrong.push(n + '=' + p.cage + JSON.stringify(caps));
    }
    ok(wrong.length === 0, model + ': stays an SFP cage limited to 1G' +
      (wrong.length ? ' (' + wrong.join(', ') + ')' : ''));
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
