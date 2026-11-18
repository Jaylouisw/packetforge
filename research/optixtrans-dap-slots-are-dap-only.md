# `TNG2DAP` section 1.9 is the DAP board's own slot table — not a board-to-subrack matrix

Correction to the open-request record for #810 (and to the sentence it generated in
`docs/DEVICE_REGISTRY.md`). Nothing is added to `devices/`; nothing is closed.

## 1. What the row claimed

`research/open-device-requests.json`, request 810, said the missing field was "one client board
chapter plus the protection mode ... `TNG1N206` (6 x 10 Gbit/s line), `TNG1N210` (10 x 10 Gbit/s
line) or `TNG1N401` (1 x 100 Gbit/s line), **which `TNG2DAP` section 1.9 shows is valid in all
four subracks**."

The validity claim is true of no document this project has read. It also matters, because it is the
one sentence a later pass would use to write `E9624 (24x TNG1N210)` and believe the board-to-subrack
half was vendor-sourced.

## 2. What section 1.9 actually contains

`https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/e75c775ac71144e6b522d7cef1601604/M3T1A669N1188254864652623965/TNG2DAP%20-.pdf`
— HTTP 200, `application/pdf`, **871,676 bytes, 51 pages**, `V100R024C00`, issue date 2024-09-30,
anonymous (crawler user-agent). Section 1.9 *Valid Slots*, Table 1 *Valid slots*, in full:

| Device | Number of Occupied Slots | Physical Slot | Logical Slot |
|---|---|---|---|
| OptiXtrans E9605 | 1 | IU1, IU2, IU3, IU4, IU5 | IU1, IU2, IU3, IU4, IU5 |
| OptiXtrans E9612 | 1 | IU1 to IU13 | IU1 to IU13 |
| OptiXtrans E9624 | 1 | IU1 to IU24 | IU1 to IU24 |
| OptiXtrans E9624X | 1 | IU1 to IU24 | IU1 to IU24 |

plus the footnote *"In the 1:3 mode of an E9624 subrack, service boards cannot be installed in slots
IU6, IU7, IU18, and IU19."*

That is the **TNG2DAP optical-amplifier board's** own placement table. It says where a DAP may sit in
each of the four subracks. It says nothing about any other board.

## 3. The text-layer measurement

Searched the extracted text of all 51 pages:

| string | occurrences |
|---|---|
| `N206` | **0** |
| `N210` | **0** |
| `N401` | **0** |
| `10 Gbit/s` | **0** |

The board codes the chapter does print are optical-layer and control only: `TNG2DAP`,
`TNG3SRAPXF`-class Raman/EDFA parts, `TNG2OACU*`, `TNG3OACU*`/`TNG3OBCU*`/`TNG3OACE*`,
`TNG1CXP`/`TNG3CXP`/`TNG4CXP`, `TNG1HCXP`, `TNG2HSOCXP`, `TNG3CXCS*`, `TNG1OACU*`. There is no
`TNZ*` code at all.

## 4. Where the board names really come from — and it is a partner mirror

`research/optixtrans-board-census.md` section 1 is the origin: a partner mirror,
`https://www.actfornet.com/solutions/solution/OptiXtrans_E9600_Boards_Overview` (re-read today, HTTP
200, **226,637 bytes**), which is a scrape of hedex document `EDOC1100126589BEJ09047` — the
*OptiXtrans E9600 (E9624/E9612/E9605) Boards Overview* chapter. Its 127 `support.huawei.com/hedex/pages/...`
links are the vendor topic paths; the copy serves their text.

What that mirror actually states, checked today: the topic titles and port counts
(`TNG1N206: 6 x 10 Gbit/s Line Service Processing Board`, `TNG1N210: 10 x 10 Gbit/s Line Service
Processing Board`, `TNV3N220: 20 x 10 Gbit/s Line Service Processing Board`) and one mapping table,
*"Mapping between the system control boards and cross-connect boards of an OptiXtrans 9800 E9624 /
E9612 / E9605 subrack"* (`E9624 subrack` → `TNG1CXP` with `TNG3CXCS01/TNG3CXCS02`; `E9612`/`E9605`
→ `TNG3CXP`/`TNG4CXP`).

What it does **not** carry in today's copy is the per-subrack `Y`/`NA` matrix itself: the string
`Not supported` occurs **0** times in its 226,637 bytes. So the earlier record's matrix was read from
a rendering that is no longer served, and the surviving copy supports the board *names and port
counts* only.

## 5. The vendor copy is still shut, at two user-agents

Same topic URL, `.../hedex/pages/EDOC1100126589BEJ09047/03/.../triu64/t212/t212.html`:

| user-agent | result |
|---|---|
| desktop Chrome/120 | **403**, 540 B, `<TITLE>Access Denied</TITLE>` |
| `Googlebot/2.1` | **302**, 0 B → `https://support.huawei.com/hedex/hdx.do?docid=EDOC1100126589&tocURL=...&tocLibId=BEJ09047&tocLibVer=03&ui=1` (viewer shell) |

So the chapter is published and gated, and no anonymous route returns its text — the mirror is the
only readable copy.

## 6. What the correction changes, and what it does not

The E9600 family requests were already blocked on one field; the field is now named correctly:

- **not** "a board part number" — the names, counts and rates are readable (`TNG1N206` 6x10G,
  `TNG1N210` 10x10G, `TNG1N401` 1x100G, and the `TNG1M*` transponder units);
- **but** no readable document states which of those boards a given subrack accepts. `TNG2DAP` §1.9
  is the DAP's own table, and the mirror's surviving copy carries no `Y`/`NA` matrix.

So the unblock is unchanged in kind and one step narrower in name: a vendor copy of the *Boards
Overview* (`EDOC1100163901`, the OptiXtrans E9600 Board Datasheet), or a stated build from the
requester (`E9624, 1:1, 24x TNG1N210`), which settles validity and complement in one line.

No port, rate, slot count or part number is invented by this file, and no spec is written from a
second-hand page.
