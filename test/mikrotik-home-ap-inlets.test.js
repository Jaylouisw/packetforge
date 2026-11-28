"use strict";
// Ten MikroTik hAP/wsAP home boxes were asking for 12.95 W on every copper socket.
//
// The guess in engine/media.js derivePortHardware() fills a silent poeIn whenever isPoePd()
// matches, and category: wireless matches every one of these. Seven of the ten name one inlet
// in their own manual and six of those also print a PoE-out port; three have no PoE at all and
// are powered from microUSB. Four of the seven inlet rows spelled the schema-illegal poeIn: true
// (DEVICE_SCHEMA.md: "watts this port draws, as a number - 12.95 and 25.5 are different devices,
// so true is wrong") and the 37 sockets beside the inlets were guessed at 12.95 W apiece.
//
//   file                        model                     copper  inlet  W   PoE-out
//   rb941-2nd                   RB941-2nD                    4     -     -     -
//   rb941-2nd-tc                RB941-2nD-TC                 4     -     -     -
//   rb931-2nd                   RB931-2nD                    3     -     -     -
//   rb951g-2hnd                 RB951G-2HnD                  5    eth1   7     -
//   rb952ui-5ac2nd              RB952Ui-5ac2nD               5    eth1   8    eth5
//   rb952ui-5ac2nd-tc           RB952Ui-5ac2nD-TC            5    eth1   8    eth5
//   rb962uigs-5hact2hnt         RB962UiGS-5HacT2HnT          5    eth1  17    eth5
//   rbd52g-5hacd2hnd-tc         RBD52G-5HacD2HnD-TC          5    eth1  16     -
//   RBD53iG-5HacD2HnD           RBD53iG-5HacD2HnD            5    eth1  12    eth5
//   rbwsap-5hac2nd              RBwsAP-5Hac2nD               3    eth1   6    eth3
//
// 37 sockets at 12.95 W = 479.15 W of demand from ten boards whose seven inlets total 74 W.
//
// Vendor material, all read 2026-11-28:
//   https://manual.mikrotik.com/hardware/hap-lite/      microUSB 5 V only, "no PoE" (RB941-2nD)
//   https://manual.mikrotik.com/hardware/hap-lite-tc/   microUSB only (RB941-2nD-TC)
//   https://manual.mikrotik.com/hardware/hap-mini/      microUSB only (RB931-2nD)
//   https://manual.mikrotik.com/hardware/rb951-series/  "The first Ethernet port accepts passive
//        Power over Ethernet accepts 8-30 V DC"; the Ether5 output is named for RB951Ui only
//   https://manual.mikrotik.com/hardware/hap-ac-lite/   "first Ethernet port (Passive PoE) ...
//        The Ether5 port supports PoE output"
//   https://manual.mikrotik.com/hardware/hap-ac-lite-tc/  same, 12-30 V DC
//   https://manual.mikrotik.com/hardware/hap-ac/        "first Ethernet port (Passive PoE) ...
//        The Ether 5 port supports PoE output ... up to 0.7 A"
//   https://manual.mikrotik.com/hardware/hap-ac-2/      first port 18-28 V DC, no PoE-out
//   https://manual.mikrotik.com/hardware/hap-ac3/       "PoE in 18-28 V DC on ethernet 1"
//   https://manual.mikrotik.com/hardware/wsap-ac-lite/  "only accepts powering at the E1 port
//        with PoE"; "The E3 port is capable of powering another RouterBOARD device"
// and each product page prints the pair (PoE in / PoE out / Max power consumption without
// attachments) quoted in the spec notes.
const path = require("path");
const { Topology, Simulator } = require("../engine");
const { loadCatalog } = require("../devices/registry");

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log("  \u2713 " + msg); }
  else { failed++; console.error("  \u2717 " + msg + (detail ? "  [" + detail + "]" : "")); }
}

const catalog = loadCatalog(path.join(__dirname, "..", "devices")).filter(function (s) { return !s.error; });
const COPPER = ["rj45", "combo"];

