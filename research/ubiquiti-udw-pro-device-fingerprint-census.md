# Ubiquiti's device fingerprint database has 701 UniFi records, and none of them is a Dream Wall Pro

Read 2026-11-19 11:4x UTC: `https://static.ui.com/fingerprint/ui/public.json` — HTTP 200,
`application/json`, **832,199 bytes**, `version` `92e630d855db10fb307f5077c5e028c8b9e92019`,
`Last-Modified: Tue, 17 Nov 2026 10:41:36 GMT`. It is the **701-record device database the UniFi
controller itself adopts hardware from** — the file that tells a console "this sysid is a UDW".

Every previous pass on #130 read surfaces a *buyer* sees: techspecs pages, the store tree, datasheets,
the FCC grantee list, the firmware release index. This one is the surface a *device* is matched against,
and it is the first that answers the question directly rather than by absence-of-listing.

## 1. Why absence here is a different kind of fact

Three properties were checked before the Dream Wall row was read, because each of them could have made
an empty result meaningless:

1. **Pro tiers are separate records with separate sysids inside one product line.** `UDM` is sysid
   `ea11`; `UDM-Pro` is `ea15` with shortnames `UDM-PRO / UDM-Pro / UDMPRO / …`; `UDR` is `eccc`;
   `UDR-5G-Max` is `a6b9`. A Pro Dream Wall would be its own row, not a suffix on `UDW`.
2. **The file encodes tiers textually as well as structurally.** 106 of the 701 records carry a
   `-PRO`/`-Pro` shortname, so the string is present at scale and a search for it is not a search for
   a rare token.
3. **Retired and trial hardware is retained, not pruned.** `UAS-XG` (Application Server XG, a 2017
   product) is still a record with its full regional shortname set and *no* sysid — i.e. rows survive
   the hardware's retirement. And 51 records carry `-EA` shortnames; `UDW`'s own record already lists
   `UDW-US-EA` and `UDW-EU-EA`. So an unreleased or early-access Pro would be visible here too, and
   "the row was deleted" is not available as an explanation for its absence.

## 2. The Dream Wall row, in full

```json
{ "sku": "UDW", "id": "3904d899-2536-40db-b437-055eb0bd61df",
  "product": { "abbrev": "UDW", "name": "Dream Wall" },
  "shortnames": ["UDW","UDW-BR","UDW-EU","UDW-EU-EA","UDW-R","UDW-US","UDW-US-EA"],
  "sysid": "ea2a", "deviceType": "console",
  "compliance": { "fcc": "SWX-UDW", "ic": "6545A-UDW", "modelName": "UDW" },
  "unifi": { "network": { "formFactor": ["WALL"], "ethernetMaxSpeedMegabitsPerSecond": 1000,
             "features": { "poe": true },
             "deviceCapabilities": ["GATEWAY","SWITCH","ACCESS_POINT","NETWORK_APPLICATION",
                                    "PROTECT_APPLICATION","CONTROLLER","APPLICATION_MODE",
                                    "HAS_CLIENTS","TRAFFIC_FLOWS_ALLOWED_TRAFFIC","SD_WAN_HUB"] } } }
```

One record. Seven shortnames, all regional or early-access spellings of the same SKU.

## 3. The absence

Across all **832,199 bytes**:

| probe | occurrences |
|---|---|
| `UDW-PRO` (any case, `_` or `-`) | **0** |
| `UDWPRO` | **0** |
| `udw` (any case) | 18 — every one inside the record above |

Thirty-four records have `"deviceType": "console"`. They are `CLOUD-CONSOLE`, `EF-Core`, `EFG`, `ENVR`,
`ENVR-Core`, `NVR`, `UAS-XG`, `UCG-Fiber`, `UCG-Industrial`, `UCG-Max`, `UCG-Ultra`, `UDM`, `UDM-Beast`,
`UDM-Pro`, `UDM-Pro-Max`, `UDM-SE`, `UDR`, `UDR-5G-Max`, `UDR7`, `UDW`, `UISP-Console`, `UNKNOWN-CONSOLE`,
`UNVR`, `UNVR-G2`, `UNVR-G2-Pro`, `UNVR-Instant`, `UNVR-Pro`, `UX`, `UX7`, `UXG-Enterprise`, `UXG-Fiber`,
`UXG-Lite`, `UXG-Max`, `UXG-Pro`. One Dream Wall, no Pro.

## 4. What this settles, and what it cannot

**Settles:** no UniFi controller has ever been given a device record for a Dream Wall Pro — not as a
product, not as an early-access build, not as a retired row. #130's SKU is not behind a bad slug.

**Cannot settle:** the port census. The record carries `features.poe: true` and no PoE class, no budget,
and `ethernetMaxSpeedMegabitsPerSecond: 1000`, which is below the 2.5G and 10G ports on the base UDW —
it is a floor, not a spec. So this surface can prove a product does not exist; it can never model one.
Nothing was written to `devices/ubiquiti/` from it.

## 5. Cross-check against the catalogue — and the one thing it does say about UDW

The row's `unifi.network` port map is the only census-shaped field here:

```
diagram: ["01 … 17", "__ … 18 19 20"]      ports: eth0…eth17 = LAN, eth18 = WAN, eth19 = WAN2
```

20 positions, split **18 LAN / 2 WAN** — the same split the vendor page gives once the SFP+ LAN port is
counted as LAN (17 GbE RJ45 + 1 SFP+ LAN; 2.5G RJ45 WAN + SFP+ WAN). `devices/ubiquiti/udw.json` has 20
interfaces with that same split, so this is agreement, not a correction. The naming differs — the
controller numbers every port `eth0`–`eth19` while the spec names the two cages `sfp1`/`sfp2` — so a
future pass must not read `eth18` here as an interface the spec is missing. (`ports.plus: [17, 20]` is
unexplained and was not used for anything.)

All 34 console records were also checked against `devices/ubiquiti/`: every one resolves to a spec except
`UAS-XG` (an application server, not a gateway) and `UNKNOWN-CONSOLE` (a placeholder). The gateway line is
fully covered, so #130 is not hiding behind a sibling nobody modelled.

## 6. Traps, so they are not re-walked

- `https://static.ui.com/fingerprint/ui/public/latest.json` and `.../public/` are **plain 404s** (112-byte
  nginx page), not the techspecs-style soft-200. The only door is the exact filename.
- It is a CloudFront object with a real `Last-Modified`; re-read the header rather than assuming the
  file is current.
- The file is *adoption* metadata. `UAS-XG`'s missing sysid shows records outlive hardware, but a row
  also tells you nothing about PoE class or per-port rate. Do not derive a port census from it.

## 7. What still unblocks #130

Unchanged, and now narrower: a Ubiquiti-hosted page, datasheet, quick-start, FCC exhibit, storefront
entry, KB article **or controller device record** naming `UDW-PRO` — or the requester confirming they
meant the **UDW** (`devices/ubiquiti/udw.json`), **UDM-Pro** (`devices/ubiquiti/UDM-Pro.json`),
**UDR-5G-Max** (`devices/ubiquiti/udr-5g-max.json`) or **UniFi Mobile Router**
(`devices/ubiquiti/umr.json`). This request stays in the queue.
