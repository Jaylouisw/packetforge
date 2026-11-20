# `show lldp neighbors`: what a Cisco switch actually prints, column by column

**Question (one, narrow).** On an IOS-like access switch, what is the exact shape of the `show lldp neighbors`
table - the legend above it, the columns and their widths, what happens to a Device ID that does not fit, and
what the Capability cell contains?

**Verdict: settled, and the console was printing a different table.** A box prints a four-line capability legend,
one blank line, a five-column header whose columns start at fixed offsets (0, 20, 35, 46, 62), the neighbour
rows, one blank line, and `Total entries displayed: N`. PacketForge printed its own shape - a
`LLDP neighbours on <device>:` heading over `Neighbour / Local port / Port ID / Mgmt address`, with widths taken
from the data. The view now prints the box's table, and the frame carries the System Capabilities TLV whose
letters the Capability column shows.

## The capture

The decisive source is a **preserved ASCII fixture**, not an HTML page whose whitespace has been reflowed:
`tests/cisco_ios/show_lldp_neighbors/cisco_ios_show_lldp_neighbors.raw` in
[networktocode/ntc-templates](https://github.com/networktocode/ntc-templates), read from
`https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/cisco_ios/show_lldp_neighbors/cisco_ios_show_lldp_neighbors.raw`:

```
Capability codes:
    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device
    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other

Device ID           Local Intf     Hold-time  Capability      Port ID
S2                  Fa0/13         120        B               Gi0/13
Cisco-switch-1      Gi1/0/7        120                        Gi0/1
Juniper-switch1     Gi2/0/1        120        B,R             666
Juniper-switch1     Gi1/0/1        120        B,R             531
Polycom VVX 500     Gi1/0/2        120        T               0004.f2d1.2222

Total entries displayed: 5
```

Measured off that capture: `Device ID` is 20 wide, `Local Intf` 15, `Hold-time` 11, `Capability` 16, then
`Port ID` to the end of the line. The same file's TextFSM template states the width from the other side -
`Value Required NEIGHBOR_NAME (.{0,20}(?<! ))` - and the `Capability` value pattern is `[BRCWPSTO,]+$, i.e. the
legend's letters, comma-separated when there is more than one.

Four things in it are easy to get wrong and each is visible above:

1. the legend is **four lines**: the heading plus two text lines, indented four spaces, and **one blank line**
   before the header (the HTML transcripts on cisco.com lose that blank line, which is how this repository
   previously concluded there was none anywhere - including between the last row and the count);
2. the Capability cell can be **blank** - the `Cisco-switch-1` row - because that neighbour advertised no System
   Capabilities TLV. It is not `-`, and it is not a guessed letter;
3. more than one capability prints **comma-separated in bit order**: `B,R` for an L3 switch, `T` for a phone;
4. the count is separated from the last row by **one blank line**.

## The 20-character Device ID

| Source | Says |
| --- | --- |
| [Cisco 8000 IOS XR Interface and Hardware Component Command Reference, `show lldp neighbors` field table (PDF)](http://www.cisco.com/c/en/us/td/docs/iosxr/cisco8000/Interfaces/b-interfaces-hardware-component-cr-8000/ethernet-interface-commands.pdf) | "**Device ID** - Name of the neighbor device. Note: If the device ID has more than 20 characters, the ID will be truncated to 20 characters in command output because of display constraints." |
| [ntc-templates issue #375, "show_lldp_neighbors.template failing when switch + domain name is long"](https://github.com/networktocode/ntc-templates/issues/375) | The behavioural witness: "When the hostname + domain name gets long the lldp neighbor output truncates at 20 characters", with the row `long_name_swt.josh-vGi0/2 120 R Gi0/0` - twenty characters then the port, no separator. |
| The fixture above | `Cisco-switch-1` (14) padded, `Juniper-switch1` (15) padded, and the 3750 configuration example's `Baseline Switch 2426Gi1/0/18` - exactly 20 characters, flush against the next field. |

So the rule is: cut at 20, no ellipsis, no space. The column is the truncation, which is why the engine cannot
keep "widths from the data" and truncate at the same time.

## The capability letters

IEEE 802.1AB-2016 Table 8-4 fixes the System Capabilities bitmap; Cisco's legend fixes the letters and prints
them in bit order. The bits this model can honestly set come from each device's own catalogue entry:

| Catalogue fact | Bit | Letter |
| --- | --- | --- |
| `capabilities` contains `host` | 0x0080 | `S` - Station, and nothing else: an end station is not a bridge or a router |
| `capabilities` contains `l2-forward` | 0x0004 | `B` - Bridge |
| `capabilities` contains `l3-forward` | 0x0010 | `R` - Router, so an L3 switch prints `B,R` |
| none of the above | - | blank cell |

`W`, `T`, `C`, `P` and `O` are in the legend because a box prints the whole legend whatever its neighbours are,
but nothing in this catalogue is mapped to them: no spec field distinguishes a desk telephone from a handset
(the `phone` category holds both), and deriving `T` from a model name would be the sort of guess this project
does not print. That is a limitation of the catalogue, not of the table.

## What changed

* `engine/lldp.js`: the System Capabilities TLV (type 7, two 2-byte bitmaps, six bytes on the wire) is built from
  `capabilityMask(dev)` / `capabilityLetters(mask)`; the neighbour record keeps the letters; the TLV's six bytes
  are counted in `payloadBytes`, so interface counters stay truthful.
* `engine/device.js`: `lldpRows()` carries `capabilities` beside `portId` and `mgmtIp`.
* `engine/cli.js`: the view is the box's - legend, blank line, fixed header, rows cut at 20, blank line, count.
  The management address is no longer a column (it remains on the record and on the port's own block); a
  neighbour whose local port cannot carry a frame keeps its reason after the last column, since the box would
  have aged the entry out and this model keeps it until its TTL.
* `test/show-lldp-neighbors-columns.test.js` (new, 27 checks): legend lines and indentation, the blank line, the
  five column offsets, the 20-character cut, `B`/`R`/`B,R`/`S`, a blank Capability cell, the TLV on the frame
  (and its six bytes), and the count closing the view one blank line down.
* `test/show-lldp.test.js`, `test/lldp-hold-time.test.js`, `test/lldp-total-entries.test.js`,
  `test/neighbours-on-load.test.js`, `test/lldp-across-trunk.test.js`: re-parsed by column offset rather than by
  the old labels; the "no blank line before the count" assertion is reversed, and the management-address
  assertion is replaced by the capability letter.

## What remains unresolved

* **Whether every IOS family truncates at 20.** The field table is IOS XR; the witness is a Catalyst IOS thread.
  NX-OS does *not* truncate - its captures print a 28-character device ID and simply push the columns right - so
  the rule is implemented for the IOS-shaped console this project imitates and would be wrong for an NX-OS one.
* **The exact width of `Port ID`.** It is last, so nothing depends on it; a box truncates nothing there.
* **Whether a real box ever prints the empty-state sentence this console prints** under the header. It does not;
  the sentence is this project's way of distinguishing "never heard anything" from "everything aged out", and it
  is the one line in the view that is not the device's.
