# ASUS RT-AX89U — a different box from the RT-AX89X, or the same one renamed?

Research for issue **#96** ("add the ASUS RT-AX89U"). The issue names a model the catalogue does
not hold. `devices/asus/` carries `rt-ax89x`, `rt-ax86u-pro`, `rt-ac5300` and `rt-be96u`, so the
question is not "is there a gap" but "is the gap real".

**Verdict: same hardware. No spec added, no device file created.** The RT-AX89U is the model id
ASUS's own firmware source uses for the board that is sold as the **RT-AX89X**; it is not a second
product. Adding it would put one box in the catalogue twice, which is what issue #60 was about.

## The port tables, side by side

ASUS publishes a specification page for the X. It does not publish one for the U — see
"No RT-AX89U product record exists" below — so the U column has nothing to quote.

| Row | RT-AX89X — quoted from the ASUS spec page | RT-AX89U |
|---|---|---|
| 10G copper | `RJ45 for 10Gbps BaseT for WAN/LAN x 1` | not published |
| 1G LAN | `RJ45 for 1Gbps BaseT for LAN x 8` | not published |
| 1G WAN | `RJ45 for 1Gbps BaseT for WAN x 1` | not published |
| 10G cage | `SFP+ x 1` | not published |
| USB | `USB 3.1 Gen 1 x 2` | not published |
| Front LEDs | `10GE x 1`, `SFP+ x 1` | not published |
| Radios | `5GHz 8x8`, `2.4GHz 4x4` (AX6000) | not published |

The full `I/O Ports` block, verbatim:

> RJ45 for 10Gbps BaseT for WAN/LAN x 1, RJ45 for 1Gbps BaseT for LAN x 8, RJ45 for 1Gbps BaseT for WAN x 1
> USB 3.1 Gen 1 x 2
> SFP+ x 1

That is exactly what `devices/asus/rt-ax89x.json` already models: `wan` (1G), `lan1`–`lan8` (1G),
`10g-rj45` (10GBASE-T with the 100/1G/2.5G/5G/10G ladder), `10g-sfp` (`connector: "sfp+"`,
1G/10G). Nothing in that spec is contradicted by anything found here.

## No RT-AX89U product record exists

Four independent checks, all negative:

1. **The spec-page slug is dead.** `…/asus-wifi-routers/rt-ax89u/techspec/` returns HTTP 200 but
   redirects up to the category index (`…/asus-wifi-routers/`). Same for the `asus-gaming-routers`
   path and for the `tw`, `hk-en` and `com.cn` locales. The extractor reported this honestly as
   *"The fetch returned a different page, not the requested one"*. The X's equivalent URL serves
   the real page with no redirect.
2. **ASUS's firmware database has no entry for it.** `GetPDBIOS` returns `Count: 15` and firmware
   `3.0.0.4.388_33812` for `model=RT-AX89X`, and for the U:

   > `{"Result":null,"Status":"FAIL","Message":"FAIL"}`

   Repeated for `website=global, jp, cn, tw, kr, de, us, uk` — FAIL in all eight. ASUS has not
   published a single firmware file for a model called RT-AX89U anywhere.
3. **The support page is a catch-all, not a product page.** `supportonly/rt-ax89u/helpdesk/`
   renders the bare shell with no download section, exactly like a deliberately fake slug:

   | Slug | Title | Has download section |
   |---|---|---|
   | `rt-ax89u` | `rt-ax89u - Support` | no |
   | `rt-zzzz999` (control) | `rt-zzzz999 - Support` | no |
   | `rt-ax89x` | `RT-AX89X - Support` | **yes**, and it resolves with `?model2Name=RT-AX89X` |

   The U behaves identically to a nonsense slug, so that page is not evidence of a product.
4. **No separate FCC filing.** Hardware databases list `ASUS RT-AX89X` (FCC ID
   **MSQ-RTAX2E00**) and `ASUS RT-AX89X rev Bx` (**MSQ-RTAX2E01**) and contain **zero** occurrences
   of "AX89U" — a grep for `AX89U` over both the deviwiki and techinfodepot ASUS device lists
   returns 0 hits.

## Positive evidence that the U *is* the X board

Absence of a product page is suggestive; these make the identification direct.

**ASUS's own firmware source builds this board under the name RT-AX89U — and never as RT-AX89X.**
In `release/src/router/shared/model.c` (Asuswrt, vendored by Asuswrt-Merlin):

> `{ "RT-AX89U",		MODEL_RTAX89U		},`

