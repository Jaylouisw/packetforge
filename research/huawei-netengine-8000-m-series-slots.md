# NetEngine 8000 M8 and M14 are 8- and 14-card chassis with no fixed panel; the M4 is the exception

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
fixed-interface row; the X4/X8/X16 are line-card chassis by definition. None of them is a
fixed-panel box.

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

## What would close #796, #797, #799, #800, #801, #802

One sentence naming the cards, in the form the vendor writes them:

> NetEngine 8000 M8 (DC), slots 1-2 = `CR8D00EAXFC1`, slots 3-4 = `CR8D00E4YFC0`

That is enough to build a spec with no inference: the chassis fixes the slot count, the cards fix
every port, and both are on the pages above. What cannot be built is the bare model, because the
bare model has no ports — a catalogue entry for "NetEngine 8000 M8" with an empty `interfaces` array
would be a question, and one with a representative card set would be an invented order.

The flat port list the catalogue uses has no way to express "8 slots, card-dependent", so this is
also the one thing a catalogue change could fix later: a slot list plus a card list would let these
six requests be modelled as chassis rather than parked.
