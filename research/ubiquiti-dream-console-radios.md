# The Dream consoles ship with an access point and were catalogued as wired-only

Read 2026-11-19 19:2x–19:3x UTC, for #130. The request behind that issue is a UniFi console
modelled as a routed gateway (NAT, DHCP, VPN, WAN), and the catalogue's consoles carried their
Ethernet, SFP+ and PoE rows but **no radios**: a lab could cable one but could not associate a
phone, laptop or AP-less client to it. That is not a missing nicety — on the Dream Wall the WiFi 6
access point is part of the chassis, and Ubiquiti's own device database lists `ACCESS_POINT`
alongside `GATEWAY` and `SWITCH` in that box's `deviceCapabilities`.

## 1. What each vendor page states

| row | WiFi standard | 2.4 GHz | 5 GHz | 6 GHz | source (read 2026-11-19) |
|---|---|---|---|---|---|
| `udw` | 802.11a/b/g/n/ac/ax (WiFi 6) | 300 Mbps, 2x2 | 2.4 Gbps, 4x4 | — | <https://dl.ui.com/ds/udw_ds.pdf> (200, 544,909 B, 3 pp, text layer) and <https://techspecs.ui.com/unifi/cloud-gateways/udw> (200, 704,702 B) |
| `udr` | 802.11a/b/g/n/ac/ax (WiFi 6) | 600 Mbps, 4x4 | 2.4 Gbps, 4x4 | — | <https://dl.ui.com/ds/udr_ds.pdf> (200, 771,202 B, 3 pp, text layer) and <https://techspecs.ui.com/unifi/cloud-gateways/udr> (200, 685,837 B) |
| `udr7` | 802.11a/b/g/n/ac/ax/be (WiFi 6/6E, WiFi 7) | 688 Mbps, 2x2 | 4.3 Gbps, 2x2 | 5.7 Gbps, 2x2 | <https://techspecs.ui.com/unifi/cloud-gateways/udr7> (200, 694,590 B) |
| `udr-5g-max` | 802.11a/b/g/n/ac/ax/be (WiFi 6/6E, WiFi 7) | 688 Mbps, 2x2 | 4.3 Gbps, 2x2 | 5.7 Gbps, 2x2 | <https://techspecs.ui.com/unifi/cloud-gateways/udr-5g-max> (200, 876,426 B) |

The two datasheet rows above were read out of the PDF text layer, not a rendered image:
`MIMO 2.4 GHz 2 x 2 / 5 GHz 4 x 4`, `Throughput rate 2.4 GHz 300 Mbps / 5 GHz 2.4 Gbps`,
`WiFi standards 802.11a/b/g/n/ac/ax` for the Dream Wall, and the same three rows at 4x4 /
600 Mbps / 2.4 Gbps for the Dream Router. `udr7` and `udr-5g-max` have no datasheet on
`dl.ui.com` — `/ds/udr7_ds.pdf` and `/ds/udr-5g-max_ds.pdf` both answer **302** to the marketing
home page — so for those two the rendered tech-spec table is the only vendor source.

## 2. How the rows are modelled

`radio0` is the 2.4 GHz radio by the convention already used by `ux`, `ux7`, `U6-Lite` and
`U7-Pro`, `radio1` the 5 GHz one and `radio2` the 6 GHz one, each at the vendor's throughput
figure for its band. `bands` is declared per radio, because `derivePortHardware()` infers the band
set from the rate alone (`generationBands()`): a 2.4 Gbps 802.11ax radio would otherwise be
credited with 2.4/5 **and 6 GHz**, and a 4.3 Gbps 802.11be radio likewise — a band the chassis
does not have. Declared bands win over the inference in `engine/media.js`.

Checked through the engine, not by eye:

```
wlan0 <-> radio0  ok=true  wireless-2.4  300 Mbps      (iPhone 16 to UDW)
wlan0 <-> radio1  ok=true  wireless-5    1000 Mbps
wlan0 <-> sfp1    ok=false "A wireless radio cannot be cabled to a wired port."
```

## 3. What is deliberately left alone

- **`udm` (base Dream Machine).** Its tech-spec page prints the WiFi section without throughput or
  MIMO rows (`802.11ac (WiFi 5) 6.5 Mbps to 1.7 Gbps`, no per-band figures), so no per-radio rate
  can be traced. It stays wired-only until a source states the band rates.
- **The rest of the catalogue's radios.** They declare `speed` and no `bands`, so their band sets
  are rate-derived. That is a separate question from this one and is not touched here — the four
  rows above are the only ones whose vendor page states a per-band rate that the inference would
  otherwise mis-state as including 6 GHz.
- **The Pro Dream Wall.** Nothing in this change is written from the non-Pro's numbers; #130 stays
  blocked on the Pro's own census.
