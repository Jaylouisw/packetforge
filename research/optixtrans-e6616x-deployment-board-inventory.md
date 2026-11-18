# A deployed E6616X names its boards: TM65K32AFB + 65UXCL + B2PD1/B2DMS - and `TM65*` is the chassis prefix, not the board one

Measured 2026-11-18 14:5x UTC, one increment on request #803 (Huawei OptiXtrans E6616X). Where the
previous passes spent their budget inside Huawei's own document tree, this one stopped asking the vendor
and looked for an **installation**. A tender or maintenance list names installed equipment by order code,
and unlike Huawei's support wall (302/401 on every hardware description, `research/optixtrans-e6616x-docs-
gated-not-unpublished.md`) it is anonymous and machine-readable.

## 1. The artifact

`http://ygcg.nbcqjy.org:8061/down/c1e5edbe-2560-4ddc-a308-0c0d66b1bacf/%E7%94%A8%E6%88%B7%E9%9C%80%E6%B1%82%E4%B9%A6-...4.13.pdf`

- 200, `application/pdf`, **736,057 B**, downloaded 2026-11-18 14:58 UTC with a Googlebot UA;
- 135 pages, **91,554 characters** of text layer, read end to end (no OCR needed, no images-only pages in
  the equipment tables);
- *用户需求书 - 宁波市轨道交通运营分公司4号线通信系统设备及2号线、3号线通信系统华为主设备维保委外项目*,
  appendix 4 *通信系统主要维保设备清单* (Ningbo Rail Transit Line 4 communications equipment plus
  Lines 2/3 Huawei maintenance outsourcing - the bill of maintained equipment).

Fleet lines that put the X in context: `控制中心延伸段传输系统设备（E6616）1 套` and
`延伸段传输系统设备（E6616X）2 套 车站通信设备室` - one E6616 at the control centre, **two E6616X in
station equipment rooms**.

## 2. What it says about an E6616X

Verbatim rows from the itemised table (items 32-36; the E6616 block immediately above it is items 19-21):

| item | printed label | model | qty |
|--|--|--|--|
| 32 | 总装机箱 (OptiXtrans E6616X) - "currently in use, Huawei, model" | **TM65K32AFB** | 1 套 |
| 33 | 通用交叉及主控时钟处理板 | **65UXCL** | 1 块 |
| 34 | 2M 处理板 | **B2PD1** | 1 块 |
| 35 | 2M 业务板 | **B2DMS** | 1 块 |
| 36 | 32xE1/T1 电接口倒换出线板 (75 欧姆) | **SSN1D75S** | 1 块 |

For comparison, the E6616 block two dozen rows earlier reads `总装机箱 (OptiXtrans E6616)` **TMK5K32AFB**,
`通用交叉及主控时钟处理板` **UXCME**, `辅助接口板` **AUX** - i.e. the same document distinguishes the two
subracks by chassis code, so the X rows are not a copy of the E6616's.

## 3. What this settles

1. **`TM65*` is the chassis and cross-connect prefix, not the service-board namespace.** Two earlier passes
   inferred "the X's boards live in the `TM65` order-code family" from the single `TM65UXCL` part number in
   the R026 brochure, and the registry's standing next step became "ask for a `TM65*` service board
   chapter". In the one deployment record that names both, the X runs `TM65K32AFB` (chassis) + `65UXCL`
   (cross-connect/main control/clock, i.e. `TM65UXCL`) and its service boards are **`B2*`**: `B2PD1`
   (2M processing) and `B2DMS` (2M interface). `B2` is the second-generation 2M pair whose assembly the
   price list calls `TMB2TPS` - "32xE1/T1 tributary board (1*DMS+2*PD1)"; this document's own row 25 spells
   the same shape as `32路E1/T1支路板 ... 1*DMS+2*PD1 ... TPS`.
2. **The X is a 2M/PDH aggregation node in the field**, which is what the request in #803 describes
   ("metro aggregation MS-OTN node"). That fits its published spec (75/120 Ω E1, SDH 160G VC-4/20G
   VC-3/12, packet 820G, no DWDM line) rather than the muxponder build its E6616 sibling is modelled with.
3. **Both `TM65K31AFB` and `TM65K32AFB` exist as X chassis codes** (K31 in the price catalogue, K32 here),
   the same K-variant pattern as the E6616's `TMK5K31/K32/K33/K34/K35` - so "the X's chassis" is a family,
   and any spec has to name its variant.

## 4. What it does not settle - and this is now the whole of the blocker

Every row is quantity **1**. This is a list of maintained swappable units, not the built complement of a
subrack, and four cards cannot be expanded into fourteen slots without inventing ten more. Specifically it
does not give:

- **the per-board front-panel census.** "2M 处理板" and "2M 业务板" are printed bare; the 32xE1/T1 figure
  attaches to the `TPS` *assembly* (1x DMS + 2x PD1), not to `B2DMS` alone, and the cable-out board in the
  same block is an OSN-generation `SSN1D75S`, not an E6600 part - so the E1 port count of a `B2DMS` is
  still unstated;
- **the slot cost per board** (the TPS assembly is three physical boards, DMS + 2x PD1, so a "32xE1/T1
  board" may occupy one slot or three);
- **any vendor statement that these boards are valid in an E6616X slot.**

## 5. The cross-check that could not corroborate it

The Tanatel E6616-series price catalogue carries the rows that would confirm the codes -
`02302131 TM65K31AFB Assembly Chassis (OptiXtrans E6616X,DC)`, `03034FAA TMB2TPS 32xE1/T1 tributary
board(1*DMS+2*PD1)`, `02301704 TMK5K34AFB Assembly Chassis(OptiXtrans E6616,AC,1500W,with fiber storage)` -
but `https://www.tanatel-comm.com/product/e6616/` **refuses TCP 443** from this host today (`curl: (28)
Failed to connect ... after 21091 ms`, reproduced 2026-11-18 14:58, same as the 10:38 pass). Search-index
snippet only; not cited as evidence, and no field in any spec rests on it.

Info-Finder's Hardware Center - the remaining vendor instrument - was measured dead for this family on
2026-11-18 (only optical modules come back, `research/optixtrans-infofinder-api.md` section 7) and was not
re-walked.

## 6. What would close #803 now

Either of two artifacts, both narrower than yesterday's ask:

- **the per-slot complement of one real subrack** - a commissioning record, NE inventory export or
  acceptance list of the shape "E6616X, TM65K32AFB, slots 1-14: n x B2PD1, n x B2DMS, ...". A tender's
  spares list cannot supply it;
- **a Huawei board chapter whose Valid Slots table names E6616X**, now with named candidates: `TMB2PD1`,
  `TMB2DMS`, `TMB2TPS` for the 2M path, and the Ethernet/packet set the same document maintains as
  `GDC` / `EX10` / `EG10` - 2x 100G, 10x 10GE (SFP+), 10x GE (SFP) - which the E6600 boards overview lists
  as `TMK1GDC`, `TMK1EX10`, `TMK1EG10`. **The `TMK1` prefix there is inference** (the tender prints the
  short code), flagged as such and not used as a source for any field.

No spec was written this pass: the frame arithmetic is vendor-sourced and waiting, the card is named but
not counted, and a 14-slot port list assembled from a spares list of qty 1 would be an invention.