A case-insensitive grep for `89x` in that same file returns **nothing**: the retail name does not
appear in the model table at all. The entry sits in the Qualcomm `ipq807x` branch next to
`RT-AD7200`, `BRT-AC828`, `GT-AXY16000` and `RT-AC95U` — the vendor's established pattern of one
board carried under several marketing names.

**That build drives a 10GBASE-T copper PHY and an SFP+ cage.** `rc/init.c`:

> `#if defined(GTAXY16000) || defined(RTAX89U)`
> `case MODEL_RTAX89U:`
> `if (!is_aqr_phy_exist()) {` … `/* no need to upload AQR firmware */`

and, in the same board block:

> `#elif defined(RTAX89U)`
> `nvram_set("HwId", "A");`

> `/* Turn off SFP+ TX disable PIN. */`
> `gpio_dir(59, GPIO_DIR_OUT);`

An Aquantia PHY plus a GPIO controlling an SFP+ transmit-disable pin is the RT-AX89X's
"one copper 10G + one SFP+" front panel, not a hypothetical third layout.

**Hardware revisions line up.** `init.c` branches on `HwId` "A" and comments the alternative
"PCB R4.00: B; or above"; the OpenWrt port documents the same split from the other side —
*"Only B revisions of the AX89X are supported"*, *"on revision B1 the copper 10G LAN port doesn't
work"*. Independent teardown reports of the U describe the same board:

> RT-AX89U (Hardware Revision B2) … U-Boot 2016.01, bootloader version 2.1.2.2 … `ipq807x_eth_halt`

and in that same thread a poster corrects themselves: *"My apologies, it is indeed the RT-AX89X
(the octagon-shaped router with the dual 10G ports and the Qualcomm IPQ8078 chipset)."*

**The clincher: ASUS has shipped RT-AX89X firmware in a file named RT-AX89U.** An owner of an
RT-AX89X, working a SFP+ regression on that router, reports:

> On firmware 3.0.0.4.386.23012 and beta `RT-AX89U_9.0.0.4_386_44150-g49dbf3e_sfp+_ui_wo_fnf_patches`,
> everything worked (gpon sfp at 1Gbps).

A build labelled RT-AX89U, with `sfp+` in its own tag, fixing an RT-AX89X's SFP+ port. One binary,
one board.

## What was and was not done

- **Created:** this file only.
- **Not created:** `devices/asus/rt-ax89u.json`. There is no documented port table to copy, and a
  spec that duplicates the X would be invented hardware — the exact failure issue #60 was opened
  about. No port was invented to make the two models look different, and none was invented to make
  them look the same.
- **Untouched:** `devices/asus/rt-ax89x.json` and everything else outside this file.

### Why the duplicate gate would not have caught this

`modelKey()` in `devices/registry.js` normalises punctuation, not model suffixes: `RT-AX89U` and
`RT-AX89X` squash to different keys (`asus|rtax89u` vs `asus|rtax89x`), so the importer's
one-model-one-spec gate from #60 would have accepted the U as a distinct device without complaint.
For this case the gate cannot substitute for reading the datasheet; the judgement has to be made
here, in writing, which is why this note exists.

### Caveat

I can only report what ASUS publishes, and ASUS publishes nothing for the U. If a region-limited
RT-AX89U ever turns up with a port table that genuinely differs from the X's — a dropped SFP+, a
different copper ladder — that would be new evidence and a spec would then be justified. Nothing
currently observable points that way, so the catalogue should hold one entry for this box.

## Pages opened

| Source | What it gave |
|---|---|
| `asus.com/…/rt-ax89x/techspec/` | the I/O Ports block quoted above (the X's real page, HTTP 200, no redirect) |
| `asus.com/…/rt-ax89u/techspec/` | **no page** — redirects to the category index (also `asus-gaming-routers`, `tw`, `hk-en`, `com.cn`) |
| `asus.com/supportonly/rt-ax89u/helpdesk/` | empty catch-all shell, plus the `rt-zzzz999` control |
| `asus.com/support/api/product.asmx/GetPDBIOS` | FAIL for the U in 8 locales; 15 files for the X |
| `asuswrt-merlin.ng` `shared/model.c`, `rc/init.c`, `www/Advanced_WAdvanced_Content.asp` | `MODEL_RTAX89U`, the AQR/SFP+ board code, no RT-AX89X model entry |
| `openwrt.org/toh/asus/rt-ax89x` | hardware notes, 10G copper + SFP+, B1/B2 revisions |
| `snbforums.com` SFP+ thread and RT-AX89U soft-brick thread | the RT-AX89U-named beta firmware; U-Boot/SoC/rev details |
| deviwiki + techinfodepot ASUS device lists | FCC IDs MSQ-RTAX2E00 / MSQ-RTAX2E01; 0 hits for AX89U |
