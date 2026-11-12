# Connectors, Cages and Ferrule Polish

**A port is a cage plus a set of media. A cable is legal only when the two cages
mate, the two ports share a medium, and a common line rate exists.** This
document is the reference for that model: every cage the engine knows, what each
one physically accepts, why some cables are refused, and how to add a new
connector family without breaking the ones already modelled.

All of it lives in two files:

| File | Holds |
|------|-------|
| `engine/media.js` | `MEDIA`, `CAGES`, `CAGE_ALIAS`, `CAGE_MATE`, `CAGE_MEDIA`, `CAGE_SPEEDS`, `FERRULE`, `inferCage`, `derivePortHardware`, `commonMedia`, `commonMediaBridged`, `negotiateSpeed`, `canMate`, `polishMismatch` |
| `engine/optical.js` | the ODN catalogue, `patchCords`/`patchCord`, `hybridCord`, `cordFits`, `cordLossDb`, and `ponBudget` |
| `engine/validation.js` | `validateConnection`, `validateTopology`, the `RULES` catalogue of error codes |

`engine/media.js` is pure data plus pure functions — no dependency on `Device` or
`Topology` — so it can be required from the engine, the server or a test.

---

## 1. Vocabulary

| Term | Meaning | Where it is defined |
|------|---------|---------------------|
| **Cage** | The physical socket fitted to the box: `rj45`, `sfp+`, `qsfpdd`, `sc-apc`, `coax`, `antenna`… A cage is hardware, not a protocol. | `CAGES` (26 entries) |
| **Medium** | The cable, optic, DAC or radio band that goes *in* the cage: `10gbase-lr`, `dac-100g`, `gpon-sc-apc`, `wireless-5`. | `MEDIA` (89 entries, 9 families: copper, fiber, fibre-channel, coax, dsl, powerline, dac, console, wireless) |
| **Mate** | Two cages are physically able to accept each other. | `CAGE_MATE` / `cagesMate()` |
| **Ferrule** | The precision ceramic sleeve at the end of a fibre connector. Has a *shape* (SC, LC, MPO) and a *polish* (UPC flat, APC angled 8°). | `FERRULE` / `ferrule()` |
| **Port hardware** | The derived descriptor hung on every interface: `{ cage, cageName, family, media[], speedCaps[], maxSpeedMbps, poeOut, poeIn }`. | `derivePortHardware()` |

Two cages with the same shape but a different polish are a *polish* mismatch;
two cages with different shapes are a *connector* mismatch. The engine keeps
those apart because "wrong patch lead, swap it" and "these two things cannot ever
connect" are different mistakes. See section 4.

---

## 2. The twenty-six cages

Family is the value the engine reports in `port.hardware.family`. The
`combo`, `coax`, `dsl`, `powerline` and `management` values are the
subscriber/management families, and `fibre-channel` marks the four FC cages;
the UI groups them as copper / combo / fibre / console / other.

**The Speeds column is what media in that cage can carry — not `CAGE_SPEEDS`.** The engine's
`CAGE_SPEEDS` map is only the fallback for a port that declares neither `speedCaps` nor a rate
label. Every cage has an entry, but the entries are three different shapes, and the difference is what
makes `CAGE_SPEEDS['sfp28']()` look like a missing row:

| Shape | Count | Cages | Behaviour |
|---|---|---|---|
| fixed list | **13** | `sfp`, `sfp+`, `qsfp+`, `qsfp28`, `qsfp56`, `sfp56`, `xfp`, the four FC cages (`fc-sfp`, `fc-sfp28`, `fc-sfpdd`, `fc-qsfp28`), `console`, `usb` | same answer at any rating — `sfp+` is `[1000, 10000]` |
| rating-filtered | **11** | `rj45`, `combo`, `sfp28`, `qsfpdd`, `sc-apc`, `sc-upc`, `lc-upc`, `lc-apc`, `coax`, `dsl`, `powerline` | a ladder clamped to the port's rate, so **called with no rate it returns `[]`** — `sfp28(25000)` is `[1000, 10000, 25000]`, `qsfpdd(100000)` is `[40000, 100000]` |
| echoes the rating | **2** | `wwan`, `antenna` | `[1000]` at 1G, `[400000]` at 400G — neither can name a medium |

So an empty `CAGE_SPEEDS['sfp28']()` means "you did not tell me the rating", not "this cage has no default".

Two things about that classification cost a probe each, so they are worth writing down beside it. First,
`antenna` belongs in the echo row, not the filtered one: `engine/media.js:750` is `function (maxMbps) { return
maxMbps > 0 ? [maxMbps] : []; }`, a rating under another name, exactly like `wwan` at `:646` — the only
difference being the zero guard (`wwan(0)` is `[0]`, `antenna(0)` is `[]`). Second, `dsl` looks fixed if you
sample high: it returns `[24,100,300]` at every rating from 300 Mbps up, and only `1:[]`, `24:[24]`,
`100:[24,100]` show the filter. Classify a ladder by probing **below** its smallest rung, or the
rating-filtered row reads as the fixed one.
A port that declares neither `speedCaps` nor a rate label therefore gets no speed classes for those twelve,
which is the real consequence. `sfp+` is the fixed one this paragraph used to contrast it with, and the contrast
is between a fixed list and a filtered ladder — not between "has an entry" and "does not".

Two ratings are not enough to reproduce that split, which matters before anyone re-derives it. `dsl`
answers `[24,100,300]` at 1G and at 400G alike and reads as fixed; what makes it filtered is the bottom of
its ladder — `dsl(1)` is `[]`, `dsl(24)` is `[24]`, `dsl(100)` is `[24,100]`. Probe below the smallest rung
or a clamped ladder files itself under fixed. `sfp28` has the same shape one rung up: `[1000]` at 1G,
`[1000,10000]` at 10G.

It is **not two** `CAGE_SPEEDS` classes that name a rate no medium in that cage carries — it is eight cages'
worth, and they are why this table's Speeds column is derived from the media instead. Comparing
`CAGE_SPEEDS[cage](rating)` against the `speedMbps` of every id in `CAGE_MEDIA[cage](rating)`, at three
ratings:

```
rated 1G      sfp 2500 · sc-apc 100,1000 · wwan 1000
rated 10G     sfp 2500 · sc-apc 100,1000,1244 · lc-upc 1000,1244 · lc-apc 1000,1244
              sc-upc 1244 · coax 5000 · antenna 10000 · wwan 10000
rated 100G    the same, plus lc-upc/lc-apc 10000,25000 and antenna/wwan 100000
```

That block is one command; it compares every cage's `CAGE_SPEEDS` ladder with the `speedMbps` of the media
that cage can actually carry, at three ratings:

```sh
node -e "
const m = require('./engine/media'), S = m.CAGE_SPEEDS, M = m.CAGE_MEDIA, MEDIA = m.MEDIA;
const speed = id => { const v = (MEDIA[id] || {}).speedMbps; return Array.isArray(v) ? v : (v === undefined ? [] : [v]); };
for (const rating of [1000, 10000, 100000]) {
  const row = [];
  for (const c of Object.keys(m.CAGES)) {
    if (!S[c] || !M[c]) continue;
    const carried = new Set([].concat.apply([], (M[c](rating) || []).map(speed)));
    const missing = (S[c](rating) || []).filter(v => !carried.has(v));
    if (missing.length) row.push(c + ' ' + missing.join(','));
  }
  console.log('rated ' + rating / 1000 + 'G: ' + row.join(' | '));
}
"
```

`1244` is not a typo and does appear in `MEDIA` — as the **upstream** rate, `upstreamMbps: 1244` on
`gpon-sc-apc`, `gpon-sc-upc`, `gpon-lc-upc` and `gpon-sc-hybrid`, which is why the PON cages list it beside
2488/9953 downstream. `5000` appears in `MEDIA` only as `5gbase-t` (copper) and `wireless-60` (a radio),
neither of which is a coax run. `antenna` and `wwan` are a third case: their `CAGE_SPEEDS` echoes the port's
own rating rather than naming a medium, so it can never be filled by one. The `lc-*` gaps are the rating
filter doing its job — those cages supply exactly one Ethernet optic per rating and list all four.


| Cage | Name | Family | Mates with | Media it can carry | Speed classes (Mbps) |
|------|------|--------|-----------|--------------------|----------------------|
| `rj45` | RJ45 | copper | `rj45`, `combo` | `10base-t`, `100base-tx`, `1000base-t`, plus `2.5gbase-t`, `5gbase-t`, `10gbase-t` when the port is rated that high | 10, 100, 1000 (all filtered by the port rating), plus 2500 / 5000 / 10000 when rated that high |
| `sfp` | SFP | optical | `sfp`, `sfp+`, `sfp28`, `sfp56`, `combo`, `fc-sfp`, `fc-sfp28` | `1000base-sx`, `1000base-lx`, `1000base-ex`, `1000base-zx`, `1000base-bx-u`, `1000base-bx-d`, `1000base-t-sfp`, `dac-1g` | 1000 |
| `sfp+` | SFP+ | optical | `sfp`, `sfp+`, `sfp28`, `sfp56`, `combo`, `fc-sfp`, `fc-sfp28`, `fc-sfpdd` | `10gbase-sr`, `10gbase-lr`, `10gbase-er`, `1000base-sx`, `1000base-lx`, `1000base-bx-u`, `1000base-bx-d`, `1000base-t-sfp`, `dac-10g`, `dac-10g-active`, `aoc-10g` | 1000, 10000 |
| `sfp28` | SFP28 | optical | `sfp`, `sfp+`, `sfp28`, `sfp56`, `combo`, `fc-sfp`, `fc-sfp28`, `fc-sfpdd` | `25gbase-sr`, `25gbase-lr`, `10gbase-sr`, `10gbase-lr`, `10gbase-er`, `1000base-sx`, `1000base-lx`, `1000base-ex`, `1000base-zx`, `1000base-bx-u`, `1000base-bx-d`, `1000base-t-sfp`, `dac-25g`, `dac-10g`, `dac-1g` | 1000, 10000, 25000 |
| `combo` | Combo | combo | `combo`, `rj45`, `sfp`, `sfp+`, `sfp28` | Union of the `rj45` and `sfp` lists: the six copper media plus all eight of `1000base-sx`, `-lx`, `-ex`, `-zx`, `1000base-bx-u`, `1000base-bx-d`, `1000base-t-sfp`, `dac-1g` | 10, 100, 1000, plus 2500 / 5000 / 10000 from the copper side when the port is rated that high |
| `qsfp+` | QSFP+ | optical | `qsfp+`, `qsfp28`, `qsfpdd`, `qsfp56` | `40gbase-sr4`, `40gbase-lr4`, `dac-40g` | 40000 |
| `qsfp28` | QSFP28 | optical | `qsfp+`, `qsfp28`, `qsfpdd`, `qsfp56`, `fc-qsfp28` | `100gbase-sr4`, `100gbase-lr4`, `dac-100g`, `40gbase-sr4`, `40gbase-lr4` | 40000, 100000 |
| `qsfpdd` | QSFP-DD | optical | `qsfpdd`, `qsfp28`, `qsfp+`, `qsfp56` | `200gbase-dr4`, `200gbase-fr4`, `400gbase-dr4`, `400gbase-fr4`, `100gbase-sr4`, `100gbase-lr4`, `40gbase-sr4`, `40gbase-lr4`, `dac-100g` | 40000, 100000, 200000, 400000 (filtered by the port rating) |
| `sfp56` | SFP56 | optical | `sfp`, `sfp+`, `sfp28`, `sfp56`, `combo` | `50gbase-sr`, `50gbase-lr`, `25gbase-sr`, `25gbase-lr`, `dac-25g` | 25000, 50000 |
| `qsfp56` | QSFP56 | optical | `qsfp56`, `qsfp28`, `qsfp+` | `200gbase-dr4`, `200gbase-fr4`, `100gbase-sr4`, `100gbase-lr4`, `40gbase-sr4`, `40gbase-lr4`, `dac-100g` | 40000, 100000, 200000 |
| `xfp` | XFP | optical | `xfp` only | `10gbase-sr`, `10gbase-lr`, `10gbase-er` | 10000 |
| `sc-apc` | SC/APC | optical | `sc-apc` only | `gpon-sc-apc`, `xgspon-sc-apc` | 2488, 9953 |
| `sc-upc` | SC/UPC | optical | `sc-upc` only | `gpon-sc-upc`, `xgspon-sc-upc`, and two Ethernet optics the UPC polish allows: `100base-fx` always, `1000base-lx` from a 1G rating | 100, 1000, 2488, 9953 (filtered by rating) |
| `lc-upc` | LC/UPC | optical | `lc-upc` only | `gpon-lc-upc`, `xgspon-lc-upc`, plus one Ethernet optic chosen by rate: `1000base-lx` (≥1G), `10gbase-lr` (≥10G), `25gbase-lr` (≥25G), `100gbase-lr4` (≥100G) | 2488, 9953, plus that one Ethernet rate — 1000, 10000, 25000 or 100000 — filtered by rating |
| `lc-apc` | LC/APC | optical | `lc-apc` only | `gpon-lc-upc`, `xgspon-lc-upc`, plus one Ethernet optic chosen by rate: `1000base-lx` (≥1G), `10gbase-lr` (≥10G), `25gbase-lr` (≥25G), `100gbase-lr4` (≥100G) | 2488, 9953, plus that one Ethernet rate — 1000, 10000, 25000 or 100000 — filtered by rating |
| `fc-sfp` | SFP+ (FC) | fibre-channel | `fc-sfp`, `sfp+`, `sfp28`, `fc-sfp28`, `fc-sfpdd` | `2gfc-sw`, `2gfc-lw`, `4gfc-sw`, `4gfc-lw`, `8gfc-sw`, `8gfc-lw`, `10gfc-sw`, `10gfc-lw`, `16gfc-sw`, `16gfc-lw` | 2125, 4250, 8500, 10519, 14025 |
| `fc-sfp28` | SFP28 (FC) | fibre-channel | `fc-sfp28`, `fc-sfp`, `sfp28`, `sfp+`, `fc-sfpdd` | `32gfc-sw`, `32gfc-lw`, `16gfc-sw`, `16gfc-lw`, `8gfc-sw`, `8gfc-lw` | 8500, 14025, 28050 |
| `fc-sfpdd` | SFP-DD (FC) | fibre-channel | `fc-sfpdd`, `fc-sfp28`, `fc-sfp`, `sfp28`, `sfp+` | `64gfc-sw`, `64gfc-lw`, `32gfc-sw`, `32gfc-lw`, `16gfc-sw`, `16gfc-lw` | 14025, 28050, 57800 |
| `fc-qsfp28` | QSFP28 (FC) | fibre-channel | `fc-qsfp28`, `qsfp28` | `128gfc-sw`, `128gfc-lw`, `32gfc-sw`, `32gfc-lw` | 28050, 112200 |
| `coax` | F-connector | coax | `coax` only | `moca-11`, `moca-25`, `docsis-30`, `docsis-30-us`, `docsis-31`, `docsis-31-us` — both directions of each DOCSIS generation, because a CMTS return-path port is its own rate | 175, 200, 1000, 2500, 10000 |
| `dsl` | RJ11 | dsl | `dsl` only | `adsl2plus`, `vdsl2-17a`, `vdsl2-35b` | 24, 100, and 300 when rated 300M |
| `powerline` | Mains | powerline | `powerline` only | `homeplug-av`, `homeplug-av2`, `ghn`, `ghn-25` | 200, 1000, 1700, 2500 (fixed) |
| `console` | Console | management | `console` only | `console-rs232` (115200) plus the fixed-baud variants `console-rs232-9600`, `-19200`, `-38400`, `-57600` | 0.0096, 0.0192, 0.0384, 0.0576, 0.1152 (9600 – 115200 baud) |
| `usb` | USB | management | `usb` | `usb-console` | 12 |
| `antenna` | Antenna | wireless | `antenna` only | `wireless-2.4`, `wireless-5`, `wireless-6`, `wireless-7` by the port's generation, from `wireless-2.4` alone at 600 Mbps up to all four above 2500; `wireless-60` from a declared `band: "60"` or — the path the catalogue uses — from a model or description naming 60 GHz, 802.11ad or wigig, which replaces the ladder (see 4.6) | the port's declared rate |
| `wwan` | Cellular | wireless | **nothing** | `lte`, `lte-a`, `5g-sub6`, `5g-mmwave` | the modem's own category |