const ROWS = [
  { file: "rb941-2nd", model: "RB941-2nD", copper: 4, inlet: null, watts: 0, out: null },
  { file: "rb941-2nd-tc", model: "RB941-2nD-TC", copper: 4, inlet: null, watts: 0, out: null },
  { file: "rb931-2nd", model: "RB931-2nD", copper: 3, inlet: null, watts: 0, out: null },
  { file: "rb951g-2hnd", model: "RB951G-2HnD", copper: 5, inlet: "eth1", watts: 7, out: null },
  { file: "rb952ui-5ac2nd", model: "RB952Ui-5ac2nD", copper: 5, inlet: "eth1", watts: 8, out: "eth5" },
  { file: "rb952ui-5ac2nd-tc", model: "RB952Ui-5ac2nD-TC", copper: 5, inlet: "eth1", watts: 8, out: "eth5" },
  { file: "rb962uigs-5hact2hnt", model: "RB962UiGS-5HacT2HnT", copper: 5, inlet: "eth1", watts: 17, out: "eth5" },
  { file: "rbd52g-5hacd2hnd-tc", model: "RBD52G-5HacD2HnD-TC", copper: 5, inlet: "eth1", watts: 16, out: null },
  { file: "RBD53iG-5HacD2HnD", model: "RBD53iG-5HacD2HnD", copper: 5, inlet: "eth1", watts: 12, out: "eth5" },
  { file: "rbwsap-5hac2nd", model: "RBwsAP-5Hac2nD", copper: 3, inlet: "eth1", watts: 6, out: "eth3" }
];

function copperKeys(spec) {
  return spec.interfaces.filter(function (i) {
    return i.type === "ethernet" && (i.connector || "rj45") === "rj45";
  });
}

let copperTotal = 0, silentTotal = 0, wattsTotal = 0;

