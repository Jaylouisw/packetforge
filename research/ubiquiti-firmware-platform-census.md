# Ubiquiti's firmware index enumerates hardware platforms — and the Dream family has no UDW-PRO

Read 2026-11-19, 00:5x–01:0x UTC, against `https://fw-update.ubnt.com/api/firmware`. This pass answers
one question the UDW-PRO thread (#130) had only ever asked of marketing surfaces and the FCC database:
**does Ubiquiti ship firmware for any platform code that would be a Dream Wall Pro?** Eleven previous
passes read product pages, datasheets, the store tree and the grantee list. None read the index the
update daemon on the device itself polls.

## 1. Why this index is the right instrument

`fw-update.ui.com` (the API's own `_links.self` points there; `fw-update.ubnt.com` answers it) is the
machine-readable release index for Ubiquiti firmware. It is keyed by **platform code**, and that code is
not cosmetic — it names the binary: the `UDW` release `v6.0.17+7bcad58` (2026-11-10) carries
`_links.data` = `https://fw-download.ubnt.com/data/unifi-dream/2d04-UDW-6.0.17-090536d9-…bin`.

Two properties make absence here mean something:

1. **Pro variants get their own code rather than reusing the parent's.** Inside this one product line,
   `UDMPRO`, `UDMPROSE` and `UDMPROMAX` are three separate platform codes for three near-identical
   consoles, and `UXMAX` is separate from `UX`. So the hypothesis "a Pro could hide under the parent's
   code because the silicon is the same" is contradicted by the family's own naming, four times over.
2. **The index is maintained.** The newest `UDW` release is 2026-11-10 and the newest `UXMAX` release
   2026-11-13, six days before this pass; `UDW` itself starts 2022-05-07, matching the May 2022
   `SWX-UDW` grant. Neither end of the range truncates.

## 2. The census

Query shape: `?limit=1000&filter=eq~~platform~~<code>`. The filter is `eq` and case-insensitive
(`udw` matches `UDW`). **The default page size is 25**, so a query without `limit=1000` silently
undercounts: `UDW` reads 25 instead of 27. Every number below was taken at `limit=1000`.

`?limit=1000&filter=eq~~product~~unifi-dream` — **340 releases across 17 platform codes**:

| platform | releases | platform | releases |
|---|---|---|---|
| `EFGCORE` | 8 | `UDMPRO` | 27 |
| `UCGA6AD` | 10 | `UDMPROMAX` | 20 |
| `UCGF` | 17 | `UDMPROSE` | 40 |
| `UCGMAX` | 19 | `UDR` | 36 |
| `UDM` | 27 | `UDR5G` | 9 |
| `UDMEA4C` | 10 | `UDR7` | 17 |
| `UDMENT` | 21 | `UDRULT` | 22 |
| `UDW` | 27 | `UX` | 15 |
| | | `UXMAX` | 15 |

No `UDWPRO`. The spellings probed, each 0 releases: `UDWPRO`, `UDW-PRO`, `UDWPROMAX`, `UDW2`,
`UDWSE`, `UDWMAX` — against 65 for `UDMPRO`, 40 for `UDMPROSE`, 20 for `UDMPROMAX` and 30 for `UX`
(the Pro/lowercase platform filter also picks up the legacy `udm`-product releases, which is why
`UDMPRO` reads 65 there and 27 inside `unifi-dream`).

**Empty-answer control.** `ZZZZ` returns the same 0-release envelope, 96 bytes, HTTP 200 — so a zero
is a valid empty result from a working query, not an error that would also have reported zero for
`UDW`. The positive control for the same endpoint and the same field is `UDW` at 27.

## 3. What this settles, and what it does not

**Settles:** Ubiquiti publishes no firmware for any Dream Wall Pro platform. Combined with the
`SWX`-grant enumeration (`research/ubiquiti-swx-grantee-census.md`, no Pro grant) and the store and
tech-spec trees (no product page), the SKU has left no trace on any vendor surface that a shipped
product must touch — firmware, authorization or catalogue.

**Does not settle:** that a Pro *could not* exist. A rebadged variant with different ports and the same
mainboard could in principle ship under the parent's platform code, and no firmware index publishes RJ45
or SFP+ counts in any case. This pass closes the question "is there a Pro platform?", not "how many
ports would it have?".

**What would still unblock #130:** unchanged and vendor-only — a Ubiquiti page, datasheet, quick-start
guide or FCC exhibit naming UDW-PRO's port count and PoE budget, or the requester confirming they meant
the **UDW**, already catalogued at `devices/ubiquiti/udw.json` with the 420 W budget published on
<https://techspecs.ui.com/unifi/cloud-gateways/udw>. The request stays open; no spec was added.

## 4. Re-running this

`scripts/ubiquiti-firmware-index.js` is the instrument:

```
node scripts/ubiquiti-firmware-index.js --platform udw
node scripts/ubiquiti-firmware-index.js --family UDWPRO,UDW-PRO,UDW2
node scripts/ubiquiti-firmware-index.js --product unifi-dream
```

The moment a `UDWPRO`-class code appears with a release, this thread has a firmware artifact to date the
product from — and the port census still has to come from a Ubiquiti document.
