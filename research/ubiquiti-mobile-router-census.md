# The cellular gateways #130 asks for had no citation, and one had no PoE budget

Open device request #130 asks for a router/gateway node that routes, NATs, serves DHCP and takes a
**cellular WAN**. The Dream Wall Pro it names does not exist in Ubiquiti's catalogue (see
`research/ubiquiti-udw-pro-absent-from-vendor-catalogue.md`), so the honest answer to that lab is one
of the mobile routers. Reading those rows on 2026-11-19 turned up two defects that have nothing to do
with the Pro: `devices/ubiquiti/umr.json` and `devices/ubiquiti/umr-ultra.json` carried **no
`sourceUrl` at all** - their `notes` quoted vendor figures with no URL behind them - and the UMR's
PoE passthrough port had **no budget**, which the simulator treats as "sources nothing".

## Why a missing budget is not cosmetic

`engine/simulator.js` opens the PoE allocator with `if (!dev.poeBudget) continue;`. A PSE with no
budget is skipped, not reported as unknown: the passthrough port can power nothing, and `show power
inline` cannot say why. The UMR's model string is `umr`, which `parsePoeBudget()` reads as zero.

## What the vendor publishes

| surface | bytes | what it carries |
|---|---|---|
| `techspecs.ui.com/unifi/integrations/umr-us` | 708,698 | "(2) GbE RJ45 ports, LTE Cat 4 radio, WiFi 4"; "(1) PoE input / (1) PoE output (Max. 10W, requires PoE+ switch)"; 9 W; PoE+ 48-54 V |
| `dl.ui.com/ds/umr_ds.pdf` | 597,924 (pdf, 2 pp) | "(2) GbE RJ45 ports"; "(1) PoE in"; "(1) PoE output*"; "*Requires a PoE+ switch" - **no** output wattage |
| `store.ui.com/us/en/products/umr-us` | 585,616 (after 307) | key feature: "PoE+ input required for PoE passthrough." |
| `techspecs.ui.com/unifi/integrations/umr-ultra-us` | 682,619 | "(2) FE RJ45 ports"; 5.7 W; USB-C 5 V/2 A or 4-pin ATX 9-30 V DC; -30 to 70 C; Features table has **no** PoE row |
| `store.ui.com/us/en/products/umr-ultra-us` | 587,964 (after 307) | second vendor surface for the same SKU |

The two documents for the UMR disagree with each other on the chassis only - datasheet 220.6 x 89.8 x
28.8 mm, 252/298 g against tech-spec 190 x 89.8 x 28.8 mm, 257/303 g. Ports, the 150 Mbps WiFi 4 rate
and the 9 W draw are identical on both, so the row models those and nothing from the disagreement.

## Traps recorded rather than re-walked

- **The `-us` SKU suffix is part of the slug on both hosts.** `techspecs.ui.com/unifi/integrations/umr`
  answers the 609,911-byte front page (the silent fallback, not a product), and `store.ui.com/us/en/
  products/umr` is a 404. The Ultra is worse: the bare `/products/umr-ultra` **307s to the
  internet-solutions category**, which is a 200 once followed - a redirect to a category is a miss,
  not a product page.
- **The Ultra has no datasheet.** `dl.ui.com/ds/umr-ultra_ds.pdf` and `.../umr-ultra-us_ds.pdf` both
  return the 609,911-byte techspecs front page, the same fallback trapped for `ucg-fiber` and
  `uxg-pro` (whose real key is hyphenated: `uxg-pro_ds.pdf`).
- **Neither surface numbers the PoE ports.** Both publish "1 input, 1 output" and neither says which
  RJ45 is which, so the row assigns `rj45-1` as the PD (9 W) and `rj45-2` as the PSE (PoE+) - the
  documented count, with the same convention as `devices/zyxel/gs1900-24ep.json`. That is a stated
  count, not a guessed census.

## What changed

