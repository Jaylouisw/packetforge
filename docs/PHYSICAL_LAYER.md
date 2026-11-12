# Physical Layer, Link Types and Feasibility Rules

PacketForge models the **physical layer** explicitly, so a topology can only be
cabled the way real hardware allows. This document covers the port model, the
medium catalogue, the feasibility rules, and the L2 features built on top
(VLANs, link aggregation, spanning tree).

---

## 1. The port model

Every interface has a derived **hardware descriptor** (`engine/media.js`):

```json
{
  "name": "sfp-sfpplus1",
  "cage": "sfp+",
  "cageName": "SFP+",
  "family": "optical",
  "media": ["10gbase-sr", "10gbase-lr", "10gbase-er", "1000base-sx", "1000base-lx", "..."],
  "speedCaps": [1000, 10000],
  "maxSpeedMbps": 10000,
  "poeOut": null,
  "poeIn": null
}
```

| Field | Meaning |
|-------|---------|
| `cage` | The physical connector/cage — **26 of them**: Ethernet cages (`rj45`, `sfp`, `sfp+`, `sfp28`, `sfp56`, `combo`, `qsfp+`, `qsfp28`, `qsfp56`, `qsfpdd`), the Fibre Channel set (`fc-sfp`, `fc-sfp28`, `fc-sfpdd`, `fc-qsfp28`), `xfp`, fibre connectors (`sc-apc`, `sc-upc`, `lc-apc`, `lc-upc`) and the non-Ethernet families (`coax`, `dsl`, `powerline`, `console`, `usb`, `antenna`, `wwan`). The full table is in [CONNECTORS.md](CONNECTORS.md). Note `mpo` is **not** a cage — it is a media `connector` value, and using it as a cage is an error |
| `media[]` | Media (optics / copper / DAC) the port can carry |
| `speedCaps[]` | Line rates the port can negotiate (Mbps) |
| `poeOut` | Watts this port can *source* (PSE) |
| `poeIn` | Watts this port *draws* (PD) |

### Which cages the catalogue actually exercises

Twenty-six cages are defined; **twenty-four** carry at least one port in `devices/`, measured by running
`derivePortHardware()` over every port `effectiveInterfaces()` returns — **17,030** ports today. The two that
carry none are `lc-apc` (every LC port in the catalogue is UPC — **115** of them) and `usb` (no spec declares
a USB port, so the cage exists for the rule table and for a future spec rather than for hardware). Coverage is
very uneven, which matters when you are judging what a change can break: `rj45` alone is **9,043** ports,
`sfp+` 1,728, `qsfp28` 1,272, `sfp28` 1,074, `antenna` 949, `sc-apc` 679 and `sfp` 595 — while **`xfp`,
`combo` and `qsfp56` are two ports each**, `fc-qsfp28` and `sfp56` eight each, and `powerline` twelve. A
change that only touches XFP, combo or QSFP56 is exercised by two ports in the whole catalogue, so "the
suite is green" says less there than it does about RJ45.

Re-measured at `7be9ef73` with the command below: **17,030 ports, twenty-four cages carrying at least one,**
and every figure in the paragraph above unchanged — `rj45` 9,043, `sfp+` 1,728, `qsfp28` 1,272, `sfp28` 1,074,
`antenna` 949, `sc-apc` 679, `sfp` 595, `lc-upc` 115, `qsfpdd` 168, `powerline` 12, `fc-qsfp28` and `sfp56` 8
each, `qsfp56`, `xfp` and `combo` 2 each. `CAGES` itself has 26 entries (`engine/media.js:314`), as does
`CAGE_MEDIA` and `CAGE_SPEEDS`; only `CAGE_MATE` is short a row, and [CONNECTORS.md](CONNECTORS.md) explains
which cage that is — it is `wwan`, measured.

The census command above was run verbatim on 2026-11-12 and prints **17030 ports** followed by twenty-four cage
lines, matching every figure in the paragraph: `rj45 9043`, `sfp+ 1728`, `qsfp28 1272`, `sfp28 1074`,
`antenna 949`, `sc-apc 679`, `sfp 595`, `lc-upc 115`, `qsfpdd 168`, `powerline 12`, `fc-qsfp28 8`, `sfp56 8`,
`qsfp56 2`, `xfp 2`, `combo 2`. `lc-apc` and `usb` appear in no line, which is the "twenty-four of twenty-six"
claim. One precision on the citation, re-read on 2026-11-12: `:313` is the `// ----` rule above the
definition, `:314` is the line `const CAGES = {` itself, and `rj45` — the first entry — is `:315`. So the
number the other pages quote is the object's opening line, not an entry and not the comment.

Every figure in that paragraph has moved at least once: it read `rj45` 6,255, `sfp+` 1,260, `qsfp28` 596,
`qsfpdd` eight and 51 LC ports when the catalogue was smaller, and `qsfpdd` is **168** now. Recount before
quoting:

```
node -e "const r=require('./devices/registry'),m=require('./engine/media');const d={};let n=0;
for(const s of r.loadCatalog())for(const i of r.effectiveInterfaces(s)){n++;const c=(m.derivePortHardware(i,s)||{}).cage||'?';d[c]=(d[c]||0)+1}
console.log(n,'ports');for(const [k,v] of Object.entries(d).sort((a,b)=>b[1]-a[1]))console.log(k,v)"
```

### Derivation

Device specs stay terse (`{ "name": "ether1", "type": "ethernet", "speed": "1G" }`).
`inferCage()` in `engine/media.js` walks these rules in order and the first one wins:

