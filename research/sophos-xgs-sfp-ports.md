# The XGS 1U fibre uplinks and the management jack: three transcription slips, one pasted port block

**Question (one, narrow).** The previous pass on #1398 found `sophos/XGS 3100 PortF1` presenting as
RJ-45 and left it for the next run. Is that one port, or a line of them?

**Verdict: a line of them.** The three 1U XGS specs carry a port block that was pasted down one row
at a time, and each row kept the previous row's hardware - the first fibre port lost its connector
(so `inferCage()` read its rate as copper), and the last row's SFP+ block ended up on the MGMT jack.
Derived hardware before the fix, and what the specs' own descriptions say each port is:

| Spec | Port | Description's port row | PRE-FIX derived | POST-FIX |
| --- | --- | --- | --- | --- |
| `xgs-3100.json` | `PortF1` | "2x 10G SFP+ (PortF1-PortF2)" | `rj45` 10/100/1000/2500/5000/10000 | `sfp+` 1000/10000 |
| `xgs-3100.json` | `PortF3` | "2x 1G SFP (PortF3-PortF4)" | `sfp+` 1000/10000 | `sfp` 1000 |
| `xgs-3100.json` | `PortF4` | same row | `sfp+` 1000/10000 | `sfp` 1000 |
| `xgs-3100.json` | `MGMT` | "1x 1G MGMT" | `sfp+` 1000/10000 | `rj45` 10/100/1000 |
| `xgs-4300.json` | `PortF1` | "4x 10G SFP+ (PortF1-PortF4)" | `rj45` 10/100/1000/2500/5000/10000 | `sfp+` 1000/10000 |
| `xgs-4300.json` | `MGMT` | "1x 1G MGMT" | `sfp+` 1000/10000 | `rj45` 10/100/1000 |
| `xgs-2100.json` | `PortF1` | "2x 1G SFP (PortF1-PortF2)" | `rj45` 10/100/1000 | `sfp` 1000 |
| `xgs-2100.json` | `MGMT` | "1x 1G MGMT" | `sfp` 1000 | `rj45` 10/100/1000 |

What that did to the links:

```
PRE-FIX  XGS 3100/PortF1  10GBASE-SR optic     -> refused as a connector mismatch (rj45 vs sfp+)
PRE-FIX  XGS 3100/PortF1  10GBASE-T copper     -> accepted, 10 Gbps, on a cage with no jack
PRE-FIX  XGS 3100/PortF3  10GBASE-LR optic     -> accepted at 10 Gbps in a 1G SFP cage
PRE-FIX  XGS 2100/MGMT    1000BASE-T copper    -> refused: the management jack was an SFP cage
PRE-FIX  XGS 3100/MGMT    10GBASE-LR optic     -> accepted at 10 Gbps on a 1G management port
```

## Evidence

No new datasheet fetch for the fibre ports: each spec's `description` counts them by rate and
connector ("2x 10G SFP+", "2x 1G SFP"), and that is the transcription that was missing.

For `MGMT` the description gives the rate ("1x 1G MGMT") and lists it apart from the SFP groups.
The shared-platform record in `research/incoming/devices-firewalls-2.json` (XGS 2100, sourced from
the Sophos operating instructions for the XGS 2100/2300/3100/3300 generation) models the same jack
as `MGMT` at `1G` with no optical connector - i.e. GE copper. Declaring `connector: "rj45"` states
that; `speedCaps` are left off so the cage's own 10/100/1000 ladder applies, because a GE copper
jack does train at 100BASE-TX and the previous `[1000]` would have refused a 100M link.

## A gate that did not catch this

`scripts/audit-port-types.js` reports "0 fibre port(s) drawn as copper" both before and after, and
`scripts/audit-devices.js` reported "0 specs describe optics but have no fibre cage" before the fix.
Both are device-level or type-level questions; a port that says `speed: 10G` and no connector is
counted as copper and is *consistent* with its declared type, so nothing fires. What would catch it
is a per-port check that reads the description's own port row against the port - that is a new gate, so
it is written up as a proposal in this run's report rather than added here.

## What changed

- `devices/sophos/xgs-3100.json`, `xgs-4300.json`, `xgs-2100.json`: the ports above now carry
  `connector` and, for the fibre cages, `speedCaps` (`[1000,10000]` on SFP+, `[1000]` on 1G SFP).
  `speed` on the 1G SFP ports was corrected from `10G` to `1G`; `MGMT` from `10G` to `1G`.
- `test/sophos-sfp-mgmt-ports.test.js`: 50 assertions, 33 of which fail on the pre-fix tree.

## Still open on #1398

`xgs-136/Port11-12` and `xgs-4300/Port5-8` are the 2.5G copper jacks whose description names only
the top rate ("2x 2.5G RJ45 PoE", "4x 2.5G RJ45"), so their 10BASE-T rung is still an inference -
same class as `mikrotik/RB5009UPr+S+IN`, `netgate/8200`, `paloalto/PA-1420`, `sophos/XGS 136`,
`sophos/XGS 4300`. They need a datasheet row naming the supported speeds before a floor is declared.
