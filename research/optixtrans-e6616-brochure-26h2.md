# The 26H2 E6616 brochure adds a fourth switch option and still carries no board table

Follow-up to `research/optixtrans-e6616x-brochure-editions-disagree.md` (PR #1986, #803). That note
established that the E6616**X** brochures disagree with themselves and that the only board part number any
Huawei-hosted E6616X document names is `TM65UXCL` - the system-control/cross-connect board. This pass went
at the sibling's newest brochure, because a family brochure is where a service-board table would sit if one
were published anywhere, and found a fourth switch option the cited chassis chapter does not list. It also
found, and measured, the only public index of E6600-generation board chapters - and every link in it is dead.

Nothing here closes #803: the service-board census is still absent.

## 1. The artifact

| field | value |
|--|--|
| title | *OptiXtrans E6616 V100R026C00 Product Brochure* (26H2) |
| landing page | <https://e.huawei.com/en/documents/products/enterprise-optical-network/dc67ba7b606b46df975107406dafb0a1> - 200, 45,213 B, server-rendered, asset path in the HTML |
| asset | <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/dc67ba7b606b46df975107406dafb0a1/M3T1A590N1296416246227165363/OptiXtrans%20E6616%20V100R026C00%20Product%20Brochure.docx> - 200, `application/docx`, **515,695 B**, read 2026-11-18, crawler user-agent |

`word/document.xml` stripped of tags yields 8,191 characters - the whole document is the specification
table plus one ASON note, which is why every field below is verbatim rather than paraphrased.

## 2. What it publishes that the cited chapter does not

The spec currently cites OptiXtrans E6600 V100R025C10 chapter 1 for the fabric. That chapter's *Current
subrack capacity* table lists three switch boards; the 26H2 brochure lists a fourth, unified one:

| item | 26H2 brochure |
|--|--|
| OTN cross-connect | K5SXCH 2.8 Tbit/s; K5XCH 2.4 Tbit/s; K6XCH 2.8 Tbit/s; **K5UXCME 920 Gbit/s** |
| OSU cross-connect | **K5UXCME 920 Gbit/s** |
| Packet switching | **K5UXCME 920 Gbit/s** |
| SDH cross-connect | K5SXCH 140 Gbit/s VC-4; K5UXCME 160 Gbit/s VC-4; K5XCS 160 Gbit/s VC-4 (all 20 Gbit/s VC-3/VC-12) |
| fgOTN capacity | K1XCL 40 Gbit/s; K1FXCL 100 Gbit/s |
| Maximum single-channel rate | 400 Gbit/s |
| Line rate | 1.25 / 2.5 / 10 / 25 / 100 / 200 / 400 Gbit/s |
| Pluggables | SFP/eSFP, XFP/TXFP, SFP+/TSFP+, QSFP+, **CFP/CFP2**, QSFP28, SFP28 |
| Weight, empty | 10.6 kg DC; 12.3 kg AC dual PSU; **14.5 kg AC four PSU** |
| Installation | 19-inch; ETSI 300 mm A63B/N63B/N63E; **ETSI 600 mm A66B**; **F01M500** |
| Service slots | DC 14; AC 12 |

Two of those rows are corrections a cable actually notices. A shelf built with `TMK5UXCME` is a
**~0.9 Tbit/s** box, not a 2.4-2.8 Tbit/s one - the catalogue's fabric note named only the three
2.4/2.8 T boards, so it read as if every E6616 were in the multi-terabit class. And the 400 Gbit/s
single-channel figure contradicts the V100R025C10 chapter, which caps a slot at 200 Gbit/s ODUk. Both
are recorded here rather than silently resolved: the modelled build (`14x B1LDCD`, a 100G/200G line side)
is unaffected by either, and choosing between the two vendor statements without the release notes would
be a guess, which is the thing this stream does not do.

## 3. What it still does not publish

Character census of those 8,191 characters:

| token | occurrences |
|--|--|
| `E6616X` | **0** |
| `TMB1` / `TMK1` | 0 |
| `TM65` | 0 |
| `TMK` | 10 - all K5/K6 **system-control** boards in the ASON and protection notes |

So the 26H2 brochure is E6616-only, and the `K5SXCH`/`K6XCH`/`K1XCL` rows are short forms of system
boards, not a service-board table. "Number of slots for service boards: DC chassis 14" is still the last
word: a slot count with no card behind it.

## 4. The one public index of E6600 board chapters indexes dead links

`https://www.actfornet.com/solutions/solution/OptiXtrans_E66000_Boards_Overview` (partner mirror, 200,
226,637 B) is the only page found that enumerates the generation's board chapters by name - about forty of
them, grouped Optical Transponder / OTN Tributary / Universal Line / Packet / SDH / PDH / EoS / PCM /
Amplifier / System control, each labelled with its port count: `TMK1EX10` "10 x 10GE Ethernet Processing
Board", `TMK1TDC` "2-port 100G tributary", `TMB1LDCD` "4-channel 100 Gbit/s to 2-channel OTUC2", and so on.

Every link points at the same document:

```
https://support.huawei.com/hedex/pages/EDOC1100156575BEJ09044/01/EDOC1100156575BEJ09044/01/resources/1800v/hd/pkg/tmk1ex10/tmk1ex10.html
  -> 302  Location: /hedex/hdx.do?docid=EDOC1100156575&tocURL=resources%2F1800v%2Fhd%2Fpkg%2Ftmk1ex10%2Ftmk1ex10.html&tocLibId=BEJ09044&tocLibVer=01&ui=1
https://support.huawei.com/hedex/api/pages/EDOC1100156575/BEJ09044/01/resources/1800v/hd/pkg/tmk1ex10/tmk1ex10.html
  -> 404  18 B  "No doc data found."
https://support.huawei.com/hedex/api/navi/EDOC1100156575/first-level-tree
  -> 404  57 B  {"status":404,"message":"No doc data found.","data":null}
```

This is the same answer `research/optixtrans-hedex-content-api.md` measured on `EDOC1100126589` and
`EDOC1100625542`, now on a third document id: the hedex content API does serve the redirect that carries
`tocLibId`/`tocLibVer`, and does not serve the chapter text to an anonymous caller. The index is useful as
a **name list** - and one negative datum: no `TM65*` **service** board appears anywhere in it. The only
`TM65` order codes on any reachable artifact are still chassis assemblies (`TM65K31AFB` ... `TM65K36AFB`,
from a partner price list), i.e. the X's frame, not its cards.

## 5. A second vendor document that names the X without a board

`Railway Optical Communication Solution (Online version)` -
<https://e.huawei.com/marketingcloud/pep/asset/20000001/Material/62113cc2ccab46328b57d124f8d24690/M3T1A669N1228650085115334895/Railway%20Optical%20Communication%20Solution_Online%20version.pdf>,
200, 6,116,746 B, `pdftotext -layout` clean. It names the X exactly once, in a device-comparison row
("E6608 / E6616/E6616X / E9612 / E9624/E9624X"), and carries **zero** `TMK`/`TMB` tokens. A solution
document is a stated deployment, so it was worth one fetch; it states none.

## 6. What changed in the catalogue, and what did not

`devices/huawei/optixtrans-e6616.json` now names `TMK5UXCME` (920 Gbit/s OTN/OSU/packet) in the fabric
note and description, with the 26H2 brochure cited, and records the 400-vs-200 Gbit/s discrepancy in the
notes. `fabric.capacityMbps` is unchanged at 2,800,000 because the modelled build uses the K5SXCH-class
shelf the label describes - a fabric figure follows the stated build, not the best board in the family.

For #803 the blocker is unchanged and exact: a `TM65*` (or any) **service** board whose chapter states
(a) the part number, (b) validity in the E6616X subrack and in which slots, (c) the front-panel census.
The frame arithmetic is vendor-sourced and waiting: DC 14 service slots (1-14), AC 12 at 1500 W,
AC 10 at 2400 W.