| # | Signal | Cage |
|---|---|---|
| 1 | name starts `wwan`, `wan5g`, `modem`, `lte`, `nr5g`, `nr`, `5g`, then **end-of-name or one of `. - _ space /`** — but only `wwan`, `modem`, `lte`, `nr` and `5g` accept a digit suffix; **`wan5g` and `nr5g` do not** | `wwan` — a cellular modem is neither copper nor Wi-Fi, and it is checked **before** `type` because specs rewrite these ports as `type: "wireless"`. The separator demand is what splits `nr5g` from `nr5g0`: see below |
| 2 | `type` is a radio type (`wireless`, `radio`, `wifi`, …) | `antenna` |
| 3 | `type` is `console` / `usb` / `coax` / `dsl`, `adsl`, `vdsl` / `powerline`, `plc`, `mains` | that family (`console`, `usb`, `coax`, `dsl`, `powerline`) |
| 4 | name starts `wlan`, `wifi`, `wi-fi`, `radio`, `wwan`, `nr5g`, optionally digit-suffixed | `antenna` — this is where `nr5g0` lands, not rule 1 |
| 5 | name contains `console`, `con<N>`, `tty`, `aux` → `console`; `usb` → `usb` | |
| 6 | name names a fibre connector — `sc/apc`, `scapc`, `sc/upc`, `scupc`, `lc/apc`, `lcapc`, `lc/upc`, `lcupc` (see the spelling trap below) | that cage |
| 7 | name says PON (`gpon`, `xg-pon`, `xgs-pon`, `pon<N>`) | `sc-apc` — the ISP convention, because a PON port's connector is a vendor choice; an explicit `connector` on the spec always wins |
| 8 | name matches `sfp`/`qsfp`/`xfp`/`cfp`/`xe-`/`et-`/`fc<N>`, **or** `speed` is the string `25G`/`40G`/`100G` (a number does not count — see below) | optical, by rule 9 |
| 9 | optical: name says `qsfpdd` → `qsfpdd`; `qsfp56` → `qsfp56`; otherwise by max rate — ≥200G `qsfpdd`, ≥100G `qsfp28`, ≥40G `qsfp+`, ≥25G `sfp28`, ≥10G `sfp+`, else `sfp` | |
| 10 | nothing matched | `rj45` |

**Rules 1 and 4 both mention `nr5g`, and the one that wins depends on what follows it.** Rule 1 tries
`nr5g` *before* `nr\d*`, and every alternative must be followed by end-of-name or a separator, so the
spelling with a separator is a modem and the spelling with a bare digit is a radio — and one spelling
matches neither list:

| name | `inferCage()` | which rule |
|---|---|---|
| `nr5g`, `nr5g.1`, `nr5g-1`, `nr5g_1` | `wwan` | 1 — `nr5g` followed by a separator |
| `nr5g0`, `nr5g1` | `antenna` | 4 — rule 1's separator test fails, so the radio rule claims it (2 claims it earlier still if the spec also says `type: "wireless"`) |
| `nr0`, `nr5`, `wwan0`, `wwan0.1`, `modem0.1`, `lte-1`, `5g1` | `wwan` | 1 |
| `nr5gx`, `wan5g0` | `rj45` | 10 — neither rule's suffix test passes, and nothing else matches |

That last row is not a hypothetical: it is the reason rule 1 above no longer says "each optionally digit-suffixed".
`wan5g` and `nr5g` are written without `\d*` in the alternation (`media.js:782`), so a cellular port named
`wan5g0` gets past both radio rules and lands on the copper default — a modem modelled as an RJ45 socket, which is
the kind of classification error the rule table exists to prevent. `wan5g-1` and `nr5g-1` are fine, because the
separator carries the match. Fourteen spot values were re-run through `inferCage()` on 2026-11-12 and all agree with
this table, `nr5g0 → antenna` and `wan5g0 → rj45` included.

That is inference, not a catalogue defect: no port in the catalogue is named `nr*` at all, and a spec
that wants a modem cage can say `connector: "wwan"` and skip the rules entirely. The one port whose name
starts `5G` and is *not* a modem — `huawei/AirEngine5760-51`'s `5GE` — is a LAN port and correctly
derives `rj45`.

**Rule 6 is narrower than it looks: the separator has to be a slash or nothing, never a hyphen.**
The regexes are `lc\/?upc`, `sc\/?apc` and so on, so `lc/upc1` and `lcupc1` resolve to `lc-upc`, while
`lc-upc1` — the spelling this table used to list, and the one a hand-written spec is most likely to
pick — matches nothing and falls all the way through to `rj45`. Measured:

| name | `inferCage()` |
|---|---|
| `lc/upc1`, `lcupc1` | `lc-upc` |
| `sc/apc1`, `scapc1` | `sc-apc` |
| `lc-upc1`, `sc-upc1`, `lc-apc1`, `sc-apc1` | `rj45` |

No catalogue device is affected — no port in the **1,661** models is named after a connector at all (this
sentence said 1,650; recounted, and the claim itself re-measured: zero ports named `rj45`, `sfp`, `lc`, `sc`,
`mpo`, `bnc`, `db9`, `usb` or `rj11` across the whole catalogue), and a
spec that does want one can set `connector` explicitly, which overrides every rule here. The trap is for
someone hand-writing a patch-panel port and expecting the name to do it.

One more thing the signature hides: the rate ladder in rules 8–9 reads the **second argument** — the
port's max rate in Mbps — not `spec.speed`. `speed` only feeds the "is this optical at all" test, so
`inferCage({ name: 'et-0/0/0', speed: '100G' })` answers `sfp`, and the same call with `100000` answers
`qsfp28`. Pass the rate or the port gets the slowest optical cage that matches its name.

And the `speed` half of that test is a **string** test, unit included. Measured on a port named `port7`,
which matches no name pattern:

| `spec.speed` | `inferCage(spec)` | why |
|---|---|---|
| `'25G'`, `'25 G'`, `'25g'` | `sfp` | the regex looks for `25`/`40`/`100` followed by `g` |
| `25000` (a number) | `rj45` | `String(25000)` is `"25000"` — no `g`, so the optical test never fires |
| `'125G'`, `'140G'` | `rj45` | the digit before `25`/`40` has to be a non-digit, so a longer number does not match by accident |
| `'10G'`, `'50G'`, `'200G'`, `'400G'` | `rj45` | only those three rates are in the test |

So a hand-written spec with `"speed": 25000` is copper by inference, however fast the number says the port
is. Write `"speed": "25G"`, or better, pass the rate as the second argument — the second argument is what
the ladder reads, and a bare `speed` only gets the port to plain `sfp`.

None of that mis-cages a catalogue spec: the loader calls `inferCage(spec, maxMbps)` with the rate it parsed
from the same `speed` field, so `25000` and `"25G"` both reach the ladder. The table above is about calling
`inferCage()` yourself, with one argument — which is what these pages do in their examples, and what a test
fixture is most likely to do.

A port named for its cage beats its rate: `qsfpdd1/1` carrying 200G is a QSFP-DD cage, not a
QSFP28 that happens to be fast. QSFP56 has to be named for the same reason — a bare 200G rate
alone resolves to QSFP-DD, which is far more common.

Anything can be overridden explicitly, either per field or via a `hardware` block:

```json
{
  "name": "ether1",
  "type": "ethernet",
  "speed": "2.5G",
  "poeOut": 30
}
```

```json
{
  "name": "sfp-sfpplus1",
  "type": "ethernet",
  "speed": "10G",
  "hardware": { "cage": "sfp+", "speedCaps": [1000, 10000] }
}
```

