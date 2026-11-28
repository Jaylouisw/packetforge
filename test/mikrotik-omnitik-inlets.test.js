"use strict";
// Four OmniTIK outdoor APs were asking a PSE for 12.95 W on every copper socket.
//
//   file                  model                  copper  inlet  W   PSE ports
//   rbomnitiku-5hnd       RBOmniTikU-5HnD            5    eth1  11   none
//   rbomnitikupa-5hnd     RBOmniTikUPA-5HnD          5    eth1  11   eth2-eth5 passive
//   rbomnitikg-5hacd      RBOmniTikG-5HacD           5    eth1  14   none
//   rbomnitikpg-5hacd     RBOmniTikPG-5HacD          5    eth1  18   eth2-eth5 af/at
//
// Every sheet is category: ptp, so isPoePd() matched it and derivePortHardware() filled each
// silent socket with 12.95 W: 18 inferred sockets, 233.1 W asked of a switch. Two of the four
// spelled the schema-illegal poeIn: true on the inlet, and the two PoE models declared the
// poe-pse capability without a single port that says it sources power.
//
// Vendor material, all read 2026-11-28:
//   https://mikrotik.com/product/RBOmniTikU-5HnDr2   "Number of DC inputs 1 (PoE-IN)", passive
//        11-30 V, "Max power consumption 11 W", no PoE-out row; "Power input Passive 11-30V PoE
//        in only" in https://cdn.mikrotik.com/web-assets/product_files/omnitik_201106.pdf
//   https://mikrotik.com/product/RBOmniTikUPA-5HnDr2  as above plus "PoE-out ports Ether2-Ether5",
//        "PoE out Passive PoE", 1 A/port, "Max total out (A) 2 A", "Max power consumption 59 W",
//        "Max power consumption without attachments 11 W"
//   https://mikrotik.com/product/rbomnitikg_5hacd   PoE in passive 12-57 V, "Max power
//        consumption 14 W", no PoE-out; brochure prints "Consumption 14 W" for this SKU
//   https://mikrotik.com/product/rbomnitikpg_5hacd  "PoE-out ports Ether2-Ether5", "PoE out
//        802.3af/at", 1 A low voltage / 450 mA high voltage, 2 A total, "Max power consumption
//        without attachments 18 W"
//   https://manual.mikrotik.com/hardware/omnitik-series/  the series manual: passive PoE in,
//        output voltage equals input voltage, 1 A per port and 2 A total
//   quick guides (MikroTik PDFs, mirrored): "OmniTik accepts 8-30V Passive PoE on WAN port
//        (ether1)" - the manual names no port, so this is what fixes the inlet to eth1
const path = require("path");
const { Topology, Simulator } = require("../engine");
const { loadCatalog } = require("../devices/registry");
const { auditPoeBudget } = require("../scripts/audit-poe-budget");

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log("  \u2713 " + msg); }
  else { failed++; console.error("  \u2717 " + msg + (detail ? "  [" + detail + "]" : "")); }
}

const catalog = loadCatalog(path.join(__dirname, "..", "devices")).filter(function (s) { return !s.error; });
const COPPER = ["rj45", "combo"];

const ROWS = [
  { file: "rbomnitiku-5hnd", model: "RBOmniTikU-5HnD", copper: 5, inlet: "eth1", watts: 11, outs: [], cls: null, wasSilent: 4 },
  { file: "rbomnitikupa-5hnd", model: "RBOmniTikUPA-5HnD", copper: 5, inlet: "eth1", watts: 11, outs: ["eth2", "eth3", "eth4", "eth5"], cls: "passive", wasSilent: 5 },
  { file: "rbomnitikg-5hacd", model: "RBOmniTikG-5HacD", copper: 5, inlet: "eth1", watts: 14, outs: [], cls: null, wasSilent: 4 },
  { file: "rbomnitikpg-5hacd", model: "RBOmniTikPG-5HacD", copper: 5, inlet: "eth1", watts: 18, outs: ["eth2", "eth3", "eth4", "eth5"], cls: "PoE+", wasSilent: 5 }
];

function copperKeys(spec) {
  return spec.interfaces.filter(function (i) {
    return i.type === "ethernet" && (i.connector || "rj45") === "rj45";
  });
}

const budget = auditPoeBudget(catalog);
let copperTotal = 0, silentTotal = 0, wattsTotal = 0, guessedTotal = 0;

