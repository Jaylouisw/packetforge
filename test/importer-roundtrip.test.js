'use strict';
// The importer must not lose hardware detail.
//
// Issue #22: it rebuilt every interface as {name, type, speed} and dropped connector,
// speedCaps, poeIn, poeOut, comboWith, comboRole - plus the top-level poe, notes,
// sourceUrl and portSplitNote. Nothing failed, because the engine infers a cage from the
// port name, so a spec that had lost its connector still produced a plausible port. The
// catalogue ended up with 684 of 878 devices carrying no hardware detail at all and 170
// describing PoE with no budget anywhere.
//
// This imports a deliberately rich spec into a scratch devices tree and asserts every
// field survives, so the flattening cannot come back.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const ROOT = path.join(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-import-'));
const incoming = path.join(scratch, 'incoming');
const devices = path.join(scratch, 'devices');
fs.mkdirSync(incoming, { recursive: true });
fs.mkdirSync(devices, { recursive: true });

// A spec using every field the importer used to discard.
const rich = {
  vendor: 'probe',
  model: 'RICH-24P',
  label: 'Rich 24-port PoE switch',
  category: 'switch',
  description: '24x 1G PoE+ with 2 combo RJ45/SFP+ uplinks and a 370 W budget.',
  capabilities: ['l2-forward', 'cli'],
  sourceUrl: 'https://example.invalid/datasheet.pdf',
  notes: 'Datasheet states 370 W with one PSU.',
  portSplitNote: '24 copper + 2 combo',
  poe: { budgetW: 370, budgetUnknown: false },
  interfaces: [
    {
      name: 'Gi1/0/1', type: 'ethernet', speed: '1G',
      connector: 'rj45', cage: 'rj45', speedCaps: [10, 100, 1000],
      poeOut: 30, description: 'access port'
    },
    {
      name: 'Gi1/0/25', type: 'ethernet', speed: '1G',
      connector: 'rj45', cage: 'rj45', speedCaps: [10, 100, 1000],
      comboWith: 'Gi1/0/25-sfp', comboRole: 'rj45', dualRole: true
    },
    {
      name: 'Gi1/0/25-sfp', type: 'ethernet', speed: '10G',
      connector: 'sfp+', cage: 'sfp+', speedCaps: [1000, 10000],
      comboWith: 'Gi1/0/25', comboRole: 'sfp'
    }
  ]
};

fs.writeFileSync(path.join(incoming, 'devices-probe.json'), JSON.stringify([rich], null, 2));

console.log('Importing a fully-populated spec:');
{
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'import-devices.js'), '--apply'], {
    env: Object.assign({}, process.env, { PF_INCOMING: incoming, PF_DEVICES: devices }),
    encoding: 'utf8'
  });
  ok(/Added: 1/.test(out), 'the importer reports one added device');

  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.json$/i.test(e.name)) files.push(p);
    }
  })(devices);
  ok(files.length === 1, 'exactly one spec file was written (' + files.length + ')');

  const got = JSON.parse(fs.readFileSync(files[0], 'utf8'));

  console.log('\nTop-level fields survive:');
  ok(got.sourceUrl === rich.sourceUrl, 'sourceUrl is preserved');
  ok(got.notes === rich.notes, 'notes are preserved');
  ok(got.portSplitNote === rich.portSplitNote, 'portSplitNote is preserved');
  ok(got.poe && got.poe.budgetW === 370, 'the PoE budget survives (it gates PoE enforcement)');
  ok(got.poe && got.poe.budgetUnknown === false, 'and so does budgetUnknown');

  console.log('\nPer-interface fields survive:');
  const byName = {};
  for (const i of got.interfaces) byName[i.name] = i;
  const p1 = byName['Gi1/0/1'];
  ok(!!p1, 'the first port is present');
  ok(p1.connector === 'rj45', 'connector survives');
  ok(Array.isArray(p1.speedCaps) && p1.speedCaps.length === 3, 'speedCaps survive');
  ok(p1.poeOut === 30, 'poeOut survives (it is what PoE budgeting counts)');
  ok(p1.description === 'access port', 'the port description survives');

  const c1 = byName['Gi1/0/25'];
  const c2 = byName['Gi1/0/25-sfp'];
  ok(c1 && c2, 'both halves of the combo pair are present');
  ok(c1 && c1.comboWith === 'Gi1/0/25-sfp', 'comboWith survives on the copper half');
  ok(c1 && c1.comboRole === 'rj45', 'comboRole survives');
  ok(c1 && c1.dualRole === true, 'dualRole survives');
  ok(c2 && c2.connector === 'sfp+', 'the fibre half keeps its connector');
  ok(c2 && Array.isArray(c2.speedCaps) && c2.speedCaps.indexOf(10000) !== -1, 'and its speedCaps');
}

console.log('\nA thin spec on disk can be repaired, and a rich one is left alone:');
{
  // Rewrite the imported spec as the old flattening would have left it.
  const dir = path.join(devices, 'probe');
  const file = path.join(dir, 'rich-24p.json');
  const thin = JSON.parse(JSON.stringify(rich));
  thin.interfaces = thin.interfaces.map(function (i) { return { name: i.name, type: i.type, speed: i.speed }; });
  delete thin.poe; delete thin.notes; delete thin.sourceUrl; delete thin.portSplitNote;
  fs.writeFileSync(file, JSON.stringify(thin, null, 2));

  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'import-devices.js'), '--apply', '--upgrade'], {
    env: Object.assign({}, process.env, { PF_INCOMING: incoming, PF_DEVICES: devices }),
    encoding: 'utf8'
  });
  ok(/upgraded: 1/.test(out), 'the flattened entry is reported as upgraded');

  const repaired = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(repaired.poe && repaired.poe.budgetW === 370, 'the PoE budget is back');
  const r1 = repaired.interfaces.find(function (i) { return i.name === 'Gi1/0/1'; });
  ok(r1 && r1.connector === 'rj45', 'the connector is back');
  ok(fs.readdirSync(dir).length === 1, 'the repair overwrote the existing file rather than creating a second one');

  // Now the file is rich: a second upgrade run must not touch it again.
  const out2 = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'import-devices.js'), '--apply', '--upgrade'], {
    env: Object.assign({}, process.env, { PF_INCOMING: incoming, PF_DEVICES: devices }),
    encoding: 'utf8'
  });
  ok(!/upgraded: \d/.test(out2), 'an already-detailed entry is not rewritten again');
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
