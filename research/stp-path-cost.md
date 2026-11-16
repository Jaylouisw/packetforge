# What a port costs before anybody sets a cost: the short path-cost table, and the two tables that disagreed

**Question (one, narrow).** Before `spanning-tree cost` is configured on anything, what path cost does a real
Cisco-style switch charge a port, and what does that make a mixed-speed ring root through?

**Verdict: settled for the speeds the vendor publishes, and corrected.** The engine charged the *32-bit* costs
(1 Gb = 20,000) under a comment that called them the 16-bit ones, and a second copy of the table lived in
`engine/simulator.js` and disagreed with the first. Both now use one table, and it is the short method a Catalyst
defaults to: 100 / 19 / 4 / 2 / 1.

## What the vendor publishes

| Source | Says |
| --- | --- |
| [Catalyst 9200 Layer 2 config guide 17.2, Configuring STP](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-2/configuration_guide/lyr2/b_172_lyr2_9200_cg/configuring_spanning_tree_protocol.html) | "The short path cost method is the default STP path cost method." Default table: `10 Mbps: 100, 100 Mbps: 19, 1 Gbps: 4, 10 Gbps: 2, 25 Gbps: 1, 40 Gbps: 1`; timers 2 / 15 / 20 s; device priority 32768; port priority 128. |
| [Catalyst 9500 Layer 2 config guide 17.2](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/17-2/configuration_guide/lyr2/b_172_lyr2_9500_cg/configuring_spanning_tree_protocol.html) | The same two tables side by side - short `100 / 19 / 4 / 2 / 1 / 1` and long `2000000 / 200000 / 20000 / 2000 / 800 / 500 / 200 / 20 / 2` - and the exception: on the `C9500-32C`, `-32QC`, `-48Y4C` and `-24Y4C` the **long** method is the default; on the `-12Q`, `-16X`, `-24Q`, `-40X` models it is short. |
| [Nexus 9000 NX-OS 10.4, Rapid PVST+](http://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/104x/configuration/layer-2-switching/cisco-nexus-9000-series-nx-os-layer-2-switching-configuration-guide-104x/m-configuring-rapid-pvst.html) | Table 4, `Default Port Cost`, carries both methods out to 400 Gb: 40 Gb `1` / `500`, 100 Gb `1` / `200`, 400 Gb `1` / `50`. "Rapid PVST+ uses the short (16-bit) path-cost method to calculate the cost by default." |
| [CBS 250/350 CLI guide, Spanning Tree Commands](https://www.cisco.com/c/en/us/td/docs/switches/lan/csbms/CBS_250_350/CLI/cbs-350-cli-/spanning-tree-commands.html) | The opposite default on the small-business line: "Default Configuration: Long path cost method" - so "Cisco defaults to short" is a claim about Catalyst and NX-OS, not about every box with that badge. |

Two numbers settle the question: a 1 Gb port costs **4** on a Catalyst and 20,000 on a switch set to long, and
`show spanning-tree` prints whichever is in force as the port's `Cost`.

## What the engine did

* `engine/stp.js` held `DEFAULT_PORT_COST = 20000` commented "802.1D short cost for a 1G link", and a `SPEED_COST`
  map of 10 Mb 2,000,000 / 100 Mb 200,000 / 1 Gb 20,000 / 10 Gb 2,000 / 40 Gb 500 / 100 Gb 200 commented
  "802.1D short path costs". Every number in both is the **long** method; only the comments were short.
* `engine/simulator.js` held a second copy, `speedToCost()`, which was not the long table either: no row for
  100 Mb (so a Fast Ethernet cable was charged 200,000) and 40 Gb = 400 where the published long table says 500.
  `computeStp()` used that copy to build the election, while `portCost()` in `stp.js` used the other, so the same
  port had two costs depending on which code path asked.

The visible consequence is not a printed number - `show spanning-tree` here reports roles and states, not costs -
but which port blocks. A bridge with one 100 Mb hop to the root (19) and a five-hop 1 Gb path (5 x 4 = 20) roots
through the 100 Mb port and blocks the chain; under the old numbers the chain cost 100,000 against 200,000 and the
bridge rooted the other way, blocking the faster link.

## What changed

* One table, `SHORT_PATH_COST` and `costForSpeedMbps()` in `engine/stp.js`, exported; `simulator.js` calls it and
  its own copy is gone (`speedToCost` was exported and unused elsewhere).
* `DEFAULT_PORT_COST` is 4 - the short cost of a 1 Gb port, which is also what an unconfigured port on the gear
  this simulator draws costs.
* `test/stp-path-cost.test.js` pins the published rows, the interpolation below, the monotonic rule, the
  election that flips, and that the simulator and the library charge the same number for the same cable (1 Gb -> 4,
  the same cable forced to 100 Mb -> 19).
* `test/stp.test.js`'s "default port cost is 20000" assertion now expects 4.

## What is inferred, not published

The vendor tables jump from 10 Gb to 25 Gb to 40 Gb to 100 Gb, and the catalogue here has 2.5G and 5G ports. No
source states their short cost. The rule chosen is: **a rate with no row of its own takes the cost of the next
slower documented row**, so 2.5G and 5G cost what 1G costs (4), anything above 100G costs 1, anything below 10M
costs what 10M costs (100). This keeps every returned number one the vendor publishes, and keeps cost
non-increasing as a link gets faster - which is the property the election depends on. It is an inference and it is
asserted as one.

## What remains unresolved

* **Port-channel cost.** Cisco derives a bundle's cost from the bundle's speed (half the cost of the aggregate
  rate, on the CBS line). This engine divides the port cost by the member count instead. For 1 Gb members those
  agree closely (4 members -> 1, where a 4 Gb aggregate would be 2 under the short table) but not always, and no
  source spells out the short-method arithmetic for a 2.5G member.
* **Per-VLAN cost and priority.** PVST/PVRST carries a tree per VLAN and adds the VLAN id to the priority
  (`32769` for VLAN 1 in the NX-OS table above). This engine runs one tree per device. Modelling that is a feature,
  not a fidelity fix.
* **Which method the *device being simulated* would use.** Short is the Catalyst default and long is the CBS and
  some C9500 default, so a strict per-model answer needs a catalogue field; the engine has none and now says
  "short", the more common default. Evidence that would settle it: a per-family default table (the 9500 guide
  above already shows Cisco changing it inside one series).
