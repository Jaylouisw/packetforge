# NetEngine 8000 F8: the board census, and the configuration Huawei itself quotes

**Question.** #789 asked for the NetEngine 8000 F8 and was parked on "Huawei publishes slots and
per-slot capacity, not a port census" — the same sentence that parked the whole M/X family. For the
F8 that stops being true one document further down: the hardware guide carries a full board chapter,
and the chassis spec table quotes typical power *for a named board mix*. That mix is the stated
configuration, so the F8 is modellable as `devices/huawei/netengine-8000-f8.json`.

## Sources

* Hardware guide, **NetEngine 8000 F8, 8000E F8 V800R024C10SPC500**, Issue 06 (2026-06-30),
  document ID `EDOC1100280456` — <https://support.huawei.com/enterprise/en/doc/EDOC1100280456>.
  Read with a Googlebot user agent (2.1 MB of server-rendered HTML); a desktop UA gets HTTP 403 and
  `web_extract` gets the preview shell with no body. Same crawler trick as
  `research/huawei-netengine-8000-m-series-slots.md`.
* Datasheet PDF, *NetEngine 8000 F8 Service Router* (2022 edition) —
  <https://e.huawei.com/marketingcloud/pep/asset/20000001/Material/e679822234f94651b2c2153c21a6621b/M2T1A669N893162565584830493/NetEngine%208000%20F8%20Universal%20Service%20Router%20Datasheet.pdf>
* Series page — <https://e.huawei.com/en/products/routers/ne8000> (the F8 column: 8 line cards,
  28.86 Tbit/s, 2362 W typical, 575 mm 13U, 121.6 kg).

## Slots and port names (guide §3.5.1.2–3.5.1.4)

| Slot type | IDs | Notes |
|---|---|---|
| LPU | 1–8 | "Different types of LPUs can be installed in the same chassis." |
| SRU | 9–10 | 1:1, lower ID is master |
| MPU | 11–12 | 1:1 |
| PM | PWR1–PWR6 | 2+1 DC, 1+1 or 2+2 AC depending on the bundle |
| Fan | FAN1–FAN3 | two fitted by default |

Port numbering is `slot ID/PIC ID/port number`. PIC IDs start at 0; an LPUC has no PIC, so its PIC
ID is 0; port numbers run from 0 left to right (top to bottom on a two-row panel). The guide's own
example: "the fifth interface … on the interface board is numbered 3/0/4" for slot 3.

## The boards

| Board | Silkscreen | Ports | Rate / cage | MACsec | Breakout |
|---|---|---|---|---|---|
| `CR8DE8NB00F0` (03050LDQ) | LPUC-800-CM 8x100GE-QSFP28 | 8 (0–7) | 100GE/50GE/40GE, QSFP28 | No | 1x50/1x40GE on 6T4-A; +4x25/4x10GE on 6T4-B |
| `CR8DEKNBXFF0` | LPUC-800-CM | 4 + 40 | 100GE QSFP28 + 10GE/GE SFP+ | — | — |
| `CR8DERXFMSF0` | LPUC-800-CM | 72 (0–71) | 10GE/GE, SFP+/SFP | Yes | No |
| `CR8DERGF00F1` | LPUC-100 | 72 | GE 100/1000Base-X SFP | Yes | — |
| `CR8DE1KB00F0` | LPUC-400-CM | 1 | 400G QSFP-DD (100G by default) | — | — |
| `CR8DLPUTK0C0` | LPUT-800-CM | 0 | trunk, takes 4 PICs per slot | — | — |

PIC IDs 0–3 fill an LPUT's four PIC positions. The PIC set is the 2022 datasheet's (10x 10GE/GE
SFP+, 10x 100/1000Base-X SFP, 8x 100/1000Base-RJ45, 4x 10GE SFP+, 2x50G/1x100G QSFP28, 16x E1,
4x channelized STM-1c POS, 8x STM-1c/STM-4c POS), plus a 4x25GE/10GE MACsec card in the 2026 guide.

## Why the 6.4T bundle and not "eight 8x100GE"

The chassis table states switching capacity per bundle — **11.35 Tbit/s** for the 1.6T/2T bundles,
**28.86 Tbit/s** for the 6.4T bundle — and quotes typical power *for a configuration*: "2362 W
(configured with SRU 6T4-B and **four 8x100GE ports and four 72x10GE ports**)". That sentence fixes
the board mix without anyone choosing it: 4x `CR8DE8NB00F0` + 4x `CR8DERXFMSF0` = 32x 100GE +
288x 10GE/GE. Which slots carry which board is *not* in the source, so the spec's placement (100GE in
1–4, 10GE in 5–8) is its own arrangement; any LPUC-800-CM board may sit in any of slots 1–8 with an
SRU-6T4-B, and the slot limits in the guide (3/6, or 4/5, on an SRU-6T4-A) bind FlexE only.

Two consequences worth keeping:

* **The 2022 datasheet describes the older bundle.** Its "up to 32 PICs, 8 LPUCs" and "maximum
  interface capacity per device: 24 x 100GE; 240 x 10GE; 320 x GE; 512 x E1; 256 x STM" are the
  PIC-based build (32 PICs x 10 ports = 320 GE, 32 x 16 E1 = 512 E1, 32 x 8 STM = 256 STM), and its
  1680 W / 2 Tbps belong to it. Modelling the F8 from the datasheet alone therefore gives a *different
  and smaller* box than modelling it from the guide.
* **RTU licensing gates the line rate, not the port.** The 8x100GE board is limited to 100 Mbit/s per
  port until the RTU licence loads (and is then 40/50/100GE auto-sensing); the 72-port board is
  unlimited in GE mode and limited to 100 Mbit/s in 10GE mode. A lab that models "64x 100G at line
  rate" is modelling a licensed configuration.

## Still unmodelled

The PIC-based builds (LPUT-800-CM + up to four PICs per slot), the LPUC-100 GE board, the
4x100GE+40x10GE board, the 400G QSFP-DD board and the VSUP-100 service card — each a different box.
The M4/M6/M8/M14 and X4/X8/X16 chassis (#796, #797, #799–#802) need their own board chapters: the
`EDOC1100465701` M-series description already covers those, the X series does not yet.