Device-level PoE budget:

```json
{ "poeBudget": 120 }
```

Resolution order — first match wins, and `Device.poeBudgetSource` records which one it was:

| Source | Field | Note |
|---|---|---|
| `spec` | `poeBudget` | an explicit number of watts |
| `research` | `poe: { "budgetW": 240 }` | a datasheet figure kept beside the spec |
| `unknown` | `poe: { "budgetUnknown": true }` | an explicit "not published" → 0 W. It deliberately does **not** fall through to the next row |
| `name` | a `NN–NNNN W` token in the model name | **a guess, and only kept if at least one port declares `poeOut`** |

`show power inline` prints the resolved budget **and its source**, so a 0 W budget that came from
an explicit "unknown" is distinguishable from one nobody ever declared:

```
SW1#show power inline
Power inline on SW1:
  Budget       : 240 W  (from research)
  Used         : 15 W
  Available    : 225 W
  Port    Admin   Powered device        Requested  Status
  1       auto    PD1                   7 W        on
  2       auto    PD2                   8 W        on
  3       never   PD3                   5 W        off (administratively)
```

The **Admin** column is the operator's decision (`power inline auto|never`) and the **Status** column is
the outcome — a port nobody has refused, a port refused by policy, and a port refused for budget are
three different words (`on`, `off (administratively)`, `denied (budget exhausted)`). A port with no cable
is not listed at all, so a table shorter than the port count is normal — with one exception worth knowing
before you conclude the console ignored you: if a port is set to `power inline never` **and** nothing is
powered anywhere on the switch, it is listed with the device column as `-` and status `off
(administratively)`, because the table is built from powered devices and the one state an operator has
just configured would otherwise be the one the show could not display. Put a powered device on any other
port and that row disappears again: the table returns to listing only ports with a device on them
(`engine/cli.js:12659-12673` for the empty case, `:12686-12693` for the populated one).

From the powered device's side the same decision reads:

```
PD1#show power inline
% PD1 declares poe-pse, passive-poe in its catalogue entry,
% but no port record on it carries power-out - so there is nothing to switch on or off
% That is a gap in the device specification, not a state of the device
  eth0          7 W from SW1 port 1 - powered
```

That warning is worth understanding rather than skipping: a device can be a powered device **and**
declare `poe-pse` (an access point that also feeds a camera), and when its spec claims the capability
without a port record carrying `poeOut`, the console says so instead of inventing a budget.

Two details in that block are worth reading twice, because both have caught people out:

- `Used` is the total to **one decimal, truncated** — not rounded — while the port column keeps the exact
  figure. One 12.95 W device prints `Used : 12.9 W` over a row saying `12.95 W`; a 7 W and a 12.95 W
  device together print `Used : 19.9 W`, not `20.0 W`. `Available` subtracts the printed number
  (`240 − 19.9 = 220.1`), so the last decimal of the budget is arithmetic, not a second measurement.
- A `denied` port means the budget was already spent when `computePoe()` ran — which in a lab you
  built normally **cannot happen**, because cabling an over-budget combination is refused at the
  moment you draw the cable:

  ```
  Error: UniFi Switch Lite 16 PoE PoE budget exceeded: 2 powered ports draw 60 W of a 45 W budget (port1, port2).
  code: E_POE_BUDGET
  ```

  Note the prefix: the message names the **device specification**, not the hostname you configured, and
  the ports are named the way that spec names them (`port1`, not `Gi0/1`). It reads oddly in a lab whose
  switch is `SW1`, but it is the honest identifier — the budget belongs to the model.

  The check sums the ports' advertised `poeOut` — not what the powered devices ask for — so two
  20 W ports are refused on a 30 W budget even if the two cameras only want 12.95 W each. The
  `denied` status becomes reachable when the budget is *corrected after* the lab is wired (a
  datasheet figure revised by research), which is exactly when you want to see who lost power.

The powered device's own view is usually the faster answer to "why is this camera dead", and it names
the port it is plugged into (`12.95 W from SW1 port 1 - powered`, or the refusal), because the port
spelling belongs to the PSE's spec rather than to the device asking.

### A PSE with no budget says why, rather than inventing a figure

The decision is keyed on a **resolved budget and a port that can source power**, not on the
`poe-pse` capability — so a device can declare itself a PSE and have nothing to switch. This is not a
rare corner: **86 of the 110** PSE-capable devices in the catalogue are in it — 57 MikroTik, 26
Ubiquiti, and one each from Peplink (`MAX-BR1-ENT`), Netonix (`WS-26-400-AC`) and FS (`AC-1004`), every
one of them with `budgetSource: 'name'` — routers whose datasheets give a port count and a `poe-pse`
capability without a wattage.

Measure it by building each spec through `Topology.addDevice()`. Constructing a `Device` straight from a
raw spec answers differently: **all 110** read 0 W, because the model-name guess is discarded when no
port record sources power, and a spec whose ports come from a `portTemplate` has not had them expanded
yet at construction time. The same trap hides research budgets — `aruba/2530-8-PoE+ (J9780A)` reads 0 W
straight from the constructor and 67 W through the topology.

Rather than answer "neither sources nor draws PoE" as if the device were not a PSE at all, the console
names the gap and says which side of it is missing:

```
R1#show power inline
% R1 declares poe-pse, 802.3at, 802.3af, passive-poe in its catalogue entry,
% but no port record on it carries power-out - so there is nothing to switch on or off
% That is a gap in the device specification, not a state of the device

AP1#show power inline
Power inline on AP1:
  eth0          7 W requested from R1 port eth1 - no PSE answers
```

Both lines are correct and neither is helpful on its own: the switch is a PSE by capability and a
non-PSE by data, and the AP's line is the only one that names a wattage. When a lab shows this,
check the switch spec for `poeBudget` / `poe.budgetW` before assuming the model is broken — the same
section's budget table is the list of ways to supply it. `poe.budgetUnknown: true` says "a PSE, but
nobody published the figure" and yields 0 W explicitly rather than by omission; exactly one device in
the catalogue uses it, so it is a supported escape hatch rather than a pattern to copy from.

Fixing one of these is not a hand edit: `scripts/apply-research.js` takes a research file with a
mandatory `sourceUrl`, refuses a budget outside 30–4000 W, and records `null` as "researched, not
published" rather than as a blank ([DEVICE_REGISTRY.md](DEVICE_REGISTRY.md#correcting-an-existing-spec-with-researched-facts)).
That is the path from "the datasheet says 65 W" to a switch that powers an AP.

