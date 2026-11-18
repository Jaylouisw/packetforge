# The enterprise↔carrier join is a Huawei statement, not an inference — but the ST has no board census

Measured 2026-11-18, 07:2x-07:4x UTC. Nothing is added to `devices/`; #807, #808 and #810 stay open.
What changes is one line of their blocker: `research/optixtrans-board-chapters-name-m-series.md` §2
recorded that "the join with the enterprise label stays an inference". It is not an inference. Huawei
says it, in a document Huawei authored, on a page that is free to read.

## 1. The source

`EUCC-3089-2026-004 Security Target` — *Huawei OptiX OSN 9800 & OptiXtrans E9600 management component
software, V100R024C10SPC100 - ST*, Issue 0.19, dated 2026-10-14, 87 pages,
`application/pdf`, 3,009,787 B, HUAWEI TECHNOLOGIES CO., LTD on the cover
(`https://certification.enisa.europa.eu/document/download/ab9c6a55-bf65-4095-99bb-4e947a28156c_en?filename=EUCC-3089-2026-004%20Security%20Target.pdf`,
HTTP 200). It is a Common Criteria security target, not a datasheet, and that is what makes it useful:
it is a vendor-authored statement of what the hardware *is*, and it has to be specific about chassis.

## 2. The brand join, stated

Page 3 (PDF page 9), verbatim:

> OptiX OSN 9800 is used by both carriers and enterprise networks, and OptiXtrans E9600 is a new
> commercial brand for enterprise networks.

Table 1-1, *SCC used in the evaluated configuration* (printed page 6, PDF page 12) then pairs the
subracks row by row — two brands, one chassis, in the same cell:

| Chassis | SCC type: slot | SCC board identification |
|--|--|--|
| OptiX OSN 9800 M24 / **OptiXtrans E9624** | CXP: IU71, IU72 | TNG4CXP |
| OptiX OSN 9800 M12/M05 / **OptiXtrans E9612 / E9605** | CTU: IU73, IU74 | TME3CTU |
| OptiX OSN 9800 U32E/U64E | CTU: IU70, IU78 | TNU4CTU |
| OptiX OSN 9800 P32/P32C | CTU: IU105, IU107 | TMP2CTU |
| **OptiXtrans E9624X** | HCXP: IU71, IU72 | TNG1HCXP |

The figure captions say the same thing again, one figure per chassis: *Figure 1-4 System architecture of
the OptiX OSN 9800 M24/OptiXtrans E9624*, *Figure 1-5 … M12/OptiXtrans E9612*, *Figure 1-6 … M05/
OptiXtrans E9605*.

So an N210 chapter whose §1.9 says "OSN 9800 M24 subrack: IU1-IU24" describes the same subrack as
`OptiXtrans E9624` — not by matching slot counts and not by a document title, but because Huawei's own
certification document puts both names on one row. The validity half of #810's blocker is answered.

## 3. What the same page adds to the shelf map

The service slots are not the whole subrack. Each device carries **two** SCC boards — *"all OSN Series
devices contain 2 SCC boards"*, active/standby on the management plane — and their slots sit **outside**
the service range the frame tables print:

- E9624: service IU1-IU24 (1:1), plus CXP in IU71 and IU72.
- E9612 / E9605: service IU1-IU13 / IU1-IU5, plus CTU in IU73 and IU74.

Any stated build therefore needs 24 + 2 (E9624), 13 + 2 (E9612) or 5 + 2 (E9605) occupied positions, and
the board that fills the last two is named here (TNG4CXP, TME3CTU) even though neither board's port
census is.

## 4. What the ST does not have

The 87-page text layer contains `TNG1N` **0**, `TNG1M` **0**, `TNG2` **0**, `TMK1` **0** occurrences. No
line card, no client card, no port count for TNG4CXP/TME3CTU/TNG1HCXP. A CC security target describes
the management boundary; it enumerates SCC boards because the TOE runs on them, and stops there.

## 5. Routes measured closed today, so nobody re-walks them

| probe | result |
|--|--|
| `TNG1N210 -.pdf`, `TNG1N206 -.pdf`, `TNG1N401 -.pdf`, `TNG1N402 -.pdf` in the **TNG2DAP asset folder** (`…/Material/e75c775ac71144e6b522d7cef1601604/M3T1A669N1188254864652623965/`) | `403`, `application/xml`, 263 B — S3 `AccessDenied` per key. Control in the same folder: `TNG2DAP%20-.pdf` = 200, 871,676 B. Chapters are one object each with their own token; the filename does not enumerate. |
| `e.huawei.com/en/products/optical-transmission/optixtrans-e9600` | 200, 344,532 B, and it links **no** documents: every `marketingcloud/pep/asset` path on it is an image, and there are zero `/en/documents/` links. |
| E9600 chapters Google has indexed on `e-file.huawei.com` / `e.huawei.com` | `TNG2DAP`, `TNG2SRAPXF`, `TNG3SRAPXF`, and one transceiver (`eSFP,1310nm,1.25Gb/s…`). All optical-layer or pluggable chapters — no `TNG1N*`, no `TNG1M*`. |

Note the fetch detail, because it cost a run: the same asset URL answers `403 text/html` (an Akamai
`Access Denied` page) to a Chrome user-agent and `200 application/pdf` to a crawler user-agent. A 403
from `e-file.huawei.com` is not evidence that a document is missing; a `403 application/xml` with an S3
`<Code>AccessDenied</Code>` body is.

## 6. What this leaves

Unchanged: **one vendor copy of a TNG1N/TNG1M chapter, or the gated `EDOC1100163901` Boards Overview, or
the requester's build in one line** (`E9624, 1:1, 24x TNG1N210` = 240 x 10G line ports; `E9612, 13x`
= 130; `E9605, 5x` = 50). Sharpened: the chapter no longer has to print the enterprise subrack name for
the spec to be honest, because the ST supplies that join — a chapter that names only `OSN 9800 M24` is
now sufficient for E9624, `M12` for E9612, `M05` for E9605.

Do not write a spec from the reprint, and do not write one from this ST: it has no ports.