`umr.json`: cites all three surfaces; `poe.budgetW` **10** (vendor's "Max. 10W"); `poeIn` **9** W
instead of `true` (the schema wants watts, and 9 W is the vendor's max consumption); capabilities gain
`poe-pd`, `poe-pse`, `802.3at`. `umr-ultra.json`: cites both surfaces. `aliases` now carry the vendor
SKUs (`UMR-US`, `UMR-Ultra-US`).

`show power inline` on the UMR, cabled to a 12.95 W 802.3af camera:

```
Available:10.0(w) Used:0.0(w) Remaining:10.0(w)
Interface  Admin  Oper  Draw     Powered device
rj45-2     auto   off   12.95 W  CAM1  (denied)
  rj45-2: PSE budget exhausted: 12.95 W requested, 10 W left
```

Before the change the box was skipped by the allocator and the port was simply dead. The 10 W ceiling
is the vendor's, so refusing a 12.95 W class-0 device is the correct answer rather than a regression;
what was missing was the number, not the policy.

## 2026-11-19 09:5x UT: the third member of the family, and the same defect

`devices/ubiquiti/umr-industrial.json` is the last mobile router in `devices/ubiquiti/` and carried the
same two defects the UMR did, one field further along: its `eth1` PSE had **no `poe.budgetW`** (so
`engine/simulator.js`'s `if (!dev.poeBudget) continue;` skipped it and `show power inline` said nothing
about why), and its `eth0` sink carried **`poeIn: 12.95`** - the 802.3af class-0 ceiling, not a figure
Ubiquiti prints. The vendor's own max consumption is **12.5 W**.

| surface | result |
|---|---|
| `techspecs.ui.com/unifi/integrations/umr-industrial-us` | **200**, 693,659 B - "(2) GbE RJ45 ports, LTE Cat 4 radio, WiFi 4"; "(1) PoE input / (1) PoE output (Max. 10W, requires PoE+ switch)"; "Max. Power Consumption 12.5W"; "Power Method PoE+ (48-54V DC), USB Type-C (5V DC), 4-pin ATX DC (9-30V DC)"; MIMO 2 x 2, 802.11n to 300 Mbps |
| `techspecs.ui.com/unifi/integrations/umr-industrial` | **200**, same 693,659 B - unlike the UMR, the `-us` suffix is **not** required here |
| `dl.ui.com/ds/umr-industrial_ds.pdf`, `.../umr-industrial-us_ds.pdf`, `.../umr_industrial_ds.pdf` | all **200** with the **609,911-byte techspecs front page** - no datasheet, so 10 W is tech-spec-only |
| `store.ui.com/us/en/products/umr-industrial-us` | 200 after a redirect into `.../collections/unifi-mobile-routing/products/umr-industrial-us`, 589,389 B |

Two traps worth keeping. **The page never prints an IEEE number** - zero occurrences of `802.3` in the
693,659 bytes; it says "PoE+" and "PoE+ (48-54V DC)", and `802.3at` is that standard's name, recorded as
such rather than as a vendor string. **Neither surface numbers the PoE ports** either, so `eth0` sinks
and `eth1` sources, the same convention as `umr.json` and `devices/zyxel/gs1900-24ep.json`: a stated
count, not a guessed census.

## 2026-11-19 13:5x UT: two mobile routers had no cellular port at all

The family is the one #130's lab reaches for *"a router/gateway node in a routed lab (NAT, DHCP,
VPN, cellular WAN)"*, and the previous passes on this file settled its PoE and its citations. What
none of them noticed is that the interface the product is named for was missing: `umr.json` and
`umr-ultra.json` modelled `rj45-1`, `rj45-2` and `radio-2g` - two copper ports and the **WiFi 4**
radio - and **no `wwan` port**, while the third member of the family (`umr-industrial.json`) has
carried a `wwan0` all along. A mobile router with no cellular interface cannot be the cellular WAN
of anything.

Read today, crawler user-agent, all three product pages, plus the one datasheet in the family:

| surface | result | the row that matters |
|---|---|---|
| `techspecs.ui.com/unifi/integrations/umr-us` | 200, 708,698 B | "Networking Interface (2) GbE RJ45 ports, **LTE Cat 4 radio**, WiFi 4"; "**LTE Throughput Speed Download 150 Mbps / Upload 50 Mbps**" |
| `dl.ui.com/ds/umr_ds.pdf` | 200, PDF, 597,924 B, 2 pp | page 2: "LTE throughput speed* **Download 150 Mbps / Upload 50 Mbps**", "LTE Category 4 radio", "Supported WiFi Data Rates 6.5 Mbps to 150 Mbps" |
| `techspecs.ui.com/unifi/integrations/umr-ultra-us` | 200, 682,619 B | "(2) FE RJ45 ports, **LTE Cat 4 radio**, WiFi 4"; "LTE Throughput Speed **Download 150 Mbps / Upload 50 Mbps**" |
| `techspecs.ui.com/unifi/integrations/umr-industrial-us` | 200, 693,659 B | same "LTE Cat 4 radio"; "LTE Throughput Speed **Download 150 Mbps / Upload 50 Mbps**"; WiFi 4 to 300 Mbps |
| `dl.ui.com/ds/umr-ultra_ds.pdf`, `.../umr-industrial_ds.pdf` | 609,911 B techspecs front page | no datasheet for either, unchanged from the earlier pass |

So the radios were never the question - the vendor names the LTE radio in the first row of the
Networking Interface table and prints its rate on every one of the three. The catalogue simply
stopped at the RJ45s and the WiFi radio.

**What was written.** `wwan0` at **150M** on `umr.json` and `umr-ultra.json` (the published
*download* figure, the convention `udr-5g-max` and `u5g-max` already use; the 50 Mbps uplink stays
in `notes` because the schema carries one rate per port), and `umr-industrial.json`'s `wwan0`
**50M -> 150M** - it was carrying the uplink half of the same table row, which made it the only
row in the family reading the wrong column.

**Why it is not cosmetic.** A `wwan` port cannot be cabled - `test/cellular-cage.test.js` pins that
("two modems in a lab are not cabled to each other: they are both subscribed to a network neither
of them contains") - so a cellular WAN in this engine is an interface you *configure*, not one you
patch. Before the change the UMR offered nothing to configure:

```
> show ip interface brief
Interface              IP-Address      OK? Method Status                Protocol
rj45-1                 unassigned      YES unset  down                  down
rj45-2                 unassigned      YES unset  down                  down
radio-2g               unassigned      YES unset  up                    up
```

After it, the lab's cellular WAN exists and takes the default route:

```
> interface wwan0 / ip address 10.99.0.10 255.255.255.0
IP address set on wwan0: 10.99.0.10/24
> ip route 0.0.0.0 0.0.0.0 10.99.0.1
Route added: 0.0.0.0/0 via 10.99.0.1
> show ip route
S*  0.0.0.0/0  [1/0] via 10.99.0.1
```

Cage resolution checked, not assumed: `wwan0` resolves to `cage=wwan`, `media=['lte']`, 150 Mbps
(`radio-2g` stays `antenna`), so the row still offers no Wi-Fi band from the cellular port and no
copper medium from either.

## Queued for a later pass (measured, not written)

`devices/ubiquiti/u-lte-backup-pro.json` still carries `wwan0` at **100M**, and its own datasheet
prints the rate: `https://dl.ui.com/ds/u-lte-backup-pro_ds.pdf` (200, PDF, 2 pp, read today) -
"LTE Category 4 radio", "Throughput speeds* **Download 150 Mbps / Upload 50 Mbps**". The comment on
#130 for PR #2150 says that citation "corrected `wwan0` from the 100M class guess to 150M", but
`git log -- devices/ubiquiti/u-lte-backup-pro.json` holds only the original #1143 commit and the
file on `main` is still `100M` - the claim outran the commit. It is a different product line from
the mobile routers, so it was left for its own pass rather than folded into this family's change.
