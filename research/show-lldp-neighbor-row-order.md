# `show lldp neighbors` — in what order does the Local Intf column run?

**Question (one, narrow).** On a box with ten or more ports, does the row for local port **10** come
before or after the row for local port **2**? The table is read down its second column, so the answer
decides whether an operator can scan a port range or has to re-sort it by eye. This note asks only about
the order of the rows that are printed; the columns, legend and count are settled in
[show-lldp-neighbors-columns.md](show-lldp-neighbors-columns.md) and
[lldp-total-entries.md](lldp-total-entries.md).

**Verdict: 10 comes after 2 — the column runs in port order, not text order.** A box that indexes the
table by local port prints 2, 9, 10 … 48; no captured output prints `Eth1/10` above `Eth1/2`. PacketForge
sorted the rows with `localeCompare`, so on a 24-port switch the tenth socket was printed above the second.
The engine now sorts by the panel-order comparator (`ifaceName.comparePortNames`), and
`test/show-lldp-port-order.test.js` pins a switch cabled on ports 10, 2 and 9 printing 2, 9, 10.

## What the vendor publishes

| Source | Says |
| --- | --- |
| [Cisco Nexus 3500 Series NX-API CLI Reference 9.2(x) — LLDP Commands, `show lldp neighbors`](https://developer.cisco.com/docs/nexus-3500-series-nx-api-cli-reference/latest/lldp-commands/) | The CLI sample runs `mgmt0`, `Eth1/2`, `Eth1/4`, `Eth1/5`, `Eth1/6`, `Eth1/7`, `Eth1/8`, `Eth1/9`, `Eth1/10`, `Eth1/11` … `Eth1/48`, then `Total entries displayed: 45`. Ten follows nine, not one. |
| [Cisco Catalyst 1300 Series CLI Guide — LLDP Commands](https://www.cisco.com/c/en/us/td/docs/switches/campus-lan-switches-access/Catalyst-1200-and-1300-Switches/cli/C1300-cli/lldp-commands.html) | `show lldp neighbors` sample: `gi1/0/1`, `gi1/0/1`, `gi1/0/2`, `gi1/0/3` — ascending, in the order the panel numbers the ports. |
| [Cisco Catalyst 1200 Series CLI Guide — LLDP Commands](https://www.cisco.com/c/en/us/td/docs/switches/campus-lan-switches-access/Catalyst-1200-and-1300-Switches/cli/C1200-cli/lldp-commands.html) | The same sample and the same order. |
| [ArubaOS 8 CLI Guide — `show lldp neighbor`](https://arubanetworking.hpe.com/techdocs/ArubaOS/oxygen/AOS-8%20Command%20Line%20Interface%20Guide/s/show-lldp-neighbor.html) | `GE0/0/1` then `GE0/0/2`, each beside its peer; `Number of neighbors: 2`. |
| [Dell Networking N-Series VoIP LLDP configuration](https://infohub.delltechnologies.com/static/media/ff6ddc4d-50fb-4e62-873f-4d781cf11f78.pdf) | A per-port LLDP view lists `Gi1/0/9`, `Gi1/0/10`, `Gi1/0/11` in that order — the same panel ordering in a neighbouring LLDP view. |
| [ntc-templates `cisco_ios_show_lldp_neighbors.raw`](https://github.com/networktocode/ntc-templates) (the fixture already cited by the column note) | `Fa0/13` then `Gi1/0/7` — consistent with panel order (all FastEthernet, then GigabitEthernet), but it has no port 10 and so cannot settle this question on its own. |

## The counter-example

| Source | Says |
| --- | --- |
| [Cisco ASR 920 Series, IOS XE 17.1.1 — Using LLDP in Multivendor Networks](http://cisco.com/c/en/us/td/docs/routers/asr920/configuration/guide/ce/17-1-1/b-ce-xe-17-1-asr920/m_ce-lldp-multivend.html) | `Router# show lldp neighbor` lists `CE1 Te0/2/6`, `CE1 Te0/2/1`, `CE1 Te0/2/0`, `CE1 Te0/2/0:2001` … then all the `PE2` rows. The rows are grouped by neighbour, and within a neighbour 6 precedes 1 precedes 0. |

That sample is real and it matters: **IOS-XE does not guarantee port order across the whole table.** Its
rows appear to follow an internal (insertion/hash) order and to group by neighbour. A one-line report of a
Catalyst 3750 (`Gi1/0/24` then `Gi1/0/20`) points the same way. So the honest rule is narrower than "the
box always sorts": a platform that indexes the neighbour table by local port prints it in port order, and
the sim should do what the port-indexed samples do rather than a text sort no sample shows.

## What PacketForge did, and why it was wrong

`device.lldpRows()` collected the map (insertion order, i.e. the order the LLDPDUs arrived) and then sorted
it with `String(a.port).localeCompare(String(b.port))`. Measured on this branch's base with a C2960X and
three PCs cabled to Gi1/0/10, Gi1/0/2 and Gi1/0/9:

```
Device ID           Local Intf     Hold-time  Capability      Port ID
PC-pc10             Gi1/0/10       120        S               eth0
PC-pc2              Gi1/0/2        120        S               eth0
PC-pc9              Gi1/0/9        120        S               eth0
```

That is string order twice over: it disagrees with the vendor samples above, and with the physical panel,
where the second socket is left of the tenth. The engine already owns the right comparator —
`ifaceName.comparePortNames` compares run by run, numeric runs as numbers — and uses it where port order
matters (the PoE allocator, `simulator.js`). The fix is to use it here as well.

## What is known

1. **No capture prints the column as text.** Every sample with a port below 10 and a port at or above 10
   puts the smaller number first (Nexus 3500: 9, 10, 11 …; Catalyst 1300: 1, 2, 3; Aruba: 1, 2).
2. **The order is the port's, not the neighbour's.** The Nexus sample interleaves three different device
   IDs (`mdr-c002`, `Shire`, `SW-INSBU-…`) while the Local Intf column still ascends; so the sort key is
   the local port, not the Device ID.
3. **IOS-XE can break that rule.** The ASR 920 sample is grouped by neighbour and is not port-ordered at
   all, so "sorted by local port" is a property of the port-indexed implementation, not of the command.

## What is inferred

* That `Eth1/10` above `Eth1/9` and `Gi1/0/10` above `Gi1/0/2` are the same panel-order rule; the Nexus
  3500 sample settles the first directly and the Catalyst 1300 sample the second, one step smaller.
* That sorting per query is acceptable for a simulator: a real table's order is stable between reads, and
  re-sorting the same row set produces the same answer, so a lab that pastes the table twice sees one shape.

## What remains unresolved

* **What IOS-XE's order actually is.** Grouped by neighbour, roughly by insertion. No public field list
  states an order, and the ASR 920 sample is the only IOS-XE brief table in hand with enough rows to see
  one. Whether it is a hash of the local port, the order the neighbours were learned, or ifindex order
  over a different interface set, is not known.
* **Subinterfaces and service instances.** The ASR sample includes `Te0/2/0:2001` and `Te0/2/3:1000`; the
  panel-order comparator treats `:2001` as another run, but whether a real box orders a subinterface
  before or after the next physical port is not settled.
* **Port-channel rows.** LLDP prints the physical local port, not the bundle, on the platforms in hand;
  no capture shows a neighbour learned through a port-channel in this table, so no ordering claim is made.

## What evidence would settle the rest

1. A `show lldp neighbors` from an IOS-XE Catalyst 9300 with neighbours on at least Gi1/0/1, Gi1/0/2 and
   Gi1/0/10 — the platform whose output this console most often imitates.
2. Two captures from the same box taken minutes apart, to see whether an aged-out and re-learned
   neighbour changes its row position.
3. A capture including a port-channel member and its bundle, to see which name the table prints.
