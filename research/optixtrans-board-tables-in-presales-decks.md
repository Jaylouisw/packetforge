# The E6600 board tables live in Huawei's presales decks - and they disagree with each other about slot cost

One increment on request #803 (Huawei OptiXtrans E6616X). The standing blocker recorded in
`research/optixtrans-e6616x-deployment-board-inventory.md` is narrow: an E6616X in the field runs
`65UXCL` plus `B2PD1` / `B2DMS` service boards, and nothing vendor-published states **how many E1/T1
ports a `B2DMS` presents**, **how many a `B2PD1` handles**, or **how many service slots the protected
pair costs**. Huawei's document tree has been drained for that answer (support portal 302/401,
hedex 401, `e-file` board chapters are optical-layer only), so this pass went one layer out: the
**channel training decks**. They contain the board tables. They also contradict each other, which is
the finding.

## 1. What was read

| artifact | host | what it is |
|--|--|--|
| `HCSA-Presales-Transmission V1.0 Training Material` | `https://www.scribd.com/document/931093259/HCSA-Presales-Transmission-V1-0-Training-Material` | Huawei partner-presales course deck, pages footed *Huawei Confidential* |
| `OptiXtrans E6600 main slide.pdf`, 50 slides, uploaded by "Bruno Teixeira" | `https://www.slideshare.net/ssuserc99286/optixtrans-e6600-main-slidepdf` | Huawei product-introduction deck, footed *Huawei Confidential* |

Neither is vendor-**hosted**. Both are re-uploads of Huawei-authored material by third parties, and
both render as slide images, so their text is reachable only through the host's index. What is quoted
below is therefore **the search-index text of those pages**, not a PDF text layer, and it is treated
in this repository as a **lead, not evidence** (see §4).

## 2. The board table, as the index renders it

From the E6600 main slide deck, board introduction section:

> PDH TMB1TPS(DMS+PD1) 32xE1/T1 ... OTPS(OMS+PD1) 8x 2M Optical port  TMB1PL1D 32xE1/T1 Electrical Port

and, on the TPS slide:

> TMB1TPS：Receives/Transmits 32xE1/T1 signals  DMS 32 x E1/T1 electrical signals  PD1 working board  protection board
> ... Two PD1 boards and one DMS board work together to provide TPS protection.

From the presales deck, the same family with **slot cost** attached:

> TMB2TPS  TMB1PL1D  TMB1SP3DE  TMB1TPSE
> 2 Slot   1 Slot     1 Slot      2 Slot
> 2 x 16E1/T1  2 x 16E1/T1  2 x 21E1  2 x 16E1

and on the E6616X tributary slide:

> 2 Tributary board B2TPS/B2OTPS/B1TPSE
> ... E1 board  Cross-connect  Line board
> B2TPS  B2OTPS  B1TPSE  K1XCL  K1UNQ2  K1UNS4  K1SNS2  K1SNS4  K1GDC
> 32 x E1/T1  10 x 2 Mbit/s  32 x E1  4 x 10G  1 x 100G  1 x 10G  1 x 100G  2 x 100G

## 3. What the pair settles, and what it contradicts

**Settled, by agreement with the sources already cited on the issue:**

1. `B2TPS` is the E6616X's tributary family and `TMB2TPS` is its order code - the presales deck prints
   `B2TPS` under *OptiXtrans E6616X*, and the reseller price list's `03034FAA TMB2TPS` row spells the
   build as `1*DMS+2*PD1`. That is the first non-deployment source to place `B2*` service boards in an
   E6616X, i.e. it corroborates the Ningbo maintenance list rather than only being inferred from it.
2. The ports sit on the **DMS** board (32xE1/T1 electrical), with the two `PD1` boards providing TPS
   working/protection; so "32xE1/T1 tributary board" is a **three-board assembly**, not one board.
   This matches `TMB2TPS = 1*DMS+2*PD1` exactly.

**Contradicted, which is why this cannot close the issue:**

- the presales deck prices that same three-board assembly at **"2 Slot"**. Two slots cannot hold three
  boards, and the assembly's own name says `1*DMS+2*PD1`. Either "Slot" there means something other
  than a service-board slot (e.g. slot **pairs**), or one of the two readings is wrong - and the deck
  does not say which.
- `2 x 16E1/T1` is printed against `TMB2TPS`, `TMB1PL1D` (1 slot) and `TMB1TPSE` (2 slots) alike, so a
  per-board port count cannot be read off it; 16 is the capacity of a `PD1`, and 32 the capacity of the
  `DMS`, but the table does not say so in a line that can be quoted.

A spec built from this would have to pick between "2 slots / 32 E1" and "3 slots / 32 E1", and it would
be guessing which - exactly the failure the issue thread has been avoiding for ten days.

## 4. The rule this pass applied

`B2DMS`/`B2PD1` port counts and `TMB2TPS` slot cost remain **unmodelled**. A re-hosted Huawei training
deck is Huawei-authored but not Huawei-published: it cannot be a `sources` entry under this repository's
evidence rule, and no field in `devices/huawei/optixtrans-e6616x.json` may rest on it. Recorded here so
the next pass does not re-walk Scribd and SlideShare, and so the two quotations are on the record if a
vendor-hosted copy of either deck is ever found.

## 5. What would still unblock #803

Any **Huawei-hosted** statement of one of:

- the `TMB2TPS` / `B2TPS` slot cost, in service-board slots of the DC chassis (2 or 3);
- the front-panel port census of `B2DMS` alone, or of `B2PD1` alone;
- a "typical configuration" for the E6616X that fixes the board complement, so the frame's 14 slots can
  be filled from a vendor statement instead of a ratio.

Preferred instruments, in order: an *OptiXtrans E6600 Product Documentation* board chapter for the
2M boards (the pattern that yields chapters anonymously on `e-file.huawei.com` works for optical-layer
boards and has not yet produced one for `B2*`); the *OptiXtrans E6616X Board Datasheet*; or the
*V100R026C00 Hardware Description*, which is the one document listed on the support portal that this
family has never served anonymously.
