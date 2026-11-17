# NetEngine 8000 M8, M14 and M6 are card chassis with no fixed panel; the M4 is the exception

Seven open device requests (#789, #796, #797, #799, #800, #801, #802) ask for NetEngine 8000 models
and were parked on the same sentence: Huawei publishes slots and per-slot capacity, not a port
census. That is true, but the earlier passes stopped at the marketing page
(`e.huawei.com/en/products/routers/ne8000.html`). The primary document says something sharper, and it
is worth recording because it converts "blocked" into "one line away".

## The primary source, and how to read it

NetEngine 8000 M14, M8, M4 and 8000E M14, M8, M4 **V800R024C10SPC500 Hardware Description** —
document ID `EDOC1100465701`, dated 2025-04-29:

- https://support.huawei.com/enterprise/en/doc/EDOC1100465701/61857a8f/chassis
- https://support.huawei.com/enterprise/en/doc/EDOC1100465701/54204537/boards
- https://support.huawei.com/enterprise/en/doc/EDOC1100465701/af1a855b/interface-card
- https://support.huawei.com/enterprise/en/doc/EDOC1100465701/ed7ab88b/netengine-8000-m4
- https://support.huawei.com/enterprise/en/doc/EDOC1100465701/e4ccf4a0/netengine-8000-m8
- https://support.huawei.com/enterprise/en/doc/EDOC1100465701/f446cf6d/netengine-8000-m14

**These pages are readable, but not by a browser — by a search crawler.** A desktop user-agent gets
HTTP 403, `web_extract` gets the JavaScript shell with no body text, and a real browser gets an empty
page after the login redirect. A Googlebot user-agent gets HTTP 200 and the whole server-rendered
document (620 kB of HTML for the M4 page):

```
curl -sS -H 'User-Agent: Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' \
  'https://support.huawei.com/enterprise/en/doc/EDOC1100465701/e4ccf4a0/netengine-8000-m8'
```

That is the same material the earlier passes recorded as a login wall, so **the wall entries in
`docs/MAINTAINING.md` were pessimistic for this vendor**; they have been corrected there.

## What the slot tables say

The slot table is the whole argument. Quoted from the model pages:

NetEngine 8000 M8, Table 1-14:

> PIC | DC: 1-8, AC: 2, 4-8
> IPU | 9,10
> PIU | DC: 11,12, AC: 1,3
> FAN | 13

NetEngine 8000 M14, Table 1-25:

> PIC | DC: 1-14; AC (Including 4\*AC Power): 5-14; AC (Including 2\*AC Power): 2,4-14
> IPU | 15,16
> PIU | DC: 17,18; AC (4\*AC): 1-4; AC (2\*AC): 1,3
> FAN | 19

NetEngine 8000 M4, Table 1-7 — the odd one out:

> PIC | DC: 1-4, AC: 2 and 4
> **Fixed interface | 5**
> PIU | DC: 6 and 7, AC: 1 and 3
> FAN | 8

So the M4 has a fixed 36-cage panel in slot 5 — which is exactly what
`devices/huawei/netengine-8000-m4.json` models, and why that request closed — and **the M8 and M14
have no fixed-interface slot at all**. Every port on an M8 or M14 arrives on an interface card in a
PIC slot. An M8 with no cards is a chassis with fans, power and no cableable port; an M8 with the
maximum fitted is 8 cards' worth of ports, not "the device".

The same test applied to the neighbours: the M6 datasheet
(`data.nag.wiki` mirror of the Huawei PDF, "NetEngine 8000 M6 Service Router Datasheet", 2 U,
"6 service slots") accounts for its 11 DC slots as 6 PIC + 2 fabric/IPU + 2 PIU + 1 FAN, with no
fixed-interface row — and its *ordering table* says the same thing more bluntly, see
"The M6, checked against its own ordering table" below. The X4/X8/X16 are line-card chassis by
definition. None of them is a fixed-panel box.

## The card census

`interface-card` lists every PIC in this document family with the port count in its own name — 60
distinct part numbers across 74 orderable codes (a few cards ship under two BOM codes, for example
`CR5D00E1NC97` = `03033HAF` and `03033HAF-001`). This is the table a "state the configuration" answer gets
built from, so it is reproduced here rather than re-fetched each run. Order numbers are the
`0303…`/`0304…`/`0305…` BOM code where the page gives one, `—` where it does not.

| card | BOM | ports, as the vendor names it |
|---|---|---|
| `CR2D000DE110` | — | 16-Port E1 Physical Interface Card(75ohm) |
| `CR2D000DE111` | — | 16-Port E1 Physical Interface Card(120ohm) |
| `CR2D000IE110` | — | 32-Port E1 Physical Interface Card(75ohm) |
| `CR2D000IE111` | — | 32-Port E1 Physical Interface Card(120ohm) |
| `CR2D00E8GE12` | — | 8-Port 100/1000Base-RJ45 Physical Interface Card |
| `CR2D00EAGF10` | — | 10-Port 100/1000Base-X-SFP Physical Interface Card |
| `CR2D00L4XF11` | — | 4-Port 10GBase LAN/WAN-SFP+ Physical Interface Card |
| `CR5D000DE170` | — | 16-Port E1 Physical Interface Card(PIC,75ohm) |
| `CR5D000DE171` | — | 16-Port E1 Physical Interface Card(PIC,120ohm) |
| `CR5D000DE1C1` | — | 16-Port E1 Physical Interface Card(PIC,75ohm/120ohm) |
| `CR5D000IE170` | — | 32-Port E1 Physical Interface Card(PIC,75ohm) |
| `CR5D000IE171` | — | 32-Port E1 Physical Interface Card(PIC,120ohm) |
| `CR5D00C4CFC1` | — | 4-Port Channelized STM-1c POS-SFP Physical Interface Card(PIC) |
| `CR5D00E1NC97` | — | 03033HAF: 1-Port 100GE/ 1-Port 200GE CFP2 Physical Interface Card(PIC) (Enable 1*100GE by default) |
| `CR5D00E1NC97` | — | 03033HAF-001: 1-Port 100GE/ 1-Port 200GE CFP2 Physical Interface Card(PIC) (Enable 1*100GE by default) |
| `CR5D00E4XM25` | — | 03033BLK: 4-Port 25GE(SFP28)/10GE(SFP+) MACsec Physical Interface Card (PIC) |
| `CR5D00E4XM25` | — | 03033BLK-001: 4-Port 25GE(SFP28)/10GE(SFP+) MACsec Physical Interface Card (PIC) |
| `CR5D00E8GE71` | — | 8-Port 100/1000Base-RJ45 Physical Interface Card(PIC) |
| `CR5D00E8XM25` | — | 03033BLM: 8-Port 25GE(SFP28)/10GE(SFP+) MACsec Physical Interface Card (PIC) |
| `CR5D00E8XM25` | — | 03033BLM-001: 8-Port 25GE(SFP28)/10GE(SFP+) MACsec Physical Interface Card (PIC) |
| `CR5D00EAGF70` | — | 10-Port 100/1000Base-X-SFP Physical Interface Card(PIC) |
| `CR5D00EAGF95` | — | 03033FXE: 10-port 100/1000Base-X-SFP MACsec Physical Interface Card(PIC) |
| `CR5D00EAGF95` | — | 03033FXE-001: 10-port 100/1000Base-X-SFP MACsec Physical Interface Card(PIC) |
| `CR5D00EAGF96` | — | 10-port 100/1000Base-X-SFP MACsec Physical Interface Card(PIC) |
| `CR5D00EEGF73` | — | 03033GMU: 20-Port 100/1000Base-X-CSFP/10-Port 100/1000Base-X-SFP Physical Interface Card(PIC) |
| `CR5D00EEGF73` | — | 03033GMU-001: 20-Port 100/1000Base-X-CSFP/10-Port 100/1000Base-X-SFP Physical Interface Card(PIC) |
| `CR5D00L4XF72` | — | 4-Port 10GBase LAN/WAN-SFP+ Physical Interface Card(PIC) |
| `CR5D00L4XF91` | — | 03033FXF: 4-Port 10GE(SFP+)/GE(SFP) MACsec Physical Interface Card(PIC) |
| `CR5D00L4XF91` | — | 03033FXF-001: 4-Port 10GE(SFP+)/GE(SFP) MACsec Physical Interface Card(PIC) |
| `CR5D00LAXF90` | — | 10-Port 10GBase LAN/WAN-SFP+ Physical Interface Card(PIC) |
| `CR5D00LAXF91` | — | 03033BLN: 10-Port 10GE/GE LAN/WAN-SFP+ MACsec Physical Interface Card(PIC) |
| `CR5D00LAXF91` | — | 03033BLN-001: 10-Port 10GE/GE LAN/WAN-SFP+ MACsec Physical Interface Card(PIC) |
| `CR5D00P4CFC1` | — | 4-Port OC-3c/STM-1c POS-SFP Flexible Interface Card(PIC) |
| `CR5D04OTU290` | — | 4-Port 10G OTU2-XFP Physical Interface Card(PIC) |
| `CR5D0E5XMF94` | — | 03033GDR: 2-Port 50GBase/1-Port 100GBase-QSFP28 FlexE MACsec Physical Interface Card(PIC) |
| `CR5D0E5XMF94` | — | 03033GDR-001: 2-Port 50GBase/1-Port 100GBase-QSFP28 FlexE MACsec Physical Interface Card(PIC) |
| `CR5DE2NE4X14` | — | 03033GDS: 2-Port 100GBase/50GBase-QSFP28 FlexE MACsec Interface Card(PIC) |
| `CR5DE2NE4X14` | — | 03033GDS-001: 2-Port 100GBase/50GBase-QSFP28 FlexE MACsec Interface Card(PIC) |
| `CR8D000600C0` | — | 6 Channes E&M Interface Board |
| `CR8D000DE1C2` | — | 16-Port E1 Physical Interface Card(PIC,75ohm/120ohm) |
| `CR8D00E1KBC0` | — | 1-Port 400GBase-QSFP-DD Physical Interface Card(PIC) |
| `CR8D00E1NBC2` | — | 03034KEF: 2-Port 50GBase/1-Port 100GBase-QSFP28 FlexE MACsec Physical Interface Card(PIC) |
| `CR8D00E1NBC2` | — | 03035JVJ: 2-Port 50GBase/1-Port 100GBase-QSFP28 FlexE MACsec Physical Interface Card(PIC) for SME |
| `CR8D00E1NCC1` | — | 1-Port 100GE/ 1-Port 200GE CFP2 Physical Interface Card(PIC) (Enable 1*100GE by default) |
| `CR8D00E2NBC4` | — | 03034KEN: 2-Port 100GBase/50GBase-QSFP28 FlexE MACsec Physical Interface Card(PIC) |
| `CR8D00E2NBC4` | — | 03035JVF: 2-Port 100GBase/50GBase-QSFP28 FlexE MACsec Physical Interface Card(PIC) for SME |
| `CR8D00E4XFC1` | — | 03034EDU: 4-Port 10GE-SFP+ FlexE MACsec Physical Interface Card(PIC) |
| `CR8D00E4XFC1` | — | 03034EDU-001: 4-Port 10GE-SFP+ FlexE MACsec Physical Interface Card(PIC) |
| `CR8D00E4XFC3` | — | 4-Port 10GE(SFP+)/GE(SFP) MACsec Physical Interface Card(PIC) |
| `CR8D00E4XFC4` | — | 4-Port 10GE-SFP+ FlexE MACsec Physical Interface Card(PIC) |
| `CR8D00E4YBC1` | — | 4-Port 25GE-SFP28 Physical Interface Card (PIC) |
| `CR8D00E4YFC0` | — | 4-Port 25GE(SFP28)/10GE(SFP+) MACsec Physical Interface Card (PIC) |
| `CR8D00E8GEB2` | — | 8-Port 100/1000Base-RJ45 Physical Interface Card(PIC) |
| `CR8D00E8GEC1` | — | 03033MNN: 8-Port 100/1000Base-RJ45 Physical Interface Card(PIC) |
| `CR8D00E8GEC1` | — | 03033MNN-001: 8-Port 100/1000Base-RJ45 Physical Interface Card(PIC) |
| `CR8D00EAGFC3` | — | 10-Port 100/1000Base-X-SFP Physical Interface Card(PIC) |
| `CR8D00EAGFCA` | — | 10-port 100/1000Base-X-SFP MACsec Physical Interface Card(PIC) |
| `CR8D00EAXFC1` | — | 03034KEC: 10-Port 10GE/GE LAN/WAN-SFP+ MACsec Physical Interface Card(PIC) |
| `CR8D00EAXFC1` | — | 03035JVG: 10-Port 10GE/GE LAN/WAN-SFP+ MACsec Physical Interface Card(PIC) for SME |
| `CR8D00EEGFXA` | — | 20-Port 100/1000Base-X-CSFP/10-Port 100/1000Base-X-SFP Physical Interface Card(PIC) |
| `CR8D00L4XFC1` | — | 4-Port 10G-SFP+ Physical Interface Card(PIC) |
| `CR8D00L8YFC1` | — | 8-Port 25GE(SFP28)/10GE(SFP+) MACsec Physical Interface Card (PIC) |
| `CR8D00P8CFC1` | — | 8-Port STM-1c/8-Port STM-4c POS Card (PIC)(Default Enable 4*STM-1c) |
| `CR8DE1KB00M1` | — | 1-Port 400GBase-QSFP-DD Single-layer Physical Interface Card(PIC) |
| `CR8DE1KB00M2` | — | 1-Port 400GBase-QSFP-DD Single-layer Physical Interface Card CM(Enable 1*100G)(PIC) |
| `CR8DE1N8XFM0` | — | 1-Port 100GBase/50GBase-QSFP28 FlexE MACsec+8-Port 10GE(SFP+)/GE(SFP) MACsec Physical Interface Card(PIC) |
| `CR8DE1NE2VC1` | — | 2-Port 50GBase/1-Port 100GBase-QSFP28 Physical Interface Card(PIC) |
| `CR8DE1NEKB11` | — | 1-Port 400GBase-QSFP-DD Physical Interface Card CM(Enable 1*100G)(PIC) |
| `CR8DE2NB00M0` | — | 2-Port 100GBase/50GBase-QSFP28 Interface Card(PIC) |
| `CR8DE4NB00M1` | — | 4-Port 100GBase/50GBase-QSFP28 Physical Interface Card(PIC) |
| `CR8DE8YF0025` | — | 8-Port 25GE(SFP28)/10GE(SFP+) MACsec Physical Interface Card (PIC) |
| `CR8DFA0E00M1` | — | 4-Port FXS/FXO + 2-Port E&M + 2-Port RS232 + 2-Port RS485 Physical Interface Card(PIC) |
| `CR8DG80400C0` | — | 4 Channels C37.94 Optical Interface and 4 Channels CoDir64K Electric Interface Board |
| `CR8DL8EFFEC1` | — | 8-Port 10GE LAN/WAN-SFP+ FlexE MACsec Physical Interface Card(PIC) |

Two caveats on that table, both deliberate:

- A card's presence in this document means it belongs to the M14/M8/M4/8000E family; **which of
  those chassis will take a given card, and how many ports a slot enables, is stated on the card's
  own page**, not in this list. That page is one click from each row above and fetches with the same
  crawler user-agent.
- Some cards are the same part number under two order codes (for example `CR8D00EAXFC1` is
  `03034KEC` and `03035JVG`, the second marked "for SME"). The port count is identical; the BOM
  differs. Do not collapse the two codes in a spec that cites an order.

## The M6, checked against its own ordering table

#796 was the one member of the family whose "no fixed panel" claim rested on a datasheet summary
rather than on the primary document. Checked 2026-11-17 against the M6's own pages:

- `https://support.huawei.com/enterprise/en/doc/EDOC1100382052/374d9a7/netengine-8000-m6` —
  *NetEngine 8000 M6, M1D, and M1C V800R023C10SPC500 Hardware Description*, read whole with a crawler
  UA (HTTP 200, 526,382 bytes). Table 1-29 "Slots on the NetEngine 8000 M6": PIC **DC 1-6 / AC 2, 4-6**,
  CXP 7, 8, PIU **DC 9, 10 / AC 1, 3**, FAN 11. **No fixed-interface row.**
- Same page, Tables 1-30 and 1-31: DC chassis **11 slots / 6 service board slots**, AC chassis
  **9 slots / 4 service board slots**, switching capacity 320 Gbit/s, and a maximum-port block reading
  "Maximum number of physical ports on the entire device: **100**", "Maximum number of 25GE ports: 6",
  "10GE ports: 16", "50GE ports: 2", "100GE ports: NA", "40GE ports: NA". Every one of those is a
  maximum over six fitted cards, not a panel: an AC M6 has four service slots and cannot reach them.
- `https://e.huawei.com/marketingcloud/pep/asset/20000001/Material/b50df453e4bf4ca4b99ef855437e8cc9/M3T1A590N1140254128116289674/NetEngine%208000%20M6%20Universal%20Service%20Router%20Datasheet.pdf`
  — the current M6 datasheet (340 kB, HTTP 200): "supports up to 160G port capacity and 6 service
  slots", spec table "Service Slots 6 (DC) / 4 (AC)". No port list, and this revision has **dropped**
  the Ordering Information section entirely.
- The ordering table survives in the earlier datasheet revision, e.g. the `data.nag.wiki` mirror
  `https://data.nag.wiki/Huawei/Datasheet/NE8000/8000M6.pdf` (12 pages), "Ordering Information →
  Basic Hardware Configurations → NetEngine 8000 M6 Basic Configurations":

  | BOM | Order name | Contents |
  |---|---|---|
  | `02353HHB` | `CR8PM6BASDC1` | chassis, 2\*CXP-160, 2\*DC power, without software and document |
  | `02353HHG` | `CR8PM6BASAC1` | chassis, 2\*CXP-160, 2\*AC power, … |
  | `02353LKW` | `CR8PM6BASDC3` | chassis, 2\*CXP-160-B, 2\*DC power, … |
  | `02353LKY` | `CR8PM6BASAC3` | chassis, 2\*CXP-160-B, 2\*AC power, … |

  **No PIC.** Every interface card is a separate BOM line further down the same table — 1-port 50GE
  `CR8D00E1VBC0`, 2-port 25G/2-ch 10G `CR8D25E2XFC0`, 4-port 10GE/GE MACsec `CR8D00L4XFC0`, 10-port
  100/1000Base-X-SFP MACsec `CR8D00EAGFC0`, 8-port 100/1000Base-RJ45 `CR8D00E8GEC2`, 4-port 10GE-SFP+
  `CR8D00L4XFC2`, a 20-port CSFP/10-port SFP combo `CR8D00EEGFC0` — alongside the E1, cPOS,
  V.35/X.21 and FXS/FXO voice boards. (The BOM column of *that* block is scrambled in the PDF's text
  layer, so pair a card to its `0303…`/`0305…` code off the rendered table, not off `pdftotext`; the
  four basic-configuration codes in the table above are the ones that extract cleanly.)

That turns the earlier inference into a statement about the goods: **an M6 as ordered has no cableable
port.** #796 asks for the model, and the base model has none — which is why the issue is parked on a
configuration rather than on research.

The nearest thing Huawei publishes to a stated configuration is the "Typical configuration" pair the
hardware description uses for its power and heat figures:

> [CXP-160/CXP-160-B] DC Typical configuration 1: 2\*CXP + 1\*FAN + 2\*DC power + 2\*`CR8D00L4XFC0`
> + 2\*`CR8D00EAGFC0` = 196.1 W
>
> DC Typical configuration 2: 2\*CXP + 1\*FAN + 2\*DC power + 2\*`CR8D00E1VBC0` +
> 1\*`CR8D00L4XFC0` + 1\*`CR8D00EAGFC0` = 205.8 W

These name real cards and a real chassis, and they are the two configurations a lab is most likely to
have in front of it. They are still **not orders**: they carry no slot assignment, Huawei presents them
only as the load used to measure power and heat, and configuration 2 leaves two of the six PIC slots
empty. Recorded here as the evidence a "state the configuration" answer should quote, not as a licence
to build an M6 spec from a wattage table.

## What would close #796, #797, #799, #800, #801, #802

One sentence naming the cards, in the form the vendor writes them — for the M6 the datasheet's own
card part numbers are the ones to use, since it has just six DC (four AC) PIC slots:

> NetEngine 8000 M8 (DC), slots 1-2 = `CR8D00EAXFC1`, slots 3-4 = `CR8D00E4YFC0`

That is enough to build a spec with no inference: the chassis fixes the slot count, the cards fix
every port, and both are on the pages above. What cannot be built is the bare model, because the
bare model has no ports — a catalogue entry for "NetEngine 8000 M8" with an empty `interfaces` array
would be a question, and one with a representative card set would be an invented order.

The flat port list the catalogue uses has no way to express "8 slots, card-dependent", so this is
also the one thing a catalogue change could fix later: a slot list plus a card list would let these
six requests be modelled as chassis rather than parked.

## The M8 has a vendor-stated build after all: its own measurement configuration (2026-11-17)

The conclusion above - "the bare model has no ports, and a representative card set would be an invented
order" - was right about the bare model and wrong about the vendor. Huawei does print a card complement
for the M8, in the row it uses to state power and heat, and the row is complete:

> Typical power consumption (with configuration) [W]
> [IPU-2T4-A/IPU-2T4-E-B] `2*CR8DE1KB00M1(1*400GE)+1*CR8DE4NB00M1(4*100GE)+1*CR8DE8YF0025(8*25GE)+2*CR5D00LAXF91(10*10GE)` = 774.3 W

Read on 2026-11-17 from the AC specification table of the vendor datasheet
`https://e.huawei.com/marketingcloud/pep/asset/20000001/Material/e9dd06e260b64df683f6221fc8442cbf/M3T1A590N1140253824460255266/NetEngine%208000%20M8%20Universal%20Service%20Router%20Datasheet.pdf`
(HTTP 200, `application/pdf`, 514,517 B) and cross-read in the Hardware Description's M8 model page
`https://support.huawei.com/enterprise/en/doc/EDOC1100465701/e4ccf4a0/netengine-8000-m8` (HTTP 200 with a
crawler user-agent, Tables 1-19/1-20).

Two things make this row usable where the M6's typical configurations were not:

1. **It closes the slot count exactly.** The AC chassis has six PIC slots (HD Table 1-14: `PIC AC: 2, 4-8`;
   datasheet: "Number of slots 11, Number of service board slots 6") and this build carries six cards -
   2 + 1 + 1 + 2. Nothing is left to choose, so no slot is silently empty and no card-to-slot assignment
   has to be guessed.
2. **Every card states its own port count and socket in its name**, which is where the numbers come from
   rather than from a maximum: `CR8DE1KB00M1` "1-Port 400GBase-QSFP-DD Single-layer Physical Interface
   Card(PIC)", `CR8DE4NB00M1` "4-Port 100GBase/50GBase-QSFP28 Physical Interface Card(PIC)",
   `CR8DE8YF0025` "8-Port 25GE(SFP28)/10GE(SFP+) MACsec Physical Interface Card (PIC)", `CR5D00LAXF91`
   "10-Port 10GE/GE LAN/WAN-SFP+ MACsec Physical Interface Card(PIC)" - all on
   `https://support.huawei.com/enterprise/en/doc/EDOC1100465701/af1a855b/interface-card`.

That build is `devices/huawei/netengine-8000-m8.json`: 34 ports (2x 400GE QSFP-DD, 4x 100GE/50GE QSFP28,
8x 25GE/10GE SFP28, 20x 10GE/GE SFP+), and it closes #797.

The DC chassis has its own stated build and it is a different population - seven cards against eight
service slots (`2*CR8DE1KB00M1+1*CR8DE4NB00M1+1*CR8DE8YF0025+2*CR5D00LAXF91+1*CR5D00EAGF95(10*GE)` = 739.1 W),
so one slot is empty in it. It is deliberately not folded into the AC entry; an M8 DC spec would need that
row quoted as its own build.

What this does **not** settle: which card sits in which PIC slot (the vendor does not print an order, so the
spec's port names are flat rather than slot-numbered). The M14 was read on a later pass - see below.

## The M14, read 2026-11-17: the build exists, but no M14 build fills its chassis

`https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/f4f1a7b9424a44ff9770b75a19eb5d2e/M3T1A590N1267221252983996547/NetEngine%208000%20M14%20Universal%20Service%20Router%20Datasheet.pdf`
(HTTP 200, `application/pdf`, 446,839 B) prints the M14 specification table: `Service Slots 14 (DC) / 10 (4AC) /
12 (2AC)`, `442 mm x 220 mm x 222 mm (5U)`, switching `2.4 / 4 / 7.2 Tbps` for IPU-1T2 / IPU-2T / IPU-3T6,
typical power `486 W / 968 W / 931 W`, and the headline `64K~400GE full-rate interfaces`. It prints **no card
list**, so as on the M8 the build has to come from the chassis page's power row.

The DC chassis `CR8B0BKPDCC1` (02353ABJ) states:

> `[IPU-2T/IPU-2T-B]DC: 1*fan+2*DC power+2*IPU+2*CR5DE2NE4X14+1*CR5D00E8XM25+3*CR5D00LAXF91+1*CR5D00EAGF95=905.6 W`

Seven PICs against **fourteen** PIC slots. The difference from the M8 is worth stating plainly: on the M8 the
stated build happened to fill all six AC service slots, which is why it needed no judgement call. On the M14
**no published build fills the chassis** - the same seven cards are stated for the 10-slot 4*AC chassis
(`CR8B0BKPACC2`, 02353ABK, 968.36 W) and a seven-card variant for the 12-slot 2*AC chassis
(`CR8B0BKPACC1`/`ACC6`, 935.81 W). So the choice is not "which build fills it" but "which chassis the build is
measured on", and the DC chassis wins because it is the one #799 names (`14 service slots`) - the request's
figure is confirmed as a slot count, not a socket count, by the datasheet's own `14 (DC)`.

Ports follow from the card names exactly: `CR5DE2NE4X14` "2-Port 100GBase/50GBase-QSFP28 FlexE MACsec Interface
Card(PIC)" x2, `CR5D00E8XM25` "8-Port 25GE(SFP28)/10GE(SFP+) MACsec Physical Interface Card (PIC)" x1,
`CR5D00LAXF91` "10-Port 10GE/GE LAN/WAN-SFP+ MACsec Physical Interface Card(PIC)" x3, `CR5D00EAGF95`
"10-port 100/1000Base-X-SFP MACsec Physical Interface Card(PIC)" x1 => 4x 100GE, 8x 25GE, 30x 10GE, 10x GE = **52
ports**, in 7 of 14 slots. `devices/huawei/netengine-8000-m14.json` closes #799.

The newer IPU-3T6 chassis codes are a **separate population** on the same 10/12-slot field:
`CR8B0BKPACM1` (2*AC, 02355VUR) and `CR8B0BKPDCM1` (DC, 02355VUS) state
`2*CR8DE1KB00M1(1*400GE)+2*CR8DE4NB00M1(4*100GE)+2*CR5D00LAXF91(10*10GE)+2*CR5D00EAGF95(10*GE)=931.67 W` -
eight cards, 50 ports. They are recorded, not merged: different forwarding units (7.2 Tbit/s), different port
population.
