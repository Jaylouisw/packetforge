# The board chapter that would close the E9600 family names the carrier subracks, not E9605/E9612/E9624

Measured 2026-11-18, 07:05-07:25 UTC, crawler user-agent. Nothing is added to `devices/`; #807, #808
and #810 stay open. What changes is the *shape* of the blocker: the client-board census this family is
waiting for is not missing from Huawei's documentation — it is missing from Huawei's *public* copy of
it, and when it is read it does not use the enterprise subrack names the specs would need.

## 1. The census exists, and a reprint shows exactly what it says

`TNG1N210` is the board the threads name (`10 x 10 Gbit/s line service processing board`). Its chapter
carries, verbatim in a reseller reprint read today
(`https://www.thunder-link.com/tng1n210.html`, HTTP 200, 659,498 B):

> Valid Slots — OSN 9800 M24 subrack: In 1:1 mode: IU1-IU24. In 1:3 mode: IU1-IU5, IU8-IU17,
> IU20-IU24. OSN 9800 M12 Subrack: IU1-IU13. 9800 M05 Subrack: IU1-IU5.

and the port census that goes with it: *"80 x ODU0/40 x ODU1/80 x ODUflex/10 x ODU2 <-> 10 x OTU2"* and
*"10 x ODU2e <-> 10 x OTU2e"*, WDM-side `OTU2/OTU2e`, pluggable list all `SFP+ -10G`, single-slot
board, 237.1 x 30.5 x 220 mm, 64 W typical / 67 W maximum.

A reprint is a lead and not admissible as a source, so this closes nothing. It does fix the search
target: the document to ask a licence-holder for is the **TNG1N210 chapter of the *OptiXtrans E9600
Board Datasheet*** (`EDOC1100163901`), table 1.9 plus its port-specification section.

## 2. The naming split this exposes

| table | subrack names it prints | counts |
|--|--|--|
| frame chapter `TNG2DAP` §1.9 (vendor, public) | OptiXtrans **E9605 / E9612 / E9624 / E9624X** | IU1-5 / IU1-13 / IU1-24 |
| board chapter `TNG1N210` §1.9 (reprint) | OptiX **OSN 9800 M05 / M12 / M24** | IU1-5 / IU1-13 / IU1-24 (M24: 20 in 1:3) |

The two tables agree slot for slot — 5, 13, 24, and the M24 1:3 set (5 + 10 + 5 = 20) is exactly what
the E9624 footnote produces by removing IU6, IU7, IU18 and IU19. The board documentation simply predates
(or sits outside) the enterprise rename, so an N210 chapter supplies the port census and the placement
rule but **not the sentence that pairs `E9605` with `M05`**. Request 807's row already accepts an OSN 9800
board chapter as admissible for validity; what this measurement adds is that the join with the enterprise
label stays an inference (identical slot counts, plus Huawei's own `OptiXtrans E9600 (OptiX OSN 9800)`
document titles) rather than a vendor statement.

Huawei does state the equivalence, at title level: the E9605 support page lists
`OptiXtrans E9600 (OptiX OSN 9800) V100R023C00 Feature Description`
(`https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e9605-pid-250732995`,
HTTP 200, 436,367 B). That is a title, not a board table, and it is not enough on its own.

## 3. The carrier product page finally prints the twin's slot count

`https://e.huawei.com/en/products/optical-transmission/osn-9800` — HTTP 200, 348,972 B — spec table
columns `OSN 9800 M12 / OSN 9800 M24 / OSN 9800 U32 Enhanced`:

| parameter | M12 | M24 |
|--|--|--|
| Dimensions (H x W x D) | 347.2 x 442 x 295 mm | 747.2 x 442 x 295 mm |
| Number of Service Slots | **13** | **12/24** |
| Cross-connect Type | N/A | ODUk/PKT/VC |

13 and 12/24 at 347.2 mm and 747.2 mm are the E9612 and E9624 figures, from a vendor page (13 is the
E9612's E3CTU DC build; see request 808 for the AC/HVDC variants). It does not name the E-series, so it
corroborates the twin reading without replacing it.

## 4. A reusable fetch route, and the negative result it gave

`https://e.huawei.com/en/documents/products/<family>/<32-hex>` pages (the brochure/datasheet hub) carry
the asset path in a hidden input, `id="attachmentUrl"`, pointing at
`e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/<hash>/<token>/<name>`. `scripts/huawei-material-fetch.js`
already matches that form, so it resolves these pages too when given the full URL rather than a bare
hash. Tested on the OSN 9800 M Series 26H2 brochure
(`.../documents/products/enterprise-optical-network/e498e35a8877406ea6e95623a43353f0`, 200, 266,031 B;
attachment 20,242,639 B, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`):
text layer contains `TNG1N` 0, `TNG1M` 0, `TNV` 0, `TMB` 0, `IU1` 0. A brochure is not a census, and
this one is not an exception.

## 5. What this leaves

Unchanged in substance, sharper in wording: **one vendor copy of the N210 chapter**, read together with
the E96xx slot table above and a stated protection mode, or the requester's own build
(`E9605, 5x TNG1N210` · `E9612, 13x TNG1N210` · `E9624, 1:1, 24x TNG1N210`). Do not write the spec from
the reprint: it would carry a plausible port list under a subrack name its own source never prints.
