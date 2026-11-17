# The E9600 family has a fourth subrack, and it is not an E9624

Follow-up to `research/optixtrans-board-chapters-public.md` and `research/optixtrans-client-board-chapters.md`,
which record the client-board wall for #807 / #808 / #810. This note is about a different mistake that the
same wall makes easy: **`OptiXtrans E9624X` is a separate product**, it appears in Huawei's own board
documentation beside the three subracks the queue asks for, and it is *not* on the E9600 family page. Anyone
answering #810 from a search hit can pick up the X's numbers and ship a box that does not exist.

Checked 2026-11-17. Vendor material only.

## 1. The family page prints three subracks and no fourth

`https://e.huawei.com/en/products/optical-transmission/optixtrans-e9600` — HTTP 200, 344,531 B, crawler UA,
server-rendered. The Specifications table has exactly three columns, `OptiXtrans E9624 | OptiXtrans E9612 |
OptiXtrans E9605`, and the string `E9624X` occurs **zero** times in those bytes. So the family page is not
where the fourth subrack lives, and a reader who stops there would conclude the family is three models.

## 2. The fourth subrack has its own page, with its own specification table

`https://e.huawei.com/en/products/optical-transmission/optixtrans-e9624x` — HTTP 200, 339,739 B, same
server-rendered shape. Verbatim rows:

| Parameter | Huawei OptiXtrans E9624X |
|--|--|
| Dimensions (H x W x D) | 825 x 442 x 295 mm |
| Number of Service Slots | 12/24 |
| Cross-Connect Type | SDH/OTN/fgOTN/PKT |
| Rate per Channel (Maximum) | OTN+TDM：10Gbit/s Ponder：400Gbit/s |
| Services | SDH, PDH (E1 & TPS), Ethernet, SAN, OTN |
| Power Supply | -48V DC/-60V DC |

Huawei's own framing on the same page: *"An intelligent all-optical converged transport platform designed for
enterprise production networks … used in core industries, including electric power and transportation"*, with
*"384 E1 access channels in a single subrack"* and *"480G Synchronous Digital Hierarchy (SDH) VC4 + 40G SDH
VC3/VC12"* — an SDH-first platform.

## 3. Set against the E9624, only the slot count is shared

| Parameter | OptiXtrans E9624 (family page, §1) | OptiXtrans E9624X (§2) |
|--|--|--|
| Subrack height | 747.2 mm (442 x 295 x 747.2) | **825 mm** (825 x 442 x 295) |
| Service slots | 12/24 | 12/24 |
| Cross-connect type | ODUk/PKT/VC | **SDH/OTN/fgOTN/PKT** |
| Max. rate per channel | 1.2 Tbit/s | **10 Gbit/s OTN+TDM, 400 Gbit/s ponder** |
| Power supply | -48/-60 V DC, 220/110 V AC, 240/336 V HVDC | **-48/-60 V DC only** |

Same slot arithmetic, different backplane, different height, different pluggable rate, and no AC or HVDC
option. This is the same class of error the catalogue has already corrected once on this family — the
E6608T modelled from the E6608 (see `research/optixtrans-e6600-xt-census.md` §2) — and the catalogue holds no
E9624X entry, so there is nothing to correct today, only something to avoid.

## 4. Huawei's board documentation treats the four subracks as one table

