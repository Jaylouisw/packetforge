
const media = require('C:/Users/jay/packetforge/engine/media.js');
const fs = require('fs');
const specs = JSON.parse(fs.readFileSync('C:/Users/jay/packetforge/research/incoming/devices-mediaconv.json','utf8'));
for (const s of specs) {
  console.log('== ' + s.vendor + '/' + s.model + '  (' + s.interfaces.length + ' ports)');
  for (const i of s.interfaces) {
    const hw = media.derivePortHardware(i, s);
    console.log('   ' + i.name.padEnd(14) + ' cage=' + hw.cage.padEnd(8) + ' fam=' + hw.family.padEnd(8) +
      ' maxMbps=' + hw.maxSpeedMbps + ' caps=[' + hw.speedCaps.join(',') + '] media=[' + hw.media.join(',') + ']');
  }
}
