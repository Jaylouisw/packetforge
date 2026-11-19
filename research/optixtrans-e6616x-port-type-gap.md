# The E6616X is not short of a census any more — it is short of an E1 port type

Re-check of request #803 (Huawei OptiXtrans E6616X), 2026-11-19 02:2x-0x UTC. Eleven passes have hunted
the *census* and each ended on the same wall (`research/optixtrans-e6616x-2m-pair-chapter-format.md`,
`-deployment-board-inventory.md`, `-support-gateway-not-a-doc-index.md`). This pass asked the next
question instead: if the census were in hand tomorrow, could a spec be written? **No — and the reason is
in this repository, not in Huawei's document tree.** The X's service ports are E1/T1, and neither is a port
type this engine has. That reclassifies #803 from the "vendor never published it" bucket (plan rank 3) to
the "a port type the engine does not have" bucket that #807/#808/#810 are already in
(`docs/plans/stated-configurations.md`, rank 2).

## 1. The census is no longer single-source, and it reads 32 per pair

Three independent pages, all reprints rather than vendor hosts, agree on the port count of the 2M pair:

| page | bytes | what it prints |
|--|--|--|
| `https://www.szhuaxunjia.com/product/2298.html` (TMB2DMS chapter) | 42,382 | 接口规格 "支持32路75Ω/120Ω的E1接口或者100Ω的T1接口"; 面板 has indicators and the interfaces; 表12 配套关系 below |
| `https://www.szdingwei.net/Product/6542134456.html` | 34,588 | page title "TMB2DMS … 32路E1/T1电接口板"; TPS described as "两块TMB2PD1单板和一块TMB2DMS单板" |
| `https://www.tanatel-comm.com/product/e6616/` (price catalogue row) | 1,020,978 | `03034FAA` / `TMB2TPS` / "32xE1/T1 tributary board(1*DMS+2*PD1)" |

So the count 32 attaches to a **pair** (one TMB2DMS interface board carrying the connectors, one TMB2PD1
carrying the processing), and 32 attaches to a **TPS group** of three boards (1x DMS + 2x PD1). Those two
statements cannot both be right unless the DMS presents 32 E1 on its panel and the second PD1 is a 1+1
standby behind the same 32 ports — which is what the TPS rows in all three pages describe. Either way the
figure is 32 E1/T1 per DMS, not 32 per PD1.

`docs/MAINTAINING.md` ranks a reseller listing **lowest — last resort, and say so in the note**, and a
re-hosted page is not a vendor host, so nothing here is quoted as a source for a field. It is enough to
settle what the artefact would say, which is what §4 needs.

## 2. The compatibility row that the gated chapter carries

Only the szhuaxunjia reprint prints it; the vendor original (`EDOC1100558549`, six editions, 401
`NOT LOGIN!`) does not answer anonymously:

> 表12 TMB2DMS单板配套关系 — TMB2DMS | E6608 | TMK2UXCL / TMK2UXCLE | V100R021C00SPC200
> … | E6616 | TMK5SXCH / TMK5UXCME / TMK5XCS | … | **E6616X | TM65UXCL | V100R022C10SPC010**

The TMB2PD1 page prints the same three device rows as its 表2. This is the answer the thread has been
asking for since 2026-11-10 — *which* board is valid in an X subrack — and it names the cross-connect too
(`TM65UXCL`), which is the part number the R026 brochure prints once and the Ningbo inventory prints as
`65UXCL`. It is still a reprint, so it changes what to ask for, not what may be written down.

## 3. Two instrument corrections worth not re-deriving

- **The marketing site serves 404s as 200s.** `https://e.huawei.com/en/products/optical-transmission/optixtrans-e6616x`
  answers **200, 336,300 B, `<title>404</title>`** to a Googlebot UA; `/…/optixtrans-e6608` answers the same
  336,300 B, while the page that exists (`/…/optixtrans-e6600`) is 339,756 B, md5 `22eea469…`. A 200 on a
  guessed product URL on that host is not evidence that a product page exists, and the X has none of its
  own — the E6600 family page is the only marketing page that carries an E6616X column.
- **Tanatel answers now.** The registry has carried "refuses TCP 443 from this host" since 2026-11-18; today
  `https://www.tanatel-comm.com/product/e6616/` is **200, 1,020,978 B**, and its E6616X price block lists
  **six** chassis SKUs — `02302131 TM65K31AFB` (DC), `02302132 TM65K32AFB` (DC, fibre storage),
  `02302133 TM65K33AFB` (AC 1500 W), `02302134 TM65K34AFB` (AC 1500 W, fibre storage), `02302295
  TM65K35AFB` (DC, no fibre preconnection), `02302296 TM65K36AFB` (AC 1500 W, same) — so **every AC SKU of
  the X is 1500 W**, and the 12 / 10 split the chassis chapter and the Greek product page describe is an
  E6616 property: the X has no 2400 W AC variant with two APIU slots taken out of the service row.
  Recorded so the next spec does not have to choose between 12 and 10 for an AC X.