That is **26 cages**. `CAGES` is the authority; if you add one, this table and
the tests in section 8.3 are what has to change with it.

Two of those 26 carry **no port on this tree** — `lc-apc` and `usb` — so a sweep that counts the cage each
port *derives* gets **24**, and `docs/UPSTREAM-DESIGN.md` quotes that 24. Both are right: 26 kinds exist,
24 are in use, and a page that says "24 cages" without saying which question it asked is quoting a
measurement rather than the model.

The **Mates with** column is `CAGE_MATE[cage]` verbatim, and `cagesMate(a, b)` is the function that answers
the same question for a pair — so it is checkable to the letter, and it was wrong in seven rows until it was
checked: the `sfp`, `sfp+` and `sfp28` rows left out `sfp56` and the three Fibre Channel cages they accept
(`fc-sfp`, `fc-sfp28`, `fc-sfpdd`), the `qsfp+`, `qsfp28` and `qsfpdd` rows left out `qsfp56`, `qsfp28` also
accepts `fc-qsfp28`, and the `usb` row claimed it mates with `console` when `cagesMate('usb', 'console')`
answers **false** — a USB port takes `usb-console` media, not a console cage directly.

```bash
node -e '
const m = require("./engine/media");
for (const c of Object.keys(m.CAGES)) console.log(c, ":", (m.CAGE_MATE[c] || []).join(", "));
console.log("usb takes a console cage?", m.cagesMate("usb", "console"));'
```

A fibre-channel cage in a copper list is not a typo in the other direction either: `cagesMate('sfp', 'fc-sfp28')`
is `true`, because a 32G FC SFP28 optic fits the same slot as a 25G Ethernet one.

Both columns were re-derived on 2026-11-12 rather than spot-checked. All **26** rows were compared **set for
set** against `CAGE_MATE` — zero mismatches, so the seven-row repair above has held — and every medium named in a
row was checked against what `CAGE_MEDIA[cage](rating)` actually offers across nine ratings from 100 Mbps to
400 Gbps: **no row names a medium its cage cannot carry**.

Two rows look wrong to a naive checker and are not. `combo` describes its media as "the six copper media plus all
eight of …" instead of listing ids, and the `console` row gives the fixed-baud variants in shorthand — `-19200`,
`-38400`, `-57600` after `console-rs232` — so a script that extracts backticked identifiers reports nine unnamed
media on the `combo` row and three on the `console` row. Expanded, the console cage offers exactly five media
(`console-rs232` at 115200 plus the four fixed bauds) and `usb` exactly one (`usb-console`). Read the shorthand as
the list, not as an omission.

**Read that table as A's view, not as a symmetric relation.** `cagesMate(a, b)` consults only
`CAGE_MATE[a]`, so a pair "mates" when the *first* cage's row names the second. Twenty-five of the
twenty-six cages have a row (`wwan` has none, so cellular mates with nothing, itself included), and four
rows are genuinely one-way: `sfp → fc-sfp`, `sfp → fc-sfp28`, `sfp56 → combo` and `qsfpdd → qsfp56`.
Measured at `7be9ef73` rather than counted by eye — every `CAGE_MATE` entry whose reverse is missing — and it
returns exactly those four and no others:

```sh
node -e 'const m=require("./engine/media");const o=[];for(const a of Object.keys(m.CAGE_MATE))for(const b of m.CAGE_MATE[a])if(!(m.CAGE_MATE[b]||[]).includes(a))o.push([a,b]);console.log(JSON.stringify(o))'
```

so the answer is `[["sfp","fc-sfp"],["sfp","fc-sfp28"],["sfp56","combo"],["qsfpdd","qsfp56"]]`. A fifth one-way
row would mean a cable that fits one way round and not the other, which reads to an operator as an
intermittent fault rather than a rule, so this list is worth re-deriving whenever `CAGE_MATE` changes.
Because `canMate(portA, portB)` is called once, in the order the link was drawn, the *reason* a cable is
refused can depend on which end you started from — `sfp → fc-sfp` passes the connector gate and is then
judged on medium and rate (`E_NO_COMMON_MEDIA`), while `fc-sfp → sfp` never gets that far and is reported
as `E_CONNECTOR_MISMATCH`, which reads like the connectors do not fit at all. When a pair surprises you,
ask in both orders:

```bash
node -e 'const m=require("./engine/media");
for (const [a,b] of [["sfp","fc-sfp"],["fc-sfp","sfp"],["sfp56","combo"],["combo","sfp56"]])
  console.log(a, "->", b, m.cagesMate(a,b));'
```

### Checking this table against the engine

