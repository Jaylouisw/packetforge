"use strict";
// Four RB751/RB951 home APs were asking a PSE for 12.95 W on every copper socket.
//
//   file              model          copper  inlet  W  PSE ports
//   rb751u-2hnd       RB751U-2HnD        5    eth1   7  none
//   rb951-2n          RB951-2n           5    eth1   3  none
//   rb951ui-2nd       RB951Ui-2nD        5    eth1   5  eth5 passive
//   rb951ui-2hnd      RB951Ui-2HnD       5    eth1   7  eth5 passive
//
// All four are category: wireless, so isPoePd() matched them and derivePortHardware() filled every
// silent socket: 14 sockets, 181.3 W asked of a switch. All four also spelled the schema-illegal
// poeIn: true on the inlet.
//
// Vendor material, all read 2026-11-28:
//   https://mikrotik.com/product/RB751U-2HnD   "Number of DC inputs 1", "PoE in Passive PoE",
//        no max-power-consumption row, no PoE-out row
//   https://cdn.mikrotik.com/web-assets/product_files/rb751U-2HnD-ug_130539.pdf   "Power over
//        Ethernet Ether 1 requires 8-30V DC (non 802.3af)", "Power consumption Up to 7W"
//   https://mikrotik.com/product/RB951-2n   PoE in Passive PoE, no PoE-out row
//   https://cdn.mikrotik.com/web-assets/product_files/rb951-2n_130506.pdf   "PoE: 8-30V DC on
//        Ether1 (Non 802.3af)", "Power consumption Up to 3W"
//   https://manual.mikrotik.com/hardware/hap/   "first Ethernet port (Passive PoE)" 10-28 V,
//        "can reach 5 W", "The Ether5 port supports PoE output ... up to 0.58 A"
//   https://mikrotik.com/product/RB951Ui-2nD   Max power consumption 5 W, PoE-out ports Ether5,
//        Passive PoE, Low voltage current limit 500 mA, Max total out 500 mA
//   https://mikrotik.com/product/RB951Ui-2HnD  Max power consumption 24 W, without attachments
//        7 W, PoE in Passive 8-30 V, PoE-out ports Ether5, 500 mA
//   https://manual.mikrotik.com/hardware/rb951-series/   "first Ethernet port (Passive PoE)",
//        "RB951Ui-2HnD 24 W", Ether5 output 2 V below input, up to 0.58 A
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
  { file: "rb751u-2hnd", model: "RB751U-2HnD", copper: 5, inlet: "eth1", watts: 7, outs: [], wasSilent: 4 },
  { file: "rb951-2n", model: "RB951-2n", copper: 5, inlet: "eth1", watts: 3, outs: [], wasSilent: 4 },
  { file: "rb951ui-2nd", model: "RB951Ui-2nD", copper: 5, inlet: "eth1", watts: 5, outs: ["eth5"], wasSilent: 3 },
  { file: "rb951ui-2hnd", model: "RB951Ui-2HnD", copper: 5, inlet: "eth1", watts: 7, outs: ["eth5"], wasSilent: 3 }
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
      return !!p && p.poeOut === true && p.poeOutClass === "passive";
    }), row.outs.join(", ") + " are the ports the product page names, classed passive");
    ok(pse.every(function (i) { return i.poeIn === false; }),
      "the sourcing port is not also a PD");
    ok(!!spec.poe && spec.poe.budgetUnknown === true,
      "the passthrough wattage is marked unpublishable rather than invented");
    const key = "mikrotik/" + row.model;
    ok(budget.unknown.some(function (r) { return r.model === key; }),
      row.model + " is in the audit's unknown cohort");
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
ok(guessedTotal === 14, "14 sockets had been left silent for the guess (" + guessedTotal + ")");
ok(Math.abs(guessedTotal * 12.95 - 181.3) < 1e-9,
  "the guess had asked " + (guessedTotal * 12.95) + " W of them (181.3 W)");
ok(wattsTotal === 22, "the four inlets total 22 W (" + wattsTotal + ")");

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
