# `show ip dhcp pool`: the field block a real box prints

**Question (one, narrow).** What does an IOS-like box print for `show ip dhcp pool [<name>]` - which fields, in
which order, with which labels - and what do the counts mean?

**Verdict: a fixed six-field block over a one-row subnet table.** This console printed a block it had invented:
`Pool lan:` then `Network:`, `Range:`, `Default router:`, `DNS servers:`, `Lease:`, `Excluded:`, `Reservations:`,
`In use:` - eight labels no router has, all of them restating configuration that `show running-config` already
prints, and none of them the numbers a real box reports. It now prints the real block, and the pool view no
longer carries the configuration at all.

```
Pool BIGPOOL :
 Utilization mark (high/low)    : 100 / 0
 Subnet size (first/next)       : 0 / 0
 Total addresses                : 254
 Leased addresses               : 61
 Excluded addresses             : 62
 Pending event                  : none
 1 subnet is currently in the pool :
 Current index        IP address range                     Leased/Excluded/Total
 10.10.10.160         10.10.10.1 - 10.10.10.254            61 / 62 / 254
```

## Known: five published captures agree on the labels, their order and the counts

| source | what it captures |
|---|---|
| Cisco 850/870, *Configuring a LAN with DHCP and VLANs*: http://www.cisco.com/en/US/docs/routers/access/800/850/software/configuration/guide/dhcpvlan.html | `Pool dpool1 :`, marks `100 / 0`, subnet size `0 / 0`, `Total addresses : 254`, `Leased addresses : 0`, **no** `Excluded addresses` line, `Pending event : none`, `1 subnet is currently in the pool :`, header `Current index IP address range Leased addresses`, row `10.10.0.1 10.10.0.1 - 10.10.0.254 0` |
| Cisco, *Operate a Robust IOS XE DHCP Server* (PDF): https://www.cisco.com/c/en/us/support/docs/ip/dynamic-address-allocation-resolution/226237-operate-a-robust-ios-xe-dhcp-server.pdf | `Total addresses : 254`, `Leased addresses : 61`, `Excluded addresses : 62`, `Remembered addresses : 77`, `Pending event : none`, header `Current index IP address range Leased/Excluded/Total`, row `10.10.10.160 10.10.10.1 - 10.10.10.254 61 / 62 / 254`; and the sentence "The number of available addresses will be the Total - (Leased + Excluded)" |
| Cisco 12.2SB, *DHCP Server - On-Demand Address Pool Manager*: https://www.cisco.com/c/en/us/td/docs/ios/12_2sb/12_2sba/feature/guide/sbandhcp.html | the field definitions: "The Total addresses field is a count of all the usable addresses in the pool", "The Leased addresses field is a total count of how many bindings were created from the pool", "The Current index columns shows the address that would be allocated next from this subnet", "The IP address range column shows the range of usable addresses from the subnet"; plus the ODAP-only variants (`Subnet size ... 24 / 24 (autogrow)`, a `VRF name` line, `3 subnets are currently in the pool :`) |
| firewall.cx, DHCP pool exhausted: https://www.firewall.cx/cisco/cisco-switches/cisco-switch-router-dhcp-server-conflicts.html | a 4507R+E capture: `Excluded addresses : 251`, header `Leased / Excluded / Total`, row `0.0.0.0 192.168.7.1 - 192.168.7.254 3 / 231 / 254`; "the value of 0.0.0.0 means that there are no more available IP addresses to lease"; "the Excluded addresses includes the manually excluded and conflicted IP addresses" |
| ManageEngine, configure DHCP on Cisco: https://www.manageengine.com/network-configuration-manager/configlets/configure-dhcp-server-cisco.html | `Total addresses : 254`, `Leased addresses : 1`, `Excluded addresses : 1`, row `192.168.0.1 192.168.0.1 - 192.168.0.254 1 / 1 / 254` |

Between them they settle the parts this change depends on:

* the **labels** and their **order** (marks, subnet size, total, leased, [excluded], [remembered], pending event,
  subnet count, table);
* `Pool <name> :` with a **space before the colon** (four of the five captures; the fifth lost the block's padding
  to HTML extraction altogether);
* `Total addresses` is the **subnet's** usable count - 254 for every /24 in every capture, whatever is excluded -
  not the number of addresses the pool will actually offer;