From the public `TNG2DAP` chapter (already cited by #807 / #808 / #810):

- §1.9 *Valid Slots*, Table 1 — four devices, so a fourth subrack is not a typo or a reseller SKU:

  | Device | Number of Occupied Slots | Physical Slot | Logical Slot |
  |--|--|--|--|
  | OptiXtrans E9605 | 1 | IU1, IU2, IU3, IU4, IU5 | IU1, IU2, IU3, IU4, IU5 |
  | OptiXtrans E9612 | 1 | IU1 to IU13 | IU1 to IU13 |
  | OptiXtrans E9624 | 1 | IU1 to IU24 | IU1 to IU24 |
  | OptiXtrans E9624X | 1 | IU1 to IU24 | IU1 to IU24 |

- §1.6 *Functions and Features* — the split is functional, not cosmetic: `Opticallayer ASON | E9605/E9612/E9624
  subrack: Supported` and, on the next row, `Opticallayer ASON | E9624X subrack: Not supported`.

## 5. The X's own board datasheet is behind the same wall as the E9600's

`https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e9624x-pid-251792361` — HTTP 200,
436,521 B, crawler UA. Its *Datasheet* block links `OptiXtrans E9624X Board Datasheet` to
`/enterprise/en/doc/EDOC1100214449?idPath=24030884|9856748|9858640|250707904|251792361`. That URL, with and
without the `idPath`, answers:

```
HTTP/1.1 302 Moved Temporarily
Location: /view/notFound
```

which is byte-for-byte the behaviour of `EDOC1100163901`, the E9600 Board Datasheet already recorded as
withheld. So the wall now covers **two named board datasheets**, not one, and neither is a search problem.

The same page's *Product Brochure* link (`/en/documents/products/enterprise-optical-network/05062a0bc9a84a5f9642a37e14d67b97`)
is dead: HTTP 200 with a 336,300 B shell whose rendered text starts `404` and which carries **zero**
`pep/asset/…/Material/…` paths, and `node scripts/huawei-material-fetch.js 05062a0bc9a84a5f9642a37e14d67b97 <dir>`
reports `no asset path in the page - this material page serves no downloadable file`.

## 6. The E9605 frame half, re-read from the chapter, unchanged

`https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/cc7356212e6146b58f38b74dd1102e08/M3T1A669N1188254859704168616/OptiXtrans%20E9605%20-.pdf`
— HTTP 200, `application/pdf`, 117,447 B, 2 pp. It opens by naming the application: *"The OptiXtrans E9605 is
an optical subrack product that meets the requirements of miniaturized OLA/ROADM sites."* Slot table verbatim:

| Area | Composition | Slot | Function |
|--|--|--|--|
| Power and interface area | Two PIU/APIU boards; two EFI boards | PIU/APIU: IU100-IU101; EFI: IU71-IU72 | EFI *"offers maintenance and management interfaces, and provides implement inter-NE communication"* |
| Fan areas | One fan tray assembly | IU90 | — |
| Service board areas | 5 service boards | IU1-IU5 | *"Service boards need to be configured based on the service plan"* |
| System control and cross-connect board area | Two CTU boards | IU73-IU74 | 1+1 backup, *"manage and provide clock signals for all other boards"* |

That confirms the registry row for #807 (5 service slots, CTU at IU73-IU74) rather than correcting it — and it
also shows why an "empty shelf" entry is not a way to close #807: with no service board fitted, the only
cabled interfaces Huawei documents for the subrack are the EFI maintenance ports, and the shelf is defined by
the boards that go in IU1-IU5.

## 7. What is still missing, and what would unblock

Unchanged, and now stated for two products rather than one: **one client/line board chapter with a Port
Specifications table** — a `TNG1N206` (6 x 10 Gbit/s line service processing board), `TNG1N210` (10 x 10
Gbit/s) or `TNG1N401` (1 x 100 Gbit/s) chapter — which `TNG2DAP` §1.9 shows is valid in all four subracks.

What would unblock, in order of preference:

1. `EDOC1100163901` (*OptiXtrans E9600 Board Datasheet*) or `EDOC1100214449` (*OptiXtrans E9624X Board
   Datasheet*), pasted by a reader with support access;
2. one of those board chapters as published PDF, on any host Huawei controls;
3. a stated configuration from the requester (e.g. "E9624, 1:1 mode, 24 x TNG1N210") plus that board's port
   table.

Then #810 becomes `E9624 (24x TNG1N210)` — a stated card complement, the convention `devices/huawei/optixtrans-e6616.json`
already uses — and no field is guessed. For #807 the same chapter yields `E9605 (5x TNG1N210)`.
