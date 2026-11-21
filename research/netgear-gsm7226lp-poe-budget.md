# GSM7226LP: how much power its 24 ports share, and which 802.3 standard they speak

**Question (one, narrow).** The NETGEAR M4100-26G-POE (part number GSM7226LP) is a 24-port PoE
switch. How many watts can it supply in total from its internal power supply, and are its 24 powered
ports 802.3af (15.4 W) or 802.3at (PoE+, 30 W)?

**Verdict: 192 W from the internal PSU, over 24 x 802.3af ports.** The catalogue had the port class
right for neither question: every powered port was declared `poeOutClass: "PoE+"`, and the model
carried no `poe` block at all, so `show power inline` answered "budget not modelled" and the
allocator never counted a watt. Both figures are in NETGEAR's own data sheet, in one table row.

## What the vendor publishes

| Source | Says |
| --- | --- |
| [NETGEAR M4100 series data sheet, "Hardware at a Glance"](https://www.downloads.netgear.com/files/GDC/datasheet/en/M4100.pdf) | The row `M4100-26G-POE`: **26** x 10/100/1000 Base-T RJ45, **4 (shared)** SFP, **"24 PoE 802.3af"**, PSU "Internal/No", RPS "1 (RPS or EPS)", PoE budget **"192W"**, with EPS **"Up to 380W (EPS)"**, model number **GSM7226LP**. The same table's `M4100-24G-POE+` row is the 802.3at sibling: **"24 PoE+ 802.3at"**, **380W**, `GSM7224P`. |
| Same data sheet, ordering information | "**M4100-26G-POE** ... **24 ports Gigabit PoE 802.3af**, Layer 2+ software package - GSM7226LP-100NES / -100AJS / -100PRS". The 802.3at model is listed separately, one row below, as "24 ports Gigabit PoE+ 802.3at". |
| Same family, [product brief](https://www.netgear.com/de/images/M4100_ProductBrief_22March1318-73884.pdf) | "IEEE 802.3af Power over Ethernet (PoE) provides **up to 15.4W per port** (M4100-D10-POE; M4100-26-POE; M4100-50-POE; **M4100-26G-POE**)" - the per-port ceiling the standard puts on the 24 ports. |
| [NETGEAR Switching and Security product catalogue](https://www.netgear.com/it/images/pdf/NETGEAR-Switching-Security-Product-Catalog.pdf) | The summary table repeats the split: "M4100-26G-POE (GSM7226LP) 26 x GbE + 4 Combo SFP | **24** | **192W** and up to 380W with EPS", beside "M4100-24G-POE+ (GSM7224P) | 24 (PoE+) | 380W and up to 720W with EPS". |
| [Mirror of the same data sheet (Voipon)](https://www.voipon.co.uk/documents/netgear_M4100-26-POE_datasheet.pdf) | The identical row and the identical ordering line, readable in text extraction where the NETGEAR PDF's tables mostly are not. |
| [A reseller's spec table (DiscTech)](https://www.disctech.com/NetGear-M4100-26G-POE-26-Port-Gigabit-Switch) | **Contradicts the vendor**: "Power over Ethernet (Poe/PoE+): **24 x PoE+ 802.3at**", with "PoE Budget (Watts) 192W / 380W EPS". A second reseller describes the SKU as "PoE+ (192 W)" in its title. |

The contradiction is the shape, not the number: both resellers keep NETGEAR's 192 W and upgrade the
*standard* to PoE+, which is the figure and the class of the **other** 24-port model on the same
sheet. Every NETGEAR document separates the two models, and the PoE+ one carries 380 W, a budget that
would be pointless on 24 ports if the 192 W box could already do 30 W each.

## Why the class matters as much as the budget

* **Arithmetic.** 24 x 15.4 W = 369.6 W of port ceiling against a 192 W supply, so the budget is
  what limits this box - which is exactly why the family's brief calls the EPS a "full power" option.
  Declaring the ports PoE+ put a 720 W ceiling on the same 192 W, and made a 30 W powered device look
  like something this switch's ports could negotiate.
* **The number the panel and the schema read.** `docs/DEVICE_SCHEMA.md` defines `poeOutClass` as
  "the class this port sources, in the vendor's words" and states that nothing in the engine reads
  it. It is a recorded claim about hardware, so it is wrong when it says 802.3at about a port the
  vendor calls 802.3af - even though no packet changes.
* **The budget is read.** `Device.poeBudget` comes from `poe.budgetW`, and `Simulator.computePoe()`
  spends it port by port in port order, refusing the first powered device it cannot fund. Without the
  block there was no budget, so there was no allocation to be refused.

## What the engine did

Measured on `e2ac102e` (main), before this change, on a switch whose ports were all declared
`PoE+` and which carried no `poe` block: `show power inline` had no budget to print, so every port
came back "not measured" and the view said why:

```
sw1# show power inline
Interface Admin  Supplied
ge1       auto   not measured
...
ge24      auto   not measured
budget not modelled on NETGEAR ProSAFE GSM7226LP (M4100-26G-POE)-sw1: the ports are reported, the power they could supply is not
```

`devices/netgear/gsm7226lp.json` declared 24 ports `"poeOut": true, "poeOutClass": "PoE+"`, no `poe`
block, and the capabilities `802.3af` **and** `802.3at`.

## What changed

* `devices/netgear/gsm7226lp.json`: `poe.budgetW = 192` with the vendor data sheet as `sourceUrl`
  and the row quoted in `poe.note`; the 24 powered ports are `"poeOutClass": "PoE"`; the `802.3at`
  capability is gone; the description says 802.3af and keeps describing only the ports this file
  models (24 copper + 2 cages), because `test/spec-vs-description.test.js` holds a description to the
  interface list; `notes` records the table row, the EPS ceiling and the port-census gap below.
* `test/netgear-gsm7226lp-poe.test.js` (26 checks): the spec's budget, source and class; 24 PSE
  ports and 2 that are not; `poeBudget === 192` with source `research`; fourteen 12.95 W access
  points powered at 181.3 W and the fifteenth refused with its reason; the `Available:` line and
  the `power-deny` row `show power inline` prints; and no `802.3at` claim left anywhere on the model.

## What is inferred, not published

* **The 15.4 W per-port ceiling.** The brief states it for the family, not in the 26G-POE row; the
  row states only "24 PoE 802.3af", and 802.3af *is* 15.4 W at the PSE. The model records the class
  rather than a wattage per port, which is the form the schema asks for and the form that keeps a
  PD's own draw, not a ceiling, in the budget arithmetic.
* **That 192 W is the internal-supply figure and the EPS is out of scope.** The sheet gives both;
  this simulator has no external power shelf, so only the internal figure is modelled, and the note
  on the data says so.

## What remains unresolved

* **The port census.** The same row says 26 x 10/100/1000 RJ45 and **4** shared SFP cages; this file
  carries 24 RJ45 + 2 SFP and its old note said the two cages are shared with copper. Which four
  copper ports the cages displace, and whether all 26 RJ45 are populated on the panel, is a census
  question with its own evidence to gather (a front-panel photo, or NETGEAR's installation guide).
  It was left alone here so that one question - power - was settled by the one table row that
  settles it. `notes` records the vendor's 26 + 4 shared census and this file's 24 + 2 side by side;
  the interface list and the description are unchanged.
* **The 380 W EPS figure.** Modelled nowhere; a lab that wants it needs an external-supply object
  this engine does not have.
* **Whether NETGEAR's own CLI reports 192 W or a lower "available" figure.** `show poe` on the box
  subtracts its own reservation; no capture of that output was found, so the console prints the
  data-sheet budget and does not pretend to be the box's `show poe`.
