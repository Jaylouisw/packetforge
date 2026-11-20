# MikroTik's PoE-out census: the product pages publish port ranges, current limits, and sometimes watts

The catalogue's MikroTik entries were imported without a `poe` block, so `scripts/audit-poe-budget.js`
listed nine of them as *silent PSEs*: ports that source power with no stated ceiling. Separately, seven
of those specs had the **wrong ports** marked as sources — because the engine infers "every RJ45 port of a
switch with `poe-pse` sources 15.4 W" (`isPoePse()` in `engine/media.js`), and a reverse-PoE box is exactly
the case where that inference is false.

## 1. Getting to the pages

`https://mikrotik.com/product/<slug>` is **case-sensitive and uses underscores**, and an unknown slug
answers 404 with a 13,238-byte page. The hyphenised guesses (`crs112-8p-4s-in`, `css610-8p-2s-in`,
`css610-1gi-7r-2s+out`) all 404; so do plausible ones for current products (`cap-ax`, `rb5009ug+s+in`).
`https://mikrotik.com/sitemap.xml` (HTTP 200, 48,450 B) lists all **653** product URLs, which is the only
reliable way to get the slug — e.g. `css610_1gi_7r_2s_out` for the CSS610-1Gi-7R-2S+OUT, whose page is
titled *netPower Lite 7R*, and `netpower_16p` for the CRS318-16P-2S+OUT.

All pages below read 2026-11-20 with a `Mozilla/5.0 … Chrome/126` UA, HTTP 200, `text/html`.

| spec file | product URL | bytes |
|---|---|---|
| `css610-8p-2s-in.json` | `css610_8p_2s_in` | 351,350 |
| `crs320-8p-8b-4s-rm.json` | `crs320_8p_8b_4s_rm` | 364,538 |
| `crs418-8p-8g-2s-rm.json` | `crs418_8p_8g_2s_rm` | 419,515 |
| `crs354-48p-4s-2q-rm.json` | `crs354_48p_4s_2q_rm` | 394,160 |
| `gperx6.json` | `gperx6` | 353,837 |
| `css610-1gi-7r-2s-out.json` | `netpower_lite_7r` | 356,904 |
| `crs318-1fi-15fr-2s-out.json` | `crs318_1fi_15fr_2s_out` | 380,113 |
| `rb260gsp.json` | `RB260GSP` | 344,158 |
| `crs112-8p-4s-in.json` (checked, unchanged) | `crs112_8p_4s_in` | 364,485 |
| `crs328-24p-4s-rm.json` | `crs328_24p_4s_rm` | 368,617 |

## 2. What the specification tables say, verbatim

The PoE block is a table of label/value pairs; the useful keys are `PoE-out ports`, `PoE out`,
`Low/High voltage PoE-Out current limit`, `Max total out (A)`, `Total output power`, and
`Number of 1G Ethernet ports with PoE-out` / `… with Reverse PoE (PoE-in)`.

- **CSS610-8P-2S+IN** — `PoE-out ports Ether1-Ether8`, `PoE out 802.3af/at`, `Total output power 140`.
- **CRS320-8P-8B-4S+RM** — `PoE-out ports Ether1-Ether8 (af/at), Ether9-Ether16 (bt)`,
  `Max total out (A) 17.82 A`, `Total output power 963`, `10/100/1000 Ethernet ports 17`,
  `Number of 1G Ethernet ports with PoE-out 16`.
- **CRS418-8P-8G-2S+RM** — `PoE-out ports Ether9 - Ether16`, `Total output power 150`,
  `Number of 1G Ethernet ports with PoE-out 8`, `10/100/1000 Ethernet ports 17`.
- **CRS354-48P-4S+2Q+RM** — `PoE-out ports Ether1-Ether48`, `Total output power 700W`,
  `Total output current 27A at 26V OR 13.2A at 53V`, `10/100 Ethernet ports 1`.
- **GPERx6** — `PoE-out ports Ether2-Ether3`, `PoE out Passive PoE up to 57V`, `Max total out (A) 2.4 A`,
  `Total output power 150`, `Number of 1G Ethernet ports with Reverse PoE (PoE-in) 1`, `… with PoE-out 2`,
  `PoE in 802.3 bt`, `Max power consumption 160 W`.
- **netPower Lite 7R** (CSS610-1Gi-7R-2S+OUT) — `PoE-out ports Ether8`,
  `Number of 1G Ethernet ports with Reverse PoE (PoE-in) 7`, `… with PoE-out 1`, `Max total out (A) 600 mA`.
  Prose: "netPower Lite 7R has 7 reverse PoE ports … Ethernet port 8 can power other PoE capable devices".
- **netPower 15FR** (CRS318-1Fi-15Fr-2S+OUT) — `PoE-out ports Ether15`, `Max total out (A) 0.75 A`,
  `Number of DC inputs 16 (DC jack, PoE-IN)`. Prose: "has 15 reverse PoE ports … Ethernet port 15 can power
  other PoE capable devices". Sixteen FE ports, one of them the output, leaves Ether1-Ether14 and Ether16 as
  the fifteen inputs — arithmetic the table forces, since `PoE-out ports` names only Ether15.
- **CRS328-24P-4S+RM** — `PoE-out ports Ether1-Ether24`, `PoE out 802.3af/at`, `Max total out (A) 20 A`,
  `Number of 1G Ethernet ports with PoE-out 24`. Its twenty-four copper ports exist only as a port template,
  and the template carried no `poeOut`, so the 24P modelled as a plain switch.
- **RB260GSP** — `PoE-out ports Ether2-Ether5`, `Max total out (A) 2 A`, `PoE in Passive PoE` (Ether1,
  11-30 V).

## 3. Why the ports, not just the numbers

A reverse-PoE switch sources one port and *draws* from the rest. With `poe-pse` in the capability list and
no per-port statement, `isPoePse()` gives every RJ45 port 15.4 W of output: the 7R was modelled as eight
PSEs (it has one), the 15FR as sixteen (it has one), the RB260GSP as five (it has four, Ether1 being the
input), the GPERx6 as two on the wrong pair (Ether1 is the 802.3bt *input*; the outputs are Ether2-Ether3),
the CRS320 as seventeen (Ether17 is the management port), the CRS418 as seventeen (only Ether9-Ether16
are PoE) and the CRS354-48P as forty-nine (the tenth-of-a-gigabit management port, `10/100 Ethernet ports 1`
in the table, was swept into the PSE set along with the forty-eight gigabit ports). Marking a port `"poeOut": false` is the spec's way of saying "the engine's guess is wrong here".

## 4. What the pages do *not* publish

NetPower Lite 7R, netPower 15FR, RB260GSP, CRS328-24P-4S+RM and CRS112-8P-4S-IN state **current** limits only
(`Max total out` in A) against an input-voltage window, never watts. Multiplying 0.6 A by 57 V is
arithmetic MikroTik did not do, so those four now carry `poe.budgetUnknown: true` with the quoted limit in
`poe.note` rather than a made-up watt figure. CRS354's 700 W, CRS320's 963 W, CRS418's 150 W, CSS610-8P's
140 W and GPERx6's 150 W are the vendor's own totals.
