'use strict';
// Sanity-check the SAN research file against the real engine rules.
const path = require('path');
const ROOT = 'C:/Users/jay/packetforge';
const media = require(path.join(ROOT, 'engine/media'));
const { expandInterfaces } = require(path.join(ROOT, 'engine/topology'));
const { validateConnection } = require(path.join(ROOT, 'engine/validation'));
const data = require(path.join(ROOT, 'research/incoming/devices-san.json'));

let bad = 0;
for (const spec of data.devices) {
  const ifaces = expandInterfaces(spec);
  const kinds = {};
  let uncabliable = 0;
  for (const i of ifaces) {
    const hw = media.derivePortHardware(i, spec);
    const key = hw.cage + '|' + hw.speedCaps.join('/') + '|' + hw.media.join(',');
    kinds[key] = (kinds[key] || 0) + 1;
    if (i.type === 'ethernet' && (!hw.media || !hw.media.length)) uncabliable++;
  }
  console.log(spec.vendor + '/' + spec.model + '  ports=' + ifaces.length + '  uncabliable=' + uncabliable);
  for (const k of Object.keys(kinds)) console.log('    ' + kinds[k] + ' x ' + k);
  if (uncabliable) bad++;
}

// Realistic SAN cabling: FC switch <-> FC switch (ISL) and FC switch <-> FC target.
const find = function (m) { return data.devices.find(function (d) { return d.model === m; }); };
const links = [
  ['G610', '0', 'SN3600B', '0'],                    // 32G FC ISL
  ['G610', '0', 'MDS 9124V', 'fc1/1'],              // 32G FC <-> 64G FC
  ['MDS 9148S', 'fc1/1', '5800V', '0'],             // 16G FC <-> 8G FC
  ['DS-6630B', '0', 'G720', '0'],                   // 32G FC <-> 64G FC
  ['G720', 'dd0', 'G720', 'dd1'],                   // SFP-DD ISL
  ['DS-6630B', 'icl0', 'DS-6630B', 'icl1'],         // QSFP ICL
  ['5800V', 'isl0', '5800V', 'isl1'],               // 10G stacking ISL
  ['G610', 'mgmt0', 'MDS 9148S', 'mgmt0'],          // out-of-band management
  ['PowerVault ME5012', 'A0', 'AFF A250', 'e0c'],   // 25GbE iSCSI
  ['MSA 2062', 'A0', 'PowerStore 500T', 'A0']       // 25GbE iSCSI
];
for (const [am, ap, bm, bp] of links) {
  const v = validateConnection({ devA: find(am), portA: ap, devB: find(bm), portB: bp });
  console.log((v.ok ? 'OK   ' : 'FAIL ') + am + ':' + ap + ' <-> ' + bm + ':' + bp +
    '  ' + (v.speedMbps ? v.speedMbps + ' Mbps' : '-') + ' via ' + (v.mediaId || '-') +
    (v.ok ? '' : '  ' + v.errors.map(function (e) { return e.code; }).join(',')));
  if (!v.ok) bad++;
}
console.log(bad ? '\n' + bad + ' problem(s)' : '\nAll specs cablable; every probe link validates.');
process.exit(bad ? 1 : 0);
