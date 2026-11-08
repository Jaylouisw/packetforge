# Hybrid UPC/APC patch cords

**Status:** design note + parts catalogue for issue #18. Documentation and data
only — no engine, web or device changes.
**Files:** `docs/HYBRID-PATCH.md` (this file), `catalogue/optics/hybrid-patch-cords.json`.
**Related:** [CONNECTORS.md](CONNECTORS.md) §4.2 (the hybrid cord escape hatch),
`engine/optical.js` (`patchCords`, `hybridCord`, `cordFits`, `cordLossDb`),
`engine/validation.js` (the `E_POLISH_MISMATCH` / `E_PATCH_CORD_*` block),
`test/hybrid-cord.test.js`.

---

## 1. The physical fact

An SC/APC ferrule is ground at 8°; an SC/UPC ferrule is flat. Push them
together and they touch along one edge only. The result is an air gap at the
core, roughly 2–3 dB of excess loss, a large reflection back into the laser, and
a good chance of chipping the angled endface or scratching the flat one. This is
why `engine/media.js` refuses the pair with `E_POLISH_MISMATCH` rather than
warning about it.

A **hybrid patch cord** does not mate the two polishes. It is a single fibre with
a UPC connector factory-terminated on one end and an APC connector on the other.
Each ferrule is polished for the socket it will meet at *that* end of the link;
the polish change happens inside the assembly, along the fibre, where there is no
ferrule-to-ferrule interface at all. Nothing is ground flat against something
angled, so there is no air gap and nothing to chip.

Two consequences drive every rule below:

1. The polish is a property of a **ferrule at a termination**, not of the fibre.
2. A cord can only change polish where a cord can physically be plugged in —
   at a port, a panel, or an adapter. It cannot do anything in the middle of a
   span, because the middle of a span has no ferrules.

---

## 2. What is in the catalogue

`catalogue/optics/hybrid-patch-cords.json` — 13 real, purchasable assemblies from
8 vendors. Ten are pure polish bridges (`polishBridge: true`, same connector shape,
opposite polish); three are shape *and* polish hybrids, catalogued because they
exist but marked `polishBridge: false` (see §4.3).

