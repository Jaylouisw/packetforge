# `show ip route`: the classful group header (`is subnetted` / `is variably subnetted`)

**Question (one, narrow).** When the table holds prefixes inside one classful network, what line does IOS
print above them, which mask does that line carry, how are `subnets` and `masks` counted, and which rows are
grouped under it?

This is the follow-up the previous note left open. [show-ip-route-prefix-field.md](show-ip-route-prefix-field.md)
listed the header as a line this console does not print, beside `L - local` and the blank line between groups,
and closed with: "What would settle it: one capture from a 2960/ISR with two subnets of a classful /8 in the
table, showing whether the group header appears when only one group exists." The captures below answer that
and more, and they agree with each other on every point except indentation.

**Verdict: the header exists, in two spellings, and its rule is coherent across builds.** A group is keyed by
the **classful** network of the row (first octet: /8, /16, /24). When every entry in that group shares one
mask the header reads `<network>/<that mask> is subnetted, <N> subnets`; when two or more masks are present it
reads `<network>/<classful mask> is variably subnetted, <N> subnets, <M> masks`. `N` is the number of entries
in the group, `M` the number of distinct masks, and the word stays `subnets` even for one. Rows under a
single-mask group print **without** a prefix length; rows under a variable group print **with** one. A route
that exactly covers its classful network and shares that network with nothing prints as a plain row, ungrouped
(`S 192.168.0.0/16`, `B 192.168.1.0/24`), and the default is always outside every group. A lone prefix whose
mask is *shorter or longer* than its classful mask is the exception that proves the key: it still gets a
header with one subnet (`172.16.0.0/24 is subnetted, 1 subnets`, `192.168.4.0/32 is subnetted, 1 subnets`).

## Evidence