There is no audit script for cages and media. Both catalogues are **functions of the port's rated
speed**, which is why the table says "gated by rating" in places and why calling them with no
argument gives nonsense (`rj45` looks empty, because every copper medium's rate is `> undefined`).
Pass a rate:

```bash
# every cage at a 100G port rating: how many media it can take, and its speed classes
node -e "const m=require('./engine/media');const v=x=>typeof x==='function'?x(100000):x;for(const c of Object.keys(m.CAGES))console.log(c.padEnd(12),(v(m.CAGE_MEDIA[c])||[]).length+' media',(v(m.CAGE_SPEEDS[c])||[]).join('/'))"

# the full media list for one cage at that rating
node -e "const m=require('./engine/media');console.log(m.CAGE_MEDIA['sfp+'](100000).join('\n'))"
```

The Media column above names what matters for a cabling decision; the commands give the computed
sets, and where they disagree the engine wins.

**Two suites pin this table, and neither is a mirror of the engine.** `test/cable-matrix.test.js` runs a
75-row cage × cage verdict table against real catalogue hardware — 37 `accept`, 26 `refuse`,
3 `accept:downshift`, 2 `refuse:polish`, 7 `refuse:protocol`, plus a catch-all `['<cage>', '*', 'refuse']`
row for 25 of the 26 cages — and drives every one of the **351** unordered cage pairs (this tree: 40 accepted,
311 refused, 0 verdict divergences, `351 passed`). It is a specification, not a snapshot: when the engine
disagrees it names the pair and the fix is not "edit `media.js` until it goes green". The figures above are
the suite's own — `node test/cable-matrix.test.js` prints `accepted by engine   : 40`, `refused by engine    :
311` and `351 passed, 0 failed`, so the sentence can be checked without being trusted.
`test/cage-media-resolves.test.js` owns the other half — every id any cage offers, at every rate it might be
asked about, must resolve to a real `MEDIA` entry, which is how an `100base-fx` that no longer existed was
caught.

`qsfp56` is the one cage with no catch-all row of its own, so its pairs are decided by the *other* cage's
wildcard. That still checks the verdict but cannot pin the **reason**, and there is a pair where the reason is
the whole story:

```
CAGE_MATE.qsfp+   ['qsfp+', 'qsfp28', 'qsfpdd', 'qsfp56']
CAGE_MATE.qsfp56  ['qsfp56', 'qsfp28', 'qsfp+']
commonMedia(QSFP56 port, QSFP+ port)  ['40gbase-sr4', '40gbase-lr4']
canMate(...)  { ok: false, code: 'E_NO_COMMON_SPEED',
                message: 'No common speed between QSFP56 and QSFP+ (A: 50000/100000/200000, B: 40000).' }
```

The cages mate in both directions and two 40G media sit in both lists, and the cable is refused anyway: the
catalogue's QSFP56 ports train at 50G and above, its QSFP+ ports at 40G, so the shared set is empty. Mating is
necessary, not sufficient — which is why the `qsfp+` row above lists `qsfp56` under "Mates with" even though no
lab built from this catalogue can cable that pair.

The XGS-PON media are **gated by rating, like everything else here**, which once read as a
disagreement: `xgspon-sc-apc`, `xgspon-sc-upc` and `xgspon-lc-upc` seemed to be missing from
`CAGE_MEDIA` for the `sc-*` and `lc-*` cages. They are not — they appear once the port is rated for
them, and the threshold is a 10G-class rating:

| rating asked | `sc-apc` | `sc-upc` | `lc-upc` |
|---|---|---|---|
| `1000` | `gpon-sc-apc` | `gpon-sc-upc`, `100base-fx`, `1000base-lx` | `gpon-lc-upc`, `1000base-lx` |
| `9953` or `10000` | + `xgspon-sc-apc` | + `xgspon-sc-upc` | + `xgspon-lc-upc`, `100gbase-lr4` |

Asking at a 1G rating is what produced the "engine gap": a 2.5G PON port legitimately cannot carry an
XGS-PON optic. `gpon-sc-hybrid` and `xgspon-sc-hybrid` are the two media **no cage returns at any
rating** — they belong to a hybrid patch cord rather than a socket, which is why they appear in
`optical.hybridCord()` and in the assemblies table instead of here.

The four `fc-*` cages are the Fibre Channel ones: same shell widths as their Ethernet
counterparts, different protocol, and they intermate with the Ethernet cages of the same width so a
real FC HBA in an SFP+ port is representable. See [FIBRE-CHANNEL.md](FIBRE-CHANNEL.md).

`wwan` is the odd one out: it mates with nothing at all, including itself. A cellular modem
connects to a base station, not to a patch lead, so a lab with two 5G CPEs in it has two
subscribers to a network neither of them contains — not a cable between them. It sits in the
`wireless` family so it carries no power, and it is a separate cage from `antenna` so the
link inspector can say which kind of radio a box has instead of calling every radio a Wi-Fi
radio (issue #129).

### Reading the table

- **`rj45` is not a synonym for "ethernet".** It is one cage among twenty-six. A
  10GBASE-T port is `rj45`; a 10GBASE-SR port is `sfp+`. Only the cage decides
  what plugs in.
- **The SFP family intermates across rates.** `sfp`, `sfp+` and `sfp28` all mate
  with each other in both directions, because a slower module fits a faster
  cage. What stops a 25G module in an SFP cage is the *medium and speed*
  intersection, not the connector — the 25G optics are simply not in the SFP
  cage's media list.
- **QSFP and SFP never mix.** `qsfp+`, `qsfp28` and `qsfpdd` mate among
  themselves; none of them mates with the SFP family. Different shell width.
- **The four PON cages mate only with themselves.** `sc-apc` will not meet
  `sc-upc`, and `lc-apc` will not meet `lc-upc`. That is the polish rule
  (section 4.2).
- **`lc-upc` and `lc-apc` carry identical media.** Both offer the PON media plus
  one Ethernet optic chosen by the declared rate (LR/LX variants, which really do
  terminate in LC), and neither medium id says "APC". Polish exists only in the
  cage and in `FERRULE`; `CAGE_MATE` refuses the pair before any medium is
  considered, so the enforcement is real even though the ids look identical.
- **LC is a connector, not a protocol.** A port whose spec says
  `"connector": "lc"` is aliased to `lc-upc` (the flat, blue, ubiquitous variant)
  rather than becoming a third, unmateable cage. Model APC explicitly as
  `lc-apc`.
- **`combo` speed classes stop at 10G** even when the port is rated higher, and
  they never include 2.5G/5G even though the media list offers those optics.
  Model a 2.5G combo port as its own cage rather than relying on this list.

### Speeds are the cage's, then the port's

`CAGE_SPEEDS` gives the *cage* its speed classes, and `derivePortHardware` calls
it with the port's declared rate. Rate-agile cages (`rj45`, `combo`, `qsfpdd`,
the PON cages, `coax`, `dsl`) filter their list with `maxMbps`; fixed-rate cages
(`sfp`, `sfp+`, `sfp28`, `qsfp+`, `qsfp28`, `powerline`, `console`, `usb`)
ignore it entirely. Final link speed is then:

```
speed = max(intersection(portA.speedCaps, portB.speedCaps))
speed = min(speed, chosenMedium.speedMbps)
```

The second clamp is why a 10G port pair with a `1000base-t-sfp` selected runs at
1000 Mbps, not 10000. "Both cages could do 10G" is not enough — the glass in the
cage decides.

Because the fixed lists ignore the port's rating, **an unqualified spec can
advertise more than its port can run**: a port declared `"speed": "10G"` with
`"connector": "sfp28"` gets `speedCaps: [10000, 25000]` and negotiates 25G
against an identical port, even though its own `maxSpeedMbps` is 10000. This is
why catalogue uplinks declare `speedCaps` explicitly:

```json
{ "name": "xe1/1", "type": "ethernet", "speed": "10G",
  "connector": "sfp28", "speedCaps": [10000, 25000] }
```

If the datasheet says the port is 10G only, say so with `speedCaps: [10000]`;
`CAGE_SPEEDS` will not do it for you.

---

## 3. Where cage inference comes from

Device specs stay terse: `{ "name": "Gi1/1/1", "type": "ethernet", "speed": "10G" }`.
`derivePortHardware` picks the cage in this order:

```
spec.cage  ->  spec.connector  ->  inferCage(spec, maxMbps)
```

so a spec can always name its own connector, and `"connector": "sfp+"` is the
usual way. Before the cage is used, `derivePortHardware` normalises it twice:

- **Aliases.** `CAGE_ALIAS` maps bare connector tokens that are really cages onto
  the cage they mean. Today that is one entry, `lc` → `lc-upc`, because a
  datasheet says "LC" and a cage has to carry a polish.
- **Unknowns.** A cage that is not a key of `CAGES` stays as it is, but with
  `family: 'unknown'`, no media, no speed caps and no mates — so every cable
  touching it is refused with `E_CONNECTOR_MISMATCH` naming the raw token. It is
  never silently reinterpreted as RJ45.

When the spec is silent, `inferCage` decides by **name first, then speed**:

1. `type` decides outright for the non-ethernet families: `wireless`/`radio` →
   `antenna`, `console` → `console`, `usb` → `usb`, `coax` → `coax`,
   `dsl`/`adsl`/`vdsl` → `dsl`, `powerline`/`plc`/`mains` → `powerline`.
2. The name decides console and USB: `/console|con\d|tty|aux/` → `console`,
   `/usb/` → `usb`.
3. The name decides fibre connectors, and it is checked **before** the generic
   PON fallback: `sc/apc` → `sc-apc`, `sc/upc` → `sc-upc`, `lc/apc` → `lc-apc`,
   `lc/upc` → `lc-upc`, then any PON-ish name (`gpon`, `xgspon`, `pon1`,
   `pon`) → `sc-apc`.
4. Otherwise the port is optical if the name looks optical
   (`sfp|qsfp|xfp|cfp|xe-|et-|fc\d`) **or** the declared speed is 25G, 40G or
   100G; if not, it is `rj45`.
5. Among optical ports, a name containing `qsfpdd` wins outright, then the rate
   grades it: ≥200G `qsfpdd`, ≥100G `qsfp28`, ≥40G `qsfp+`, ≥25G `sfp28`,
   ≥10G `sfp+`, otherwise `sfp`.

Two consequences worth knowing:

- **A 200G port with no connector in its spec becomes `qsfpdd` by rate alone**,
  and a 100G port becomes `qsfp28`. That is how most uplinks in the catalogue
  are modelled — correctly, as long as the rate in the spec is the truth.
- **A missing `speed` means 1G** (`parseSpeedMbps(spec.speed) || 1000`), which
  means a port with no speed and no connector is RJ45 at 1G. If a fibre port
  comes out copper, the first thing to check is a typo in the port name — the
  name is the only hint the deriver has.

---

## 4. What will not mate, and why

`canMate` answers in a fixed order and returns the **first** verdict. Seven gates, in this order:

1. either port is missing → `E_NO_PORT`
2. `antenna` against anything that is not `antenna` → `E_WIRELESS_TO_WIRED`; two `antenna` ports pass
   this gate and mate on whatever bands they share
3. a console/USB-only port against a data port → `E_PROTOCOL_MISMATCH` — the message names both sides
   ("`Console is an out-of-band management console and RJ45 is a data port`"), so read it before assuming
   a connector problem
4. `cagesMate()` fails and the polishes differ → `E_POLISH_MISMATCH`
5. `cagesMate()` fails → `E_CONNECTOR_MISMATCH`
6. no shared medium → `E_NO_COMMON_MEDIA`
7. no common speed → `E_NO_COMMON_SPEED`

Gates 1–3 are not about connectors at all, which is why they come before `cagesMate()`: asking the
connector question about two radios, or about a console port, would answer the wrong thing. Measured:
a console port against `rj45` is `E_PROTOCOL_MISMATCH`, `rj45` against a missing port is `E_NO_PORT`, and
`antenna` against `antenna` is `ok: true` with `media: ["wireless-2.4","wireless-5"]`.

The order is observable rather than implied, which takes pairs where two gates would both apply. An
`antenna` port against a console port answers `E_WIRELESS_TO_WIRED`, not the `E_PROTOCOL_MISMATCH` the
console rule would give — gate 2 speaking before gate 3. A console port against an SFP28 answers
`E_PROTOCOL_MISMATCH`, not the `E_CONNECTOR_MISMATCH` that `cagesMate()` would give — gate 3 before gate 5.
And gate 6 is reachable **inside one cage**: two `antenna` ports on different bands, a 60 GHz radio against
a 2.4/5 GHz one, pass gate 2 and land on `E_NO_COMMON_MEDIA` with `No shared medium between Antenna and
Antenna.` — the same-code answer for a pair whose cages mate and whose polishes match.

The whole table was re-run against `canMate()` on 2026-11-12, by building hardware the way
`derivePortHardware()` does — `{ cage, cageName, media: CAGE_MEDIA[cage](maxMbps), speeds: CAGE_SPEEDS[cage](maxMbps) }` —
and calling the engine directly rather than through a lab:

| Pair (rate caps) | Verdict |
|---|---|
| `rj45` ↔ `sfp+`, `sfp`, `sfp28`, `qsfp28` | `E_CONNECTOR_MISMATCH` on all four |
| `sc-apc` ↔ `sc-upc`, `lc-apc` ↔ `lc-upc` | `E_POLISH_MISMATCH`, message naming both polishes |
| `lc-upc` ↔ `sc-upc` | `E_CONNECTOR_MISMATCH` — different ferrule, so gate 5 not gate 4 |
| `sfp28` ↔ `qsfpdd`, `qsfp28` ↔ `sfp+`, `xfp` ↔ `sfp+` | `E_CONNECTOR_MISMATCH` |
| `antenna` ↔ `rj45`, `antenna` ↔ `wwan` | `E_WIRELESS_TO_WIRED` — `wwan` is a wired port with a radio medium, not a radio |
| `dsl` ↔ `coax`, `powerline` ↔ `rj45` | `E_CONNECTOR_MISMATCH` |
| `qsfpdd` ↔ `qsfp28` / `qsfp+` / `qsfp56` | **`ok: true`** — `CAGE_MATE.qsfpdd` is `['qsfpdd','qsfp28','qsfp+','qsfp56']`, exactly as §4.4 quotes |
| `combo` ↔ `rj45`, `combo` ↔ `sfp` | `ok: true` — `CAGE_MATE.rj45` is `['rj45','combo']`, matching §4.1 |
| `sfp` ↔ `sfp`, `sfp+` ↔ `sfp28`, `coax` ↔ `coax` | `ok: true`, with six DOCSIS/MoCA media shared in the coax case |
| `usb` ↔ `usb` | `ok: true`, `media: ["usb-console"]` — a USB console is still a console, so gate 3 lets it through |

One practical trap when writing such a probe: `canMate()` reads **`speedCaps`**, not `speeds`, when it
negotiates, so a hand-built `{ cage, media, speeds }` throws instead of returning a code — and which line
you see depends on which side the object occupies. Passed **second**, it is
`TypeError: pb.speedCaps is not iterable` at `media.js:1167`; passed **first**, it is
`TypeError: Cannot read properties of undefined (reading 'filter')` at `media.js:1168`, because by then the
second port's caps have already been turned into a lookup set. Only the far-side message names the missing
field; the near-side one does not, which is what makes the trap expensive when it bites there. Set both
fields, or take the object from `derivePortHardware()`, which always has them.

| Refused pair | Code | Reason |
|--------------|------|--------|
| RJ45 into an SFP/SFP+/SFP28/QSFP cage | `E_CONNECTOR_MISMATCH` | Copper plug cannot enter a module cage |
| Fibre optic into an RJ45 socket | `E_CONNECTOR_MISMATCH` | The socket has no cage to hold a ferrule |
| SC/APC into SC/UPC, LC/APC into LC/UPC | `E_POLISH_MISMATCH` | Same ferrule shape, incompatible endface angle |
| LC into SC (any polish) | `E_CONNECTOR_MISMATCH` | Different ferrule shape |
| SFP28 into QSFP-DD, QSFP28 into SFP+ | `E_CONNECTOR_MISMATCH` | Different shell size |
| Antenna into anything wired | `E_WIRELESS_TO_WIRED` | A radio has no cable |
| Two radios on different bands | `E_NO_COMMON_MEDIA` | They mate, but share no radio band |
| Console into a data port | `E_PROTOCOL_MISMATCH` | Management only — but see the note below about the *other* console code |
| Combo RJ45 half while the SFP half is cabled | not `canMate`'s answer — see below | One physical position, two logical ports |

Two of these refusals come from somewhere else, and the distinction matters when you are reading a
transcript:

| Code | Produced by | When you meet it |
|---|---|---|
| `E_PROTOCOL_MISMATCH` | `canMate()`, `engine/media.js` | Trying to build the cable at all |
| `E_CONSOLE_TO_DATA` | `validateTopology()`, `engine/validation.js` | The link exists; the lab itself is being checked |
| `E_COMBO_OCCUPIED` | `connect()`, `engine/topology.js` | The second half of a combo port is being cabled |

So a console cable can fail with two different codes depending on whether you asked `canMate` first or
loaded a board that already contains the link. Neither is wrong; they answer different questions.

### 4.1 Copper into an optical cage, and fibre into RJ45

The commonest refusal, and the one that is always correct. `CAGE_MATE.rj45` is
`['rj45', 'combo']`; no optical cage lists `rj45`. The reverse fails the same
way — an `sfp+` port against `rj45` finds no entry either.

There is a deliberate distinction inside the optical world that trips people up:
`1000base-t-sfp` is the **copper SFP module**, and it *is* legal in `sfp` and
`sfp+` cages. Bare `1000base-t` — RJ45 copper cabling — is deliberately absent
from those media lists, because including it once let two fibre cages be joined
by a copper run. If you need copper at the far end of an SFP link, the medium is
`1000base-t-sfp`; if you need copper *cabling*, the port is `rj45`.

### 4.2 SC/APC into SC/UPC, and LC/APC into LC/UPC

An APC ferrule is ground at an **8° angle**; a UPC ferrule is flat. Push the two
together and the endfaces meet along one edge only, leaving an **air gap** across
the core. The glass/air boundary reflects roughly 4 % of the light straight back
down the fibre into the transmitter — the very reflection the angled polish
exists to deflect into the cladding. In practice that costs about **3 dB** of
loss, destabilises the laser, and the spring load on the single contact edge can
**chip the endface**. It is not a marginal link; it is a damaged connector.

So `sc-apc` lists only `sc-apc`, `sc-upc` only `sc-upc`, and the same for the LC
pair. `FERRULE` carries the geometry that lets the engine say *why*:

```js
'sc-apc': { shape: 'sc', polish: 'apc', colour: 'green', angleDeg: 8 },
'sc-upc': { shape: 'sc', polish: 'upc', colour: 'blue',  angleDeg: 0 },
'lc-apc': { shape: 'lc', polish: 'apc', colour: 'green', angleDeg: 8 },
'lc-upc': { shape: 'lc', polish: 'upc', colour: 'blue',  angleDeg: 0 },
```

`polishMismatch(a, b)` is true only when `fa.shape === fb.shape` **and**
`fa.polish !== fb.polish`. Anything else falls through to the generic connector
mismatch, which is why SC against LC/APC is `E_CONNECTOR_MISMATCH` and not a
polish error.

Field conventions for the colours are enforced only by comment and by the
`colour` field: green is APC, blue is UPC, aqua is MPO. Use the colour as your
sanity check when reading a datasheet — an OLT "green SC" port is APC.

#### The hybrid cord: the one legal way across

Real OLT-to-ODN plant is *made* of this mismatched pair. Vendor OLT PON modules
ship SC/UPC (FS `GSFP-43-20C`, `XGS-SFP-52-20N2I`) while the ODN side is SC/APC,
and what joins them is a **hybrid patch cord** — a factory-terminated assembly
with UPC on one end and APC on the other. The polish change happens inside the
lead, between two ferrules ground to match each other, so there is no air gap and
nothing to chip.

The engine models that as a **part**, not as a looser rule:

```js
optical.hybridCord('sc-upc', 'sc-apc')   // -> the SMSCSX catalogue entry
optical.hybridCord('sc-apc', 'sc-upc')   // -> the same entry (order does not matter)
optical.hybridCord('sc-apc', 'sc-apc')   // -> null: a matched pair needs no cord
```

### The UI's part picker is a snapshot of the catalogue, and it can be behind

The engine reads `catalogue/optics/transceivers.json`; the browser cannot. That directory sits outside the
static root the UI is served from, so `web/app.js` carries `PART_ROWS` — a hand-kept copy that becomes
`opticParts` for the picker and backs `partsForMedia()`. Adding a transceiver to the catalogue therefore
does **not** add it to the picker; someone has to append it, and `test/link-parts.test.js` is what says so.
It asserts three things about the copy: the same number of parts, the same field values, and no part the
catalogue does not list.

Read the current count rather than trusting this paragraph:

```bash
node test/link-parts.test.js | grep 'carries every catalogue part'
# the UI carries every catalogue part (34 of 58)      <- red, 24 behind, measured
```

The 24 that are missing are worth sorting before hunting for one in the picker: **all three** QSFP-DD parts
(`QSFP-DD-400G-SR8`, `-DR4`, `-FR4`) and **both** QSFP56 (`QSFP56-200G-SR4`, `-FR4`), **ten of the twelve**
QSFP28, **four of the eight** QSFP and **five of the nineteen** SFP — the last being `SFP-25G-SR`,
`SFP-25G-SR-E`, `SFP-10G-SR1`, `SFP-10G-SR-E` and `SFP-10G-iLR`. A 400G or 200G module is therefore never
offered, while no family is uniformly absent: two QSFP28 and four QSFP rows are in the copy, so the picker
can offer one 100G part and not its sibling. Those optics are perfectly valid in a spec — `cagesMate()` and
`canMate()` do not consult the picker — so the practical effect is a working lab you cannot build through
the UI, which is the kind of gap a reader looks for in a page like this one rather than in a red test.

`hybridCord(a, b)` only answers for the same shape with different polishes, and
only when `catalogue/optics/odn.json` actually contains a cord terminated that
way. A link then *declares* the part:

```js
topo.connect(olt.id, 'gpon0/1', sp.id, 'uplink', { lengthM: 2000, patchCord: 'SMSCSX' });
```

`validateConnection` returns `ok: true`, `polishWeakened: true`,
`patchCord: 'SMSCSX'`, `patchCordLossDb: 0.3`, the medium `gpon-sc-hybrid` (the
cord, not one polish), and a `W_HYBRID_CORD` warning. The 0.3 dB is the cord's
published insertion loss and is added to the PON budget.

Re-run on 2026-11-12 through `Topology.connect()` against **catalogue** ports rather than hand-built
objects, because a hand-built port hides exactly the fields that decide this: `allied-telesis/AT-MC102XL`
`scupc1` against `ubiquiti/UF-Instant` `gpon0` throws `E_POLISH_MISMATCH` and its message names the cord
(*"A hybrid patch cord (SMSCSX, sc-upc to sc-apc, 0.3 dB insertion loss) joins these two polishes: declare it
on the link …"*), and the same pair with `{ patchCord: 'SMSCSX' }` links, carrying `patchCord: "SMSCSX"` on the
returned link beside its ten other keys. The speed example the wiki's getting-started page offers reproduces too: an `sfp` port capped
`[100, 1000]` mated to an `sfp+` capped `[1000, 10000]` builds a link at `speedMbps: 1000`, so the "1G optic in
a 10G cage comes up at 1G" example is a measurement rather than an intention.

The five fields above were read straight off `validateConnection()` on that pair: `ok: true`,
`polishWeakened: true`, `patchCord: 'SMSCSX'`, `patchCordLossDb: 0.3`, media `gpon-sc-hybrid`, warning
`W_HYBRID_CORD`, errors empty — and, uncorded, `ok: false` with `E_POLISH_MISMATCH` and nothing else. One field
the list does not mention is worth knowing before treating the cord as a repair for a mistyped link: **`speedMbps`
comes back `null`**, and the link built from it carries `speedMbps: null` too, because these two catalogue ports
advertise `[100]` and `[1244, 2488]` — no shared class. So "the run becomes buildable" is exactly true: buildable,
not matched. A hybrid cord fixes the polish, and it does not give the span a rate.

Two things that deliberately do **not** change:

- An **uncorded** `sc-apc` ↔ `sc-upc` link is still `E_POLISH_MISMATCH`. The
  refusal now also names the hybrid part that would make it buildable.
- A cord whose ends are not the two cages in front of you is refused with
  `E_PATCH_CORD_ENDS`, and an unknown part number with `E_PATCH_CORD_UNKNOWN`.
  The cord is not a permission flag; it is a specific assembly with two specific
  endfaces, and putting one on two UPC ports is the wrong part. Measured on the
  `sc-upc` ↔ `sc-apc` pair above: `SMLCSX` (terminated `lc-upc` to `lc-apc`) is refused —
  *"SMLCSX is terminated lc-upc to lc-apc and cannot join SC/UPC (sc-upc) to SC/APC (sc-apc)"* —
  while `FCA-S2SR-SCASCU-02M`, the same two polishes terminated in the **opposite order**
  (`sc-apc` to `sc-upc`), is accepted. So the ends are compared as a **set**, not a sequence:
  a cord is not directional, and a page that described the check as "the two ends must match the
  two ports in that order" would be wrong about a part that ships in the catalogue.

Absent `patchCord` means ordinary cable, which is what every saved topology
written before this existed records.

### 4.3 LC into SC

Different shape (`shape: 'lc'` versus `shape: 'sc'`), so `polishMismatch` is
false and the verdict is `E_CONNECTOR_MISMATCH`: "Cannot mate SC/APC to LC/UPC
(incompatible connectors)". There is no adapter in the model, because there is
no adapter in the field that does not cost you a patch panel and a second lead.
Model the patch panel as a device if you need one.

Note that `FERRULE` also contains `lc` and `mpo` keys. Those exist because the
`MEDIA` catalogue uses them as `connector` values; they are not cages. `mpo` is
the 40G/100G/200G/400G ribbon connector and currently has no cage of its own —
those optics ride in QSFP cages. That is a known gap, not an oversight in this
document.

### 4.4 QSFP-DD taking QSFP28 and QSFP+ modules

`CAGE_MATE.qsfpdd` is `['qsfpdd', 'qsfp28', 'qsfp+', 'qsfp56']`, and `CAGE_MEDIA.qsfpdd`
includes the 100G and 40G optics — plus the 200G and 400G ones, and `dac-100g`. That is by design: a QSFP-DD cage is
backward-compatible with older modules, and refusing the pair would make a 400G
port unable to accept the 100G optic most labs actually own.

The consequence is that **the link runs at the module's rate, not the cage's
maximum**. A 200G `qsfpdd` port against a 100G `qsfp28` port negotiates the
highest common rate, picks `100gbase-sr4`, and reports `speedMbps: 100000`. It
does **not** raise `W_SPEED_DOWNGRADE`, because that warning fires only when the
rate is below the maximum of *both* ports and here one of them is a 100G port.
Do not read "no warning" as "ran at full speed" — read `speedMbps`.

The other direction is not automatic: `qsfpdd` does **not** mate with `sfp28`,
and `qsfp28` does **not** mate with `sfp+`. A 100G uplink cabled to a 25G uplink
is refused with `E_CONNECTOR_MISMATCH`, not silently downshifted. Backward
compatibility runs QSFP-DD → QSFP28 → QSFP+, never across the SFP shell.

### 4.5 Combo RJ45/SFP cages

A combo port is one physical position that accepts **either** an RJ45 plug or an
SFP module, never both. Hardware sells it that way; `CAGES.combo` models it as
one cage that mates with both worlds, and the device spec models it as two
interfaces that name each other:

```json
{ "name": "Gi0/0/3",     "type": "ethernet", "speed": "1G",
  "comboWith": "Gi0/0/3-sfp", "comboRole": "rj45" },
{ "name": "Gi0/0/3-sfp", "type": "ethernet", "speed": "1G", "connector": "sfp",
  "speedCaps": [1000], "comboWith": "Gi0/0/3", "comboRole": "sfp" }
```

Either half accepts a cable on its own, in its own medium. Once one is cabled the
other is refused with **`E_COMBO_OCCUPIED`**, naming the sibling port. That check
is *not* in `validation.js` — it is in `Topology.validateLink` (`engine/topology.js`),
so that the dry-run endpoint and a real connection attempt behave identically.
`E_COMBO_OCCUPIED` therefore never appears from a bare
`validation.validateConnection()` call, and a contributor adding cable rules
should remember that one code lives outside the rules engine.

Two traps. **Exclusion is checked on the half you cable, not on the pair**, so the order decides whether it
bites: the check reads `comboWith` off the incoming port and asks whether *that* sibling is in use. Cloning
`ISR 4331` and stripping one pointer splits the outcomes four ways — both halves intact: `rj45` then `sfp`
refused; only the `sfp` half carrying it: `rj45` then `sfp` refused, but **`sfp` then `rj45` accepted, two
cables in one cage**; only the `rj45` half carrying it: `sfp` then `rj45` refused. So "both halves carry
`comboWith`" is the rule to write specs by, but it is not the test the engine runs — one pointer on the
incoming half is enough, and the hole opens when the *second* cable goes into the half without one. And a
device with combo ports has *more interfaces than physical ports* — that is correct, not a miscount.

### 4.6 An antenna port is not cablable

`CAGE_MATE.antenna` is `['antenna']`, and `canMate` short-circuits first: if
exactly one side is `antenna`, the answer is `E_WIRELESS_TO_WIRED`. An AP's
`radio0` cannot be cabled to a switch port, a router port or a PON port.

Antenna-to-antenna is legal — that is how a point-to-point radio link is drawn —
but the two radios must also share a medium, and which media a radio gets is decided
two ways.

**By generation, from the rated speed** — the ladder returns the bands that generation
uses, so it is a list, not one band:

| rated | generation | media |
|---|---|---|
| ≤ 600 Mbps | 802.11n | `wireless-2.4` |
| ≤ 1000 Mbps | 802.11ac | `wireless-2.4`, `wireless-5` |
| ≤ 2500 Mbps | 802.11ax | `wireless-2.4`, `wireless-5`, `wireless-6` |
| above | 802.11be | `wireless-2.4`, `wireless-5`, `wireless-6`, `wireless-7` |

**By a declared band**, which narrows the port to exactly one medium and beats the ladder:
`band: "2.4"`, `"5"`, `"6"` or `"60"` gives `wireless-2.4`, `-5`, `-6` or `-60` (`bandMediaId` at
`engine/media.js:847`, applied at `:864-865`, where a `bands` array wins over a bare `band`). A 60 GHz
radio is a *band*, not a fast 5 GHz, and the rating ladder used to hand a Wi-Fi 7 phone a
millimetre-wave medium for exactly that reason.

**By the device's own name** — and this is the path that actually fires, so a declared band is not the
only way in. `engine/media.js:870` matches `/60\s*ghz|802\.11ad|wigig/i` against the model and
description and returns `['wireless-60']` *instead of* the ladder. Measured on four synthetic specs,
all at a 5760 Mbps rating: a model of `MetroLinq 60 GHz` with no `band` gives `['wireless-60']`, a
description of `wigig backhaul` gives `['wireless-60']`, `band: '60'` gives `['wireless-60']`, and an
explicit `bands: ['2.4','5']` gives `['wireless-2.4','wireless-5']` — the narrowing case. No catalogue
device declares `band` or `bands` at all, so every one of the 25 antenna ports listing `wireless-60`
got it by name.

`speedCaps` for a radio is `[maxMbps]`, i.e. exactly the declared rate. So a radio pinned to 5 GHz
against a 600 Mbps 2.4 GHz radio mates — both are simply "Antenna" — and then fails with
`E_NO_COMMON_MEDIA: No shared medium between Antenna and Antenna.`

### 4.7 Console and USB

`console` mates only `console`, and `usb` mates only `usb` — there is no usb-to-console
path in the table at all:

```text
cagesMate('usb', 'console')      -> false
cagesMate('console', 'usb')      -> false
```

This paragraph used to read the other way round, and the history is the argument for step 3 of the
new-connector checklist. `CAGE_MATE.usb` was `['usb', 'console']`, so `cagesMate('usb', 'console')`
answered true while the reverse answered false, and the same pair got an order-dependent verdict from
`canMate`. The entry was reduced to `['usb']`, and `media.js` says why in place: a USB-to-serial adapter
is an external part, not a cable between two devices. A one-sided entry is silent, survives review, and
is miserable to debug — which is exactly what symmetry checks are for.

With the pair gone, a console port against a USB port fails at mating: **`E_CONNECTOR_MISMATCH: Cannot
mate Console to USB (incompatible connectors)`**, in both argument orders. It does *not* reach the
protocol check, because a real USB port carries `usb-console` media, whose family is `console` — both ends
count as console-only, so the "console against a data port" test never fires. No shipped device has a `usb`
cage port anyway — **0** of 1,661 specs — so the pair is not reachable from the catalogue at all.

`validateConnection` reports `E_CONSOLE_TO_DATA` and suppresses the connector
verdict when a console port is paired with a data port, so the message the user
sees is "console cannot be cabled to the data port", not "RJ45 does not mate
Console".

---

## 5. How the engine decides

The full chain, in call order:

```
iface spec  (JSON)
   |
   v  derivePortHardware(spec, devSpec)          engine/media.js
   |     cage  = spec.cage || spec.connector || inferCage(spec, maxMbps)
   |     media = CAGE_MEDIA[cage](maxMbps)       (or spec.media / spec.supportedMedia)
   |     speeds= CAGE_SPEEDS[cage](maxMbps)      (or hw.speedCaps / spec.speedCaps)
   v
port hardware  { cage, media[], speedCaps[], maxSpeedMbps, poeOut, poeIn }
   |
   v  Topology.validateLink(aId, aIface, bId, bIface)    engine/topology.js
   |     1. combo sibling check -> E_COMBO_OCCUPIED
   |     2. delegate to validateConnection
   v
validateConnection({portA, portB, ...})            engine/validation.js
      E_NO_PORT -> E_SELF_LINK -> E_PORT_IN_USE -> E_CONSOLE_TO_DATA
      -> canMate() verdict (E_WIRELESS_TO_WIRED / E_POLISH_MISMATCH /
         E_CONNECTOR_MISMATCH / E_NO_COMMON_MEDIA / E_NO_COMMON_SPEED)
      -> E_MEDIA_NOT_SUPPORTED (only when the caller names a mediaId)
      -> speed = max(common caps), clamped by the chosen medium
      -> E_OPTICAL_BUDGET (PON only) / W_OPTICAL_HEADROOM
      -> E_POE_BUDGET, E_LAG_SPEED_MISMATCH
      -> warnings: W_DISTANCE, W_COPPER_LONGRUN, W_DUPLEX_MISMATCH,
         W_SPEED_DOWNGRADE, W_POE_DRAW
   v
{ ok, errors[], warnings[], media[], mediaId, speedMbps }
```

`cagesMate(a, b)` reads `CAGE_MATE[a]` **only**, so the table has to be
symmetric by hand. Add `b` to `a`'s list and `a` to `b`'s, or the link will be
refused in one direction and accepted in the other.

`commonMedia` is the intersection of the two ports' `media[]`, but only after
`cagesMate` passes — a mating failure produces no media list at all, which is why
`verdict.media` is empty on a refused link. `preferredMedia` then chooses one id from that intersection,
in three steps that are worth knowing exactly because the answer can depend on which port you passed
first:

1. **Drop what the port cannot carry.** When a max rate is supplied, media whose `speedMbps` exceeds it
   are removed before ranking (`['1000base-t','10gbase-t']` at 1 G → `1000base-t`). If nothing fits, the
   original list is kept rather than emptied.
2. **Rank the family** — `fiber: 3`, `dac: 2`, and **`copper`, `console` and `wireless` all at 1**. Copper
   does *not* outrank a console or a radio medium; they are equal, so the next step decides.
3. **Break the tie on speed**, higher winning. A complete tie — same family, same speed — keeps whichever
   came first in the input list, and that list is built from the ports' own media order, so
   `preferredMedia(['1000base-t','1000base-t-sfp'])` answers `1000base-t` while the reversed list answers
   `1000base-t-sfp`. The *verdict* for such a pair does not depend on direction; the chosen medium can.

One demotion sits outside that ranking: a `linkOnly` medium is pushed to rank −1 unless **every** candidate
is link-only. `1000base-bx` exists only because a U module met a D module and no cage offers it as a choice,
so an ordinary SFP pair is described as `1000base-lx` (`['1000base-bx','1000base-lx']` → `1000base-lx`)
while the asymmetric pair still gets `1000base-bx` (`['1000base-bx']` → `1000base-bx`).

Every example in that description was re-run against `preferredMedia()` on 2026-11-12, and all of them hold:

| Call | Answer |
|---|---|
| `preferredMedia(['1000base-t','1000base-t-sfp'])` | `1000base-t` — same family, same speed, so input order wins |
| `preferredMedia(['1000base-t-sfp','1000base-t'])` | `1000base-t-sfp` — the same pair, reversed |
| `preferredMedia(['1000base-t','10gbase-t'], 1000)` | `1000base-t` — step 1 drops the 10G medium |
| `preferredMedia(['1000base-t','10gbase-t'], 10000)` | `10gbase-t` — and step 3 prefers it once nothing is dropped |
| `preferredMedia(['1000base-bx','1000base-lx'])` | `1000base-lx` — the `linkOnly` demotion |
| `preferredMedia(['1000base-bx'])` | `1000base-bx` — demoted only when something else is left |
| `preferredMedia(['10gbase-sr','1000base-t'])` | `10gbase-sr` — fiber 3 over copper 1 |
| `preferredMedia(['dac-10g','10gbase-sr'])` / `(['dac-10g','1000base-t'])` | `10gbase-sr` / `dac-10g` — dac 2 sits between fiber and copper |
| `preferredMedia([],…)` and `preferredMedia(null,…)` | `null` |

The pair step 1 exists for is the SC/UPC cage, and it is worth seeing because the two media are both fibre:
`CAGE_MEDIA['sc-upc']()` is `["gpon-sc-upc","100base-fx"]`, and `preferredMedia` of that answers **`100base-fx`** at
100 Mbps and **`gpon-sc-upc`** at 2488 — a 100M link described by a 2.5G PON medium was the bug the filter was
added for.

The rank map is `{ fiber: 3, dac: 2, copper: 1, console: 1, wireless: 1 }` and `rankOf` falls back to `|| 0` for any
family it does not name — which today means **`fibre-channel`, `coax`, `dsl` and `powerline` rank 0**, below
copper. `preferredMedia(['2gfc-sw','1000base-t'])` really does answer `1000base-t`, and
`['docsis-30','1000base-t']` answers `1000base-t` too. Neither list is reachable from a real link, because an FC
or coax cage only mates its own kind, so the medium is still named correctly in practice — but the asymmetry is
why a "tidy-up" of that map can change labels without any test going red. There are **89** media across **9**
families (`copper`, `fiber`, `fibre-channel`, `coax`, `dsl`, `powerline`, `dac`, `console`, `wireless`).

`negotiateSpeed` takes the maximum shared `speedCaps` entry.

**`speedMbps` from `canMate`/`negotiateSpeed` is the port ceiling, not the cable's
speed.** The two are equal whenever both ports are single-rate and matched, which is most of
the catalogue — and then they diverge. Measured on a Catalyst 9300's `sfp+` uplink pair with a
1G SFP part (`1000base-t-sfp`) between them:

| Question | Answer |
|---|---|
| `canMate(A, B).speedMbps` | **10000** — the highest shared `speedCaps`, i.e. what these sockets could do |
| `negotiateSpeed(A, B)` | **10000** |
| `topo.validateLink(…, {mediaId: '1000base-t-sfp'})` | `ok: true`, no errors, one `W_SPEED_DOWNGRADE` ("runs at 1G, below the 10G of Gi1/1/1 …") |
| the created link's `speedMbps` | **1000** — what the cable actually runs at |

So a caller that reads `canMate().speedMbps` and calls it the link rate is wrong on exactly the
downgrade case that warning exists to describe. The link record and the warning are the truth;
`canMate` answers "could these two sockets run together at all, and if so how fast at best".

### Error and warning codes

Everything the rules engine can emit, and where it comes from:

| Code | Severity | Emitted by | Meaning |
|------|----------|-----------|---------|
| `E_NO_PORT` | error | validation | Port does not exist on its device |
| `E_SELF_LINK` | error | validation | A device cabled to itself |
| `E_PORT_IN_USE` | error | validation | Port already carries a link |
| `E_COMBO_OCCUPIED` | error | **topology.js** | The other half of the combo cage is in use |
| `E_CONSOLE_TO_DATA` | error | validation | Console port paired with a data port |
| `E_WIRELESS_TO_WIRED` | error | media `canMate` | Radio against a wired cage |
| `E_POLISH_MISMATCH` | error | media `canMate` | Same ferrule shape, different polish |
| `E_PATCH_CORD_UNKNOWN` | error | validation | Declared patch cord is not in the catalogue |
| `E_PATCH_CORD_ENDS` | error | validation | Declared patch cord ends are not the two cages being joined |
| `E_CONNECTOR_MISMATCH` | error | media `canMate` | Cages cannot physically mate |
| `E_BIDI_MISMATCH` | error | media `canMate` | Exactly one end is a single-strand (BiDi) optic |
| `E_BIDI_SAME_WAVELENGTH` | error | media `canMate` | Both ends carry the same half of a BiDi pair — two transmitters into one strand |
| `E_PROTOCOL_MISMATCH` | error | media `canMate` | Console against a data port, *or* a Fibre Channel port against an Ethernet one |
| `E_BAUD_MISMATCH` | error | media `canMate` | Two console ports whose baud rates have no value in common |
| `E_NO_COMMON_MEDIA` | error | media `canMate` | Cages mate but share no medium |
| `E_NO_COMMON_SPEED` | error | media `canMate` | Shared medium, no common rate |
| `E_MEDIA_NOT_SUPPORTED` | error | validation | Caller asked for a medium one port lacks |
| `E_OPTICAL_BUDGET` | error | validation | PON downstream *or* upstream over the class budget |
| `E_POE_BUDGET` | error | validation | PSE ports draw more than the budget |
| `E_LAG_SPEED_MISMATCH` | error | validation | LAG members at different rates |
| `W_OPTICAL_HEADROOM` | warning | validation | PON link within 3 dB of the budget |
| `W_DISTANCE` | warning | validation | Length exceeds the medium's reach |
| `W_COPPER_LONGRUN` | warning | validation | Copper past the 90 m horizontal limit |
| `W_DUPLEX_MISMATCH` | warning | validation | Ends disagree on duplex |
| `W_SPEED_DOWNGRADE` | warning | validation | Link below the maximum of *both* ports |
| `W_POE_DRAW` | warning | validation | Powered device on a port that supplies no PoE |
| `W_HYBRID_CORD` | warning | validation | Hybrid UPC/APC cord joining two polishes; legal, costs its IL |

`RULES` in `validation.js` is the declared catalogue and `validateTopology` uses it for severity:
**20** codes, and every one of them is emitted somewhere. The traffic is one-way outside that list —
the three connector-path files emit **32** distinct codes between them, so **12** are emitted without a
`RULES` entry: `E_COMBO_OCCUPIED` and five other link-management codes from `topology.js`
(`E_NO_DEVICE`, `E_SAME_DEVICE`, `E_NO_FREE_PORTS`, `E_NO_LINK`, `E_BAD_LENGTH`), `E_OPTICAL_BUDGET` and
`W_OPTICAL_HEADROOM` from `validation.js`, and the four `canMate` codes above — `E_BIDI_MISMATCH`,
`E_BIDI_SAME_WAVELENGTH`, `E_PROTOCOL_MISMATCH`, `E_BAUD_MISMATCH` — which are decided in `media.js` and
reach `validation.js` only as a verdict. Unknown codes are still classified — anything starting `W_` is a
warning, everything else an error — but if you add a code, add it to `RULES` so the UI can document it and
the counts stay honest.

Those two counts were re-derived on 2026-11-12 and need one caveat to reproduce. `RULES` holds **20** entries —
`node -e "console.log(require('./engine/validation.js').RULES.length)"` — and every one of them is emitted in those
files. The other two numbers depend on how you count a fallback: scrape every quoted `E_`/`W_` literal out of
`validation.js`, `media.js` and `topology.js` and you get **34** distinct codes with **14** outside `RULES`, not
32 and 12, because two of them are defaults rather than rules — `E_UNKNOWN` at `topology.js:248` (the code used
when a verdict comes back with no errors at all) and `E_LINK` at `topology.js:373` (used when a refusal carries no
error). Both are reachable only if something upstream returns an empty error list, which is not supposed to
happen; neither is a rule you can provoke. Exclude those two literals and the page's 32/12 is exact.

The table above is `RULES` plus seven of the twelve: six `canMate`/`validation` codes and `W_OPTICAL_HEADROOM`.
The five it leaves out are the link-management codes from `topology.js` (`E_NO_DEVICE`, `E_SAME_DEVICE`,
`E_NO_FREE_PORTS`, `E_NO_LINK`, `E_BAD_LENGTH`), which belong to `E_COMBO_OCCUPIED`'s family and are documented
with the topology rather than with connectors.

Four of those codes are hard to reach from the catalogue as it ships, which is worth knowing before you
go looking for a reproduction. Measured over all 1,661 specs: **178** console ports exist and every one of
them advertises all five baud media (`console-rs232`, `-57600`, `-38400`, `-19200`, `-9600`) — none of
which is written in the spec, whose whole port is `{ "name": "serial1", "type": "console" }`: the five
are the cage's ladder, `CAGE_MEDIA.console()` at `engine/media.js:629-631`, reached because `inferCage`
maps that `type` to `console` at `:784`. So two
catalogue console ports always share a rate and `E_BAUD_MISMATCH` needs a port that declares a narrower
list; there are **0** ports with a `usb` cage at all; and **3,399** ports list a BiDi medium while **0**
list a single half, so `E_BIDI_SAME_WAVELENGTH` and `E_BIDI_MISMATCH` fire only for a port whose `media:`
override names the module actually fitted — which is how `test/bidi-media.test.js` builds its fixtures,
and why a U module against a U module reads `ok` on two catalogue SFP ports whose cage default lists both
halves.

The 3,399 needs spelling out, because the obvious search finds nothing: **no medium id in the catalogue
contains "bidi"**. They are `1000base-bx`, `1000base-bx-u` and `1000base-bx-d`, and all 3,399 ports list
the `-u`/`-d` pair together with **0** listing either half alone — and, measured the same way, **0** ports
offer the unsided `1000base-bx` at all, so the pair is the only way this medium reaches a port: 3,399 offer
`1000base-bx-u` and 3,399 offer `1000base-bx-d`, which is every port in both counts. A `grep -ril bidi devices/` answers three
files and six occurrences, every one of them prose — a product named `om4501-40gsr4bidi`, two
"bidirectional" notes and one "bidium" — and no port at all. Count through `derivePortHardware()` and the
medium ids, never the word.

`E_PROTOCOL_MISMATCH` is the one you will actually meet, and it covers two unrelated pairs: a console port
against anything that is not a console, and a Fibre Channel port against an Ethernet one. Read its message
rather than the code.

One behaviour to expect while debugging: **warnings are computed even when a
link is refused.** An SC/APC to SC/UPC pair returns `E_POLISH_MISMATCH` *and*
`W_SPEED_DOWNGRADE`, because the speed intersection is calculated regardless of
the connector verdict. The error is the one that blocks; ignore the warning on a
refused link.

---

## 6. Worked examples

All three transcripts are real output from
`new Topology().validateLink(aId, aIface, bId, bIface)` with the catalogue in
`devices/`. The `devices` are built from the JSON shown, so you can reproduce
any of them.

### 6.1 Refused: copper into an SFP+ uplink

`devices/generic/generic-pc.json` declares `{ "name": "eth0", "type": "ethernet",
"speed": "1G" }` — no connector, so it infers `rj45`. The Catalyst 9300 uplink
declares its cage:

```json
{ "name": "Gi1/1/1", "type": "ethernet", "speed": "10G",
  "connector": "sfp+", "speedCaps": [10000] }
```

```text
> validateLink(pc, 'eth0', c9300, 'Gi1/1/1')

{
  "ok": false,
  "errors": [
    {
      "code": "E_CONNECTOR_MISMATCH",
      "message": "PC/eth0 <-> Catalyst 9300-48P/Gi1/1/1: Cannot mate RJ45 to SFP+ (incompatible connectors)."
    }
  ],
  "warnings": [],
  "media": [],
  "mediaId": null,
  "speedMbps": null
}
```

The object also carries four keys this excerpt leaves out — `patchCord: null`,
`patchCordLossDb: 0`, `polishWeakened: false` and `patchCordOptions: []` — so a reader diffing a live
result against the block above is looking at a superset, not a mismatch.

The refusal is correct and the fix is a hardware decision, not a config one.
Either put a 1000BASE-T SFP in the uplink (`"media": ["1000base-t-sfp"]` on the
spec, or just let the medium be chosen — it is already in the `sfp+` media list),
or cable `eth0` to one of `Gi1/0/1`…`Gi1/0/48`, which are `rj45`.

### 6.2 Refused: SC/APC into an SC/UPC socket

The OLT is real hardware from the catalogue; the ONT is the minimum spec that
demonstrates the rule:

```json
{ "vendor": "lab", "model": "ONT-UPC", "label": "Lab ONT (SC/UPC)",
  "category": "ont", "capabilities": ["host"],
  "interfaces": [
    { "name": "pon", "type": "pon", "speed": "2.5G", "connector": "sc-upc" }
  ] }
```

The OLT's `pon1` is `sc-apc` (declared in `devices/adtran/sdx-6320.json`).

```text
> validateLink(olt, 'pon1', onu, 'pon')

ok=false  speedMbps=2488
[E_POLISH_MISMATCH] SDX 6320 10G Combo PON OLT/pon1 <-> Lab ONT (SC/UPC)/pon:
  SC/APC and SC/UPC take the same SC ferrule but not the same polish
  (APC angled 8 deg vs UPC flat). They are not intermateable - forcing it costs
  about 3 dB and can chip the endface. A hybrid patch cord (SMSCSX, sc-upc to
  sc-apc, 0.3 dB insertion loss) joins these two polishes: declare it on the
  link (patchCord: "SMSCSX") and the run becomes buildable.
[W_SPEED_DOWNGRADE] Link ... runs at 2.488G, below the 9.953G of pon1 and the
  2.5G of pon.
```

Note the second line: the GPON rate *was* negotiated (2488 Mbps) even though the
link is impossible. The error blocks; the warning is noise in this context.

The fix is a green-vs-blue patch lead: declare the ONT `"connector": "sc-apc"`,
swap the OLT's PON module for an SC/UPC one and declare `sc-upc` on both ends, or
declare the hybrid cord the refusal itself now names — `patchCord: "SMSCSX"`, the
same assembly `patchCordOptions[]` lists and §4.2 documents. Declaring *one* end
differently to silence the error is the bug this check exists to catch.

### 6.3 Accepted: a 100G module in a 200G QSFP-DD cage

Neither spec names its cage; both are inferred from the rate.

```json
/* devices/adtran/sdx-6330.json */
{ "name": "qsfpdd1/1", "type": "ethernet", "speed": "200G" }
```

```json
/* devices/arista/7050cx3-32s.json — 32x 100G QSFP28 */
{ "name": "Ethernet1", "type": "ethernet", "speed": "100G" }
```

```text
> validateLink(sdx6330, 'qsfpdd1/1', a7050cx3, 'Ethernet1')

ok=true  mediaId=100gbase-sr4  speedMbps=100000
```

What happened, step by step:

1. `inferCage` saw 200G on the left → `qsfpdd`; 100G on the right → `qsfp28`.
2. `CAGE_MATE.qsfpdd` contains `qsfp28`, so they mate.
3. Shared media: the 100G and 40G optics, both in each cage's list.
4. `preferredMedia` ranked fibre over DAC and picked the fastest — `100gbase-sr4`.
5. `negotiateSpeed` took the highest shared caps entry, `100000`.

To force the 40G path instead, pass `mediaId`:

```js
validateConnection({ portA, portB, mediaId: '40gbase-lr4' })  // 40000 Mbps
```

and to prove the model is not merely permissive, change `Ethernet1` to an
`sfp28` port: the same call then returns
`E_CONNECTOR_MISMATCH: Cannot mate QSFP-DD to SFP28 (incompatible connectors).`

---

## 7. Debugging a refused cable

In order:

1. **Read the code, not the label.** `E_CONNECTOR_MISMATCH` names both cages in
   the message. If it says "RJ45" about a port you believe is fibre, the spec
   does not say what you think it says.
2. **Print the derived hardware**, not the JSON:
   `new Topology().addDevice(spec)` then read `iface.hardware` — `cage`,
   `media`, `speedCaps`, `maxSpeedMbps`. The JSON is an input; this is what the
   rules actually used.
3. **Check for an unknown cage.** A connector that is not in `CAGES` does not
   throw: the port keeps the raw string, reports `family: 'unknown'` with an
   empty `media` and `speedCaps`, and refuses everything — including a port of
   its own kind, with the slightly comic `Cannot mate sfp++ to sfp++`. If a port
   shows no media and no rates at all, the cage name is wrong or unmodelled.
4. **Check `speedCaps` overrides.** A spec that declares
   `"speedCaps": [10000]` on an SFP+ port removes 1000 from the negotiation, and
   a 1G optic in it then fails with `E_NO_COMMON_SPEED` even though the cage
   supports both rates. `CAGE_SPEEDS` is only a default.
5. **Check the medium, not just the cages.** `E_NO_COMMON_MEDIA` after a
   successful mate almost always means one port carries `1000base-t` (RJ45
   copper) while the other carries `1000base-t-sfp`. They are different ids on
   purpose.
6. **Check for a combo sibling.** `E_COMBO_OCCUPIED` means the other half of the
   position is patched.
7. **Remember the missing speed.** No `speed` field means 1G, and that silently
   grades an optical port down to `sfp`.
8. **Trust warnings about distance, not about speed, on a refused link.**

---

## 8. Adding a new connector family

A connector family is data, not logic. The checklist below is the whole job;
each item is a constant in `engine/media.js` unless stated otherwise. Use
`combo`, `sc-apc` and `qsfpdd` as reference implementations of a hybrid cage, a
polish-sensitive cage and a backward-compatible cage.

### 8.1 Checklist

1. **`MEDIA` — add the media the new cage can carry.** One entry per
   cable/optic/band, with `name`, `family` (`copper` | `fiber` | `dac` |
   `console` | `wireless`, plus `coax` | `dsl` | `powerline`), `connector`,
   `speedMbps`, `maxRangeM`, and `fiber`/`wavelengthNm` or `upstreamMbps` where
   relevant. A cage with no media in `MEDIA` can never carry a link.
2. **`CAGES` — add the cage** with `name`, `family` and `label`. The `label` is
   what the UI tooltip shows, so write it for a human: `'SC/APC (green, angled
   8 deg)'`. If the datasheet calls the connector by a bare token that is not a
   cage (as `lc` is), add a `CAGE_ALIAS` entry pointing it at the real cage — an
   unaliased token becomes an unknown cage and refuses every cable.