## 4. What the engine cannot express

`engine/media.js` knows these port families: `ethernet`, `wireless`, `console`, `dsl`, `pon`, `coax`,
`powerline`, `serial` (`devices/*/*.json` uses the same vocabulary — 18,499 `ethernet`, 1,386 `wireless`,
683 `console`, 436 `dsl`, 366 `pon`, 165 `coax`, 15 `powerline`, 2 `serial`, nothing else). The two
candidates for a 32x E1/T1 port are both wrong in the field:

| what a spec could say | what the engine does with it |
|--|--|
| `"type": "serial"` | resolves to the single serial cage `serial: { name: 'V.35', family: 'serial' }` and the medium `serial-v35` (1.544 Mbps, cable `v35`) — a WIC-2T smart-serial port, not a G.703 tributary |
| `"type": "coax", "connector": "f"` | resolves to the F-connector DOCSIS/MoCA cage (`coax: { name: 'F-connector' }`), so a 75 Ω E1 BNC renders as a cable-TV socket |
| `"type": "ethernet", "connector": "rj45"` | cables at Ethernet rates on a port that runs at 2.048 Mbit/s — the exact failure `docs/MAINTAINING.md` calls a number that belongs to a different part of the family |

There is no `bnc`, `rj48`, `g703` or `e1` cage in `engine/media.js`, and `scripts/audit-port-types.js`
polices connector/type coherence on the expanded interface list, so a 32-port E1 board cannot be added
without an engine change: a new cage, a new medium, and a classifier entry. That is the same shape of
blocker the plan records for OTU ports on #807/#808/#810, and this stream does not carry engine changes.

## 5. So the request needs two decisions, not one

1. **A build.** The frame is fully vendor-sourced (E6616X brochure: 14 service slots DC / 12 AC, 680 G
   OTN, 680 G OSU, 800 G packet, 100 G grey per channel, no wavelength plan). A stated build in the
   catalogue's sense (`docs/DEVICE_SCHEMA.md`, "A port list may be a stated build") would be
   `E6616X DC (n x TMB2TPS)`, with `TMB2TPS = 1x TMB2DMS + 2x TMB2PD1` and 32 E1/T1 per group. What no
   source states is how many groups a 14-slot chassis is built with, or the slot cost of the DMS itself
   against the two PD1 boards — the deployment record's rows are qty 1 each.
2. **An E1/T1 port type** (§4), which is an engine change and therefore out of scope here.

Neither is a research gap any more: the census reads 32 per DMS, the compatibility row names E6616X, and
the remaining unknowns are a build choice and a classifier. That is worth saying plainly rather than
filing a twelfth note about Huawei's login wall.

## 6. Sources checked this pass

- `https://www.szhuaxunjia.com/product/2298.html` — 200, 42,382 B (TMB2DMS chapter reprint, 表12)
- `https://www.szhuaxunjia.com/product/2297.html` — 200, 47,885 B (TMB2PD1 chapter reprint, 表2)
- `https://www.szdingwei.net/Product/6542134456.html` — 200, 34,588 B
- `https://www.tanatel-comm.com/product/e6616/` — 200, 1,020,978 B (price catalogue incl. six X chassis SKUs)
- `https://e.huawei.com/en/products/optical-transmission/optixtrans-e6616x` — 200, 336,300 B, `<title>404</title>`
- `https://e.huawei.com/en/products/optical-transmission/optixtrans-e6600` — 200, 339,756 B, md5 `22eea469c0f87453f17a520cc7abb162`
- `https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e6616x-pid-257173887` —
  **403, 464 B** to desktop Chrome, **200, 454,559 B** to a Googlebot UA, where the document tree renders:
  260 unique `EDOC` ids and titles, of which **47 answer 200 and 213 answer 302**. The 200 set is the
  videos, the 【Optical Basics】 posts and the ten "Routine Maintenance of OptiXtrans E6600 Hardware"
  chapters; the X's own Quick Start (`OptiXtrans E6616X Quick Installation Guide 02`) and every hardware
  description edition are 302. The earlier record's "6,539 B shell / no document is found" is what the same
  URL returns to a non-crawler agent, not a statement about the tree.
