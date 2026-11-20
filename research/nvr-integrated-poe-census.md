# Four NVRs with an integrated PoE switch: three silent, one sourced from a reseller

Measured 2026-11-20 18:2x-19:5x UTC, one increment on the catalogue stream. Neither open device
request is answered here (`#130` UDW-PRO and `#803` E6616X are both still blocked upstream).

This pass opened as a seven-row sweep of Dahua/Hikvision recorders whose PoE total was written in
prose and never in the field the engine reads. PR #2295 landed three of those rows (`#2295`, merged
18:38) before this branch could; the branch was reconciled onto that commit and now carries only
what is still missing. The three rows #2295 took - `nvr5216-16p-ei2`, `ds-7608ni-k2-8p`,
`ds-7616ni-k2-16p` - keep that PR's wording and are not contested here.

## The defect, in one line

Four recorder rows in `devices/dahua/` and `devices/hikvision/` declare eight or sixteen camera
ports named `PoE n`. **Three of them carried no `poe` block at all**, and the fourth carried a
`budgetW` that pointed at a reseller's reprint rather than the vendor. Their
`description` and `notes` quote a wattage ("80 W total budget", "200 W aggregate") that
`engine/device.js` never reads: `poeBudget` fell through every branch to `parsePoeBudget(model)`,
which finds no number in `DS-7616NXI-K2/16P`. The boxes therefore *source* power from a 0 W supply,
and `show power inline` says so.

Measured with `scripts/audit-poe-budget.js`, main at `83e2e7c4`: **49 of 411 PSEs silent**. On this
branch: **46 silent** - the Dahua/Hikvision recorder delta, three rows.

## The four, each against the vendor's own document

| spec | vendor figure, verbatim | source |
|--|--|--|
| `devices/dahua/nvr2108hs-8p-4ks3.json` | PoE Port `8 ports, 10/100 Mbps, IEEE 802.3 af/at`; `Total output power of PoE is 72 W, the maximum output power of a single port is 25.5 W` | <https://www.dahuasecurity.com/products/network-products/network-recorders/lite-series/nvr2-4ks3-series/nvr2108hs-8p-4ks3> (200, 514,739 B, server-rendered spec table, re-read this pass) |
| `devices/dahua/nvr4208-8p-4ks3.json` | same port line; `Total output power of PoE is 130 W, the maximum output power of a single port is 25.5 W` | <https://www.dahuasecurity.com/products/network-products/network-recorders/Lite-Series/NVR4-4KS3-Series/2HDD/NVR4208-8P-4KS3> (200, 524,439 B, re-read this pass) |
| `devices/dahua/nvr5216-16p-4ks2e.json` | `PoE 16 ports (IEEE802.3af/at), 1-8 ports support ePoE & EoC`; `PoE: Max 25.5W for single port`, `130W total rated power, 80% control for protection` | <https://www.dahuasecurity.com/asset/upload/product/20180201/DHI-NVR5216_5232-16P-4KS2E_Datasheet_20180201.pdf> (200, `application/pdf`, 452,417 B, 3 pp, text layer read with pypdf) |
| `devices/hikvision/ds-7616nxi-k2-16p.json` | PoE `Interface 16, RJ-45 10/100 Mbps self-adaptive Ethernet interface`; `Power <= 200 W`; `Standard IEEE 802.3af/at` | <https://www.hikvision.com/content/dam/hikvision/products/S000000001/S000000132/S000000007/S000000026/OFR031212/M000141849/Data_Sheet/Datasheet-of-DS-7616NXI-K2_16PD_20240523.pdf> (200, `application/pdf`, 987,036 B, 5 pp) |

The NVR5216-16P-4KS2E row is both a missing citation and a citation repair: it carried `budgetW: 130`
correctly but cited a **reseller's re-hosted copy** of the Dahua datasheet
(`rxtx.com.au/wp-content/uploads/2023/03/...`), as did its top-level `sourceUrl`. A field resting on
a reprint is what `docs/MAINTAINING.md` refuses, so both now point at the Dahua asset the sibling
NVR5232 row already used, and the figure was re-read there rather than inherited.

## A note on reaching the Hikvision PDF

The Hikvision asset host answers a JS cookie challenge (`__tst_status`) to plain clients; a bare
`curl` gets 987 bytes of `<script>` and no PDF, and the same challenge guards the product page. The
document is reachable: evaluating that one inline script with a stubbed `document`/`location` yields
`__tst_status` and `EO_Bot_Ssid`, and the PDF then returns 200 at the byte count recorded above. The
count is the check - a challenge page and the datasheet cannot match to the byte.

## The arithmetic the budget has to defend

Every one of these boxes advertises 802.3af/at per port, and the vendor's own per-port ceiling is
25.5 W (Dahua, stated) or the standard's 30 W (Hikvision, not stated - so the rows claim no vendor
per-port figure for Hikvision). Against that:

- 8 x 25.5 W = **204 W** of port ceiling on a **72 W** supply (NVR2108HS-8P-4KS3) - five 15 W
  cameras exhaust it;
- 8 x 25.5 W = 204 W against **130 W** (NVR4208-8P-4KS3);
- 16 x 25.5 W = **408 W** against **130 W** (the 4KS2E, where 130 W is the *rated* figure that an 80%
  limiter is applied to);
- 16 x 30 W = 480 W against **200 W** (DS-7616NXI-K2/16P).

Each spec's `poe.note` records the pair, so a lab that fills every camera port at the datasheet's
per-port maximum is told which number runs out first.

## What changed beyond the number

- `devices/dahua/nvr4208-8p-4ks3.json` and `devices/hikvision/ds-7616nxi-k2-16p.json` had **no
  `poeOut` on any of their 8 / 16 camera ports** at the spec level. The engine's name rule
  (`isPoePse()` sees `PoE 1`) inferred them at load time, which is why the audit still counted 8 and
  16 PSE - but a declared port is the authority, and an inferred one disappears the moment a port is
  renamed. Both now declare it: Dahua `poeOut: 25.5` matching its three siblings, Hikvision
  `poeOut: true` + `poeOutClass: "PoE+"` matching the `DS-3E` switch rows.
- `poe-pse`, `802.3af` and `802.3at` were absent from all four `capabilities` lists. Added. The
  `nvr` category is not a switch, so `isPoePse()` still refuses to treat the LAN uplink as a source -
  the capability cannot leak onto the uplink.

## What this pass did NOT find

No Dahua or Hikvision recorder in the catalogue publishes a PoE budget the vendor does not state;
the models that had one (NVR5216/5232-16P-4KS2E, and the four `DS-3E` switches) were already right,
and the four `DS-3E` rows keep their own datasheet citations. There is no "the vendor is silent" case
in this family to mark `budgetUnknown`.