3. **`CAGE_MATE` — add the cage to *both* sides of every pair.** Symmetry is
   manual. A cage that mates with itself needs its own name in its own list. The
   `usb`/`console` pair is the codebase's own example of getting this wrong:
   `usb` listed `console` while `console` did not list `usb`, so the same pair
   answered differently depending on which end you asked about, and the entry was
   later reduced to `['usb']`. Section 4.7 has the details.
4. **`CAGE_MEDIA` — add a function `(maxMbps) => [mediaId]`.** Filter by
   `maxMbps` when the cage has a rate ceiling (see `rj45`, `coax`); return a
   fixed list when it does not (see `sfp`, `powerline`). Never put a bare
   copper id (`1000base-t`) in an optical cage.
5. **`CAGE_SPEEDS` — add a function `(maxMbps) => [Mbps]`.** Fixed list for a
   fixed-rate cage, filtered list for a rate-agile one. These are the values
   `negotiateSpeed` intersects, so a missing entry means the link cannot form
   even if both cages "obviously" support the rate.
6. **`FERRULE` — only for optical cages.** Add `{ shape, polish, colour,
   angleDeg }` so a polish mistake produces `E_POLISH_MISMATCH` with a reason
   instead of a generic refusal. Shapes must be spelled identically for two
   cages to be considered the same shape (`'sc'`, `'lc'`); polish is `'upc'` or
   `'apc'`; APC is `angleDeg: 8` and green, UPC is `0` and blue.
