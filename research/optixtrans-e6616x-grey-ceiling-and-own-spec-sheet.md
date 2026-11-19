# The E6616X has its own spec sheet, and it is grey-only — which is why E6616's boards cannot stand in

Re-check of request #803 (Huawei OptiXtrans E6616X), 2026-11-18 23:5x UTC. The previous pass left one
step: a board part number valid in an E6616X, with its front-panel census. This pass did not find one.
It did close the sibling-substitution question with the vendor's own numbers, and it repaired the
instrument that is needed to fetch a chapter the day one appears.

## 1. The E6616X is not an AC variant of the E6616 — it has its own spec sheet

`OptiXtrans E6616X Product Brochure` —
`https://e.huawei.com/marketingcloud/pep/asset/20000001/Material/6fffa7f348f9475081b17eb1fc591b10/M1T1A669N837008945971838990/OptiXtrans%20E6616X%20Product%20Brochure.pdf`,
HTTP 200, `application/pdf`, **216,145 B**, md5 `6f217c3b057a42e86d927a3d18aca7e5`, 4 pages,
6,037 characters of text layer. Under *Product Specifications (E6616X)* it states:

| field | E6616X |
|--|--|
| dimensions (H x D x W) | 221.5 x 220 x 442 mm |
| weight | 10.6 kg DC / 12.3 kg AC (dual PSU) |
| number of service board slots | DC chassis: 14, AC chassis: 12 |
| OTN cross-connect | 680 Gbit/s |
| OSU cross-connect | 680 Gbit/s |
| SDH cross-connect | 160 Gbit/s higher order, 20 Gbit/s lower order |
| packet switching | 800 Gbit/s |
| maximum rate per channel | **100 Gbit/s (Gray light)** |
| line rate | 2.5 Gbit/s, 10 Gbit/s, 100 Gbit/s (Gray light) |
| pluggables | SFP/eSFP, XFP, SFP+, QSFP+, TXFP, QSFP28, SFP28; electrical GE SFP |

The brochure names **no board part number and no port count**: `TMB` occurs 0 times, `TMK` 0 times, and
the four occurrences of "board" are prose ("board replacement", "intra-board 1+1 protection"). The
frame is now vendor-sourced field by field; the population is not stated anywhere in the document.

## 2. The same table on the product page, and the merged cell that will mislead a flat text dump

`https://e.huawei.com/en/products/optical-transmission/optixtrans-e6600` — HTTP 200, 339,756 B,
md5 `0d66ab2750b69fc2597ee095ede950c1`; the specification table inside it is 3,182 B. Read as HTML rather
than as flattened text, its four product columns are E6616 / E6608 / E6608T / E6616X and two rows merge
cells:

- `Maximum Number of Wavelengths` — three cells `DWDM: 96 CWDM: 8` then `N/A`, and the `N/A` is the
  E6616X cell;
- `Maximum Rate per Channel` — one cell with `colspan="3"` carrying `400 Gbit/s`, then a single cell
  `100Gbit/s（grey）`, which is the E6616X cell.

So "100 Gbit/s grey" and "no wavelength plan" are the vendor's words for the E6616X on **both** the
product page and its own brochure. A flattened dump of that table reads `400 Gbit/s | 100Gbit/s（grey）`
with no column mapping and invites the opposite conclusion; the colspans are what settle it.

## 3. The leaflet class is now measured, not sampled — no service board in it