ROWS.forEach(function (row) {
  console.log("");
  console.log("== " + row.model + (row.inlet
    ? ": one inlet at " + row.watts + " W, " + (row.copper - 1) + " sockets that say no"
    : ": no PoE at all, " + row.copper + " sockets that say no"));

  const spec = catalog.filter(function (s) { return s.vendor === "mikrotik" && s.model === row.model; })[0];
  ok(!!spec, row.model + " is in the catalogue (" + row.file + ".json)");
  if (!spec) { return; }

  const copper = copperKeys(spec);
  ok(copper.length === row.copper, row.copper + " copper sockets (" + copper.length + ")");
  copperTotal += copper.length;

  ok(copper.every(function (i) { return typeof i.poeIn === "number" || i.poeIn === false; }),
    "no copper socket is left silent for isPoePd() to fill in",
    copper.filter(function (i) { return typeof i.poeIn !== "number" && i.poeIn !== false; })
      .map(function (i) { return i.name + "=" + JSON.stringify(i.poeIn); }).join(","));

  const drawing = copper.filter(function (i) { return typeof i.poeIn === "number" && i.poeIn > 0; });
  if (row.inlet) {
    ok(drawing.length === 1 && drawing[0].name === row.inlet,
      "exactly one socket draws power, and it is " + row.inlet);
    ok(drawing.length === 1 && drawing[0].poeIn === row.watts,
      "it draws " + row.watts + " W (" + (drawing[0] && drawing[0].poeIn) + ")");
    ok(drawing.length === 1 && typeof drawing[0].poeIn === "number",
      "and states watts as a number, not true");
    ok(copper.filter(function (i) { return i.name !== row.inlet; })
      .every(function (i) { return i.poeIn === false; }),
      "every other socket declares poeIn: false - a claim, not a silence");
    wattsTotal += row.watts;
    silentTotal += row.copper - 1;
  } else {
    ok(drawing.length === 0, "no socket on the board draws power (" + drawing.length + ")");
    ok(copper.every(function (i) { return i.poeIn === false; }),
      "all " + row.copper + " sockets declare poeIn: false");
    silentTotal += row.copper;
  }

  if (row.out) {
    const pse = copper.filter(function (i) { return i.name === row.out; })[0];
    ok(!!pse && pse.poeOut === true, row.out + " is the PoE-out port its manual names");
    ok(!!pse && pse.poeIn === false, row.out + " sources power and is not a PD itself");
  } else {
    ok(copper.every(function (i) { return i.poeOut !== true; }),
      "no socket on this board claims to source power");
  }

  ok(!!spec.sourceUrl && /^https:\/\//.test(spec.sourceUrl), "the row names its source URL");
  ok(/mikrotik\.com/.test(String(spec.notes)), "notes cite the vendor page that names the socket");

  const dev = new Topology().addDevice(spec);
  const hw = [...dev.interfaces.values()].map(function (i) { return i.hardware; })
    .filter(function (h) { return h && COPPER.indexOf(h.cage) !== -1; });
  const asked = hw.reduce(function (a, h) { return a + (typeof h.poeIn === "number" ? h.poeIn : 0); }, 0);
  ok(Math.abs(asked - row.watts) < 1e-9,
    "the engine makes the whole board ask for " + row.watts + " W (" + asked + ")");
  ok(hw.filter(function (h) { return h.poeIn === 12.95; }).length === 0,
    "no port carries the inferred 12.95 W figure any more");
});

console.log("");
console.log("The ten sheets together: " + copperTotal + " copper sockets, " + silentTotal + " of them cold");
ok(copperTotal === 44, "44 copper sockets across the ten boards (" + copperTotal + ")");
ok(Math.abs(silentTotal * 12.95 - 479.15) < 1e-9,
  "the guess had asked " + (silentTotal * 12.95) + " W of the cold sockets (479.15 W)");
ok(wattsTotal === 74, "the seven inlets total 74 W (" + wattsTotal + ")");

console.log("");
console.log("Against a real PSE, only an inlet is a load:");
const pseSpec = catalog.find(function (s) {
  return s.vendor === "aruba" && s.model === "CX 6000 24G CL4 PoE 4SFP 370W";
});
ok(!!pseSpec, "the Aruba 370 W reference PSE is in the catalogue");

if (pseSpec) {
  ROWS.filter(function (r) { return !!r.inlet; }).forEach(function (row, n) {
    const spec = catalog.filter(function (s) { return s.vendor === "mikrotik" && s.model === row.model; })[0];
    if (!spec) { return; }
    const port = n + 1;

    const t1 = new Topology();
    t1.addDevice(pseSpec, "sw1");
    t1.addDevice(spec, "r1");
    t1.connect("r1", row.inlet, "sw1", "1/1/" + port);
    const s1 = new Simulator(t1);
    s1.computePoe();
    ok(s1.poe[0].used === row.watts,
      row.model + ": the PSE spends " + row.watts + " W on the " + row.inlet + " inlet (" + s1.poe[0].used + " W)");

    const other = copperKeys(spec).filter(function (i) { return i.name !== row.inlet; })[0].name;
    const t2 = new Topology();
    t2.addDevice(pseSpec, "sw2");
    t2.addDevice(spec, "r2");
    t2.connect("r2", other, "sw2", "1/1/" + port);
    const s2 = new Simulator(t2);
    s2.computePoe();
    ok(s2.poe[0].used === 0,
      row.model + ": a cable into " + other + " buys 0 W, because it is not a PD (" + s2.poe[0].used + " W)");
  });

  ["RB941-2nD", "RB931-2nD"].forEach(function (model, n) {
    const spec = catalog.filter(function (s) { return s.vendor === "mikrotik" && s.model === model; })[0];
    if (!spec) { return; }
    const t = new Topology();
    t.addDevice(pseSpec, "sw3");
    t.addDevice(spec, "r3");
    t.connect("r3", "eth1", "sw3", "1/1/" + (20 + n));
    const s = new Simulator(t);
    s.computePoe();
    ok(s.poe[0].used === 0, model + ": microUSB-powered, so eth1 buys 0 W (" + s.poe[0].used + " W)");
  });
}

console.log("");
console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
