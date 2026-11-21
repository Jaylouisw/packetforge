# UniFi gateways: Ubiquiti's fingerprint says which of them are switches

Written 2026-11-21 for request #130 (Dream Wall Pro). The Pro has no vendor page, so the work this
thread can still do is on the rows around it - and the missing `l2-forward` on the Dream-family rows
turned out to be checkable against a vendor surface the thread had not used for that question.

## The instrument

`https://static.ui.com/fingerprint/ui/public.json` (HTTP 200, 832,585 B, read 2026-11-21) is the
device database UniFi controllers adopt from. Each SKU carries:

- `unifi.network.deviceCapabilities` - a capability list, e.g. UDR: `GATEWAY`, **`SWITCH`**,
  `ACCESS_POINT`, `NETWORK_APPLICATION`, `PROTECT_APPLICATION`, `CONTROLLER`, `APPLICATION_MODE`,
  `HAS_CLIENTS`;
- `unifi.network.diagram` - the panel drawn as port positions, `__` for a gap: UDR
  `01 02 03 04 __ 05`, UDM the same, UCG-Ultra the same, UDM-Pro `01 03 05 07 __ __ 10` /
  `02 04 06 08 __ 09 11`.

`SWITCH` in that list is the vendor classifying the box as a switch, which is the claim
`l2-forward` encodes. It is stronger than a MAC-table inference and it is per-SKU, so it also
separates the gateways that are *not* switches: UXG-Lite (`01 02`), UXG-Enterprise (`01 03 05`),
UXG-Pro (`01 03` / `02 04`) and EFG carry no `SWITCH` and have no LAN bank to bridge.

The diagram is the second half: a `4 + 1` split with the singleton set apart matches the datasheet's
`LAN: (4) / WAN: (1)`, which is how the UDR got a WAN role this pass without guessing a socket.

## Worklist left by this pass

Rows whose vendor record says `SWITCH` but whose spec still has no `l2-forward` (read 2026-11-21):

| SKU | diagram | spec |
|---|---|---|
| UDM | `01 02 03 04 __ 05` | `devices/ubiquiti/udm.json` |
| UDR7 | `01 02 03 04 05` | `devices/ubiquiti/udr7.json` |
| UDR-5G-Max | `01 02 03 04 05` | `devices/ubiquiti/udr-5g-max.json` |
| UXG-Fiber | `01 02 03 04 05 06 07` | `devices/ubiquiti/uxg-fiber.json` (not `ucg-fiber.json`, which is a different SKU and was fixed in PR #2338) |
| UCG-Industrial | `01 02 03 04 05 06` | `devices/ubiquiti/ucg-industrial.json` |
| UDM-Beast | `01 03 05 07 09 __ 11 13` / `02 04 06 08 10 __ 12 14` | `devices/ubiquiti/udm-beast.json` |
| EF-Core | `01 03 05 07 09 11 13 __ 15 23 __ 31` | `devices/ubiquiti/ef-core.json` |

Fixed this pass: `UDR` (MAC Address Table Size 1,000, VLAN segmentation, `VLAN 802.1Q` in the
datasheet, fingerprint `SWITCH`). Each remaining row needs its own count read off its tech-spec page
before the same change - the `4 + 1` and `4 + 0` diagrams differ, so the WAN socket is not always
the separated one.

## Worklist closed, 2026-11-21 (second pass)

All seven remaining rows now declare `l2-forward`. Each was read off its own tech-spec page before the
change; the pages are server-rendered and answer 200 to a bot UA, while an unknown slug 307s to the
609,911 B techspecs front page, so the byte count is the test. Read 2026-11-21, bytes as returned.

| SKU | MAC Address Table Size | LACP row | VLAN segmentation row | page bytes | fingerprint |
|---|---|---|---|---|---|
| UDM | *(no table on the tech-spec page)* | absent | absent | 608,032 | `SWITCH`, `01 02 03 04 __ 05` |
| UDR7 | 2,000 | absent | ticked | 694,590 | `SWITCH`, `01 02 03 04 05` |
| UDR-5G-Max | 2,000 | absent | absent | 876,426 | `SWITCH`, `01 02 03 04 05` |
| UXG-Fiber | 4,000 | absent | absent | 649,433 | `SWITCH`, `01 02 03 04 05 06 07` |
| UCG-Industrial | 4,000 | absent | ticked | 699,443 | `SWITCH`, `01 02 03 04 05 06` |
| UDM-Beast | 32,000 | ticked | absent | 679,909 | `SWITCH`, `01 03 05 07 09 __ 11 13` / `02 04 06 08 10 __ 12 14` |
| EF-Core | 130,000 | ticked | absent | 674,322 | `SWITCH`, `01 03 05 07 09 11 13 __ 15 23 __ 31` / `02 04 06 08 10 12 14 __ 19 27 __ __` |

The UDM is the exception and the reason is recorded rather than glossed: its tech-spec page carries the
model name and no specification table at all (125 text cells, no `MAC Address Table Size` row), so the
evidence is the datasheet (`https://dl.ui.com/ds/udm_ds.pdf`, 200, 747,030 B, three pages, text layer
1,936 chars) which prints `VLAN 802.1Q` in Software beside `(4) LAN: GbE RJ45 ports / (1) WAN: GbE RJ45
port`, plus the fingerprint's `SWITCH` classification. That is weaker than a printed FDB size and is
labelled as such in the spec note.

WAN roles were deliberately left alone: none of these pages pins a copper socket to WAN. UDR7 and
UDR-5G-Max print `Default WAN Ports = (1) 10G SFP+ / (1) 2.5 GbE RJ45` with `Max. WAN Port Count = 4`
over one unbroken five-socket diagram; UCG-Industrial prints three default WAN ports over a six-socket
run. Naming a copper socket WAN there would be a guess, and a wrong one would move a saved lab's uplink.
