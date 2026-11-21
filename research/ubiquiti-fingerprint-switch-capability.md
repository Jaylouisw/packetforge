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
