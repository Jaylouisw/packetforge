# The E9600 board census is public. The port census is not — and the engine has no port type to hold it

Follow-up to `research/optixtrans-slot-census.md`. That file settled the *frame* arithmetic for the five
OptiXtrans requests (#803 E6616X, #804 E6608T, #807 E9605, #808 E9612, #810 E9624) and named the one
missing field: **the board part number per slot**. This pass went looking for it and found it — but found a
second blocker underneath it that no earlier pass had recorded, and that one is not a sourcing problem.

## 1. The boards are named, per subrack, in vendor documentation

Huawei's OptiXtrans E9600 product documentation carries a "boards supported per subrack" matrix, reprinted
verbatim by a partner (ActForNet, `https://www.actfornet.com/solutions/solution/OptiXtrans_E9600_Boards_Overview`,
read 2026-11-17) with `Y` / `NA` per subrack column. The mirror is not a vendor URL, so treat the matrix as
a *lead*, not as evidence; the vendor page it mirrors is
`https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e9605-pid-250732995`
(Datasheet → "OptiXtrans E9600 Board Datasheet", 2026-04-03 listing).

What the matrix says, restricted to the **E9605** (the narrowest frame, 5 service slots):

| Board family | E9624 | E9612 | **E9605** |
|--|--|--|--|
| OTN line boards `TNG1N206` (6x10G), `TNG1N210` (10x10G), `TNG1N401` (1x100G) | Y | Y | **Y** |
| OTN tributary boards (`TNG1T206`, `TNG1T212`, `TNV1T410`, `TNV2T601`, …) | Y | NA | **NA** |
| Packet boards (`TNV2E224`, `TNV3E402`, …) | Y | NA | **NA** |
| Optical transponder units (`TNG1M210D`, `TNG1M402`, `TNG1M520SM`, `TNG2M604SM`, …) | Y | Y | **Y** |
| General service (`TNG1A212`), mux/demux (`TNG2UD40`, `TNG3M48`, `TNG2M60`, …), ROADM (`TNG2WSMD9`, `TNG2DWSS20`, `TNG2TMD20`, `TNG3ADC0824`) | Y | Y | **Y** |

So the E9605 is **not** a small OTN cross-connect with tributary cards: it hosts line boards, transponder
units, amplifiers and mux/ROADM boards only. Its client-side ports can only arrive as the client side of a
`TNG1M*` wavelength-conversion board or as the line ports of a `TNG1N*` board. Ten board rows, not the ~40
the E9624 accepts.

Port counts are printed in the board names themselves (same documentation set; corroborated by the
HCIP-Transmission board table, `TNG1N206` = "6 x 10 Gbit/s line service processing board", `TNG1N210` =
"10 x 10 Gbit/s line service processing board", with front-panel silkscreens `T1/R1`–`T10/R10`):

`TNG1N206` 6 x 10G · `TNG1N210` 10 x 10G · `TNG1N401` 1 x 100G · `TNG1T206` 6 x 10G · `TNG1T212` 12 x 10G ·
`TNV1T410` 10 x 100G · `TNV2T601` 1 x 400GE · `TNG1M210D` 10 x any-rate + 2 x OTU2 · `TNG1M402`
2 x 100G → 1 x 200G/100G · `TNG1M404DM` 4 x 40G → 2 x 100G · `TNG2M604SM` 4 x 100G → 1 x 400G/200G.

That is enough to write `OptiXtrans E9605 (5x TNG1N210)` = 50 x 10G ports without guessing a single number.

## 2. The second blocker: there is no port type to file an OTN line port under

`devices/*.json` ports resolve through `engine/media.js`. The types the engine knows are
`ethernet, wireless, console, usb, coax, dsl, powerline, serial, pon` (the catalogue uses the first eight;
`pon` exists for OLTs), and the cages are Ethernet/storage ones: `rj45, sfp, sfp+, sfp28, combo, qsfp+,
qsfp28, qsfpdd, qsfp56, sfp56, xfp, fc-sfp …, cfp2, sc-apc, lc-upc, lc-apc, …`.

A `TNG1N210` front-panel port is an **OTU2/OTU2e WDM-side optical port** whose published module list is
SFP+ optics (10 km / 40 km / 80 km, DWDM 100 GHz and 50 GHz tunable, CWDM). Filed as `type: "ethernet",
connector: "sfp+"` — the only combination the engine will accept today — that port becomes an Ethernet
socket: `CAGE_MEDIA['sfp+']` offers 10G Ethernet media and the link layer will happily join it to a 10G
Ethernet peer, which is precisely the class of bug this catalogue exists to prevent ("a guessed array is a
bug that only shows up when a lab refuses to cable"). The physical cage is right; the *protocol* claim is
wrong, and there is no `otn` / `wdm` / optical-line type to say so.

Adding one is an engine change (`engine/media.js` type table plus the faceplate renderer), which this
stream is explicitly not allowed to make. So the family is blocked on **two** fields now, in this order:

1. board part number per slot — **now available** (above);
2. a port type that can represent an OTN line port — **not available, and not a document**.

## 3. Sources checked this pass (2026-11-17), and what each returned

| URL | Result |
|--|--|
| `https://e.huawei.com/marketingcloud/pep/asset/20000001/Material/0f9e00e3f2ca431693884a01667d7ec6/M3T1A669N1188254857740624027/OptiXtrans%20E9600%20Family%20-.pdf` | HTTP 200, 277,705 bytes. Vendor brochure: "Max. number of service board slots — 1:1 cross-connect mode: 12 large slots or 24 small slots; 1:3 cross-connect mode: 10 large slots or 20 small slots (E9624); 13 (E9612); 5 (E9605)". No board list, no port census. |
| `https://e.huawei.com/en/products/optical-transmission/optixtrans-e9600` | spec table, three model columns, slot counts and `Cross-connect Type: NA` for E9612/E9605 — unchanged since 2026-11-16. |
| `https://support.huawei.com/hedex/pages/EDOC1100126589BEJ09047/03/EDOC1100126589BEJ09047/03/resources/help/wdm/9800/hd/line/n210/n210.html` | **HTTP 403** (536 bytes) to a crawler user-agent — the board description that would settle client-vs-WDM sides. |
| `https://support.huawei.com/enterprise/en/doc/EDOC1100624531` ("OptiXtrans E9600 Board Datasheet") | 404, body `This document cannot be found.` (unchanged since 2026-11-16). |
| `https://www.actfornet.com/solutions/solution/OptiXtrans_E9600_Boards_Overview` | HTTP 200 — partner mirror of the board matrix above. Lead only. |

## 4. What would unblock each request

- **#807 E9605 / #808 E9612** — board list is settled; needs an `otn` port type (or a project decision to
  model WDM line ports as a distinct non-Ethernet port). Stated configuration ready to write:
  `E9605 (5x TNG1N210)` = 50 x 10G OTU2 line ports.
- **#810 E9624** — same, plus the protection mode in the label (`1:1` 12/24 slots vs `1:3` 10/20).
- **#803 E6616X / #804 E6608T** — the E6600 matrix has not been read against the board documentation yet;
  same two-blocker shape expected, DC vs AC slot count still to be carried into the label.

No spec is added by this file: the frame arithmetic and the card arithmetic are both public, the port type
is not, and a mislabelled port is worse than a missing device.