7. **`inferCage` — add a name rule, in the right place.** Name rules go before
   the generic optical test, and **any fibre connector rule must go before the
   PON fallback** (`/gpon|xgs-?pon|pon/` → `sc-apc`), or every port you name
   will be captured by it. If the family is selected by `type` (`coax`, `dsl`,
   `powerline`, `wireless`), add it to the `type` block at the top instead.
8. **UI labels — update the copies.** `web/canvas.js: cageLabel()` and
   `web/faceplate.js: CAGE_INFO` both keep their own cage → label/family maps
   (the canvas cannot import the app module). Both fall back gracefully
   (`|| cage`, `CAGE_INFO.unknown`), so a missing entry is a cosmetic bug, not a
   crash — but it will show a raw id in the tooltip.
9. **Tests — run the ones that exist, then add one.** See 8.3.
10. **Docs — this file, and `docs/PHYSICAL_LAYER.md` if the medium catalogue
    changed.** Add a row to section 2, and a "will not mate" case if the new
    family has an obvious trap.

### 8.2 A worked sketch

To add a hypothetical `cs` connector (a duplex LC-sized push-pull used on some
100G/400G optics), the diff would touch exactly five constants and one regex:

```js
// 1. MEDIA: nothing new if the optics already exist — reuse 100gbase-*.
// 2. CAGES
cs: { name: 'CS', family: 'optical', label: 'CS duplex (flat polish)' },
// 3. CAGE_MATE  (both directions!)
cs: ['cs', 'qsfp28', 'qsfpdd'],
// 4. CAGE_MEDIA
cs: function (maxMbps) { return ['100gbase-sr4', '100gbase-lr4', '400gbase-dr4', '400gbase-fr4']; },
// 5. CAGE_SPEEDS
cs: function (maxMbps) { return [100000, 400000].filter(function (v) { return v <= maxMbps; }); },
// 6. FERRULE (flat polish, so a CS/APC variant would be a separate cage)
cs: { shape: 'cs', polish: 'upc', colour: 'blue', angleDeg: 0 },
```

