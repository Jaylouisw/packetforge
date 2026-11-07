'use strict';
// One-off repair for issue #9: devices whose description names SFP ports that were
// modelled as copper.
//
// The rule is deliberately conservative: a port is only converted when its own NAME
// appears in the description next to an SFP/SFP+ claim (for example "8x 1G SFP fiber
// (ports 1-8)" or "eight 10G SFP+ cages (eth1-eth8)"). Where the description gives a
// count but no names, this leaves the device alone and reports it for a human -
// guessing which of 16 identical sockets is the fibre one is how wrong data gets in.
const fs = require('fs');
const path = require('path');
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine');

const OPTICAL = ['sfp', 'sfp+', 'sfp28', 'qsfp+', 'qsfp28', 'sc-apc', 'sc-upc'];
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const apply = process.argv.indexOf('--apply') !== -1;

function expandRange(a, b) {
  const out = [];
  const na = Number(a), nb = Number(b);
  if (!isNaN(na) && !isNaN(nb) && nb >= na) {
    for (let i = na; i <= nb; i++) out.push(String(i));
    return out;
  }
  // eth1-eth8 / Gi0/0/1-Gi0/0/4 style: keep the common prefix/suffix.
  const ma = String(a).match(/^(.*?)(\d+)$/), mb = String(b).match(/^(.*?)(\d+)$/);
  if (!ma || !mb || ma[1] !== mb[1]) return null;
  for (let i = Number(ma[2]); i <= Number(mb[2]); i++) out.push(ma[1] + i);
  return out;
}

// Pull out every "<n>x <speed> SFP[+] ... (names)" claim in the description.
function claims(desc) {
  const out = [];
  const text = String(desc || '');
  // Split into clauses so a claim cannot borrow a port list from another sentence.
  for (const clause of text.split(/[.;]/)) {
    if (!/sfp|qsfp|fiber|fibre/i.test(clause)) continue;
    if (/\b(no|without|optional|option|unfitted|not fitted|blank)\b/i.test(clause)) continue;
    const speed = /10G|10\s*Gb/i.test(clause) ? '10G' : (/25G/i.test(clause) ? '25G' : '1G');
    const kind = /sfp\+|10G/i.test(clause) ? 'sfp+' : 'sfp';
    // Port names in brackets: "(ports 1-8)", "(eth1-eth8)", "(ports 17-20)"
    const m = clause.match(/\(([^)]*)\)/);
    if (!m) continue;
    const inner = m[1];
    const range = inner.match(/([A-Za-z]*\d+(?:\/\d+)*)\s*-\s*([A-Za-z]*\d+(?:\/\d+)*)/);
    const listed = inner.match(/ports?\s+([\d,\s]+)/i);
    let names = null;
    if (range) names = expandRange(range[1], range[2]);
    else if (listed) names = listed[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (names && names.length) out.push({ names: names, speed: speed, kind: kind, clause: clause.trim().slice(0, 70) });
  }
  return out;
}

const fixes = [], manual = [];
for (const spec of catalog) {
  const t = new Topology();
  const dev = t.addDevice(spec);
  const ifaces = [...dev.interfaces.values()];
  if (ifaces.some(function (i) { return OPTICAL.indexOf(i.hardware.cage) !== -1; })) continue;
  const cs = claims(spec.description);
  if (!cs.length) {
    const optics = /\b(sfp|qsfp|xfp)\b/i.test(String(spec.description || ''));
    if (optics) manual.push(spec.vendor + '/' + spec.model + ' (no port names in description)');
    continue;
  }
  const changes = [];
  for (const c of cs) {
    for (const nm of c.names) {
      const hit = ifaces.find(function (i) {
        return i.name === nm || i.name.toLowerCase() === nm.toLowerCase();
      });
      if (!hit) continue;
      if (OPTICAL.indexOf(hit.hardware.cage) !== -1) continue;
      changes.push({ port: hit.name, kind: c.kind, speed: c.speed });
    }
  }
  if (!changes.length) { manual.push(spec.vendor + '/' + spec.model + ' (named ports did not match interfaces)'); continue; }
  fixes.push({ vendor: spec.vendor, model: spec.model, changes: changes });
}

console.log('Devices that can be repaired from their own description: ' + fixes.length);
for (const f of fixes) {
  console.log('  ' + f.vendor + '/' + f.model + ': ' +
    f.changes.map(function (c) { return c.port + '->' + c.kind + '@' + c.speed; }).join(', '));
}
console.log('\nLeft for a human (' + manual.length + '):');
for (const m of manual) console.log('  ' + m);

if (!apply) { console.log('\nDry run. Re-run with --apply to write.'); process.exit(0); }

let written = 0;
for (const f of fixes) {
  const dir = path.join(__dirname, '..', 'devices', f.vendor);
  for (const file of fs.readdirSync(dir)) {
    if (!/\.json$/.test(file)) continue;
    const full = path.join(dir, file);
    const spec = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (spec.model !== f.model) continue;
    for (const ch of f.changes) {
      const iface = spec.interfaces.find(function (i) { return i.name === ch.port; });
      if (!iface) continue;
      iface.type = 'ethernet';
      iface.connector = ch.kind;
      iface.speed = ch.speed;
      iface.speedCaps = ch.kind === 'sfp+' ? [1000, 10000] : [100, 1000];
    }
    fs.writeFileSync(full, JSON.stringify(spec, null, 2) + '\n');
    written++;
  }
}
console.log('\nWrote ' + written + ' device file(s).');
