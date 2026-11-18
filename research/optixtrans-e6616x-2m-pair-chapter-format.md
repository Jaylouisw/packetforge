# The E6600 board chapters prove compatibility, not slots — and the TMB2DMS chapter exists only on mirrors

Re-check of request #803 (Huawei OptiXtrans E6616X), 2026-11-18 19:2x-19:4x UTC. The previous pass ended
by naming the next step exactly: *"a Huawei board chapter whose Valid Slots table names E6616X — now with
named candidates: `TMB2PD1`, `TMB2DMS`, `TMB2TPS` for the 2M path"* (`research/optixtrans-e6616x-
deployment-board-inventory.md` §6). This pass walked that step. Two results, one of them a correction to
the instruction itself.

## 1. The three named candidates, searched on the route that worked before

The e-file route is the only one that has ever yielded an anonymous Huawei board chapter: `(6)-UXCME`
and `(21)-TMB3AUX` were found by search-engine hit on an opaque
`/marketingcloud/pep/asset/20000001/Material/<32-hex>/M3T1A669N<19 digits>/<board>.pdf` path
(`research/optixtrans-e-file-numbered-bundle.md`). Same instrument, this pass, five queries:

| query | result |
|--|--|
| `site:e-file.huawei.com TMB2DMS` | no asset PDF; the `site:` hits are storage/FusionCompute documents that merely mention TMB |
| `"TMB2DMS" site:huawei.com` | nothing on any Huawei host |
| `"TMB2DMS" filetype:pdf` | unrelated biochemistry datasheets (TMB = tetramethylbenzidine) |
| `"TMB2DMS" "E6616X"` | one Huawei support page (product/document index, below) and noise |
| `"TMB2DMS单板" 面板 32路E1/T1 有效槽位` | three reseller pages and one partner solution page |

**No Huawei-hosted chapter exists for `TMB2DMS`, `TMB2PD1` or `TMB2TPS` on any index this host can reach.**
The numbered E6600 bundle was already enumerated exhaustively and holds no client board, so this is
consistent with that measurement rather than contradicting it: the 2M pair simply is not among the
chapters Huawei publishes anonymously.

## 2. What the mirrors carry — and the correction

Two reseller pages reprint the Huawei board chapter **verbatim**, including the table numbering (`表12`),
the 替代关系 note and the 机械指标/功耗 tables:

- `https://www.szhuaxunjia.com/product/2298.html` — *TMB2DMS 32路E1/T1电接口出线板*, page updated 2024-09-30;
- `https://www.szhuaxunjia.com/product/2297.html` — *TMB2PD1 支路业务处理板*, same date.

Verbatim from the DMS reprint:

> 接口规格 | 支持32路75Ω/120Ω的E1接口或者100Ω的T1接口。
> 面板 | TMB2DMS单板的面板上有单板指示灯和接口。

and table 12, 配套关系:

| 单板 | 配套设备 | 配套主控板-交叉板 | 配套主控交叉的起始版本 |
|--|--|--|--|
| TMB2DMS | E6608 | TMK2UXCL / TMK2UXCLE | V100R021C00SPC200 |
| | **E6616X** | **TM65UXCL** | **V100R022C10SPC010** |
| | E6616 | TMK5SXCH / TMK5UXCME | V100R021C00SPC300 |
| | | TMK5XCS | V100R021C10SPC200 |

The PD1 reprint carries the same four rows and adds the sentence this thread has been waiting for in a
different form: *"TMB2PD1单板的面板上无接口，由DMS接口板提供75Ω/120Ω E1接口或100Ω T1接口"* — the PD1
has no ports, the DMS does, and the pair is what presents 32 x E1/T1.

**The correction.** §6 of the previous note asks for a chapter "whose Valid Slots table names E6616X".
The E6600 family does not have that table. Two E6600 board chapters were read end to end on 2026-11-17
(`(6)-UXCME`, `(21)-TMB3AUX`) and both carry **zero** occurrences of "Valid Slots"; the mirrored DMS and
PD1 chapters carry none either — their compatibility section is a **配套关系 (companion equipment)** table
that names the accepted subracks and the cross-connect board each needs. That is the E6600 chapter format,
and it is a different instrument from the E9600 chapters, which do print a Valid Slots table with slot
ranges. So the standing unblock criterion was aimed at a section that will never appear for this family.
The artifact that answers the question is the **TMB2DMS chapter itself**; its 配套关系 table is what names
the X.

## 3. Why this still does not write a spec

Everything in §2 is on a reseller reprint. `docs/RESOLUTIONS.md` and the E6616 spec's own notes both
record the rule: a field may not rest on a re-hosted page, and this project's most-repeated correction is
a spec that quotes a document it did not read. Three specific gaps survive the reprint:

1. **No vendor-hosted copy.** The text is Huawei's, the host is not; the same numbers on
   `e.huawei.com`/`e-file.huawei.com`/`support.huawei.com` would be a citable source, and none of the five
   queries finds one.
2. **No slot cost.** The chapter states the interface, not how many service slots the DMS or the PD1
   occupies. Rather the mirror's own dimensions disagree with the arithmetic in the presales deck: DMS is
   listed at 193.80 x 40.10 x 205.90 mm against PD1's 96.40 x 19.80 x 161.50 mm, i.e. two different board
   form factors, while the deck prices the 1*DMS+2*PD1 assembly at "2 Slot". A fourteen-slot complement
   cannot be derived from either figure.
3. **No line side.** The Ningbo deployment record lists no line or SDH board for the X
   (`research/optixtrans-e6616x-deployment-board-inventory.md` §2), and the mirrored chapters are 2M
   tributary boards only. A subrack with 32 E1 ports and no uplink is not the metro aggregation node #803
   asks for.

One near-miss worth recording so it is not mistaken for the answer: `https://actfornet.com/solutions/
solution/OptiXtrans_E66000_Boards_Overview` is titled *OptiXtrans E6600(E6608T E6608 E6616) Boards
Overview* — the same document the E6616 spec records as gated (`EDOC1100156575BEJ09044`) — but its
content index serves a stub to a non-JS fetch (one heading, "Optical Transponder Board"), its indexed
fragment prints the PDH section as `TMB1DMS: 32 x E1/T1 switching board`, and its title covers
E6608T/E6608/E6616, not the X. The B1 generation and the wrong three subracks.

## 4. What would answer #803 now (narrower than the last ask)

1. **The TMB2DMS chapter, Huawei-hosted.** `EDOC1100558549` (OptiXtrans E6600 V100R025C10 硬件描述) is the
   newest edition the Chinese product page lists and answers 401 `NOT LOGIN!` to an anonymous crawler; its
   TMB2DMS section (§功能和特性, §面板, §配套关系) is the whole of the missing field. Any of the six editions
   on that page answers the same question.
2. **A Huawei-hosted PDF of the same chapter** on the e-file asset route that produced `(6)-UXCME`, if
   Huawei ever publishes the client-board chapters there.
3. **A commissioning record or NE inventory export** giving one built subrack: `E6616X, TM65K32AFB,
   slots 1-14: n x TMB2DMS, n x TMB2PD1, <line board>`.

The spec that gets written the moment (1) or (3) lands is a stated build in the shape #803 asks for —
`OptiXtrans E6616X (1x TMB2DMS + 1x TMB2PD1 + <line board>)` — with the 32 x E1/T1 panel traced to the
chapter and the slot arithmetic to the chassis chapter already read
(`research/optixtrans-e6600-chassis-chapters.md`). No field in `devices/` changes today.