and in `CAGE_MATE`, `qsfp28` and `qsfpdd` must each gain `'cs'` as well, or the
pair is refused from the QSFP side. Then add the name rule to `inferCage`
*above* the PON fallback.

### 8.3 Which test to run

| Test | What it protects |
|------|------------------|
| `node test/hardware-invariants.test.js` | Runs the whole catalogue: every spec's claimed optics must be deliverable by its ports, no unknown cages, no impossible media |
| ↳ the line-rate assertion | No port may declare a rate its cage cannot carry — this is the check that caught seven devices claiming 10G on a 2.5G SFP cage. Read the trap in §8.4 before touching it. |
| `node test/combo.test.js` | Combo cage mates both worlds and `E_COMBO_OCCUPIED` blocks the second cable |
| `node test/fiber-connectors.test.js` | SC/APC vs SC/UPC refusal, ferrule geometry, PON ports are not copper |
| `node test/pon-connectors.test.js` | LC/SC connectors on real OLT/ONT specs; unresolved cages are never painted copper |
| `node test/qsfpdd.test.js` | QSFP-DD cage, 200G/400G optics, downshift to a QSFP28 module |
| `node test/optics-catalogue.test.js` | Every optical medium is reachable from at least one cage |
| `node test/validation.test.js` | Error codes and severities, rule ordering |
| `npm test` | the port-type audit, the control-byte check, then every suite — CI runs those two as its own steps *and* again through this script ([CI.md](CI.md)) |

