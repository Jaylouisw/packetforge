# Two Extreme 48-port SFP+ leaves were cabled as copper: the connector was never declared

Found by `node scripts/audit-port-types.js` on 2026-11-20, in its own section - *"Template ports at
10G+ presented as RJ45 copper on a box that describes itself as SFP"* - which listed exactly two
models, both Extreme:

```
- extreme/VSP 7254XSQ  48/48 template ports at 10G (1:1 -> rj45)
- extreme/X690-48x-2q-4c  48/48 template ports at 10G (1:1 -> rj45)
```

## 1. Why it is a bug and not a gap

Neither spec declared a `connector` on its `portTemplate`, and 10G is not in the engine's optical
rate list, so the faceplate renderer fell back to the copper cage: a 48-port fibre leaf was drawn as
48 RJ45 sockets that would accept a patch lead. That is the #60 shape (FortiGate 80F/600E/200G)
arriving through the template path instead of through a written `connector: "rj45"`. A lab cabling a
DAC into "port 1:1" would be told to plug into a copper socket that does not exist.

The descriptions were already right ("48x 1G/10GBASE-X SFP+", "48x 1G/10G SFP+"), so nothing
contradicted the drawing: the specs simply stated nothing where the engine needed a cage.

## 2. Vendor sources, verbatim

| model | vendor surface | wording |
|--|--|--|
| X690-48x-2q-4c (17350) | *X690 Series Switch Quick Reference*, 121148-00, <https://documentation.extremenetworks.com/HW_QRG/121148-00_x690_qrg.pdf> | "X690-48x-2q-4c Base unit, **48 1Gb/10Gb SFP+ ports**, 2 10Gb/40Gb QSFP+ ports, 4 10Gb/25Gb/40Gb/50Gb/100Gb QSFP28 ports" - and, in the front-panel legend, "1Gb/10GBASE-T ports (48t model) **or** 1Gb/10Gb SFP+ ports (48x model)" |
| VSP 7254XSQ | *VOSS 8.9 User Guide*, "VSP 7200 Series", <https://documentation.extremenetworks.com/VOSS/SW/89/VOSSUserGuide/GUID-9364F72C-5FD5-4F86-ACCF-4D0C63C690E0.shtml> | "The **VSP 7254XSQ has 48 SFP/SFP+ fiber ports**. The VSP 7254XTQ has 48 RJ-45 copper ports." / "Slot 1 is the grouping of the 48 10 Gbps ports on the left. Slot 2 is the grouping of the 6 40 Gbps ports on the right." |

Both quotes are read from the PDF text layer / the server-rendered page respectively, 2026-11-20.
The X690 figure is the *datasheet* sentence, not the port legend alone, which is why the 48-port
cage count and the mixed rate (1G/10G) are both sourced rather than inferred from the model name.

The X690's copper twin is a *different part number* (X690-48t-2q-4c, 17360: "48 1Gb/10GBASE-T
ports") and the VSP's is the 7254XTQ, so "the 48 ports are fibre" is a vendor statement about the
exact SKU, not a family guess.

## 3. What changed

`devices/extreme/x690-48x-2q-4c.json` and `devices/extreme/vsp-7254xsq.json`:

- `portTemplate` gains `connector: "sfp+"` and `speedCaps: [1000, 10000]` (both SKUs are 1Gb/10Gb per the
quotes above; the VSP note is why 1G stays listed - the PHYless 7254XSQ runs 1000BASE-T SFP
AA1419043-E6 at 1 Gbps only);
- `1:49`/`1:50` (X690) and `2:1`-`2:6` (VSP) gain `connector: "qsfp+"`, `speedCaps: [10000, 40000]`;
- X690 `1:51`-`1:54` gain `connector: "qsfp28"`,
`speedCaps: [10000, 25000, 40000, 50000, 100000]` - the datasheet sentence spells that ladder out;
- both specs gain a `sourceUrl` (they carried none) and a `notes` field quoting the vendor line, so the next
pass does not re-derive which of the two SKUs is copper.

No port count, rate or capability changed: 54 sockets on each model before and after.
`docs/CONNECTORS.md` was regenerated (973 -> 974 distinct port shapes).

## 4. Effect on the audit

Before: 96 template ports in 2 specs at 10G+ drawn as RJ45 on a box that describes itself as SFP.
After: that section is empty. Undeclared template ports fell 2,800 -> 2,704 (126 specs), which is
the remaining population of the same *cause* (a template that states no cage); those mostly infer
correctly from the port name, and each one still needs its own datasheet before a connector can be
written.

## 5. Not touched

`vsp-7254xtq` (10GBASE-T) is not in the catalogue, so there is no copper twin to keep consistent; if
it is added later, its 48 ports are `rj45`, per the same VOSS sentence that names the XSQ as fibre.