| document | URL | bytes | text | board part numbers |
|--|--|--|--|--|
| E6616X Product Brochure | `.../6fffa7f348f9475081b17eb1fc591b10/M1T1A669N837008945971838990/OptiXtrans%20E6616X%20Product%20Brochure.pdf` | 216,145 | 6,037 chars | `TMB` 0, `TMK` 0 |
| OptiXtrans E6616 V100R025C10 产品彩页 (.docx) | `https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/6c94817240a44b19bb49566f0634ea9e/M3T1A590N1246470205869879492/OptiXtrans%20E6616%20V100R025C10%20%E4%BA%A7%E5%93%81%E5%BD%A9%E9%A1%B5.docx` | 516,108 | 3,327 chars | `TMB` 0; ten `TMK` mentions, all cross-connect/control/clock: K5SXCH, K5XCH, K6XCH, K5UXCME, K5XCS, K1XCL, K1FXCL |
| Railway Optical Communication Network-Brochure 26H1 (TR) | `https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/00a9d517b714455ca0d59d9d8f2e5a2f/M3T1A669N1272073348910575792/Railway%20Optical%20Communication%20Network-Brochure_26H1_-TR.pdf` | 6,117,094 | 8 pp, 9,542 chars | `TMB` 0, `TMK` 0; board *types* only (EMR8, UXCMS, UNQ2) |

The Chinese leaflet is the first *editable* Huawei document in this thread, and it is the clearest
statement of the pattern: the leaflet class prints cross-connect capacity and part numbers for the
cross-connect boards, never for a service board. That is consistent with `(2)-OptiXtrans E6616-Datasheet`
(1,535,511 B, 20 pp, 22,964 chars), which also carries no service-board table — `TMB1APIU` is the only
`TMB` part it names, and it is a power board.

## 4. Why the catalogue's E6616 row cannot be reused for the E6616X

`devices/huawei/optixtrans-e6616.json` is modelled as **14x B1LDCD** — 4x 100GE QSFP28 client into
2x programmable 100G/200G line (CFP2), i.e. a DWDM muxponder. The E6616X's own sheet caps the per-channel
rate at **100 Gbit/s grey** with line rates of 2.5/10/100 Gbit/s, gives it **no** DWDM/CWDM plan (`N/A`),
and rates its cross-connect at 680 Gbit/s OTN/OSU and 800 Gbit/s packet against the E6616's 2.8 Tbit/s.
A 200G DWDM line board does not fit that box, so the population is not transferable even though the
5U / 14-slot DC / 12-slot AC frame is identical. `E6616X` occurs **0** times in the 22,964-character
E6616 datasheet text, so the document does not claim the boards for both models either.

This is the family-sibling error the catalogue has corrected on UDM PoE, two i-MO console ports and three
MA5801 uplinks, caught before it was made: the frame transfers, the boards do not.

## 5. What is still missing, and it is now one item

- a **service-board part number valid in an E6616X**, and that board's **front-panel port census**.

The frame no longer needs sourcing: 14/12 service slots, 5U, 10.6 kg DC, 680G OTN/OSU, 800G packet,
100G grey per channel, all from the brochure above. What would unblock it is unchanged at the document
level — one authenticated read of `EDOC1100625826` (its board chapters print `配套设备`), the E6616X
Quick Installation Guide `EDOC1100299472`, or a stated configuration of the shape
`E6616X DC (12x <board>)`. `node scripts/huawei-doc-gate-probe.js` still reports 27 gated / 2 public /
1 absent on the 30-id baseline, measured 23:5x UTC today.

## 6. Instrument repair: the material-page fetch had started answering 403

`scripts/huawei-material-fetch.js` is the tool that turns a 32-hex material hash into the chapter PDF,
and every invocation on 2026-11-18 23:5x returned `page 403` with a 428-byte body — the same URL and the
same crawler user-agent that `curl` fetched as **200, 337,802 B** in the same minute. Adding
`accept-language`, `connection: close`, `upgrade-insecure-requests` or a browser user-agent did not
change the 403 from node; the difference is the TLS client, not the headers. The script now uses curl as
its transport when curl is on PATH and keeps the node client as the fallback.

Verified after the fix, same hashes as the record:

| hash | document | bytes |
|--|--|--|
| `621bfc22e8564cf69ae86581569a7594` | `(2)-OptiXtrans E6616-Datasheet`, 20 pp, title resolves | 1,535,511 |
| `104eb87894f1489dac28e58171dca5cc` | `(21)-TMB3AUX` board chapter | 482,177 (identical to the figure in `research/optixtrans-e-file-numbered-bundle.md`) |

Without this, the next pass would have read a 403 on the only anonymous route to a Huawei board chapter
as "the chapter is gone".