ROWS.forEach(function (row) {
  console.log("");
  console.log("== " + row.model + ": one inlet at " + row.watts + " W, " +
    (row.copper - 1) + " sockets that say no" + (row.outs.length ? ", " + row.outs.length + " that source" : ""));

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
  ok(drawing.length === 1 && drawing[0].name === row.inlet,
    "exactly one socket draws power, and it is " + row.inlet);
  ok(drawing.length === 1 && drawing[0].poeIn === row.watts,
    "it draws " + row.watts + " W (" + (drawing[0] && drawing[0].poeIn) + ")");
  ok(copper.filter(function (i) { return i.name !== row.inlet; })
    .every(function (i) { return i.poeIn === false; }),
    "every other socket declares poeIn: false - a claim, not a silence");
  wattsTotal += row.watts;
  silentTotal += row.copper - 1;
  guessedTotal += row.wasSilent;

  const pse = copper.filter(function (i) { return i.poeOut === true; });
  if (row.outs.length) {
    ok(pse.length === row.outs.length, row.outs.length + " sockets source power (" + pse.length + ")");
    ok(row.outs.every(function (n) {
      const p = copper.filter(function (i) { return i.name === n; })[0];
      return !!p && p.poeOut === true && p.poeOutClass === row.cls;
    }), row.outs.join(", ") + " are the ports the product page names, classed " + row.cls);
    ok(pse.every(function (i) { return i.poeIn === false; }),
      "a PSE port is not a PD at the same time");
    ok(!!spec.poe && spec.poe.budgetUnknown === true,
      "the wattage is marked unpublishable rather than invented");
    const key = "mikrotik/" + row.model;
    const cohort = budget.unknown.filter(function (r) { return r.model === key; })[0];
    ok(!!cohort, row.model + " is in the audit's unknown cohort, not the silent one");
    ok(!budget.silent.some(function (r) { return r.model === key; }),
      "and it is not counted as silent");
  } else {
    ok(pse.length === 0, "no socket on this board claims to source power");
    ok(!spec.poe || spec.poe.budgetUnknown !== true, "and no PoE budget marker was invented");
  }

  ok(!!spec.sourceUrl && /^https:\/\//.test(spec.sourceUrl), "the row names its source URL");
  ok(/mikrotik\.com/.test(String(spec.notes)), "notes cite the vendor page that names the socket");

  const dev = new Topology().addDevice(spec);
  const hw = Array.from(dev.interfaces.values()).map(function (i) { return i.hardware; })
    .filter(function (h) { return h && COPPER.indexOf(h.cage) !== -1; });
  const asked = hw.reduce(function (a, h) { return a + (typeof h.poeIn === "number" ? h.poeIn : 0); }, 0);
  ok(Math.abs(asked - row.watts) < 1e-9,
    "the engine makes the whole board ask for " + row.watts + " W (" + asked + ")");
  ok(hw.filter(function (h) { return h.poeIn === 12.95; }).length === 0,
    "no port carries the inferred 12.95 W figure any more");
});

console.log("");
console.log("The four sheets together: " + copperTotal + " copper sockets, " + silentTotal + " of them cold");
ok(copperTotal === 20, "20 copper sockets across the four boards (" + copperTotal + ")");
ok(guessedTotal === 18, "18 sockets had been left silent for the guess (" + guessedTotal + ")");
ok(Math.abs(guessedTotal * 12.95 - 233.1) < 1e-9,
  "the guess had asked " + (guessedTotal * 12.95) + " W of them (233.1 W)");
ok(wattsTotal === 54, "the four inlets total 54 W (" + wattsTotal + ")");

console.log("");
console.log("Against a real PSE, only the inlet is a load:");
const pseSpec = catalog.find(function (s) {
  return s.vendor === "aruba" && s.model === "CX 6000 24G CL4 PoE 4SFP 370W";
});
ok(!!pseSpec, "the Aruba 370 W reference PSE is in the catalogue");

if (pseSpec) {
  ROWS.forEach(function (row, n) {
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

    const cold = row.outs.length ? row.outs[0] : "eth2";
    const t2 = new Topology();
    t2.addDevice(pseSpec, "sw2");
    t2.addDevice(spec, "r2");
    t2.connect("r2", cold, "sw2", "1/1/" + port);
    const s2 = new Simulator(t2);
    s2.computePoe();
    ok(s2.poe[0].used === 0,
      row.model + ": a cable into " + cold + " buys 0 W, because it is not a PD (" + s2.poe[0].used + " W)");
  });
}

console.log("");
console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