* `Excluded addresses` counts addresses the server will **not offer** (configured exclusions and conflicts), and it
  is **absent** from the captures where nothing is excluded;
* `Current index` is "the address that would be allocated next", and **`0.0.0.0` when there is none**;
* the subnet row's `IP address range` is the **subnet's** usable range, not any narrower allocation range;
* the table header has two published forms - `Leased addresses` (IOS 12.4 era) and `Leased/Excluded/Total`
  (IOS XE) - and the triple is what a reader needs once an excluded count is printed.

## Inferred, not known

* **The column the colons sit in.** The captures are HTML or PDF text whose runs of spaces were collapsed, so the
  width of the label field cannot be recovered from them. What can be recovered is that the colons **align**: five
  labels of different lengths share one column. This console pads the label to 31 characters after a single leading
  space, which puts every colon in column 33; the test pins the alignment (every field line's `:` at the same
  index), not the width.
* **A narrower `range` is an exclusion.** Cisco's pool takes a `network`; this console's `range` is a shorthand for
  the part of that subnet the pool may offer - the same fact `ip dhcp excluded-address` writes the long way.
  `Excluded addresses` is therefore derived as `Total - poolCapacity()`, which folds the out-of-range addresses and
  the gateway (never allocatable in this engine) into the count, so leased + excluded + free add up to the total -
  the arithmetic the XE capture states.
* **`Utilization mark (high/low) : 100 / 0` and `Subnet size (first/next) : 0 / 0`** are the defaults every
  non-ODAP capture prints. Both fields belong to on-demand address pools, which this console does not model, so
  printing the defaults states configuration it does not have rather than guessing at allocation.
* **Manual bindings and the lease count.** The engine counts live leases; whether a configured `host` reservation
  that has never been requested counts in IOS's `Leased addresses` is not settled by any capture here, so the
  reservation is left out of the count - and out of the index - instead of being guessed into it.

## What this run changed

* `engine/dhcp.js` - `poolSummary(pool, taken)` derives `total`, `capacity`, `excluded`, `index` and the subnet's
  usable `range` once, beside `poolCapacity()`, so the console and any later caller cannot compute them two ways.
* `engine/cli.js` - `show ip dhcp pool` prints the real block: labels, order, a colon column, and the subnet table.
  The configuration fields are gone (`show running-config` has every one of them). The two engine-only facts the old
  block carried are kept, as `%` lines after the table: a pool that cannot serve says why, and a pool that turned
  requests away says how many, with the engine's own sentence (#1453).
* `test/show-ip-dhcp-pool-layout.test.js` - 36 checks: label order, colon alignment, no invented field, the
  arithmetic of the three counts, an absent `Excluded addresses` line when nothing is excluded, `Current index`
  moving past leases and exclusions, `0.0.0.0` on an exhausted pool, `not measured` without a simulation, and a
  broken pool printing a reason and no row.
* `test/dhcp-bindings.test.js`, `test/dhcp-lease-one-answer.test.js`, `test/dhcp-infinite-lease.test.js`,
  `test/dhcp-refusal-visible.test.js` - the checks that read the invented fields now read the real ones, or
  `show running-config` where the fact is configuration.
* `docs/CLI.md`, `docs/ARCHITECTURE.md` - the transcripts, and the paragraphs that explained `In use:`.

## What remains unresolved

* **A capture from a box in hand.** Every source above is vendor documentation or a third-party paste. One
  `show ip dhcp pool` screenshot from a physical router would settle the colon column and the table's spacing.
* **`Excluded addresses : 0`.** Two captures with nothing excluded omit the line; none shows an explicit zero. This
  console omits it too, on the reading that the line appears only when non-zero. A capture showing `: 0` would
  settle it.
* **`Remembered addresses`.** IOS XE prints a fourth count when `ip dhcp remember` is configured. This console does
  not model the feature, so the line is absent rather than printed as zero - a different question.
* **Which header a given release prints.** `Leased addresses` and `Leased/Excluded/Total` are both real. This
  console prints the triple because it prints an excluded count; the older single-count header is the same table
  with less to say.
* **`Pending event`** carries a value other than `none` only for on-demand pools (`subnet request`), which this
  console does not model.