Add a case to the closest of those rather than a new file: a new connector
family belongs in `fiber-connectors.test.js` (or a sibling) with at least
"mates with itself", "refused against the nearest wrong cage", and "carries the
medium its datasheet claims". `npm run syntax` catches the rest.

---

### 8.4 The line-rate assertion, and the way it used to do nothing

The assertion reads each port's declared `speedCaps`, takes the fastest, and requires that the cage
under it can carry that rate. Console ports are exempt from the 100 Mbps floor (a USB console really
does run at 12 Mbps) but **not** from the ceiling check — skipping them outright is how 163 console
ports carried a gigabit on a 115.2 kbps cage through a green suite for a while.

The part worth remembering is why the check was once a no-op. `speedCaps` is whatever the spec author
wrote, and they write text:

```json
{ "connector": "sfp", "speedCaps": ["10G", "1G"] }
```

`Math.max.apply(null, ["10G", "1G"])` is `NaN`, and **every comparison against `NaN` is false**, so the
`if (fastest > cageSpeed)` branch never ran for any port whose caps were written as strings — which is
how an EdgePoint S16 carried a 10G claim on a 1G SFP cage. The current code parses the strings before comparing (`parseSpeedMbps()` on each cap, dropping the
unparseable). Two lessons that generalise beyond this file:

- **`NaN` is a silent pass.** Any assertion of the form `if (measured > limit)` is green when `measured`
  is `NaN`. Prefer asserting the number is finite first, then comparing.
- **A check that has never failed is a check you have not tested.** The same suspicion applies to the
  documentation sweepers in [CI.md](CI.md), one of which turned out to be inspecting zero tables for the
  same class of reason.

Cages have ceilings that are easy to forget, and the assertion is really about the cage rather than the
speed. Seven devices once declared `"connector": "sfp"` with a `10G` rate — every one of them genuinely
has a 10G uplink, and their descriptions said so. The fault was the cage: **SFP tops out at 2.5G, and
10G over SFP needs SFP+**, so the pair was undeliverable even though each half was defensible. Three
were caught by this assertion and all seven by `test/spec-vs-description.test.js`, and the fix was
data-only (`sfp` → `sfp+` on fourteen interface lines). If a spec you are importing claims more than
the cage name allows, the cage is usually what is wrong, not the speed.

Ports whose `media` array is empty are skipped here on purpose: a port with no medium can be cabled to
nothing at any rate, and that question is owned by `test/wired-port-has-media.test.js`.

### 8.5 The transceiver catalogue, and the second copy it forces

An optic is a different kind of addition from a connector family: it does not touch `MEDIA`, `CAGES` or
`FERRULE` at all. It is one object in `catalogue/optics/transceivers.json` — **58 of them today**, and a
part is only buildable when it appears in **two** places.

| Field | Meaning | Seen in this catalogue |
|---|---|---|
| `partNumber` | the orderable string, recorded exactly as a vendor writes it | all 58 |
| `vendor` | lowercase vendor token | all 58 |
| `formFactor` | the cage family the module fits | `sfp` 8, `sfp+` 21, `sfp28` 4, `qsfp+` 7, `qsfp28` 13, `qsfp-dd` 3, `qsfp56` 2 |
| `connector` | the cage at the fibre end | `lc` 43, `mpo` 8, `sc-upc` 3, `sc-apc` 1, `rj45` 3 |
| `polish` | descriptive only — see rule 1 | `upc` 42, `apc` 2, `null` 14 |
| `wavelengthNm` | transmit wavelength | all optical parts |
| `reachM` | rated reach in metres | all 58 |
| `fiber` | `smf`, `mmf` or `copper` | all 58 |
| `speedMbps` | line rate, the number the speed ladder compares | all 58 |
| `biDi` + `pairWavelengthNm` | one strand, two directions — the partner's wavelength goes here | 9 parts, e.g. `SFP-10G-BXU-I` at 1270 nm pairs with 1330 nm |
| `cwdmChannel` | the CWDM grid slot, as a string | 7 parts, e.g. `CWDM-SFP10G-40L` is `"1470nm"` |
| `standard` | the IEEE/MSA name, which is what a reader recognises | all 58 |
| `sourceUrl` | the datasheet the row was transcribed from | **all 58** — no part is recorded from memory |
| `note` | the caveat that does not fit a column | **57** — `SFP-10G-LR` is the one without |

Two rules follow from the shape of the file rather than its contents:

1. **`polish` is descriptive, and the catalogue is inconsistent about it.** Nothing reads it: the
   refusal comes from the *cages*, not the part numbers — `polishMismatch(pa.cage, pb.cage)` in
   `engine/media.js` compares the `FERRULE` entries of the two cages, so a wrong or missing `polish`
   here cannot produce or suppress an `E_POLISH_MISMATCH`. What the field shows is an intake gap: of the
   **43** `lc` parts, **33** declare `upc` and **10** declare `null`, and the 14 nulls are three copper
   modules (where null is correct — `GLC-TE` is `rj45` on `copper` and has no ferrule) plus eleven
   optical ones (`SFP-25G-SR`, `QSFP28-100G-LR4`, `SFP-10G-iLR`, …) that were transcribed without it.
   Do not read a null as "this module has no polish"; read it as "nobody filled it in".
2. **The browser cannot read this directory**, so `web/app.js` keeps `PART_ROWS` and the picker is
   whatever that array says — see "The UI's part picker is a snapshot of the catalogue" above, which
   records the current gap (`34 of 58`). Adding a part to the catalogue and stopping there produces an
   optic the engine accepts and the UI cannot offer.

```bash
node -e "const a=require('./catalogue/optics/transceivers.json');
  const ff={}; a.forEach(p=>ff[p.formFactor]=(ff[p.formFactor]||0)+1);
  console.log(a.length,'parts',JSON.stringify(ff))"
node test/link-parts.test.js | grep 'carries every catalogue part'
```

Both commands were run on 2026-11-12. The first prints `58 parts {"sfp":8,"sfp+":21,"sfp28":4,"qsfp+":7,"qsfp28":13,"qsfp-dd":3,"qsfp56":2}`; the second prints
`✗ the UI carries every catalogue part (34 of 58)`, and the suite around it reports `81 passed, 2 failed` — this
gap is one of the two red assertions on this branch, not a stale note.

Every count in the field table above was re-derived from the JSON rather than read off the page, and all of them
hold: **58** parts; `connector` `lc` 43, `mpo` 8, `sc-upc` 3, `sc-apc` 1, `rj45` 3; `polish` `upc` 42, `apc` 2,
`null` 14; **9** BiDi parts; **7** CWDM; `sourceUrl` on **58**; `note` on **57**, with `SFP-10G-LR` the single
blank; the 43 `lc` parts split **33** `upc` / **10** `null`; and the 14 nulls split **3** copper / **11** optical,
naming `QSFP-DD-400G-DR4`, `QSFP-DD-400G-FR4`, `QSFP56-200G-FR4`, `SFP-25G-SR`, `SFP-25G-SR-E`, `QSFP28-100G-LR4`,
`QSFP28-100G-ER4`, `QSFP28-100G-ZR4`, `SFP-10G-SR1`, `SFP-10G-SR-E` and `SFP-10G-iLR`. The two spot examples are
right too: `SFP-10G-BXU-I` is `wavelengthNm` 1270 with `pairWavelengthNm` 1330, and `CWDM-SFP10G-40L` records
`cwdmChannel: "1470nm"`.

The census behind that paragraph is one command:

```bash
node -e "
const a = require('./catalogue/optics/transceivers.json');
const tally = k => a.reduce((m, p) => { const v = p[k] === null ? 'null' : p[k]; m[v] = (m[v] || 0) + 1; return m; }, {});
const lc = a.filter(p => p.connector === 'lc');
const np = a.filter(p => p.polish === null);
console.log('connector', JSON.stringify(tally('connector')));
console.log('polish', JSON.stringify(tally('polish')));
console.log('biDi', a.filter(p => p.biDi === true).length, '| cwdm', a.filter(p => p.cwdmChannel).length,
            '| sourceUrl', a.filter(p => p.sourceUrl).length, '| note', a.filter(p => p.note).length);
console.log('lc', lc.length, 'upc', lc.filter(p => p.polish === 'upc').length, 'null', lc.filter(p => p.polish === null).length);
console.log('null polish', np.length, 'copper', np.filter(p => p.fiber === 'copper').length,
            'optical', np.filter(p => p.fiber !== 'copper').length);
"
```

```
connector {"lc":43,"rj45":3,"mpo":8,"sc-upc":3,"sc-apc":1}
polish {"upc":42,"null":14,"apc":2}
biDi 9 | cwdm 7 | sourceUrl 58 | note 57
lc 43 upc 33 null 10
null polish 14 copper 3 optical 11
```

Rule 1 also still holds, and it is checkable: nothing reads the catalogue's `polish`. Every `polish` in `engine/`
is `FERRULE` geometry — `polishMismatch()` compares `ferrule(a).polish` for the two **cages** — and the one other
read is `optical.js:381`, which compares ferrule polishes to decide whether a hybrid cord is needed. The JSON
field is descriptive in the strongest sense: deleting all 58 values would change no verdict.

One trap for the next audit: `PART_ROWS` in `web/app.js` is an array of pipe-delimited strings
(`'GLC-SX-MMD|sfp|1000BASE-SX|1000|550|LC/UPC|850'`), not objects, so a grep for `partNumber:` there finds **zero**
rows and reads as "the UI carries nothing". Splitting on `|` gives **34** unique ids, all of them present in the
catalogue, with **24** catalogue parts absent — the gap this section describes.

## 9. Model limits worth knowing

Stated so nobody debugs a limitation as a bug:

- **MPO has no cage.** The 40G/100G/200G/400G ribbon optics ride in QSFP cages,
  and `FERRULE.mpo` exists for the media catalogue. There is no separate MPO
  patch-panel cage or breakout modelling.
- **No adapters, no gender changers, no media converters.** Every link is
  cage-to-cage. Model an adapter as a device if a lab needs one.
- **DAC length is a medium property, not a cage property.** `dac-1g` to
  `dac-100g` carry their own `maxRangeM`; the cage does not constrain it.
- **`console` is 0.1152 Mbps**, i.e. 115200 baud expressed in the same unit as
  everything else. Do not "fix" it to 0.
- **Polish is enforced by the cage pair, not by the medium.** `lc-upc` and
  `lc-apc` share medium ids; only `CAGE_MATE` and `FERRULE` keep them apart.
- **An unrecognised connector is reported as unknown, not guessed.** No media, no
  rates, no mates, `family: 'unknown'` — a refusal you can act on instead of a
  copper port that refuses every lead. Add the cage to `CAGES` if it is real.
- **`W_SPEED_DOWNGRADE` needs both ports to be faster than the link.** A 400G
  port on a 100G link produces no warning if the other port is 100G. Read
  `speedMbps` and `mediaId` instead of inferring rate from the absence of
  warnings.
- **The chosen medium can depend on argument order, even when the verdict does not.** `CAGE_MATE` is
  symmetric now, so `ok`/refused is the same either way round; what is not symmetric is
  `preferredMedia`'s tie-break, which keeps whichever candidate came first in the input list when family
  and speed both tie. `preferredMedia(['1000base-t', '1000base-t-sfp'])` answers `1000base-t` and the
  reversed list answers `1000base-t-sfp`. Never write a test that assumes the two are interchangeable.

