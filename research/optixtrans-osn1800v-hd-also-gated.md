# The OptiX OSN 1800 V hardware description is gated in every edition, so the OSN side cannot stand in for the E6616X board census

Measured 2026-11-18 21:2x UTC, one increment on request #803 (Huawei OptiXtrans E6616X).

The E6600 board census is walled in the E6600 documentation: the six 硬件描述 editions and the English
Hardware Description `EDOC1100456166` answer `401 NOT LOGIN!` to an anonymous caller
(`research/optixtrans-e6616x-docs-gated-not-unpublished.md`). One substitution had not been measured:
**read the same chapter out of the OptiX OSN 1800 V documentation instead of the E6600's.**

## 1. Why that substitution was plausible, not hopeful

- The 2M pair the one deployment record names - `TMB2DMS` / `TMB2PD1` - is sold as an **OSN 1800 V Pro**
  board, not an E6600-only board.
- The only public index of the generation's board chapters links them into the **1800 V** package path,
  not an E6600 one:
  `https://support.huawei.com/hedex/pages/EDOC1100156575BEJ09044/01/EDOC1100156575BEJ09044/01/resources/1800v/hd/pkg/tmk1ex10/tmk1ex10.html`
  (recorded in `research/optixtrans-e6600-xt-census.md`). If the board chapters live under `1800v/`, then
  an OSN 1800 V Hardware Description is the same document family, and any public edition would carry the
  `TMB2DMS` chapter with its `配套设备` table - the table that is the whole of the #803 blocker.

## 2. The census: nine Hardware Description editions, all behind the login

`https://support.huawei.com/enterprise/en/optical-transmission/optix-osn-1800-v-pro-pid-250732494`
(Googlebot UA: **200, 476,757 B**, 391 document links) lists the OSN 1800 V and 1800 V Pro hardware
descriptions. One `GET /hedex/api/navi/<ID>/first-level-tree` each:

| document | id | answer |
|--|--|--|
| OSN 1800 Hardware Description 01 | `EDOC1100558550` | **401** NOT LOGIN |
| OSN 1800 V V100R025C00 Hardware Description 01 | `EDOC1100525975` | **401** |
| OSN 1800 V V100R024C10 Hardware Description 03 | `EDOC1100456158` | **401** |
| OSN 1800 V V100R022C10 Hardware Description 01 | `EDOC1100303420` | **401** |
| OSN 1800 V V100R021C10 Hardware Description 05 | `EDOC1100249290` | **401** |
| OSN 1800 V V100R019C10 Hardware Description 06 | `EDOC1100192279` | **401** |
| OSN 1800 V V100R025C10 Product Description 01 | `EDOC1100558552` | **401** |

Not one edition is public, and the reachable ones are not merely sparse - they are refused before any
chapter is listed, so no amount of section-hash guessing reaches a board chapter.

## 3. Instrument controls, run in the same minute

The 401s are only informative against a live three-state instrument. Same endpoint, same user-agent, same
session:

- `EDOC1100447312` - **200**, `{"status":200,...}` (a public document still answers);
- `EDOC9999999999` - **404** `No doc data found.` (a non-existent id is distinguishable from a gated one);
- `EDOC1100299472` - **401** - the **English** `OptiXtrans E6616X Quick Installation Guide 02`, which the
  E6616X support page prints under *Quick Start*
  (`https://support.huawei.cn/enterprise/en/optical-transmission/optixtrans-e6616x-pid-257173887`, 200,
  454,559 B). Its Chinese twin `EDOC1100299473` was already recorded as 401; this run pairs the two ids
  so a later pass does not read them as two documents.

## 4. What this settles, and what it does not

**Settled:** the OSN 1800 V route is closed as a substitution. The board census is not obtainable by
reading a sibling product line's documentation, because that line's hardware descriptions are under the
same gate. A later pass that notices `TMB2DMS` is an OSN 1800 V Pro board should not spend a run on the
1800 V HD editions.

**Unchanged:** `devices/` gains no E6616X spec. The frame fields are vendor-sourced and waiting
(14/12 service slots, 780G OTN / 620G OSU / 160G VC-4 SDH / 820G packet, 100 Gbit/s grey per channel,
221.5 x 220 x 442 mm - <https://e.huawei.com/en/products/optical-transmission/optixtrans-e6600>), and
there is still no cableable port count behind any of them.

**Exact missing fields:** (1) the per-board front-panel census of a board valid in the E6616X - the
reprints of the `TMB2DMS` chapter print "32 x 75-ohm/120-ohm E1 or 100-ohm T1", but a re-hosted page is
not a source; (2) the per-slot complement of one built subrack.

**What would unblock it:** one free Huawei enterprise account reading OptiXtrans E6600 V100R025C10
硬件描述 `EDOC1100558549` (§ TMB2DMS), or a stated configuration of the shape
`E6616X DC chassis, slots 1-14: n x TMB2DMS + n x TMB2PD1`.
