"use strict";
// The CRS328-24P-4S+RM shipped with poe.budgetUnknown true and a per-port poeOut of true.
//
// The note that marked it unknown said MikroTik publishes current limits only, no watt figure - but
// that reading stopped at the specification table. The same page description prints the allocation and
// the per-port ceiling outright, read 2026-11-27 from
// https://mikrotik.com/product/crs328_24p_4s_rm (HTTP 200):
//
//   "... 100-240 V AC 500 W power supply built-in. The device consumes up to 44 W leaving guaranteed
//    450 W (3x150 W per every 8 Ethernet ports) to power your PoE devices. Each port can provide up to
//    30 W of power with any power output option you choose."
//
// and the table corroborates the arithmetic: Max power consumption 494 W, without attachments 44 W.
// So 450 W is the vendor reserve for PDs - not the 500 W PSU rating, and not the number in the model
// name, which is why the budget comes back with source research and not name. Output options are
// "Passive PoE, low voltage PoE, 802.3af/at (Type 1 ... Type 2 ...) with auto-sensing", so the
// passive-poe token belongs in capabilities too.
const path = require("path");
const { Topology, Simulator } = require("../engine");
const { CliSession } = require("../engine/cli");
const { loadCatalog } = require("../devices/registry");

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log("  \u2713 " + msg); }
  else { failed++; console.error("  \u2717 " + msg + (detail ? "  [" + detail + "]" : "")); }
}

const catalog = loadCatalog(path.join(__dirname, "..", "devices")).filter(function (s) { return !s.error; });
function spec(m) {
  const s = catalog.filter(function (x) { return x.vendor === "mikrotik" && x.model === m; })[0];
  if (!s) throw new Error("missing spec mikrotik/" + m);
  return s;
}

const SW = spec("CRS328-24P-4S+RM");
const AP = catalog.filter(function (s) { return s.vendor === "aruba" && s.model === "AP-515"; })[0];

console.log("\nThe printed PoE allocation is the budget:");
ok(SW.poe && SW.poe.budgetW === 450, "budgetW is the 450 W MikroTik guarantees for PDs (" + (SW.poe && SW.poe.budgetW) + ")");
ok(SW.poe && SW.poe.budgetUnknown !== true, "and it is no longer marked unknown");
ok(SW.poe && SW.poe.sourceUrl === "https://mikrotik.com/product/crs328_24p_4s_rm",
  "cited to the product page (" + (SW.poe && SW.poe.sourceUrl) + ")");
ok(String(SW.poe && SW.poe.note).indexOf("leaving guaranteed 450 W") !== -1,
  "the note carries the vendor sentence the number came from");
ok(String(SW.description).indexOf("450 W") !== -1, "the description states the allocation too");

console.log("\nEach of the 24 copper ports is a 30 W PoE+ PSE:");
const tmpl = SW.portTemplate || {};
ok(tmpl.count === 24 && tmpl.prefix === "eth", "the template builds eth1..eth24 (" + tmpl.count + ")");
ok(tmpl.poeOut === 30, "at the vendor ceiling of 30 W, as a number (" + tmpl.poeOut + ")");
ok(tmpl.poeOutClass === "PoE+", "classed PoE+, the 802.3at Type 2 the page prints (" + tmpl.poeOutClass + ")");
ok(tmpl.connector === "rj45", "on RJ45 sockets (" + tmpl.connector + ")");
ok(Array.isArray(tmpl.speedCaps) && tmpl.speedCaps.indexOf(1000) !== -1,
  "at 10/100/1000 (" + JSON.stringify(tmpl.speedCaps) + ")");

const sfp = (SW.interfaces || []).filter(function (i) { return /^SFP\+/.test(i.name); });
ok(sfp.length === 4, "four SFP+ cages (" + sfp.length + ")");
ok(sfp.every(function (i) { return i.poeOut === undefined; }), "the cages source no power");

["poe-pse", "802.3af", "802.3at", "passive-poe"].forEach(function (c) {
  ok((SW.capabilities || []).indexOf(c) !== -1, "capability " + c + " is declared");
});

console.log("\nThe engine builds the same census:");
const t = new Topology();
const sw = t.addDevice(SW, "sw1");
const dev = t.devices.get(sw.id);
ok(dev.poeBudget === 450, "the device carries the 450 W budget (" + dev.poeBudget + ")");
ok(dev.poeBudgetSource === "research", "from the spec, not the 500 W in the model name (" + dev.poeBudgetSource + ")");
const pse = [...dev.interfaces.values()].filter(function (p) { return p.hardware && p.hardware.poeOut; });
ok(pse.length === 24, "24 PSE ports (" + pse.length + ")");
ok(pse.every(function (p) { return p.hardware.poeOut === 30; }),
  "none falls back to the 802.3af default: " + [...new Set(pse.map(function (p) { return p.hardware.poeOut; }))].join(","));
ok(!dev.interfaces.get("SFP+1").hardware.poeOut, "and SFP+1 supplies nothing");

console.log("\n450 W - not 500 W - is what the ports can spend:");
{
  let accepted = 0, refusal = null;
  for (let i = 1; i <= 24; i++) {
    const ap = t.addDevice(AP, "ap" + i);
    try { t.connect(ap.id, "E0", sw.id, "eth" + i); accepted++; }
    catch (e) { refusal = e; break; }
  }
  ok(accepted === 15, "fifteen 30 W-class links fit in 450 W (" + accepted + ")");
  ok(!!refusal && refusal.code === "E_POE_BUDGET", "the sixteenth is refused at cabling time (" + (refusal && refusal.code) + ")");
  ok(!!refusal && refusal.message.indexOf("450 W budget") !== -1,
    "naming the vendor budget: " + (refusal && refusal.message));
  ok(!!refusal && refusal.message.indexOf("500 W") === -1, "and never the PSU rating");

  const sim = new Simulator(t);
  sim.computePoe();
  const entry = sim.poe.filter(function (p) { return p.dev === sw.id; })[0];
  ok(entry.ports.filter(function (p) { return p.powered; }).length === 15, "fifteen ports are powered");
  const lines = new CliSession(dev, t, sim).run("show power inline").output.map(String);
  ok(lines[0] === "Available:450.0(w) Used:382.5(w) Remaining:67.5(w)",
    "show power inline reports the allocation: " + lines[0]);
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed) process.exitCode = 1;
