'use strict';
// A port has one identity and several spellings (issue #39).
//
// Renaming MikroTik ports to the form printed on the hardware (eth1, SFP+1) was right, but
// Topology.connect() looked a port up by exact name: every lab saved before the rename
// threw "Unknown interface ether1", and CI went red on the example labs. A display change
// must never invalidate saved work, so the engine resolves names through one alias table -
// the same one the CLI uses - and stores the device's own spelling on the link.
const path = require('path');
const fs = require('fs');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const ifaceName = require('../engine/iface-name');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));

// A MikroTik device (ports renamed to eth1 / SFP+1) and anything it can legally meet.
function mikrotikWithEth() {
  return catalog.find(function (s) {
    return String(s.vendor).toLowerCase().indexOf('mikrotik') !== -1 &&
      (s.interfaces || []).some(function (i) { return i.name === 'eth1' && i.type === 'ethernet'; });
  });
}

function copperPeer(exceptVendor) {
  return catalog.find(function (s) {
    if (String(s.vendor).toLowerCase() === String(exceptVendor).toLowerCase()) return false;
    return s.category === 'switch' &&
      (s.interfaces || []).some(function (i) {
        return i.type === 'ethernet' && (!i.connector || String(i.connector).toLowerCase() === 'rj45');
      });
  });
}

const mt = mikrotikWithEth();
ok(!!mt, 'the catalogue has a MikroTik device with a panel-named eth1 port (' + (mt && mt.model) + ')');

console.log('');
console.log('The table itself:');
{
  ok(ifaceName.portKey('ether1') === ifaceName.portKey('eth1'), 'ether1 and eth1 share a key');
  ok(ifaceName.portKey('ETH1') === ifaceName.portKey('eth1'), 'case does not matter');
  ok(ifaceName.portKey('sfp-sfpplus1') === ifaceName.portKey('SFP+1'), 'sfp-sfpplus1 folds onto SFP+1');
  ok(ifaceName.portKey('ether1.10') !== ifaceName.portKey('eth1'),
    'a subinterface is not the parent');
}

console.log('');
console.log('A saved lab that says ether1 still loads:');
{
  const t = new Topology();
  const a = t.addDevice(mt);
  const b = t.addDevice(copperPeer(mt.vendor));
  const peerPort = [...b.interfaces.keys()].find(function (n) { return b.interfaces.get(n).hardware.cage === 'rj45'; });

  const link = t.connect(a.id, 'ether1', b.id, peerPort, {});
  ok(!!link, 'connect() accepts the RouterOS spelling');
  ok(link.a.iface === 'eth1', 'and stores the panel spelling on the link (' + link.a.iface + ')');
  ok(a.interfaces.get('eth1').peer !== null, 'the port knows it is cabled');
}

console.log('');
console.log('And the panel spelling is unchanged:');
{
  const t = new Topology();
  const a = t.addDevice(mt);
  const b = t.addDevice(copperPeer(mt.vendor));
  const peerPort = [...b.interfaces.keys()].find(function (n) { return b.interfaces.get(n).hardware.cage === 'rj45'; });
  const link = t.connect(a.id, 'eth1', b.id, peerPort, {});
  ok(link.a.iface === 'eth1', 'connect() with eth1 works the same way');
}

console.log('');
console.log('A dry run agrees with the real thing:');
{
  const t = new Topology();
  const a = t.addDevice(mt);
  const b = t.addDevice(copperPeer(mt.vendor));
  const peerPort = [...b.interfaces.keys()].find(function (n) { return b.interfaces.get(n).hardware.cage === 'rj45'; });
  const byAlias = t.validateLink(a.id, 'ether1', b.id, peerPort, {});
  const byPanel = t.validateLink(a.id, 'eth1', b.id, peerPort, {});
  ok(byAlias.ok === byPanel.ok, 'validateLink gives the same verdict for both spellings');
  ok(byAlias.ok === true, 'and the verdict is that a copper cable is fine');
}

console.log('');
console.log('Resolution refuses to guess:');
{
  const t = new Topology();
  const a = t.addDevice(mt);
  ok(ifaceName.resolvePortName(a, 'eth999') === null, 'a port that does not exist resolves to nothing');
  ok(ifaceName.resolvePortName(a, '') === null, 'and an empty name resolves to nothing');
  let threw = false;
  try { t.connect(a.id, 'eth999', a.id, 'eth1', {}); } catch (e) { threw = /Unknown interface/.test(e.message); }
  ok(threw, 'connect() still throws a clear error for a name that means nothing');
}

console.log('');
console.log('The shipped example labs use the printed names:');
{
  const lab = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'lab3-multi-vendor-campus.json'), 'utf8'));
  const text = JSON.stringify(lab);
  ok(!/"ether\d+"/.test(text), 'no lab still says ether1');
  ok(text.indexOf('"sfp-sfpplus') === -1, 'no lab still says sfp-sfpplus1');
  ok(text.indexOf('"eth1"') !== -1 || text.indexOf('"SFP+1"') !== -1, 'and the printed names are used');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
