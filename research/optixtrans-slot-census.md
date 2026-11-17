# OptiXtrans slot counts are not one number: mode, power and cross-connect all move them

Five open device requests (#803 E6616X, #804 E6608T, #807 E9605, #808 E9612, #810 E9624) are parked on
the same sentence: the OptiXtrans specification tables publish what a *frame* can do, never a port
census, because an OTN subrack has no ports until service boards are fitted. That is true. What the
earlier passes did not record is how differently the five frames behave, and one of them breaks the
number everyone quotes.

## The two specification tables, read 2026-11-16

OptiXtrans E6600 (https://e.huawei.com/en/products/optical-transmission/optixtrans-e6600), four model
columns:

> Number of Service Board Slots | **DC chassis: 14 / AC chassis: 12** (E6616) | **DC chassis: 6 / AC
> chassis: 4** (E6608) | **DC chassis: 7 / AC chassis: 5** (E6608T) | **DC chassis: 14 / AC chassis:
> 12** (E6616X)
>
> Cross-connect Capacity | OTN(fgOTN)/PKT/SDH | OTN/PKT/SDH | **NA** (E6608T) | OTN/PKT/SDH

OptiXtrans E9600 (https://e.huawei.com/en/products/optical-transmission/optixtrans-e9600), three
model columns:

> Number of Service Slots | **12/24** (E9624) | **13** (E9612) | **5** (E9605)
>
> Cross-connect Type | ODUk/PKT/VC (E9624) | **NA** (E9612) | **NA** (E9605)
>
> Line rate | up to 1.2 Tbit/s | up to 1.2 Tbit/s | up to 1.2 Tbit/s

## Three things this settles that the blocker notes did not

**1. Three of the five are photonic shelves, not OTN cross-connects.** The E6608T and the E9605/E9612
publish `NA` where the cross-connect row should be. So the sentence "an OTN subrack has no ports until
service boards are fitted" understates it for those three: they host optical amplifier, multiplexer and
OTU boards and nothing else, and the only cableable ports any of them will ever have are the client
sides of the OTU boards fitted in them. A spec for an E6608T or an E9605 is *entirely* a board
statement — there is no chassis-only port to fall back on, not even a management-plane Ethernet port
in the published table.

**2. "E9624 = 24 slots" is wrong outside 1:1 mode.** Huawei's own FTTO brochure
(https://e.huawei.com/marketingcloud/pep/asset/20000001/Material/6c96e5825bc34cf58c30fd13e0d8e7f2/M3T1A669N1129732965963960451/FTTO%20Solution%20for%20Education%20Campus_K-12_-Brochure_25H1_.pdf,
"Maximum number of slots for service boards") prints the mode dependency the marketing page compresses
into `12/24`:

> 1:1 mode: 12 large slots or 24 small slots
> 1:3 mode: 10 large slots or 20 small slots

So the same subrack is a 12-slot frame, a 24-slot frame, a 10-slot frame or a 20-slot frame depending
on the protection mode and on board size — and a large board and a small board are not interchangeable
in the slot count. Modelling `24` would be as wrong as modelling `12`; the mode belongs in the label.

**3. Power constrains the count only for the E66xx family.** The E6608/E6608T are the same 1U
mechanical size (88.1 x 220 x 442 mm) but carry 6/4 and 7/5 service slots respectively: the extra slot
in the T is the one the DC-only power and fan arrangement frees. Which chassis you have is therefore a
port-census input, not a footnote — the same lesson the MA5800-X17 spec already encodes (DC vs AC
subrack slot counts).

## The field that is still missing, per issue

Every one of the five needs the same single line, but the line has a different consequence each time:

| Issue | Model | Slots (per vendor) | Cross-connect | Missing field |
|--|--|--|--|--|
| #803 | E6616X | DC 14 / AC 12 | OTN/PKT/SDH | board part number per slot |
| #804 | E6608T | DC 7 / AC 5 | **NA** | board part number per slot (no client port exists otherwise) |
| #807 | E9605 | 5 | **NA** | board part number per slot (photonic shelf) |
| #808 | E9612 | 13 | **NA** | board part number per slot (photonic shelf) |
| #810 | E9624 | 12/24 in 1:1 mode, 10/20 in 1:3 | ODUk/PKT/VC | board part number per slot **and** protection mode |

`docs/RESOLUTIONS.md` already names the shape the label takes — `OptiXtrans E6616 (14x B1LDCD)` — so
one stated configuration converts each of these to a spec in a single step: the board's own datasheet
gives its port count and connector, the frame's table above gives how many of them fit, and the
product is `slots x board ports` with no guessing anywhere.

## What was tried and is still not public

- **Board port counts.** `https://support.huawei.com/enterprise/en/doc/EDOC1100624531` (OptiXtrans
  E9600 Board Datasheet) answers HTTP 404 to a crawler user-agent as of 2026-11-16; the 404 body is
  `This document cannot be found.` The E9600 Hardware Description index (EDOC set under
  `.../optical-transmission/optixtrans-e9605-pid-250732995`) lists V100R025C10 and V100R026C00
  Hardware Descriptions, none of which was reachable by that URL on this pass.
- **Per-model port counts.** Huawei's OceanProtect-style "Front-End Port Types" row has no OptiXtrans
  equivalent anywhere in the two specification tables: the pages stop at wavelengths, line rate and
  service type. There is no number to transcribe, in either revision of either page.

Until a board set is named, these five stay open — but they are one line away, not one research
project away.
