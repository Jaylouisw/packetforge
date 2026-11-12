# Requesting hardware

The catalogue is the project. If a device is missing, that is a bug and we want it filed.

## How to ask

Open a **[device request](https://git.jayw.uk/jaylouisw/packetforge/issues/new?template=device_request.yml)**
with:

- **vendor and exact model number** - the string printed on the box, e.g. `CRS326-24G-2S+RM`
- **a link to the vendor's own documentation** - the datasheet or hardware guide, not a shop page
- **which ports you actually care about**, if not all of them

That is enough. You do not need to write JSON.

## What happens next

1. The request is checked against the vendor's documentation: port counts, connector per
   port, speed ladder, PoE budget, and anything the box claims that a simulator must respect.
2. A spec is written as `devices/<vendor>/<model>.json`, and three things check it before it
   can merge. `scripts/audit-port-types.js` runs first inside `npm test` and walks every port
   with **eleven rules** (`unknown-cage`, `copper-connector-fibre-cage` and
   `fibre-connector-copper-cage`, `ethernet-not-data`, `pon-not-optical-connector`,
   `console-not-console`, `coax-not-coax`, `dsl-not-dsl`, `powerline-not-powerline`,
   `wireless-not-antenna`, `template-undeclared-hardware`) and refuses to let a red finding
   reach the test runner at all. Then `test/hardware-invariants.test.js` runs over the whole
   catalogue, not a fixture, with **25 assertions** named for the mistake that caused each one
   (`no port is declared twice in a spec`, `every combo pair names its partner symmetrically`,
   `every ethernet port has at least one usable medium`, `no port claims a line rate its cage
   cannot carry`, `no optical cage accepts a copper medium`, `no device has zero interfaces`).
   `test/spec-vs-description.test.js` reads the prose against the ports and fails on a device
   that promises ports or PoE it does not have.
3. The spec records the datasheet URL it was built from, so a later reader can check the claim
   rather than trust it. It is **recommended, not enforced**: 1,313 of the 1,661 specs carry a
   `sourceUrl` and 20 more carry the older `source` spelling, so 1,333 point at a datasheet
   somewhere; the remaining 328 are tracked as missing rather than refused. Those three numbers
   move as the catalogue grows, so re-count rather than quote -- `grep -rl` counts files, not keys, and
   overcounts by 24 on this tree, because a few specs mention the key in a note:

   ```bash
   node -e "const l=require('./devices/registry').loadCatalog(require('path').resolve('devices')).filter(d=>!d.error);const u=l.filter(d=>d.sourceUrl).length,o=l.filter(d=>!d.sourceUrl&&d.source).length;console.log(l.length,'specs,',u,'sourceUrl,',o,'source,',l.length-u-o,'neither')"
   # 1661 specs, 1313 sourceUrl, 20 source, 328 neither
   ```

## What "accurate" means here

A device is modelled port by port, not by marketing category:

- the **connector** each port really has (RJ45, SFP, SFP+, SFP28, QSFP28, SC/APC, coax, ...)
- the **speeds** it really negotiates, including the ones the datasheet omits
- **shared and combo ports** - an RJ45/SFP pair is one port position, not two ports
- **PoE**: which ports are PSE, the per-port limit and the total budget

Where a datasheet genuinely does not say something, the spec records that it is unknown
rather than filling the gap with a plausible number. A simulator that guesses teaches the
guess.

## If it is not in the catalogue at all

Some things are out of scope on purpose: anything that cannot be described by ports and
links. Everything else - printers, cameras, TVs, phones, smart meters, EV chargers - is fair
game, and increasingly already there.