| # | Part number | Vendor | End A | End B | Fibres | IL (dB) | Length | Source |
|---|-------------|--------|-------|-------|--------|---------|--------|--------|
| 1 | SMSCSX | FS.com | SC/UPC | SC/APC | 1 | 0.3 max/conn | 1/2/3 m | [fs.com](https://www.fs.com/products/96103.html) |
| 2 | ADAEP-ARYL003 | 3M | SC/UPC | SC/APC | 1 | 0.3 typ/conn | 3 m | [3M PDF](https://multimedia.3m.com/mws/media/1090868O/3m-fiber-optic-patch-cords-and-pigtails-data-sheet.pdf) |
| 3 | FJ1-SCUSCAL-03P | Siemon | SC/UPC | SC/APC | 1 | 0.40 max/conn | 3 m | [Siemon PDF](https://files.siemon.com/en/specsheet/siemon-xglo-simplex-singlemode-lc-and-sc-jumpers_spec-sheet.pdf) |
| 4 | FCA-S2SR-SCASCU-02M | L-com | SC/APC | SC/UPC | 1 | 0.3 max/conn | 2 m | [l-com.com](https://www.l-com.com/sc-apc-sc-upc-9-125-single-mode-simplex-fiber-patch-cable-os2-2-meter-fca-s2sr-scascu-02m) |
| 5 | OCJ-S1-05MASIA-S2 | CommScope | SC/UPC | SC/APC | 1 | 0.5 (grade C) | 5 m | [commscope.com](https://www.commscope.com/product-type/cable-assemblies/fiber-cable-assemblies/fiber-patch-cords/item2160363-5/) |
| 6 | SMLCSX | FS.com | LC/UPC | LC/APC | 1 | 0.3 max/conn | 1/2/3 m | [fs.com](https://www.fs.com/products/123906.html) |
| 7 | FJ1-LCALCUL-03P | Siemon | LC/APC | LC/UPC | 1 | 0.40 max/conn | 3 m | [Siemon PDF](https://files.siemon.com/en/specsheet/siemon-xglo-simplex-singlemode-lc-and-sc-jumpers_spec-sheet.pdf) |
| 8 | SMLCDX | FS.com | LC/UPC | LC/APC | 2 (duplex) | 0.3 max/conn | 1/2/3 m | [fs.com](https://www.fs.com/products/177395.html) |
| 9 | FCA-LALU-DPS2Z-05 | L-com | LC/APC | LC/UPC | 2 (duplex) | 0.3 max/conn | 5 m | [l-com.com](https://www.l-com.com/fiber-optic-patch-cable-lc-apc-lc-upc-duplex-9-125-single-mode-os2-lszh-5-meter-fca-lalu-dps2z-05) |
| 10 | F923RANSNSNM001 | Panduit | SC/APC | SC/UPC | 2 (duplex) | 0.5 max/conn | 1 m | [panduit.com](https://www.panduit.com/en/products/fiber-optic-systems/fiber-optic-cable-assemblies/fiber-optic-interconnects-patch-cords-pigtails/f923ransnsnm001.html) |
| 11 | FCA-SALU-DPS2P-02 | L-com | SC/APC | LC/UPC | 2 (duplex) | 0.3 max/conn | 2 m | [l-com.com](https://www.l-com.com/fiber-optic-patch-cable-sc-apc-lc-upc-duplex-9-125-single-mode-os2-ofnp-2-meter-fca-salu-dps2p-02) |
| 12 | F225801G1Z20007M | Corning | LC/APC | SC/UPC | 1 | 0.25 max/conn | 7 m | [Corning spec sheet](https://ecatalog.corning.com/optical-communications/EMEA/en/generate-product-specsheet/F225801G1Z20007M.pdf) |
| 13 | N366-02M-AP | Eaton Tripp Lite | LC/UPC | SC/APC | 2 (duplex) | 0.30 | 2 m | [Tripp Lite PDF](https://assets.tripplite.com/product-pdfs/en/n36602map.pdf) |

Coverage: SC/UPC↔SC/APC simplex (5 parts), LC/UPC↔LC/APC simplex (2), duplex
same-shape (3), shape+polish hybrids (3). Both argument orders appear, on purpose —
`hybridCord()` is order-independent and the catalogue should prove it.

A note on the numbers: only Siemon, Panduit and Corning publish a numeric **max**
per connector. CommScope publishes a **grade** (IEC 61755-1 Grade C, whose ceiling
is 0.50 dB, with Grade B at 0.25 dB on request). 3M publishes a **typical**
(0.3 dB), FS publishes a flat "≤0.3 dB" family spec, and L-com's SKU pages state
that the assembly is "100% tested for insertion loss" while the numeric 0.3 dB max
comes from the sibling assembly datasheets. That distinction matters when you pick
a part for a budget — see §6.

---

## 3. When a hybrid cord is correct

A hybrid cord is the right answer when **all** of these hold:

1. **The mismatch is at a termination.** One port and one socket, facing each
   other, with two ferrules that do not seat (SC/UPC module ↔ SC/APC ODF port,
   SC/APC pigtail ↔ SC/UPC ONT). This is the case issue #18 is about: vendor OLT
   PON modules ship SC/UPC (`FS GSFP-43-20C`, `XGS-SFP-52-20N2I`) while the ODN
   side is SC/APC.
2. **The connector shapes match.** SC-to-SC or LC-to-LC. A shape difference is a
   different problem with a different answer (§4.3).
3. **The polishes differ, one UPC and one APC.** Two UPC ends or two APC ends
   need an ordinary cord; a hybrid part there is simply the wrong part.
4. **Both ends are reachable by a cord.** Equipment-to-panel, panel-to-equipment,
   ONT-to-wall-box. If the two ends are kilometres apart, the polish question is
   not the one you are solving.
5. **The part is factory-terminated and you can name it.** The whole value of the
   cord is that the transition happens under factory polish and test. A UPC cord
   with a field-install APC connector on one end is a re-termination, not a
   conversion, and it carries field loss and field return loss.
6. **The loss and the return loss fit** (§6). The cord costs real dB, and its UPC
   end caps the link's return loss.

If all six hold, declaring the cord is not a workaround — it is the same thing a
field engineer does, expressed as a part number. If any of them does not hold, no
cord makes the link correct.

---

## 4. When a hybrid cord is NOT acceptable

### 4.1 In the middle of a span

**A hybrid cord cannot repair a span; it can only terminate one.** A span is
fibre, splices and closures. Polish lives on ferrules at the ends. Splicing joins
glass — a fusion splice has no polish, and no splice can turn a UPC pigtail into
an APC one. Putting a cord "in the middle" means adding two mated pairs, two
more connector bodies and two more dirt/reflection points into a run, and you
cannot do it at all inside a buried or aerial span.

If a span ends in the wrong polish, the answers are: re-terminate (fusion-splice
a pigtail of the right polish in a closure or ODF), or land it on a panel and
patch from there. Both are terminations. Neither is a cord mid-span.

### 4.2 Where no polish change is needed

- **UPC↔UPC or APC↔APC:** ordinary cord. Declaring a hybrid part here is the
  wrong part and the engine says so (`E_PATCH_CORD_ENDS`) — the cord's two ends
  are not the two cages in front of you.
- **One end already right:** if the OLT is SC/UPC and the ODF is SC/UPC, you do
  not need a hybrid; you need the ODN side re-terminated or a UPC→APC panel port.

### 4.3 Across connector shapes (LC ↔ SC, anything ↔ MPO)

A hybrid cord changes polish, not geometry: 1.25 mm ferrule versus 2.5 mm,
different adapter sleeve, different latch. Shape changes need an **adapter panel
plus two cords**, which is exactly why `CAGE_MATE` has no adapter entry and
`E_CONNECTOR_MISMATCH` is not a polish error.

Parts 11–13 in the catalogue are shape *and* polish hybrids (Corning LC/APC–SC/UPC,
L-com SC/APC–LC/UPC duplex, Tripp Lite LC/UPC–SC/APC duplex). They are real and
purchasable, and they are listed so nobody has to rediscover them — but they are
marked `polishBridge: false`. The engine will not use them to rescue a mismatch:
`hybridCord()` only returns a part when both cages are the *same shape* with
different polishes, and `validateConnection` only re-tests the pair when the
refusal was `E_POLISH_MISMATCH`. Declaring one on an LC↔SC link gives
`E_CONNECTOR_MISMATCH` with no cord-based rescue, which is the correct verdict.

### 4.4 Where the panel does not cooperate

A hybrid cord does not convert an adapter either. The APC end must land in an
APC (green) adapter and the UPC end in a UPC (blue) one. If the ODF only has
UPC adapters, a hybrid cord does not get you to an APC pigtail field — you need
the right adapter, or an APC pigtail landed on an APC adapter.

### 4.5 As a daisy-chain

Two hybrids back to back is not a way to walk a polish across two hops: that is
four connectors, two extra mated pairs, and two more things to clean. If a design
needs two polish changes, it has one termination too many.

### 4.6 Where return loss is the binding constraint

The cord's UPC end is flat: ≥50 dB return loss, against ≥60 dB on the APC end.
The link's reflectance is set by its worst connector, so a hybrid cord gives you
an APC-grade path at one end and a UPC-grade path at the other. For GPON that is
irrelevant (G.984.2 sets a 32 dB ODN return-loss floor, cleared with margin); for
analogue video overlay, RFoG, or any plant with an operator reflectance budget
tight enough to have specified APC in the first place, the UPC end is the weak
point. If both ends must be APC-grade, the fix is an SC/APC OLT module, not a
cord.

### 4.7 As a flag on a link

The cord is a specific assembly with two specific endfaces, not a permission bit.
If the model let `patchCord: true` (or an arbitrary part number) suppress
`E_POLISH_MISMATCH`, every future topology would silently claim hardware nobody
ordered. `E_PATCH_CORD_ENDS` and `E_PATCH_CORD_UNKNOWN` exist to keep the part
number honest.

---

## 5. What the engine must refuse regardless

| Code | Condition | Should it ever be relaxed? |
|------|-----------|----------------------------|
| `E_POLISH_MISMATCH` | Same shape, different polish, **no cord declared** | No. This is the physical failure. The message now names the part that would fix it (`engine/validation.js:574-579`), which is the useful form of the refusal. |
| `E_POLISH_MISMATCH` | Same shape, different polish, cord declared but `cordFits()` false | No. A wrong part bridges nothing; the code clears `cord` so the pair fails on physics, not on paperwork. |
| `E_PATCH_CORD_ENDS` | Declared part's ends are not the two cages on the link | No. This is how "one part, two endfaces" stays true. |
| `E_PATCH_CORD_UNKNOWN` | Part number not in the catalogue | No. Unknown hardware is not hardware. |
| `E_CONNECTOR_MISMATCH` | Different shapes, **with or without a cord** | No. Only `E_POLISH_MISMATCH` is rescuable (`validation.js:550`); shape is not. |
| `E_MEDIA_NOT_SUPPORTED` | Cord bridges, but the ports share no bridged medium | No. `commonMediaBridged()` returning empty means the two services were never the same service. |

Deliberately **not** refused today, and worth a follow-up decision:

- A declared part with `polishBridge: false` on a same-shape pair. It cannot
  happen with the current 13 entries (the three false entries are shape hybrids,
  so they fail `cordFits` on shape), but a future bad entry — say an APC/APC
  assembly — would pass `cordFits` on a `sc-apc`↔`sc-apc` link and then quietly
  do nothing. A `E_PATCH_CORD_NOT_A_BRIDGE` check on `cord.polishBridge === false`
  would close that hole.
- A cord declared on a link where the polishes already match. Today
  `cordFits` catches it only because the ends are UPC/APC; an ordinary
  UPC/UPC assembly added to the catalogue later would not be caught. The
  `polishBridge` field gives the loader the information to refuse it properly.

---

## 6. Loss budget treatment

### 6.1 The double-count nobody wants to discover in the field

`ponBudget()` charges `connectorPairs × CONNECTOR_LOSS_DB` — default 2 pairs at
0.3 dB = 0.6 dB — and then adds `patchCordLossDb` on top
(`engine/optical.js:105-134`). But **vendor insertion loss for a patch cord is
per connector**, i.e. per mated pair:

| Vendor | Published figure | Basis |
|--------|------------------|-------|
| Corning | 0.25 dB | max, per connector |
| Siemon | 0.40 dB | max, per connector |
| Panduit | 0.50 dB (SC OS2), 0.25 dB (LC OS2) | max, per connector |
| 3M | 0.3 dB | typical, per connector |
| FS.com | ≤0.3 dB | family spec, per connector |
| L-com | 0.3 dB | max, per assembly datasheet |

The cord's two connectors **are** the OLT-side and ODN-side mated pairs in a
simple OLT↔ODN link. Charging 0.3 dB for the cord *and* 0.6 dB for two pairs
counts the same two interfaces twice. It is only 0.3 dB, but on a 1:64 budget
that is the difference between headroom and a red link — and it is the kind of
number an engineer notices.

### 6.2 Three ways to charge it, and what this catalogue does

`insertionLossBasis` on every entry says which of these you are looking at:

- **`per-connector-max`** — a worst case you can budget directly (Corning,
  Siemon, Panduit, L-com).
- **`per-connector-typical`** — 3M's number; do not use it as a ceiling.
- **`iec-61755-1-grade-c-max`** — CommScope quotes a grade, not a dB figure;
  Grade C is the 0.50 dB ceiling, Grade B the 0.25 dB option.

Recommended budgeting, in order of preference:

1. **Charge the delta, not the total** (works with today's engine, no code
   change). If the cord's per-connector loss is within the 0.3 dB already assumed
   per mated pair, `patchCordLossDb = 0`, because the two connector losses are
   already in `connectorPairs`. For a 0.40 dB cord charge 0.1 dB; for a 0.50 dB
   cord charge 0.2 dB. This keeps the number honest without double counting.
2. **Basis-aware accounting** (the clean fix, needs an engine change):
   `ponBudget` adds `cord × 2` for `per-connector-*` parts and `cord` for
   `per-assembly` parts, and the caller drops `connectorPairs` by the number of
   cord ends. The catalogue already carries the field needed to do this.
3. **Charge the published number as-is** (what `patchCordLossDb: 0.3` does now).
   Defensible as a conservative over-estimate, but it should then be documented
   as "cord plus its two mated pairs", not "the cord".

Whatever the choice, it should be one of these on purpose, and it should be the
same in the docs, the tests and the UI.

### 6.3 Duplex cords

A duplex assembly is two fibres with four connectors. A GPON or XGS-PON path uses
one fibre per direction on a single strand (1310 up / 1490 or 1577 down), so the
path is charged **once**, not twice. Duplex matters for the connector count and
for polarity, not for the per-path budget.

### 6.4 Worked example

GPON class B+ (28 dB), 1:32 split, 12 km span, 4 splices, OLT and ONT mated pairs:

| Element | dB |
|---------|----|
| Fibre, 12 km @ 1490 nm (0.25 dB/km) | 3.00 |
| Splitter 1:32 | 16.50 |
| Splices, 4 × 0.1 | 0.40 |
| Connector pairs, 2 × 0.3 | 0.60 |
| Hybrid cord, charged as delta (SMSCSX, 0.3/conn) | 0.00 |
| **Total** | **20.50** |

Charging the cord's 0.3 again gives 20.80 dB — still inside 28 dB, so this
particular link survives either convention. The 1:64 case (20.5 dB splitter)
does not have the same slack, which is why the convention has to be written down
rather than left to whoever reads the datasheet last.

---

## 7. `catalogue/optics/hybrid-patch-cords.json`

### 7.1 Loader status — the parts are live

**This section used to say the file was inert. It is not.** `engine/optical.js`
loads `odn.json` and `hybrid-patch-cords.json` together (`ODN_FILES`), so every assembly in
this catalogue is selectable by part number or catalogue id:

```js
const ODN_FILES = ['odn.json', 'hybrid-patch-cords.json'];
```

Parts are keyed on the orderable part number. Where both files describe the same part
(`SMSCSX`, `SMLCSX`), the `odn.json` record keeps its identity and the hybrid record fills
the gaps it does not have — `polishBridge`, `insertionLossBasis`, vendor — and its catalogue
id is kept as an `aliasIds` entry so either id resolves. Records with no part number (a
splitter has a model and a ratio, not a stock number) are appended rather than merged.
A missing or malformed file is skipped, not fatal, so a checkout without this catalogue
still runs.

**Selection rules** (`engine/validation.js`):

| Situation | Outcome |
|---|---|
| Same connector shape, different polish, cord declared on the link | Accepted, `ok: true`, with warning `W_HYBRID_CORD` naming the part and its loss |
| Same connector shape, different polish, no cord declared | Refused `E_POLISH_MISMATCH`, naming the part that would fix it and its dB |
| Same connector shape, different polish, no catalogue part bridges them | Refused, saying so: *"No hybrid patch cord in the catalogue … bridges these two polishes"* |
| Different connector **shape** | Still `E_CONNECTOR_MISMATCH` — a cord cannot fix geometry, and `polishBridge: false` assemblies are never offered |
| Cord declared between two ports of the *same* polish | `E_PATCH_CORD_ENDS`; the cord is cleared, so nothing is bridged, recorded or charged |

A cord must fit at **both** ends (`cordFits()` compares connector and polish, order
independently), so a cord is chosen per link rather than per device.

**Loss is charged, not absorbed.** The accepted verdict carries `patchCord` and
`patchCordLossDb`; `ponBudget({ patchCordLossDb })` charges the cord exactly as it charges a
splice. A branch that fits bare but not once corded is refused on `E_OPTICAL_BUDGET` — for
loss, not for polish, which is the honest reason.

**Ordering is still user-visible.** `hybridCord()` returns the first match, so an
`sc-upc`↔`sc-apc` refusal names `SMSCSX` (FS, 0.3 dB) because it comes first in the file.
Adding a part above it changes the part number printed in the refusal. If that instability
ever matters, prefer an explicit `"default": true` entry over relying on file order.

### 7.2 Schema

Every entry validates against this schema (JSON Schema draft-07; the same
`kind`/`model`/`connector`/`insertionLossDb`/`returnLossDb`/`bidirectional`/
`wavelengthNm`/`sourceUrl`/`note` shape as `odn.json`, plus the fields the
hybrid lookup needs):

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://packetforge.dev/schema/hybrid-patch-cords.json",
  "title": "Hybrid UPC/APC patch cord catalogue",
  "type": "array",
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "kind", "id", "partNumber", "vendor", "model",
      "endA", "endB", "connector", "duplex",
      "fiber", "lengthM", "insertionLossDb", "insertionLossBasis",
      "returnLossDb", "polishBridge", "bidirectional",
      "wavelengthNm", "sourceUrl", "note"
    ],
    "properties": {
      "kind":            { "const": "patch-cord" },
      "id":              { "type": "string", "pattern": "^patch-cord-hybrid-[a-z0-9-]+$" },
      "partNumber":      { "type": "string", "minLength": 1 },
      "vendor":          { "type": "string", "minLength": 1 },
      "model":           { "type": "string", "minLength": 1 },
      "endA":            { "$ref": "#/definitions/cage" },
      "endB":            { "$ref": "#/definitions/cage" },
      "connector":       { "enum": ["sc", "lc", "mpo"] },
      "duplex":          { "type": "boolean" },
      "fiber":           { "enum": ["smf", "mmf"] },
      "fiberGrade":      { "type": "string" },
      "jacket":          { "type": "string" },
      "lengthM": {
        "type": "array",
        "minItems": 1,
        "items": { "type": "number", "exclusiveMinimum": 0 }
      },
      "insertionLossDb": {
        "oneOf": [
          { "type": "number", "minimum": 0 },
          {
            "type": "object",
            "required": ["min", "max"],
            "additionalProperties": false,
            "properties": {
              "min": { "type": "number", "minimum": 0 },
              "max": { "type": "number", "minimum": 0 }
            }
          }
        ]
      },
      "insertionLossBasis": {
        "enum": [
          "per-connector-max",
          "per-connector-typical",
          "per-assembly-max",
          "per-assembly-typical",
          "iec-61755-1-grade-c-max",
          "iec-61755-1-grade-b-max"
        ]
      },
      "returnLossDb": {
        "type": "object",
        "required": ["upc", "apc"],
        "additionalProperties": false,
        "properties": {
          "upc": { "type": ["number", "null"] },
          "apc": { "type": ["number", "null"] }
        }
      },
      "polishBridge":    { "type": "boolean" },
      "bidirectional":   { "const": true },
      "wavelengthNm": {
        "type": "array",
        "minItems": 1,
        "items": { "type": "integer" }
      },
      "sourceUrl":       { "type": "string", "format": "uri" },
      "note":            { "type": "string", "minLength": 20 }
    }
  },
  "definitions": {
    "cage": { "enum": ["sc-upc", "sc-apc", "lc-upc", "lc-apc"] }
  }
}
```

Field notes:

| Field | Meaning |
|-------|---------|
| `id` | Stable catalogue id. `patchCord()` matches `id` as well as `partNumber`, so a topology can survive a vendor renumbering. |
| `endA` / `endB` | The two cages this assembly terminates in, in the engine's cage ids (`engine/media.js` `FERRULE`). Order is not significant to `cordFits()`; the vendor's own order is kept for readability. |
| `connector` | Shape of the assembly. When `endA` and `endB` differ in shape this is the shape of the **A** end, and `polishBridge` must be `false`. |
| `duplex` | `true` for two-fibre zipcord. Not used by `cordFits()`; needed for polarity, RJ45-style ordering and the "charge per path, not per cord" rule in §6.3. |
| `insertionLossDb` | The number the vendor publishes. Number or `{min,max}` — the same shape `cordLossDb()` and the splitters already accept. |
| `insertionLossBasis` | What that number means. Without this field the budget cannot tell a per-connector max from a per-assembly typical, and §6.2 becomes guesswork. |
| `returnLossDb` | Per-polish minimum return loss, because a hybrid cable has two different ones and the link inherits the worse. |
| `polishBridge` | `true` only when the two ends are the **same shape** with **different polish** — i.e. a part `hybridCord()` may return. `false` for shape+polish hybrids, which the engine models as `E_CONNECTOR_MISMATCH`. |
| `lengthM` | Stocked lengths, longest-first is not implied. Custom-length families list the stocked ones and say so in `note`. |
| `note` | Why the entry exists, what the vendor actually measured, and any trap (per-connector vs per-assembly, grade instead of dB, sibling SKU with a different polish). |

Invariants worth a test when the loader lands:

```js
// every polishBridge entry is same-shape, different-polish
j.filter(p => p.polishBridge).every(p =>
  media.ferrule(p.endA).shape === media.ferrule(p.endB).shape &&
  media.ferrule(p.endA).polish !== media.ferrule(p.endB).polish);
// every !polishBridge entry is NOT that
j.filter(p => !p.polishBridge).every(p =>
  media.ferrule(p.endA).shape !== media.ferrule(p.endB).shape);
// ids and part numbers unique; sourceUrl present; IL positive
```

### 7.3 Adding a part

The bar is the same one `odn.json` sets: a real, orderable assembly with a
vendor or distributor page that states the connector types, the polish at each
end, and an insertion loss. Concretely:

1. Find the vendor page or datasheet (not a marketplace listing that re-sells an
   unbranded assembly).
2. Record `partNumber` exactly as orderable, plus `vendor` and the `sourceUrl`
   you actually read.
3. Set `endA`/`endB` from the datasheet's connector description, mapping polish
   to the engine's cage ids — green SC is `sc-apc`, blue SC is `sc-upc`;
   "SC" with no polish letter is UPC.
4. Set `insertionLossBasis` from the wording: "max" → `…-max`, "typical" →
   `…-typical`, "per assembly" → `per-assembly-*`, a standard grade →
   `iec-61755-1-grade-*`.
5. Set `polishBridge` honestly. A part that changes shape is not a bridge, even
   if it also changes polish.
6. Put the traps in `note` — the sibling SKU with the other polish, the plenum
   variant, the length suffix rules.
7. Keep the array flat and the key order consistent; the loader is an append, and
   diffs stay readable.

---

## 8. Open questions for the maintainers

1. **Loader:** fold `hybrid-patch-cords.json` into `odnParts()` (recommended), or
   merge these entries into `odn.json` and keep one file? One file is simpler;
   two files keep ODN plant and hybrid assemblies separable. This change assumes
   two, with a one-line append.
2. **Loss accounting:** adopt the delta convention (§6.2 option 1) as the
   documented meaning of `patchCordLossDb` now, or wait for basis-aware
   accounting (option 2)? The field is already in the catalogue data, so option 2
   is a small engine change whenever someone wants it.
3. **`polishBridge` enforcement:** add `E_PATCH_CORD_NOT_A_BRIDGE` so a
   `false` part can never sit on a link quietly?
4. **Shape hybrids:** should `CAGE_MATE` grow a modelled adapter (LC↔SC) so parts
   11–13 become usable, or does the "no adapter without a panel" rule stand? The
   current doc position is that it stands, and the parts stay catalogued but
   unusable — which is honest, if unsatisfying.
5. **Default part:** `hybridCord()` returns the first match, so the refusal
   message depends on file order. Add an explicit `default: true`, or sort by
   loss?