The name heuristic exists because most PoE switches put the budget in the model (`GS110TP-100W`),
but it is discarded when nothing on the device can source power: `ES-24-500W` is a 500 W PSU, not a
500 W PoE budget, and `AR651W-8P` parses to 651 W on a router with no PoE-out ports. A
research-sourced figure is kept even when it looks odd — a contradiction there is a data bug for a
human to see, not something to hide.

The heuristic has its own bounds, and they are **not** the research path's: `parsePoeBudget()`
(`engine/media.js:1406`) matches `/(\d{2,4})\s*W\b/` in the model string and keeps the figure only
inside **30–2000 W**, so a model whose budget the datasheet puts outside that window needs
`poe.budgetW` instead. Measured, because each of these is a way to be surprised:

| model string | budget | why |
|---|---|---|
| `GS110TP-100W`, `PoE+ 370W`, `740W` | 100, 370, 740 | digits followed by `W` |
| `240` | **0** | no `W`, so nothing matches — a bare number is not a budget |
| `240W` | 240 | the `W` is what makes it one |
| `2500W` | **0** | above the 2000 W ceiling |
| `29W` | **0** | below the 30 W floor |
| `S5720-28X-PWR-SI-AC` | **0** | no wattage in the name at all |

There is no `poe-pse` capability check in the **budget** path: the budget comes from the fields above,
and a port sources power because it declares `poeOut`. The capability still matters one step
earlier, for the default: a device with `poe-pse` whose port declares no `poeOut` gets the 802.3af
figure of **15.4 W** (measured), while the same port on a device without the capability gets `null`
and can never source power. So `poe-pse` decides *whether a port defaults to sourcing*, and
`poeOut` decides *how much it can actually give*.

---

## 2. Medium catalogue

89 media across nine families (copper, fiber, fibre-channel, DAC, coax, DSL,
powerline, console, wireless), carried by 26 cages — see [CONNECTORS.md](CONNECTORS.md) for
the cage-by-cage table. Selected highlights:

| Family | Medium | Speed | Connector | Reach |
|--------|--------|-------|-----------|-------|
| copper | `10base-t` / `100base-tx` / `1000base-t` | 10M / 100M / 1G | RJ45 | 100 m |
| copper | `2.5gbase-t` / `5gbase-t` / `10gbase-t` | 2.5G / 5G / 10G | RJ45 | 100 m |
| fiber | `1000base-sx` / `-lx` / `-ex` / `-zx` | 1G | LC | 550 m – 80 km |
| fiber | `10gbase-sr` / `-lr` / `-er` | 10G | LC | 300 m – 40 km |
| fiber | `25gbase-sr` / `-lr` | 25G | LC | 100 m – 10 km |
| fiber | `40gbase-sr4` / `-lr4` | 40G | MPO / LC | 150 m – 10 km |
| fiber | `100gbase-sr4` / `-lr4` | 100G | MPO / LC | 100 m – 10 km |
| DAC | `dac-10g`, `dac-10g-active`, `aoc-10g` | 10G | SFP | 7 / 15 / 20 m |
| DAC | `dac-40g`, `dac-100g` | 40G / 100G | QSFP | 5 / 3 m |
| console | `console-rs232` | 115.2 kbps | RJ45 | 15 m |
| console | `usb-console` | 12 Mbps (USB full speed) | USB | 5 m |
| wireless | `wireless-2.4`, `wireless-5`, `wireless-6`, `wireless-7`, `wireless-60` (the last one from the device's own name, not a rate — see below) | radio | antenna | — |

The full list is served at **`GET /api/media`** (`server/index.js:315`). Reach is `MEDIA[id].maxRangeM`
— one number per medium, which is why the console pair needs two rows rather than one: `console-rs232`
reaches 15 m and `usb-console` 5 m, and they do not even share a unit of rate (115.2 kbps against 12 Mbps
USB full speed). A row that said "15 m, 115.2 kbps" for both was the only place in this table where two
media with different physics shared a line.

Which of those five a port is offered is decided in `wirelessBands()` (`engine/media.js:861-872`), and the
obvious reading of `wireless-60` is wrong. Rate picks a generation, one rung at a time: `speed: 600`
offers `wireless-2.4` alone, `2400` offers `wireless-2.4, wireless-5, wireless-6`, and above 2500 adds
`wireless-7`. No rate reaches 60 GHz, because it is a different radio rather than a faster one; that id is
matched from the **device's own words** — `/60\s*ghz|802\.11ad|wigig/i` over `model` and `description`
(`:870`) — which is the only path that fires today. The catalogue's 60 GHz gear declares its radio as
`"speed": "1G"`, so `generationBands(1000)` would offer it 2.4 and 5 GHz; the name is what overrides that.
Counted over the catalogue's **949** antenna ports: `wireless-2.4` 924, `wireless-5` 588, `wireless-6`
282, `wireless-7` 92, `wireless-60` 25.

The `band` and `bands` keys exist and **no catalogue device sets either** — and they narrow rather than
widen, which is the trap in them. `{ speed: 5760, band: '6' }` is offered `wireless-6` **only**, i.e.
802.11ax at 2400 Mbps, while the same port with no band declared is offered 802.11be's four media.
`bandMediaId('6')` has one answer for both 6 GHz generations (`:845-850`), so naming the band costs the
port its Wi-Fi 7 row.

---

## 3. Can these two ports be cabled?

Three tests, in order (`media.canMate`):

1. **Cages mate?** `CAGE_MATE` — RJ45 only mates RJ45; optical cages mate within the
   SFP family (`sfp` ↔ `sfp+` ↔ `sfp28`) and within the QSFP family.
2. **Shared medium?** The intersection of the two ports' `media[]` must be non-empty.
3. **Common speed?** The intersection of `speedCaps[]` must be non-empty; the link
   runs at the highest common rate.

If all three pass, the link is created with the **preferred** medium (fiber/DAC over
copper SFP; higher speed wins) unless the user picks another valid one.

Example: a 10G SFP+ port cabled to a 1G SFP port negotiates **`1000base-sx` at 1 Gbps** —
physically correct, because the SFP+ cage accepts a 1G optic.

`canMate` also refuses for reasons the §4 tables do not carry, because they belong to the **modules**
rather than to the span:

| Code | Fires when |
|------|------------|
| `E_BIDI_MISMATCH` | exactly one end carries a single-strand module — `1000BASE-BX10-U` transmits 1310 nm into the one strand and listens at 1490 nm, so it only ever pairs with the mirrored `-D` half |
| `E_BIDI_SAME_WAVELENGTH` | both ends carry the **same** half (`-U` against `-U`): two transmitters face each other down the strand and neither receiver hears anything |
| `E_PROTOCOL_MISMATCH` | an out-of-band console port meets a data port — a console link carries an operator typing at a baud rate, not frames |
| `E_BAUD_MISMATCH` | two console-only ports whose declared rates do not intersect. It is checked **before** the media intersection — the code reads `speedCaps` first and falls back to each medium's `baud` — so 115200 against 9600 answers this code directly, with no `E_NO_COMMON_MEDIA` before it. Unreachable from the catalogue: all 178 console ports advertise all five baud media |

Measured: `-U` ↔ `-D` is `ok: true`; `-U` ↔ `-U` is `E_BIDI_SAME_WAVELENGTH` ("two transmitters face
each other and neither receiver hears anything"); `-U` ↔ a duplex `1000base-lx` port is
`E_BIDI_MISMATCH`; console ↔ RJ45 is `E_PROTOCOL_MISMATCH`; console ↔ USB stops earlier at
`E_CONNECTOR_MISMATCH` (a real USB port carries `usb-console`, so both ends are console-only and the
protocol test never fires); console at 115200 ↔ console at 9600 is `E_BAUD_MISMATCH`, checked before
any media intersection.

---

## 4. Feasibility rules

`engine/validation.js` returns **nine** fields, not the six this page used to list:
`{ ok, errors[], warnings[], media[], mediaId, speedMbps, patchCord, patchCordLossDb, polishWeakened }`
— read off the object on 2026-11-12, and the last three are the ones that describe a hybrid lead
(§ elsewhere on this page). **Errors block the link**; warnings are surfaced but allowed.

### Errors (block)

| Code | Meaning |
|------|---------|
| `E_NO_PORT` | Port does not exist on the device |
| `E_SELF_LINK` | A device cannot be cabled to itself |
| `E_PORT_IN_USE` | Port already carries a link |
| `E_CONNECTOR_MISMATCH` | Cages cannot physically mate (e.g. RJ45 → SFP+) |
| `E_NO_COMMON_MEDIA` | Cages mate but no shared optic/DAC/copper module |
| `E_NO_COMMON_SPEED` | Shared medium but no common line rate |
| `E_WIRELESS_TO_WIRED` | Radio port cabled to a wired port |
| `E_CONSOLE_TO_DATA` | Console port cabled to a data port |
| `E_MEDIA_NOT_SUPPORTED` | Requested medium is not supported by both ports |
| `E_POE_BUDGET` | Powered ports exceed the PSE's PoE budget |
| `E_LAG_SPEED_MISMATCH` | LAG members run at different line rates |
| `E_POLISH_MISMATCH` | Same connector shape, different polish (SC/APC against SC/UPC). An 8° angled ferrule does not seat against a flat one; only a hybrid cord joins them |
| `E_PATCH_CORD_UNKNOWN` | The patch-cord part number the link declares is not in the optics catalogue |
| `E_PATCH_CORD_ENDS` | The declared patch cord is not terminated in the two connectors it is joining |
| `E_OPTICAL_BUDGET` | The span's loss (fibre, splices, connectors) exceeds the optic's budget, per direction |

### Warnings (allow)

| Code | Meaning |
|------|---------|
| `W_DISTANCE` | Cable longer than the medium's reach |
| `W_DUPLEX_MISMATCH` | Ends configured with different duplex |
| `W_SPEED_DOWNGRADE` | Link runs below both ports' maximum |
| `W_POE_DRAW` | PoE-powered device on a port that cannot supply power |
| `W_COPPER_LONGRUN` | Copper run longer than the 90 m horizontal limit |
| `W_HYBRID_CORD` | A UPC/APC hybrid lead joins two different polishes: legal, but it costs its insertion loss and cannot be swapped for a plain lead |
| `W_OPTICAL_HEADROOM` | The link passes, but with only a few dB of the PON class budget left |

**Two of those codes are not in `RULES`, and that is worth knowing before you grep for them.** `RULES`
(`engine/validation.js`) is an **array of 20** `{ code, severity, description }` entries — 14 `E_` and 6
`W_` — and measured on 2026-11-12 it contains every code in the two tables above **except**
`E_OPTICAL_BUDGET` and `W_OPTICAL_HEADROOM`. Those two are emitted inline by the PON budget phase at the
end of `validateLink()` (`engine/validation.js:705` and `:712`, with a second `E_OPTICAL_BUDGET` site in
`engine/optical.js:140`), so a tool that enumerates `RULES` to decide which codes are legal would reject
two refusals the engine really produces. The file's own header asks that a renamed code be added to
`RULES`, which is the rule these two are the exception to.

**Every code in `RULES` is actually reachable.** Counted on 2026-11-12: all **20** appear as a quoted
literal somewhere other than the `RULES` array itself (`:61-138`), which is the definitions. Most are
emitted once, inside `validateLink()`; **seven** come from a second module as well, which is where a code
can surprise you — `E_NO_PORT` from `Topology.connect()` when a cable names a port that has since gone
(`topology.js:471`) and from `canMate()` (`media.js:1232`); `E_WIRELESS_TO_WIRED`, `E_CONNECTOR_MISMATCH`,
`E_POLISH_MISMATCH` and the media/speed pair from `media.js` (`:1236`, `:1277`, `:1268`, `:1331`,
`:1338`) — the polish refusal is one branch past the check that *permits* a hybrid lead, which is why it
sits in the same block; and `E_LAG_SPEED_MISMATCH` from the LAG validator (`lag.js:258`) as well as from
the link check. So a refusal whose code you do not recognise may not have come from `validation.js` at
all. The count is what moves: the sentence said five when the list had six and one code was missing from
it, and the list is the thing to re-derive.

Both are PON-only: the check runs when both ends are `sc-apc`, `sc-upc`, `lc-upc` or `lc-apc`, budgets
each direction separately — `E_OPTICAL_BUDGET` names which one failed (`downstream at 1490 nm` or
`upstream at 1310 nm`) because the upstream wavelength is the lossier — and `W_OPTICAL_HEADROOM` fires
when the surviving headroom is **under 3 dB**, computed with a declared patch cord's insertion loss
included and an undeclared one adding nothing. Two details of that check are easy to get backwards: the
warning sits in the `else` of the budget test (`engine/validation.js:708-716`), so a link that already
fails reports `E_OPTICAL_BUDGET` and **no** headroom warning, and the figure compared against 3 dB is the
**smaller of the two directions** (`Math.min(down.headroomDb, up.headroomDb)`), not the downstream one —
which is why a 20 km link at 1310 nm warns on 2.7 dB while the same link at 1490 nm has 5.3 dB to spare.
The class the budget is measured against is the device's (`spec.ponClass`), and when neither end declares
one the check **falls back to B+** — 28 dB — instead of refusing to judge (`engine/validation.js:693-694`),
so the refusal names a class the databook may never have said:
`% upstream at 1310 nm Path loss 28.6 dB exceeds the B+ budget`. That is what
`POST /api/topologies/<id>/validate-link` answers for two ADTRAN 411 ONTs (`pon` to `pon`) at 80,000 m —
`verdict.ok` false, `mediaOptions` still one — while the same pair at 30,000 m passes with only a
`W_DISTANCE` warning, because the budget and the reach are separate checks and the reach one is a warning.

Try it live: **`POST /api/topologies/:id/validate-link`** returns the verdict plus every medium the two
**cages** have in common, which is what the UI's media picker is built from.

That list is a claim about the sockets, not about the rate. It is an intersection of the two cage ladders, so
it can offer a medium carrying a speed **neither port declares** — an `fc-sfp` pair offers `10gfc-sw` with
10519 in neither port's `speedCaps`, and naming `16gfc-sw` on a pair where only one end declares 14025 is
accepted, with the link then reporting `speedMbps` 8500 under a `16gfc-sw` label. Read the picker as *what
will mate*, and read the cable's own `speedMbps` for what it will run; [FIBRE-CHANNEL.md](FIBRE-CHANNEL.md#two-fc-ports-link-and-negotiate-down)
has the worked case. The budget check above is a different kind of judgement and worth keeping apart from
this one: it refuses on **loss**, not on rate, so a PON pair can be offered every medium and still fail.

### A refusal that tells you what to buy

`validateConnection()` returns the reason **and**, where the catalogue has a fix, the part that
performs it. Mating an SC/APC PON port to an SC/UPC one (both derive from the port name — `pon1`
and `scupc1`) produces:

```
E_POLISH_MISMATCH  olt-x/pon1 <-> ont-x/scupc1: SC/APC and SC/UPC take the same SC ferrule but not
the same polish (APC angled 8 deg vs UPC flat). They are not intermateable - forcing it costs about
3 dB and can chip the endface. A hybrid patch cord (SMSCSX, sc-upc to sc-apc, 0.3 dB insertion loss)
joins these two polishes: declare it on the link (patchCord: "SMSCSX") and the run becomes buildable.
```

plus a machine-readable `suggestion`:

```json
{ "code": "S_PATCH_CORD_REQUIRED", "field": "patchCord", "value": "SMSCSX", "lossDb": 0.3,
  "message": "Add SMSCSX (sc-upc → sc-apc) and this link is buildable." }
```

Declaring that cord turns the refusal into a `W_HYBRID_CORD` warning and the link builds at the
cord's loss, which is the point: the answer to "why can't I cable this?" is a part number rather
than a shrug. See [HYBRID-PATCH.md](HYBRID-PATCH.md).

---

### The check runs when a cable is drawn, and again whenever state is served

`connect()` asks the rule once, at the moment of building, and then forgot the answer: nothing asked
again. A topology that arrived from a file — hand-edited, written against an older catalogue, or
produced by anything that was not this UI — could therefore hold a run that could never have been
built, and the link inspector answered for every cable with one hardcoded sentence:

> this cable passed the physical-layer check when it was created

which is a claim about a check that, for a loaded cable, nobody had run. A copper pair joined by
`1000base-lx` in the file was described that way, while the engine's own rule said:

```
E_MEDIA_NOT_SUPPORTED: 1000BASE-LX (1000base-lx) is not supported by both PC/eth0 and Switch (L2)/Fa0/1;
possible media: 10BASE-T, 100BASE-TX, 1000BASE-T.
```

`Topology.linkVerdict(link)` runs that same rule over the hardware as it is now, in the `revalidate`
form so a pair that is cabled to each other is not refused for being cabled, and returns the verdict.
Every state payload the server builds carries one per link. It is attached in `fullState()` and not in
`serialize()`, deliberately: a saved file records what was built, while a verdict is a derived answer
about the hardware as it is now, and one written into a file would be read back as fact long after the
hardware it describes had changed.

Recomputing every link on every state payload costs about **5 µs per cable** — a 211-cable board
serialises in 1.24 ms with verdicts against 0.21 ms without, measured — so it stays a straight
recomputation rather than a cache. A cached verdict is the thing this whole change exists to avoid.

The inspector renders what it is handed rather than asserting anything of its own:

| verdict | what the panel says |
| --- | --- |
| `ok` | the cages mate and the media is supported at both ends, checked against the hardware as it is now |
| `ok` with a warning | the same, plus the warning — an over-length run still carries `W_DISTANCE` |
| refused | this cable cannot exist as drawn, with the engine's own message, and that drawing it now would be refused |
| absent | this cable has not been checked in this session — never a claim that it passed |

**What this does not do:** the data path does not consult the physical rule. Frames still cross a
cable that could never have been built, exactly as they still cross an over-length run — the verdict
is a report, not a door. Making it a door is a different change with a sharp edge: a lab restored from
a hand-edited file would fall silent the moment it loaded, so the refusal stays at the panel and says
what it would do.

## 5. VLANs (802.1Q) — enforced in the data path

`engine/vlan.js` implements per-port configuration:

```js
{ mode: 'access' | 'trunk', accessVlan: 10, nativeVlan: 1, allowedVlans: 'all' | [10, 20] }
```

- **Access**: egress untagged on `accessVlan`; ingress accepts untagged, drops tagged with the reason
  token `tagged-frame-on-access` — a trunk carrying VLAN 20 into an access port on VLAN 10 renders as
  `vlan-drop  SWB   tagged-frame-on-access, on Fa0/1, vlan 20` in `show logging vlan-drop`. Note the
  console prints the token, not prose, where the egress side prints a sentence.
- **Trunk**: egress untagged for `nativeVlan`, tagged for every other allowed VLAN; ingress maps untagged
  → `nativeVlan`, tagged → VID when allowed, else drops. Measured with `nativeVlan 10` on both ends and a
  VLAN 10 host either side: the only shape the trunk emits for that traffic is `vid: 10, wireTagged:
  false, wireVid: null`, and a VLAN 20 host's traffic on the same trunk is `vid: 20, wireTagged: true,
  wireVid: 20`. Both are readable back from the port — `show interfaces switchport` prints
  `Trunking Native Mode VLAN: 10` and `Trunking VLANs Enabled: 10,20`.

The simulator calls `classifyIngress` on every received frame and `classifyEgress`
before every transmission, so:

- **MAC tables are per VLAN** (`Device.macTableFor(vid)`), because VLANs are separate
  broadcast domains. VLAN 1 keeps the flat legacy table.
- **Flooding is scoped to the VLAN**: a broadcast never crosses a VLAN boundary.
- **Trunks tag real frames**, and each `frame` event carries three fields that say so: `vid` (the VLAN
  the frame belongs to), `wireTagged` and `wireVid` (what is actually on the wire). Measured across one
  trunk between two switches, VLAN 10 on the host ports: every frame on `SWA:Fa0/1 -> SWB:Fa0/1` with
  `vid: 10` reports `wireTagged: true, wireVid: 10`, the untagged LLDP riding the same link reports `vid:
  1, wireTagged: false`, and both access ports report `vid: 10, wireTagged: false`. What you will **not**
  see is any of that on the console: `show logging frame` renders every frame as `from SWA, to SWB`, so
  the tagging is a property of the event object rather than of the printed table.
- Frames a port's VLAN rules reject are dropped with a **`vlan-drop`** event, and that is a narrower case
  than it sounds. A cross-VLAN ping that simply has nowhere to go produces a plain **`drop`** —
  `% … no egress ports in VLAN 20` — because no port on the switch is in that VLAN at all. `vlan-drop` is
  for a port that is considered and then refuses: with a trunk allowed-list of `10`, the untagged LLDP in
  VLAN 1 is dropped as `VLAN 1 not allowed on egress, on Fa0/1, vlan 1`, while the VLAN 20 user traffic on
  the same switch still leaves as `no egress ports in VLAN 20`.

VLANs 1–4094 are assignable, and anything outside the range is refused by number —
`% VLAN 4095 is outside 1-4094`, `% VLAN 0 is outside 1-4094` (and `% VLAN 4096 is outside 1-4094`), while a value that is not a number at all is refused a step earlier as `% VLAN id must be a number, not "abc"` — so round and non-numeric ids fail with different messages. The IEEE 802.1Q **reserved block
1002–1005 is not enforced anywhere in the running simulator.** `engine/vlan.js` names it
(`VLAN_RESERVED_MIN`/`VLAN_RESERVED_MAX`, `isReservedVlan()`) and `validatePortConfig()` would report
`E_VLAN_RESERVED` for it, but nothing in `engine/`, `server/` or `web/` calls that function — only the
suites do. So the console creates one on request — `VLAN 1003 created (name: VLAN1003)` — and accepts a
port assignment to it: `Access VLAN 1003 on Fa0/1 (VLAN 1003 did not exist and was created - "no vlan
1003" removes it)`, after which 1003 is a live row in `show vlan brief`. Treat 1002–1005 as
documented-but-unenforced until something calls the validator.

## 6. Link aggregation (LACP) — enforced in the data path

`engine/lag.js` — modes `lacp-active`, `lacp-passive`, `static`; hash policies
`l2`, `l3`, `l3l4`. `hashFrame` is a deterministic hash and `selectMember` maps a
frame onto a member: it drops disabled members and duplicate names, **sorts the survivors by name
before hashing** — that sort is what makes the choice order-independent — and returns `null` when
nothing is eligible (duplicate names collapse, disabled members are skipped, and a set that is empty or
all-disabled gives `null`).

Which policy a group uses is a field on the LAG (`config.lags[id].hashPolicy`), not a console command:
`show etherchannel` prints the group, protocol and members in every form it accepts, so the policy is
invisible from the keyboard and cannot be set there either. The default depends on how the group was made
— a `channel-group` typed at the console stores `l2`, a group normalised from topology JSON defaults to
`l3l4`, and the data path falls back to `l2` when the field is missing — which matters when two labs that
look identical pick different members. `docs/SIMULATION.md` carries the measured behaviour row.

In the simulator a LAG is **one logical port**:

- Spanning tree sees a single edge, so it does **not** block member links. Measured on two switches
  joined by a 2-member bundle *and* a redundant single link: `show spanning-tree` lists `lag-1` at cost
  10000 and puts the redundant `Fa0/3` in `alternate blocking (traffic dropped)` on the far side, leaving
  both bundle members forwarding.
- Exactly one member carries each frame: egress members are collapsed per group and one is picked
  (`engine/simulator.js:3663-3681`). The `lag` event object does record which — `{type: "lag", dev:
  "SWA", lag: "1", members: ["Fa0/1","Fa0/2"], picked: "Fa0/1", vlan: 1}` — but two caveats sit between
  that object and a reader: the event is emitted only when the group has **more than one** usable member,
  so a bundle down to a single live port forwards silently; and `show logging lag` renders it as
  `vlan 1`, so the console never names the member and offers no option to (`--json` and `count` are both
  `% Unknown option` / `% Unexpected argument`).
- A frame that arrived on a member is **never sent back out the same group** — `if (inLagId && lag &&
  lag.id === inLagId) continue;` at `engine/simulator.js:3659`, which is what stops a hairpin looping.

`validateLag(lag, memberPorts)` takes the group **and** the members' own properties. Errors: an unknown
`mode` (`E_LAG_BAD_MODE`), fewer than two members (`E_LAG_TOO_FEW`), a port listed twice
(`E_LAG_DUPLICATE_MEMBER`), differing member speeds (`E_LAG_SPEED_MISMATCH`, which names the rates it
found in Mbps), differing duplex (`E_LAG_DUPLEX_MISMATCH`) and a member whose `vlanCompatible` is false
(`E_LAG_VLAN_MISMATCH`). A member that is administratively down is only a **warning** —
`W_LAG_DISABLED_MEMBER`, "carries no traffic" — so a LAG with one shut member still validates, and
`selectMember()` simply never picks that member.

**None of those six codes reaches a console user.** Three separate reasons, all measured on a
`generic-switch`:

- The second argument is optional and `engine/cli.js:4539` does not pass it — `lagLib.validateLag(g)`,
  one-argument, so `ports` is `[]` and every check that reads a member's speed, duplex, VLAN or admin
  state has nothing to read. Put `Fa0/1` at `speed 100`, add a 100M and a 1G port to channel group 1 and
  the console prints the two `Interface … added to channel group 1 (LACP active)` lines and nothing else;
  the same group validated with port data reports `E_LAG_SPEED_MISMATCH`, *"member speeds differ
  (100/1000 Mbps); all members must run at the same link speed."* Validated the way the console does it,
  `errors` is `[]`.
- `E_LAG_TOO_FEW` is filtered out of the message on purpose, because every bundle is short of members the
  moment its first port is added.
- The other two need a malformed group, and the CLI normalises the group before validating it: the mode
  word comes from the parser (`channel-group 1 mode bogus` → `% Invalid mode: bogus (use
  active|passive|on)`) and overwrites whatever the group held — a JSON-authored `mode: "bogus"` becomes
  `lacp-active` on the next port add — while a member already listed is not added twice, so a duplicate
  is reported as a second `Interface … added` line and `show etherchannel` still lists the port once.

So the branch that would print one of them (`% Warning: …`, first remaining error only, `E_` or not) does
not fire in any console session; the checks are live for direct library and test calls, which do pass port
properties (`test/lag.test.js`). Treat the codes as a library contract, not as console output.

## 7. Spanning tree (802.1D) — enforced in the data path

`engine/stp.js` — `runStp({bridges})` performs a deterministic root election and
returns per-port roles (`root` / `designated` / `alternate`) and states
(`forwarding` / `blocking`), plus the list of blocked ports. The shape is worth having exactly, because
`root` is not a bridge key:

```
{ root:    { priority, mac },                 // the winner, named by priority and MAC - not by key
  ports:   { <bridgeKey>: { <portName>: { role, state, cost } } },
  blocked: [ … ] }
```

Same input gives byte-identical JSON on a second call. Bridges are indexed by `key` and the **first**
definition of a duplicated key wins, so a later duplicate is ignored rather than merged or refused. Empty
input is not an error: it answers `{ root: { priority: 32768, mac: null }, ports: {}, blocked: [] }` — a
root object whose `mac` is `null`, which a caller must not dereference.

`Simulator.computeStp()` builds the bridge graph from the live topology (including
LAG collapsing) and is run before every ping — `ping()` at `engine/simulator.js:758` and `ping6()` at
`:2623`, each after `reset()` — as well as from `refreshControlPlanes()` (`:479`) and, on any cable
change, `recomputeStp()` (`:688`). Blocked ports **drop both ingress and
egress traffic** (`stp-block` events), which is what turns a physical loop into a
working topology instead of a broadcast storm.

Check it from the console. Two Catalyst 2960s wired twice — `Fa0/1`↔`Fa0/1` and `Fa0/2`↔`Fa0/2`, a
loop someone built by accident — settle into one forwarding path and one blocked port. Measured on a
freshly created board, with nothing run on it yet:

```
Catalyst 2960-d1>show spanning-tree
Spanning tree enabled protocol ieee
  Root bridge: priority 32768, 02:00:00:00:00:00 (Catalyst 2960-d1)
  This bridge: Catalyst 2960-d1 priority 32768, 02:00:00:00:00:00   (this bridge is the root)
Port   Role        State       Cost
Fa0/1  designated  forwarding  200000
Fa0/2  designated  forwarding  200000

Catalyst 2960-d2>show spanning-tree
Spanning tree enabled protocol ieee
  Root bridge: priority 32768, 02:00:00:00:00:00 (Catalyst 2960-d1)
  This bridge: Catalyst 2960-d2 priority 32768, 02:00:00:00:01:00   root path cost 200000
Port   Role       State                         Cost
Fa0/1  root       forwarding                    200000
Fa0/2  alternate  blocking   (traffic dropped)  200000
  Fa0/2 is alternate: Catalyst 2960-d1 reaches the root for 0, this bridge for 200000
```

The switch that is not the root blocks the second path — `alternate`/`blocking`, with
`(traffic dropped)` spelled out, because a reader should not have to know what `BLK` implies, and a
closing line saying *why* the port lost: what the root's path to itself costs against this bridge's.
The root keeps both of its ports `designated`/`forwarding`; the loop is broken on one side, which is
all STP needs. Both tables carry the root bridge's priority and MAC, this bridge's own bridge id and
either `(this bridge is the root)` or the root path cost, and a `Cost` column.

**The table is computed when you ask for it, not when something runs.** Running a `show` refreshes the
control planes first (`engine/cli.js:9283-9297`), so a freshly created board answers in full — the
transcript above was taken before any ping. Two answers that are *not* a table, and both are about
wiring rather than timing:

```
Catalyst 2960-d1>show spanning-tree          # an L2 switch with nothing bridged
Spanning tree enabled protocol ieee
  Root bridge: priority 32768, 02:00:00:00:00:00 (Catalyst 2960-d1)
  This bridge: Catalyst 2960-d1 priority 32768, 02:00:00:00:00:00   (this bridge is the root)
  No bridged ports: this device is not part of any L2 loop.

PC-d2>show spanning-tree                     # a device that does not bridge
% PC-d2 does not bridge, so it runs no spanning tree
% A host sends everything to its default gateway and never forwards
% The L2 view on a switch is "show spanning-tree"
```

---

## 8. Adding a new medium

1. Add an entry to `MEDIA` in `engine/media.js` (family, connector, speed, reach).
2. Add it to the relevant `CAGE_MEDIA` entry so ports expose it.
3. Add a test to `test/validation.test.js` covering the new compatibility case.
4. If the medium belongs to a family the drawing does not know, add it to the UI too — see below.

The API needs nothing: `server/index.js` reads `MEDIA` at request time, so `/api/…` answers about the new
medium as soon as it exists. **The UI is not dynamic**, though, and "no other code changes are required"
was too strong:

- `web/canvas.js` holds `MEDIUM_RULES`, a hand-written list of nine regular expressions mapping a media id
  to a colour family, and `web/app.js` holds `CABLE_FAMILIES`, the same nine ids with legend labels —
  measured, both nine, same set. `web/style.css` styles `.link-<family>` and the matching
  `.lg-row.link-<family>` swatch.
- A medium that matches no rule still works — it draws in the default slate `stroke: #3c4a63` with
  `data-medium="unknown"` — but it gets no colour and no legend row, which is already true of 28 of the 89
  media. Adding a *new* family means editing all three files; adding an id to an existing family means
  editing the one regex list (and, if the id should be listed, nothing else).

So the honest version is: nothing breaks, and nothing shows either.

## Protocol families

A cage decides what physically mates; the medium decides what protocol the link carries. Ethernet
and Fibre Channel share the SFP socket family and share nothing else, so FC has its own cages and
its own rate ladder, and an FC-to-Ethernet cable is refused by name. See
[FIBRE-CHANNEL.md](FIBRE-CHANNEL.md).