Each of those was re-checked on 2026-11-12, and one of them is looser than it reads:

| Claim | Measured |
|---|---|
| MPO has no cage | `FERRULE` has six entries including `mpo`; `CAGES` and `CAGE_MEDIA` have no `mpo` key |
| DAC length is a medium property | `maxRangeM` on the six DAC media: `dac-1g` 3 m, `dac-10g` 7 m, `dac-10g-active` 15 m, `dac-25g` 5 m, `dac-40g` 5 m, `dac-100g` 3 m |
| `console` is 0.1152 Mbps | `MEDIA['console-rs232'].speedMbps` is `0.1152` |
| `lc-upc` and `lc-apc` share media | identical lists at 400G — `["gpon-lc-upc","xgspon-lc-upc","100gbase-lr4"]` both — while `sc-apc` is `["gpon-sc-apc","xgspon-sc-apc"]` |
| An unknown connector is reported, not guessed | `derivePortHardware({ cage: 'wat' })` returns `family: "unknown"`, `media: []`, `speedCaps: []`, and refusal against `rj45` is `E_CONNECTOR_MISMATCH` |
| `W_SPEED_DOWNGRADE` needs both ports faster | the guard is `speed < portA.maxSpeedMbps && speed < portB.maxSpeedMbps` at `validation.js:804-806` |

The loose one is the unknown cage: "no rates" is true of `speedCaps` (empty) but not of `maxSpeedMbps`, which comes
back as **1000** — a default, not a measurement. So a bogus cage refuses everything by connector while still
reporting a 1G ceiling, and anything that reads `maxSpeedMbps` without reading `family` will treat an unknown cage
as a 1G port.

---

See also: [docs/PHYSICAL_LAYER.md](PHYSICAL_LAYER.md) for the medium catalogue and
the L2 rules built on top, and [docs/DEVICE_REGISTRY.md](DEVICE_REGISTRY.md) for
how a device spec declares its connectors.

## What each cable looks like on the canvas

A cable's colour is its medium family, not decoration. The canvas carries the family in a
class (`link-dac`, `link-fiber`, ...) and in `data-medium` on the line element, so the
drawing can be read without clicking anything, and a screenshot means something.

| Family | Drawn as | What it is |
| --- | --- | --- |
| `copper` | warm brown, 2.5 px | twisted-pair Ethernet (10/100/1000/2.5G/5G/10GBASE-T) |
| `fiber` | cyan, 2 px | optical Ethernet (SFP/SFP+/QSFP optics) |
| `dac` | amber, 3.5 px | direct-attach twinax: copper, but a stiff assembly, not a run |
| `aoc` | teal, 3 px | active optical cable: fibre with transceivers moulded on |
| `pon` | mauve, dashed 10 3 | a shared optical drop from a splitter |
| `coax` | steel grey, 3 px | DOCSIS / MoCA segment |
| `dsl` | green, dashed 6 4 | one twisted pair carrying VDSL2/ADSL2+ |
| `powerline` | yellow, dashed 2 4 | the mains as a medium |
| `wireless` | blue, dashed 5 5 | an association, not a cable |

All nine rows were checked against `web/style.css` and `web/canvas.js` on 2026-11-12, colour values included,
because "warm brown" is only useful if it is the colour the browser actually paints:

| Class | Custom property | Hex | Stroke |
|---|---|---|---|
| `link-copper` | `--c-copper` | `#b98b5e` | 2.5 px |
| `link-fiber` | `--c-fiber` | `#4db6e2` | 2 px |
| `link-dac` | `--c-dac` | `#e0a458` | 3.5 px |
| `link-aoc` | `--c-aoc` | `#58d5c9` | 3 px |
| `link-pon` | `--c-pon` | `#b48ead` | 2.25 px, `10 3` |
| `link-coax` | `--c-coax` | `#9aa5b1` | 3 px |
| `link-dsl` | `--c-dsl` | `#8bc34a` | 2 px, `6 4` |
| `link-powerline` | `--c-powerline` | `#f0c674` | 2.5 px, `2 4` |
| `link-wireless` | `--c-wireless` | `#7aa2f7` | `5 5` |

`MEDIUM_RULES` in `web/canvas.js` maps a media id to those nine classes in a fixed order, so the classification is
decided by the medium's string and not by the link's type, and the line element carries
`data-medium: family || 'unknown'` (`canvas.js:222`) — note the fallback, an unclassified medium draws neutral and
says `unknown` rather than guessing a family. `test/canvas-cables.test.js` reports **25 passed, 0 failed** on this
tree, and it is the suite that fails when a new medium has no rule.

Cables are drawn above the chassis: a run that passes behind a device stays continuous from
socket to socket instead of being erased for that span. If you add a medium to
`engine/media.js`, give it a rule in `MEDIUM_RULES` (`web/canvas.js`) and a stroke in
`web/style.css`, or it will draw in the neutral default and `test/canvas-cables.test.js`
will tell you so.

## Console and serial cables

A console port is not a data port: it has a **baud rate**, not a line rate, and the baud rate is
the thing that actually goes wrong. PacketForge models each standard rate as its own medium, so a
mismatched pair refuses with a reason an operator can act on:

| Medium | Rate |
|---|---|
| `console-rs232-9600` | 9,600 baud (0.0096 Mbps) |
| `console-rs232-19200` | 19,200 baud |
| `console-rs232-38400` | 38,400 baud |
| `console-rs232-57600` | 57,600 baud |
| `console-rs232` | 115,200 baud (the default everyone sets) |
| `usb-console` | USB CDC-ACM console |

```js
canMate(baud9600, baud115200)
// { ok: false, code: 'E_BAUD_MISMATCH',
//   message: 'Console runs at 9600 baud and Console runs at 115200 baud. No shared baud rate
//             means the link comes up and every character arrives as noise - the classic
//             console failure. Set both ends to the same speed.' }
```

A multi-baud console (the ladder in `speedCaps` or `baud: [9600, 115200]`) negotiates **down** to
the highest rate both ends share, so a 9600-only terminal links to a 115200 switch at 9600 rather
than pretending to run at 115200. Measured: a `baud: 9600` port against the five-rate default answers
`ok` at `0.0096` Mbps.

That only works if the narrow end says its rate in `speedCaps`. A port whose spec lists the medium but
no rate — `"media": ["console-rs232-9600"]` with no `baud` — derives an **empty** cap list, and the pair
then fails with `E_NO_COMMON_SPEED`, not a baud error: the message reads
`No common speed between Console and Console (A: , B: 0.1152/0.0096)` and the empty side is the tell.
A `baud` value, scalar or array, is what puts the rate in the caps; the medium alone does not.

A console port cabled to a data port refuses with `E_PROTOCOL_MISMATCH`: the connectors may be
different shapes, but the more useful explanation is that a console carries an operator typing
rather than frames from a network stack.

Specs state the rate the way a datasheet does, in baud:

```json
{ "name": "console", "type": "console", "connector": "console", "baud": 115200 }
```

A spec that names nothing but its type gets the cage's own top rate (115,200 baud), not a
gigabit — a default line rate of 1000 Mbps used to make every console port in the catalogue claim
a rate its medium could never carry.

## Coax: DOCSIS and MoCA

DOCSIS is asymmetric and the two directions are different sized pipes on the same F-connector, so
each direction is its own medium:

| Medium | Direction | Rate |
|---|---|---|
| `docsis-30` | downstream | 1 Gbps |
| `docsis-30-us` | upstream | 200 Mbps |
| `docsis-31` | downstream | 10 Gbps |
| `docsis-31-us` | upstream | 1 Gbps |
| `moca-11` | symmetric | 175 Mbps |
| `moca-25` | symmetric | 2.5 Gbps |

A CMTS return-path port asks for its own rate (200 Mbps on a 3.0 chassis, 1 Gbps on a 3.1 one), so
without an upstream entry it shares no rate with any medium and gets an *empty* media list — a port
that exists, draws on the faceplate and cannot be cabled to anything. That is what five cable-access
chassis in `devices/` were doing: Casa `C100G` and `C3200`, Cisco `cBR-8`, CommScope `E6000` and the
Harmonic `CableOS Reef RPS`. Three of them call themselves CCAP in their own descriptions; `C3200` is
a CMTS chassis and CableOS is a virtualised one, so treat "CCAP" as the family rather than the count.
All **164** DOCSIS ports measured across **32** devices are upstream-capable today, so the fix holds.
Re-counted on 2026-11-12 through `derivePortHardware()` rather than by grepping the JSON: **164** coax ports on
**32** devices, every one of them offering an upstream medium — `docsis-30-us` on all 164, `docsis-31-us` on 132,
alongside `docsis-30` 132, `docsis-31` 14, `moca-11` 164 and `moca-25` 20. The six rates above are the media's own
`speedMbps` values, and the reach is set per medium too: **300 m** for all four DOCSIS entries, **100 m** for both
MoCA ones.

Reproduce the count without trusting this paragraph:

```bash
node -e "const{loadCatalog}=require('./devices/registry'),media=require('./engine/media');
  const n={},devs=new Set();let ports=0;
  for(const s of loadCatalog())for(const i of (s.interfaces||[])){
    const hw=media.derivePortHardware(i,s);if(!hw)continue;
    const list=(hw.media||[]);if(!(hw.cage==='coax'||list.some(m=>/^(docsis|moca)/.test(m))))continue;
    ports++;devs.add(s.vendor+'/'+s.model);for(const m of list)n[m]=(n[m]||0)+1;}
  const r=m=>m+' '+media.MEDIA[m].maxRangeM+' m';
  console.log(ports+' coax ports on '+devs.size+' devices '+JSON.stringify(n));
  console.log(['docsis-30','docsis-31-us','moca-11','moca-25'].map(r).join(', '));"
```

It prints `164 coax ports on 32 devices {"moca-11":164,"docsis-30":132,"docsis-30-us":164,"docsis-31-us":132,"moca-25":20,"docsis-31":14}`
and then `docsis-30 300 m, docsis-31-us 300 m, moca-11 100 m, moca-25 100 m`. The first line is also why this
section exists: grepping the JSON for `docsis` matches the **description** and returns no port at all, so a text
search reports zero — the media list is derived, and only `derivePortHardware()` knows it.

Of the five cable-access chassis named above, exactly **three** say CCAP in their own description —
Casa `C100G`, Cisco `cBR-8` and CommScope `E6000` — while `C3200` and the Harmonic `CableOS Reef RPS` do not, which
is why "CCAP" reads as the family and not as the count.

An **MCX** connector (CMTS RF modules, small-cell gear) resolves to the coax cage: the shapes
differ, and every real install reaches the plant through an MCX-to-F jumper, which is the adapter
the model assumes rather than making forty ports uncablable. `CAGE_ALIAS.mcx` is `'coax'`
(`media.js:392`), and all forty such ports on this tree are the CommScope `E6000`, whose
`interfaces` carry `"type": "coax"` *and* `"connector": "mcx"` — a census that tests one field and stops
sees ordinary coax and misses them.

## XFP is not SFP+

XFP came before SFP+ and is a different size: 10 Gbit/s only, and an **SFP+ module does not seat in
an XFP cage**. That distinction survives in access equipment, which is where it bites - OLT uplink
cards are still built with XFP:

| Card | Uplinks |
|---|---|
| FiberHome HU2A | 2 x 10GE **XFP** + 2 x GE SFP/electrical combo |
| FiberHome HU1A / HU1B | 4GE + 1 x 10GE |
| Huawei H801X2CA | 2 x 10GE **XFP** |
| Huawei H801X2CS / H802X2CS | 2 x 10GE **SFP+** — the `H802X2CS` is the SyncE variant of the same board |

Modelling HU2A's 10G ports as SFP+ would let a lab cable a module that physically will not seat, so
the engine refuses it:

```
canMate(xfpPort, sfpPlusPort)
// { ok: false, code: 'E_CONNECTOR_MISMATCH', ... }
```

The two same-numbered Huawei cards are the clearest illustration of why the cage is a hardware fact
rather than a label: **X2CA and X2CS are both "2x 10GE"**, and only the last letter tells you whether
the optic is XFP or SFP+.

Measured on 2026-11-12, and the table is thinner than it looks: the catalogue holds **exactly two XFP ports in the
whole tree**, `xge1/1` and `xge1/2` on the FiberHome `AN5516-01`, both `speedCaps: [10000]`, alongside that board's
two modelled GE combo pairs (`ge1/1` + `ge1/1-sfp`). No Huawei port is XFP. The `MA5600T` carries **48 DSL, 4 SFP
and 2 SFP+** ports — the X2CS row is modelled, the **X2CA row is notes-only**, and so is the HU1A/HU1B row. The
card facts themselves live in the two specs' `notes` fields (`devices/fiberhome/an5516-01.json`,
`devices/huawei/ma5600t.json`), which also list a third FiberHome board the table omits: **GU6F, 6xGE**.

The cage is narrow by construction, which is why the refusal matters more than the count: `CAGE_MEDIA.xfp()` returns
only `['10gbase-sr', '10gbase-lr', '10gbase-er']` (`media.js:548`), `CAGE_SPEEDS.xfp()` returns `[10000]`
(`media.js:705`), and `CAGE_MATE.xfp` is `['xfp']` — an XFP cage mates with XFP and nothing else, so the engine cannot
offer an SFP+ module there even by accident.