| Source | What it prints |
| --- | --- |
| [Cisco, *Understand Load Sharing with BGP in Single/Multihomed Environments* (doc 13762, HTML, updated 2026)](https://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/13762-40.html) | `      10.0.0.0/8 is variably subnetted, 4 subnets, 2 masks` over `C        10.10.10.0/24 is directly connected, GigabitEthernet0/0` / `L        10.10.10.1/32 ...` / `C        10.20.20.0/24 ...` / `L        10.20.20.1/32 ...`, then `      192.168.1.0/32 is subnetted, 1 subnets` over `C        192.168.1.1 is directly connected, Loopback0`. Lower in the same page, an older capture of two classful C networks prints `C    192.168.12.0/24 is directly connected, Ethernet0/0` **with no header**, then `     10.0.0.0/24 is subnetted, 2 subnets` over `C       10.10.13.0 is directly connected, Serial8/0` and `B       10.10.34.0 [20/0] via 10.10.13.3` - rows with no mask at all |
| [Cisco, *FlexVPN HA Dual Hub Configuration Example* (doc 118888, HTML)](https://www.cisco.com/c/en/us/support/docs/security/flexvpn/118888-configure-flexvpn-00.html) | `10.0.0.0/8 is variably subnetted, 11 subnets, 3 masks` whose eleven rows include the classful route itself, `S 10.0.0.0/8 is directly connected, Null0`; then `172.16.0.0/16 is variably subnetted, 2 subnets, 2 masks` (`C 172.16.0.0/24`, `L 172.16.0.1/32`); then `S 192.168.0.0/16 is directly connected, Null0` **alone on its own line, no header**, immediately followed by `192.168.0.0/24 is variably subnetted, 2 subnets, 2 masks` (`C 192.168.0.0/24`, `L 192.168.0.1/32`). On another router in the same page: `192.168.4.0/32 is subnetted, 1 subnets` over `H 192.168.4.4 [250/1] via 10.0.1.3, 00:01:30, Virtual-Access1`, and `172.16.0.0/24 is subnetted, 1 subnets` over `B 172.16.0.0 [200/0] via 192.168.0.1` |
| [Cisco, *Verify and Troubleshoot Basic NAT Connectivity* (doc 221481, HTML, updated 2026)](https://www.cisco.com/c/en/us/support/docs/ip/network-address-translation-nat/221481-8605-13.html) | `      10.0.0.0/8 is variably subnetted, 2 subnets, 2 masks` / `C        10.10.10.0/24 is directly connected, GigabitEthernet3` / `L        10.10.10.6/32 ...`, then `      172.16.0.0/16 is variably subnetted, 6 subnets, 2 masks` over six rows, three `/24` and three `/32` - `N` counts rows, `M` counts lengths |
| [Cisco, *Configure a Gateway of Last Resort that Uses IP Commands* (doc 16448)](https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/16448-default.html) | `S* 0.0.0.0/0 [1/0] via 10.108.99.2` printed **above** `10.0.0.0/8 is variably subnetted, 4 subnets, 2 masks`, i.e. the default is outside every group (the same capture the previous note cites for the CIDR destination) |
| [Cisco, *Understand Administrative Distance* (doc 15986, HTML)](https://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/15986-admin-distance.html) | `172.16.0.0/16 is variably subnetted, 2 subnets, 2 masks` over `C 172.16.1.0/24` and `L 172.16.1.100/32`; `192.168.1.0/24 is variably subnetted, 2 subnets, 2 masks` over `C 192.168.1.0/24` and `L 192.168.1.1/32` |
| [Cisco, *Initial Configurations for OSPF over a Point-to-Point Link* (doc 13687)](https://www.cisco.com/c/en/us/support/docs/ip/open-shortest-path-first-ospf/13687-15.html) | `     2.0.0.0/32 is subnetted, 1 subnets` over `C 2.2.2.2 is directly connected, Loopback0`, twice, on two routers - a single `/32` in a classful /8, grouped, one subnet, and the row prints the bare address |
| [Cisco, `show ip route` command reference (E-Learning reprint, older build)](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_ip_route.htm) | The same two spellings in one table, with a **dotted** header mask: `     172.19.0.0 255.255.255.0 is subnetted, 1 subnets` / `C 172.19.64.0 is directly connected, Ethernet0`, then `     171.69.0.0 is variably subnetted, 2 subnets, 2 masks` / `C 171.69.232.32 255.255.255.240 ...` / `S 171.69.0.0 255.255.0.0 ...` |
| [Cisco Learning Network, *Introduction to VRFs - Part 1*](https://learningnetwork.cisco.com/s/article/introduction-to-vrfs-part-1-ipv4-only-vrfs-x) (practitioner captures, IOS 15) | `10.0.0.0/8 is variably subnetted, 8 subnets, 2 masks` above four visible `/30` rows, in a table filtered with `show ip route \| exclude L`: the counts describe the table, not the rows a pipe left on screen |

## What is known

1. **Two spellings, chosen by mask variety inside the group.** One mask: `<net>/<mask> is subnetted, <N>
   subnets` - no mask count (`10.0.0.0/24 is subnetted, 2 subnets` with two `/24` rows; `10.0.0.0/24 is
   subnetted, 1 subnets`; `192.168.4.0/32 is subnetted, 1 subnets`). Two or more masks: `<net>/<classful
   mask> is variably subnetted, <N> subnets, <M> masks` - `10.0.0.0/8 ... 4 subnets, 2 masks` when the rows
   are `/24` and `/32`.
2. **The header's mask is the classful mask once the group is variable.** `172.16.0.0/16 is variably
   subnetted` with `/24` and `/32` rows: `/16` is neither the shortest nor the longest entry, it is the
   classful mask of 172.16.0.0. This kills the competing reading ("print the shortest mask"): the shortest
   row mask there is `/24`.
3. **The group's network is the classful network of its first octet**, not the first row's prefix. That is why
   `S 192.168.0.0/16` is not in the `192.168.0.0/24` group: a class-C block keyed at `/24` cannot contain a
   `/16`, so the supernet prints on its own and the `/24` + `/32` pair forms the group.
4. **`N` counts every entry in the group**, including an exact classful route when the group is variable
   (`10.0.0.0/8 ... 11 subnets` where one of the eleven rows *is* `S 10.0.0.0/8`), and including rows a display
   filter removed.
5. **The word stays `subnets` for one**: `1 subnets`, in five separate captures and across three trains. No
   capture shows `1 masks`, so `masks` singular is unobserved (below).
6. **A lone classful-complete route is not grouped.** `C 192.168.12.0/24 is directly connected` and `S
   192.168.0.0/16 ... Null0` print as plain rows with no header and no deeper indent. A lone route whose mask
   *differs* from its classful mask is grouped: `172.16.0.0/24 is subnetted, 1 subnets` (classful /16, entry
   /24), `192.168.4.0/32 is subnetted, 1 subnets` (classful /24, entry /32).
7. **Rows change shape with the group's variety, on the same box.** In doc 118888 one router prints
   `B 172.16.0.0 [200/0] via 192.168.0.1` inside a single-mask group and `C 192.168.0.0/24 is directly
   connected` inside a variable one. Single-mask groups print the address alone; variable groups print
   `<address>/<len>`. The ungrouped rows keep the mask (`C 192.168.12.0/24`), which is the same statement: the
   mask is printed when it is needed to tell two rows of one network apart, and omitted when the header
   already gave it.
8. **The default is outside every group** and above them (`S* 0.0.0.0/0`), which matches what this console
   already does.
9. **Order is ascending by network**, groups and ungrouped rows interleaved by address (`10.0.0.0/8` group,
   `172.16.0.0/16` group, `S 192.168.0.0/16`, `192.168.0.0/24` group, then the `192.168.1.0/24`,
   `192.168.3.0/24`, `192.168.4.0/24` rows).

## What is inferred

* **The header is a display grouping of the same RIB, not a separate object.** The counts move with the table
  (doc 118888: 11 rows, 11 subnets; doc 221481: six rows, six subnets), and the filtered-capture evidence
  says the pipe acts after the count. That is enough to implement from the engine's existing rows - no new
  state to model.
* **`L - local` rows inflate `M` in every capture that has them**, because a `/32` local route shares the
  connected `/24`'s network. This console prints no `L` rows, so a table here that a capture shows as
  "2 subnets, 2 masks" is a table with one row in this engine. A reader diffing the two should expect that
  gap, and it is not a defect this note introduces.
* **The header is per classful network, so a table with no overlapping classful blocks prints no header at
  all** - the common single-router-on-a-/30 lab, which is why so many small captures show plain rows.

## What this console prints, and why it was not changed here

`show ip route` currently prints every row in one shape, with no headers (a two-interface router with a
classful static):

```
Codes: C - connected, S - static, O - OSPF, B - BGP, * - candidate default
Gateway of last resort is not set
C   10.1.1.0/24 is directly connected, Gi0/0
C   10.2.2.0/24 is directly connected, Gi0/1
S   172.16.0.0/16 [1/0] via 10.1.1.254
```

A box would print the `10.0.0.0/8` group header above the first two rows and drop their `/24` (one mask in the
group), and leave the `S` row alone (classful-complete, ungrouped). Doing that here is not a wording change:
it repaints **every row** of the view, removes the prefix length from the commonest lab table, changes the
docs' examples, and has to be decided against the console's four-character code field - which the
previous note deliberately left alone (the separator after the prefix is no longer one of them: it is the
device's one space, `research/show-ip-route-field-separator.md`). That is a change with its own test surface
(`test/show-ip-route-*.test.js`), not a footnote to this one, so this increment stops at the evidence. What a
change would have to decide, with the answers this note supplies:

| Decision | Answer from the captures |
| --- | --- |
| Group key | classful network by first octet |
| Header mask, one mask in group | that mask |
| Header mask, two or more | classful mask |
| `N` | rows in group, including an exact classful route |
| `M` | distinct prefix lengths in group |
| Singular | never: `1 subnets` |
| Rows in a single-mask group | address without prefix |
| Rows in a variable group | `address/len` |
| Ungrouped rows | mask printed, no header |
| Header indent / row indent | **not settled** (below) |

## What remains unresolved, and what would settle it

* **Indentation.** In doc 13762's newer capture the header starts in column 7 and a grouped destination in
  column 10; the older capture on the same page starts them at 6 and 9, and puts an ungrouped destination at
  6. Doc 221481 agrees with the newer one (7 and 10). Widths drift by train and, within one page, by capture
  date. One `show ip route` capture per train from a named image, with the spaces intact
  (a terminal capture, not a reflowed web page) would fix the widths; until then this console should keep its
  own four-character code field and not pretend to a column it cannot verify.
* **`1 masks`.** No capture shows a group with one mask in the `variably` spelling, and none shows the count
  going singular. If IOS never prints `1 masks`, the plural is a fixed word, like `subnets`; if it does, the
  rule is ordinary pluralisation. A capture of a two-mask group in which one mask has a single row would not
  settle it (`2 masks`); the needed case is a group whose second mask appears once *and* where IOS chooses the
  `variably` spelling - i.e. any two-mask group, counting `masks` as 2. So this may be unobservable, and the
  safe reading is "the word is always plural".
* **Dotted vs slashed mask in the header.** The E-Learning reprint (older build) writes `172.19.0.0
  255.255.255.0 is subnetted`, and the same page's variable group writes no mask at all (`171.69.0.0 is
  variably subnetted`). Every modern capture uses `<net>/<len>`. This console is CIDR throughout, so the
  modern spelling is the one to follow; the dotted form is recorded as a build difference, not a rule.
* **Whether a header is printed when the classful group holds one route whose mask is *longer* than classful
  and nothing else.** The captures say yes (`192.168.4.0/32 is subnetted, 1 subnets`,
  `172.16.0.0/24 is subnetted, 1 subnets`, `2.0.0.0/32 is subnetted, 1 subnets`), but all three are
  protocol-learned or loopback rows. A connected-only capture of the same shape would remove the last doubt.
* **The `+`/`%`/`&` marks** that appear between code and destination on newer trains (`S % 10.0.1.1/32`,
  `C + 100.1.1.0/24`) are a different question - route-source marks - and are untouched here.
