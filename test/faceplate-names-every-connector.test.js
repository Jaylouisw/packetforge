'use strict';
// Every connector in the catalogue has a name, and a serial port is not a console port.
//
// The 2811 - the router every lab starts with - declares `connector: "serial"` on Se0/0/0 and Se0/0/1. The faceplate
// had no word for that connector, so the label fell through to the unknown placeholder *and* the family fallback put
// both ports under "Console", giving this over a WIC-2T:
//
//     Console   [Connector unknown]   2 ports   0.064M/0.128M/0.256M/0.512M/1.024M/1.544M
//
// Three separate wrongs in one header: a data port titled as a management port, a connector the spec names drawn as
// unknown, and a 64 kbit line printed as "0.064M" where `show interfaces` says "64K".
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadCatalog } = require('../devices/registry');
const { formatSpeedMbps } = require('../engine/media');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; }
  else { failed++; console.log('  not ok - ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ctx = { console: console, window: {}, Math: Math, Date: Date, JSON: JSON };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'faceplate.js'), 'utf8'), ctx,
  { filename: 'faceplate.js' });
const FP = ctx.window.PFFaceplate;
ok(!!FP && typeof FP.cageLabel === 'function', 'faceplate.js loads and exposes cageLabel');

// 1. a serial connector has a name ---------------------------------------------------
ok(FP.cageLabel('serial') === 'Serial',
  'a connector the specs name is drawn with its name, not "Connector unknown"', FP.cageLabel('serial'));
ok(FP.cageLabel('nonsense') === 'Connector unknown',
  'and a connector nothing names is still drawn as unknown, not guessed', FP.cageLabel('nonsense'));

// 2. a serial port is not a console port --------------------------------------------
ok(FP.familyOf('serial', { type: 'serial' }) === 'serial',
  'serial is its own family', FP.familyOf('serial', { type: 'serial' }));
ok(FP.familyOf('no-such-cage', { type: 'serial' }) === 'serial',
  'a serial port whose connector has no entry still falls back to serial, not to console',
  FP.familyOf('no-such-cage', { type: 'serial' }));
ok(FP.familyOf('no-such-cage', { type: 'console' }) === 'console',
  'and a console port with no connector still falls back to console',
  FP.familyOf('no-such-cage', { type: 'console' }));
ok(FP.FAMILY_ORDER.indexOf('serial') > FP.FAMILY_ORDER.indexOf('console'),
  'serial sorts after console on the chassis, like the specialist connectors it belongs with',
  FP.FAMILY_ORDER.join(','));

// 3. no port in the catalogue is titled as a management port unless it is one -------------
const specs = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return s && s.interfaces; });
let mislabelled = 0, serials = 0, unnamed = 0;
const examples = [];
for (const s of specs) {
  for (const i of s.interfaces) {
    const cage = FP.resolveCage ? FP.resolveCage(i) : (i.cage || i.connector || i.type);
    const family = FP.familyOf(cage, i);
    if (i.type === 'serial') {
      serials++;
      if (family !== 'serial' || /unknown/i.test(FP.cageLabel(cage))) {
        unnamed++;
        if (examples.length < 4) examples.push(s.vendor + '/' + s.model + ' ' + i.name + ' → ' + FP.cageLabel(cage));
      }
    }
    if (family === 'console' && i.type !== 'console' && cage !== 'console' && cage !== 'usb') {
      mislabelled++;
      if (examples.length < 4) examples.push(s.vendor + '/' + s.model + ' ' + i.name + ' (' + i.type + ')');
    }
  }
}
ok(serials > 0, 'the catalogue declares serial ports at all: ' + serials);
ok(unnamed === 0, 'every serial port in the catalogue draws a serial connector', unnamed + ': ' + examples.join('; '));
ok(mislabelled === 0, 'no port is drawn in the console family unless it is a console port',
  mislabelled + ': ' + examples.join('; '));

// 4. the faceplate spells a speed the way the engine does -------------------------------
const RATES = [0.0096, 0.064, 0.1152, 1, 1.544, 10, 100, 1000, 2500, 40000, 400000, 800000];
let drift = 0;
for (const mbps of RATES) {
  const mine = FP.fmtRate(mbps);
  const engine = formatSpeedMbps(mbps);
  if (mine !== engine) { drift++; console.log('  not ok - ' + mbps + ' Mbps: faceplate "' + mine + '" vs engine "' + engine + '"'); }
}
ok(drift === 0, 'every rate is spelt the way `show interfaces` spells it (' + RATES.length + ' sampled)');
ok(FP.fmtRate(0.064) === '64K', 'a 64 kbit serial line is 64K, not 0.064M', FP.fmtRate(0.064));
ok(FP.fmtRate(0.0096) === '9.6K', 'a 9600 baud console line is 9.6K, not 0.0096M', FP.fmtRate(0.0096));

// 5. the router every lab starts with, end to end --------------------------------------
const c2811 = specs.find(function (s) { return s.vendor === 'cisco' && s.model === '2811'; });
ok(!!c2811, 'cisco/2811 is in the catalogue');
if (c2811) {
  for (const name of ['Se0/0/0', 'Se0/0/1']) {
    const i = c2811.interfaces.find(function (x) { return x.name === name; });
    ok(!!i, name + ' is modelled');
    if (i) {
      const cage = FP.resolveCage(i);
      ok(FP.cageLabel(cage) === 'Serial', name + ' is drawn as Serial (' + FP.cageLabel(cage) + ')');
      ok(FP.familyOf(cage, i) === 'serial', name + ' is in the serial group (' + FP.familyOf(cage, i) + ')');
    }
  }
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
