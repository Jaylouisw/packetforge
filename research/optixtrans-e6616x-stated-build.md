# The E6616X leaves the queue on an Ethernet build: TMB3EGS4 is valid in the X, and its 4 ports are stated

Measured 2026-11-21 05:2x-05:4x UTC, one increment on request #803 (Huawei OptiXtrans E6616X).
`research/optixtrans-e6616x-port-type-gap.md` left the request holding two decisions: a build, and an
E1/T1 port type the engine does not have. This pass took the build decision and stopped needing the
second one - the X is an MS-OTN shelf, and its Ethernet service board is published with both a
subrack-validity table and a four-port panel, so a spec exists that never touches a G.703 tributary.

## 1. The board, and the two tables that make it citable

`TMB3EGS4` chapter of the *OptiXtrans E6600 Hardware Description*, read from the verbatim partner copy
at <https://www.szhuaxunjia.com/product/2302.html> (HTTP 200, 67,351 B, 2026-11-21):

| what | verbatim |
|--|--|
| 表1 单板配套关系 | `TMB3EGS4 \| E6616X \| TM65UXCL \| V100R022C10SPC010` - and the same table's E6608 / E6616 rows name their own cross-connect boards, so the E6616X row is not a copy of a sibling's |
| 表3 单板接口说明 | silkscreen `TX1/RX1～TX4/RX4`, 连接器类型 `LC或RJ-45`, 网管接口序号 `1～4` - four ports, each a cage that takes an optical or an electrical module |
| 端口工作模式 | GE electrical 10M/100M/1000M full duplex and autoneg, GE optical 1000M, FE optical 100M - a 1G ceiling |
| 机械/功耗 | 193.80 × 19.80 × 205.90 mm (one slot), 61 W typical / 66 W maximum |
| feature note | 功能特性 opens with 说明：仅适配 E6608/E6616/E6616X时支持 - the X is one of the three subracks this chapter names |

The compatibility table is the field this thread spent eleven passes asking Huawei for: it is the
vendor's statement that the board fits an E6616X slot, and it names the cross-connect the X needs
(`TM65UXCL`, printed `65UXCL` in the Ningbo deployment record). It is read from a reprint, not a
Huawei host - the vendor original (`EDOC1100558549` and its editions) answers 302/401 anonymously -
and `devices/huawei/optixtrans-e6616x.json` says so in its own notes, the same disclosure shape the
E9605 spec carries for its ActForNet-mirrored Boards Overview.

## 2. The build, stated rather than implied

No Huawei document states a typical configuration for an E6616X, so the spec does what
`devices/huawei/optixtrans-e6616.json` and `devices/huawei/optixtrans-e9605.json` do: it fills every
service slot with one board the vendor lists as valid in the subrack, and puts the complement in
`label` (`14x TMB3EGS4`) while `model` stays `OptiXtrans E6616X`. The DC chassis has 14 service slots;
the AC chassis has 12, and every AC X SKU the price list carries is 1500 W, so unlike the E6616 there
is no 10-slot AC variant to disambiguate. 14 boards × 4 cages = 56 ports, named `<slot>/<port>`,
slots 1-14, ports 1-4 in the board's own NMS numbering.

## 3. Why not the 2M build the field record shows

The one public deployment record (Ningbo Rail Transit) runs the X with `B2PD1` + `B2DMS`, 32× E1/T1 per
DMS. That build stays unmodelled for a reason that is in this repository, not in Huawei's tree: the
engine has no E1/T1 port type (`engine/media.js`: ethernet, wireless, console, dsl, pon, coax,
powerline, serial), and a 2.048 Mbit/s G.703 tributary declared as `rj45` or `coax` would cable at the
wrong rate - the failure `docs/MAINTAINING.md` names. The EoS board has an Ethernet cage and an
Ethernet rate, so it can be written down today. A future pass that adds an `e1` cage can add the
`TMB2TPS` build as a second spec; it does not need to re-open this one.

## 4. What the spec does not claim

- It is not "the" E6616X, only a valid fully-populated build of one; the label says which.
- It does not model the OTN/fgOTN side, the SDH mapping behind the EoS board, or the 100 Gbit/s grey
  ceiling as ports. The frame figures stay in `notes` (14/12 service slots, OTN(fgOTN)/PKT/SDH
  cross-connect, no DWDM/CWDM line).
- `l2-forward` is declared because the board bridges (EPLAN/EVPLAN on an 802.1d MAC bridge, 16k MAC
  table, 4095 VLANs, STP/RSTP, LAG on panel ports); nothing about the cross-connect is inferred from it.

## 5. Sources checked this pass

- <https://www.szhuaxunjia.com/product/2302.html> - 200, 67,351 B, TMB3EGS4 chapter (表1, 表3, port modes, dimensions, power)
- <https://www.szhuaxunjia.com/product/2303.html> - 200, 72,652 B, TMB4EGS8: 8× FE/GE but TX5-TX8 need a 端口扩展 RTU, so 4 usable by default - not used
- <https://www.szhuaxunjia.com/product/2301.html> - 200, 71,406 B, TMB4EFS8: 8× FE only (100M) - not used
- <https://e.huawei.com/en/products/optical-transmission/optixtrans-e6600> - the E6616X column of the family spec table (frame, slot counts, wavelength rows N/A)
- <https://actfornet.com/solutions/solution/OptiXtrans_E66000_Boards_Overview> - 200, 73,192 B, the E6600 Boards Overview landing page; it lists `TMK1EX10` (10× 10GE) as a packet board but carries no subrack-validity column and never prints `E6616X`, so it cannot place a board in the X
