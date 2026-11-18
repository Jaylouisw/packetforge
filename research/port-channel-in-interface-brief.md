# `show ip interface brief`: does an EtherChannel have a row, and what does it say?

**Question (one, narrow).** On a switch with an EtherChannel, does a real box list the **bundle** in
`show ip interface brief` beside its member ports — under what name, with what IP/method cells, and what status
when no member is really in the bundle?

**Verdict: known, and adopted for this one table.** The bundle is an interface, it has a row, and the row is
`Port-channel<n>  unassigned  YES unset  up  up` when the bundle carries — `down  down` when it does not. This
console listed only the member ports, so the interface an operator addresses (and pings) appeared in no view they
open first. The state is not the members' state: a bundle whose members are all stand-alone reads `down down`
while every member reads `up up`.

## What PacketForge did

```
sw1#show ip interface brief
Interface              IP-Address      OK? Method Status                Protocol
Gi1/0/1                unassigned      YES unset  up                    up
Gi1/0/2                unassigned      YES unset  up                    up
...
Gi1/0/28               unassigned      YES unset  down                  down
```

Twenty-eight rows and no bundle: `lagFor()` maps each member to `{id}`, and nothing in the model was an
interface object for the port-channel (the same gap `research/mac-table-port-channel-name.md` records as
unresolved items 6 and 7). A lab that built a bundle and then asked "which interface do I address" was told
about the cables and not about the bundle.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco, *Integrate Redundant Solution for Secure Firewall and L3 Switch* (doc 221664)](https://www.cisco.com/c/en/us/support/docs/security/secure-firewall-management-center/221664-integrate-redundant-solution-for-secure.html) | a 3850's own `show ip interface brief`: `Vlan300 10.8.4.31 YES manual up up`, then `Port-channel2 unassigned YES unset up up`, `Port-channel3 unassigned YES unset up up`. The same page's config transcript shows the box creating the interface - `channel-group 2 mode active` / `Creating a port-channel interface Port-channel 2` - so the row is the interface that command made |
| [Cisco, *Troubleshoot LACP Port-Channel Failure in Firewall Cluster Environment* (doc 225790)](https://www.cisco.com/c/en/us/support/docs/security/secure-firewall-threat-defense/225790-troubleshoot-lacp-port-channel-failure.html) | `show interface ip brief` on an FTD: `Port-channel1  unassigned  YES  unset  down  down`, directly under `Internal-Data0/4 ... down up`, with the members `suspended (no LACP PDU)` - the bundle down while its own ports are up |
| [Cisco Community, "Port not working for access to vlan" (3750X)](https://community.cisco.com/t5/switching/port-not-working-for-access-to-vlan/td-p/4084339) | a full table: `GigabitEthernet1/0/1` … `Te1/1/1`, `Te1/1/2`, then `Port-channel1 unassigned YES unset up up` and `Port-channel20 unassigned YES unset down down` - bundles last, in number order, and one up beside one down |
| [Cisco Community, "Help understanding Etherchannel Output"](https://community.cisco.com/t5/switching/help-understanding-etherchannel-output/m-p/4015412) | one capture, both spellings: `1 Po1(SD) - Gi1/1(D)` and `4 Po4(SU) LACP Gi4/31(P)` in the summary, then `Port-channel4 unassigned YES unset up up` / `Port-channel4A unassigned YES unset up up` in the brief table |
| [Cisco, *Catalyst 3750-X/EtherChannel configuration*] `show etherchannel summary` key, as quoted above | `SD` is a Layer2 bundle that is down, `SU` one in use - the same letter pair the summary in this model prints, so "the bundle is down" has a vendor spelling to agree with |

The Method cell in every capture is `unset` for an unaddressed bundle, and `manual`/`NVRAM` where the bundle
holds an address. This model builds no Layer 3 bundle, so its row is always `unassigned  YES unset`; that is a
limit of the model, not a claim about hardware.

## What is known

1. **The bundle has a row.** Three independent captures, three platforms (3850, FTD, 3750X), one shape.
2. **The name is spelled out**: `Port-channel4`, `Port-channel20`, never `Po4`, in this table. The same captures
   show the summary abbreviating it (`Po4(SU)`) — the abbreviation belongs to the table cell, not to the object.
3. **`up up` means a member is in the bundle**, not that a cable is in a member: doc 225790 prints the bundle
   `down down` while its member is `up up` on the previous line.
4. **Bundles come after the physical ports** in three of the four captures (221664's rows are shown with the
   table's middle elided; 4084339 prints them last, in ascending number).

## What is inferred

5. **`down down`, not `down up`.** A bundle with no member in it has no line protocol either — the same two
   columns a real box prints for a suspended bundle (doc 225790). For a bundle whose members are *stand-alone*
   (a one-sided channel group) no capture was found; this model prints `down down` there, because its members
   are not in the bundle even though they carry traffic as single links.
6. **One live member is enough.** No capture shows a 8-member bundle with one member down and the bundle still
   up, but every EtherChannel chapter states the bundle keeps forwarding while a member remains, so `up up` on
   `live.length > 0` follows the forwarding rule rather than a quoted table.

## Unresolved

7. **Row order.** One capture in hand (`c9300`-class output pasted on the Cisco Learning Network, "Switch Port
   Numbers") prints `Port-channel1` **first**, before `FastEthernet0/1`. Order in this table follows the
   interface index, which this model does not keep, so either order is defensible; this console appends bundles
   after the ports, which is what three of four captures show.
8. **The `Port-channel` row is not yet an interface object.** `show ip interface brief` now names it, but
   `show interfaces Port-channel1`, `show interfaces Port-channel1 switchport` and
   `show mac address-table interface Po1` still cannot resolve it (the last is item 6 of
   `research/mac-table-port-channel-name.md`). Making the bundle nameable everywhere a port name is accepted is
   a port-identity change, and it is the next increment this question opens.
9. **No bundle block in `show interfaces`.** A real box prints a full `Port-channel1 is up, line protocol is up
   (connected)` block there too, with the bundle's own MAC (usually the lowest member's or the chassis MAC) and
   its own counters. This model has no counters for the aggregate and no MAC to print, so adopting the block
   would invent both. The row in the brief table was the part that could be told truthfully now.
10. **The creation receipt.** `channel-group 1 mode active` on a box also prints `Creating a port-channel
    interface Port-channel 1` the first time a group is made (doc 221664). This console answers
    `Interface Gi1/0/1 added to channel group 1 (mode active)` and does not say the interface was created; that
    is a sentence of its own and a second question.

## What changed

* `engine/lag.js`: `portChannelIfaceName(id)` — the long spelling, beside `portChannelName(id)` (`Po1`), so the
  two forms of one name live in one library.
* `engine/cli.js`: `_lagMemberStates()` holds the per-member rule that `show etherchannel summary` already used
  (`(P)`/`(I)`/`(D)`/`(H)`/`(s)`, and `live`); the summary now calls it, and `show ip interface brief` appends one
  row per bundle using `live.length` for both the Status and Protocol cells. One predicate, so the summary cannot
  call a bundle up while the interface table calls it down.
* `test/brief-port-channel-row.test.js`: 19 checks — the row and its four cells, the long name against the
  summary's short one, numeric order after the physical ports, one-sided/stand-alone → `down down`, one member
  shut → still `up up`, all members shut → `down down`, no bundle → no row, and the cells under their headings.
* `docs/CLI.md`: the `show ip interface brief` row of the command index and a paragraph under
  "Reading `show ip interface brief`".
