# The E9600 board-to-subrack matrix exists, and it is Table 3 of the Boards Overview

Settles #807 (E9605), #808 (E9612) and #810 (E9624) as three specs on one card: the frame
half and the card half are both vendor text, and the one field that was never published —
which subrack accepts a `TNG1N*` line board — is printed in a table nobody had read.

## 1. What the open-request record said was missing

`docs/DEVICE_REGISTRY.md` section "What is left open" carried, for all three requests, the same
sentence, added on 2026-11-18 by `research/optixtrans-dap-slots-are-dap-only.md`:

> no document this project has read states which of those boards a given subrack accepts

That document is right about the document it examined: `TNG2DAP` section 1.9 *Valid Slots* is the
DAP board's own placement table, and `N206`/`N210`/`N401` occur zero times in its 51 pages.
It is wrong as a statement about the document set. The **Boards Overview** chapter — the
same chapter whose board names the registry already cites — carries a second table that is
exactly a board-to-subrack matrix.

## 2. Table 3, read verbatim

`https://www.actfornet.com/solutions/solution/OptiXtrans_E9600_Boards_Overview`
— HTTP 200, 226,637 B, text layer 22,221 B (re-read 2026-11-18; `https://actfornet.com/...`
without `www` is the same page, 226,489 B). It is a partner-hosted scrape of hedex chapter
`EDOC1100126589` *OptiXtrans E9600 (E9624/E9612/E9605) Boards Overview*.

> **OTN Line Boards — Table 3**
> *Mapping between the line boards and OptiXtrans 9800 E9624/E9612/E9605 subrack*
>
> | Board name | E9624 subrack | E9612 subrack | E9605 Subrack |
> |---|---|---|---|
> | TNG1N206 / TNG1N210 | 1:1 mode: Y, 1:3 mode: Y | Y | Y |
> | TNG1N401 | 1:1 mode: Y, 1:3 mode: Y | Y | Y |

and, in the topic list above it, the board's own name:

> `TNG1N210: 10 x 10 Gbit/s Line Service Processing Board`

Two fields, both from Huawei's own text:

1. **Validity.** `TNG1N206`/`TNG1N210` is valid in all three subracks, in both E9624
   cross-connect modes. This is the field the three issues were parked on.
2. **Port count per card.** Ten. The card's name carries its count, which is exactly the
   condition `docs/DEVICE_SCHEMA.md` section "A port list may be a stated build" sets for a build
   being safe ("the card's own name carries its count").

## 3. Frame census, re-fetched today (not taken from the registry)

| document | URL | HTTP | bytes |
|---|---|--:|--:|
| E9600 Family brochure | `.../Material/0f9e00e3f2ca431693884a01667d7ec6/M3T1A669N1188254857740624027/OptiXtrans%20E9600%20Family%20-.pdf` | 200 | 277,705 |
| OptiXtrans E9605 Subrack | `.../Material/cc7356212e6146b58f38b74dd1102e08/M3T1A669N1188254859704168616/OptiXtrans%20E9605%20-.pdf` | 200 | 117,447 |
| OptiXtrans E9612 Subrack | `.../Material/1df5f09736174bdcaed9ea4e9276bf8b/M3T1A669N1188254859888107676/OptiXtrans%20E9612%20-.pdf` | 200 | 333,351 |
| TNG2DAP chapter | `.../Material/e75c775ac71144e6b522d7cef1601604/M3T1A669N1188254864652623965/TNG2DAP%20-.pdf` | 200 | 871,676 |

Host for all four: `https://e-file.huawei.com/marketingcloud/pep/asset/20000001/`. They answer 200
to a `curl/8.4.0` user-agent and 403 to a browser one, which is worth knowing before concluding
"the host is closed" from a 403.

Brochure, "Max. number of service board slots": E9624 **12 large or 24 small** (1:1) /
**10 or 20** (1:3), E9612 **13**, E9605 **5**. Dimensions 747.2 / 347.2 / 177 mm tall.

E9605 chapter, *Descriptions of the areas and slots*: "Service board areas | 5 service
boards | IU1-IU5"; CTU pair IU73-IU74; PIU/APIU IU100-IU101; EFI IU71-IU72; fan IU90;
177 x 442 x 260 mm, 7.6 kg.

E9612 chapter, E3CTU table: DC `IU1-IU13` = **13** service slots; AC/HVDC `IU3-IU13` = 11
(one APIU occupies physical IU1 and IU2, logical IU1). The older AUX+SCC table gives 12
(DC), 10 (AC master), 11 (AC slave). A TMF1EFI is optional and takes IU13 (logical IU72).

E9624: there is **no** subrack chapter in the public set — the E9600 bundle publishes only
the E9605 and E9612 chapters. Its slot count comes from the two documents that do print it,
and they agree: the brochure row above, and `TNG2DAP` Table 1 (`OptiXtrans E9624 | 1 |
IU1 to IU24`) with the footnote *"In the 1:3 mode of an E9624 subrack, service boards cannot
be installed in slots IU6, IU7, IU18, and IU19."* — 24 in 1:1, 20 in 1:3.

## 4. What is stated, what is derived, and what is a build

Stated by a vendor document:

- slot count per subrack, and which slots (sources in section 3);
- that `TNG1N210` fits all three subracks in both E9624 modes (Table 3);
- that one `TNG1N210` carries 10 x 10 Gbit/s line ports (the board's name, Table 3 topic list);
- that the E9600 family's supported pluggables include `SFP+` (brochure, "Supported
  pluggable optical modules"), i.e. a 10G optical port in these shelves is an SFP+ cage.

Derived, and flagged as derived in each spec's `notes`:

- the **SFP+ cage**. No public chapter prints a front panel for `TNG1N210`; the board
  datasheet that does (`EDOC1100163901`) still answers 302 -> `/view/notFound`. The cage is
  therefore read off the 10G optical line rate plus the brochure's pluggable list, not
  transcribed. If a chapter turns up and says otherwise, three files change one field.

A build, recorded in the label and not claimed of any vendor document:

- the **complement** — every service slot filled with the same line board
  (`5x`, `13x`, `24x TNG1N210`). That is the convention
  `devices/huawei/optixtrans-e6616.json` and `devices/arista/7504r.json` already use, and
  it is the only complement the printed tables can support, because they name which card
  fits, never a shipped configuration. A shelf with tributary (`TNG1T212`, `TNG1A212`) or
  WSS cards in some slots is a different box with a different port list, and the specs say so.

## 5. Ordinals that would be wrong to model, and are not

- `E9624X` is a **fourth** subrack with its own page (825 mm, SDH/OTN/fgOTN/PKT cross-connect,
  DC only) and is not one of these three; `research/optixtrans-e9624x-fourth-subrack.md`.
- `TNG2DAP` is an EDFA. Its Table 1 says an amplifier fits IU1-IU5 / IU1-IU13 / IU1-IU24, which
  would make "5x TNG2DAP" an amplifier shelf, not this request's OTN node. Not used.
- The 1:3-mode E9624 is 20 slots, not 24: the four blocked slots are printed in the same
  footnote as the 24-slot row.

## 6. What this does not settle

The **client** side. A `TNG1N210` shelf is all line ports; a node that terminates Ethernet or
SDH clients needs a tributary card (`TNG1T212` 12x10G, `TNG1A212` 12x any-rate), and the
public set still has no port table for either. That is a new request, not a blocker on these
three: the frame, the card, and the card's count are all vendor-sourced.
