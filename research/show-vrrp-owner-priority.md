# What an address owner's priority reads as, and whether `show vrrp` may print a value the command refuses

**Question (one, narrow).** When a router's own interface address *is* one of a VRRP group's virtual
addresses — the IP address owner — what priority does the group run at, and what does `show vrrp` print
for it: the number an operator configured, or the 255 the election votes with?

This is the follow-up the previous note left open. [vrrp-priority-range.md](vrrp-priority-range.md)
settled that `vrrp <vrid> priority` accepts 1-254, and closed with: "This engine's `show vrrp` prints
the *configured* priority in its `Pri` column, so a router that owns the virtual address prints `100`
while the election gives it 255. That is a separate display question with its own evidence to gather,
and it was left alone here."

**Verdict: the priority in force is 255, and the column now prints it.** The configured number is kept
where it belongs - in `show running-config` and in the election's own record - and a note under the
table says why the two numbers differ. What remains unresolved is narrower than the question: no
transcript in hand shows what *IOS's* `show vrrp brief` Pri column prints for an owner.

## What the vendor publishes

| Source | Says |
| --- | --- |
| [Cisco IOS First Hop Redundancy Protocols Configuration Guide, Configuring VRRP](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/configuration/xe-16/fhp-xe-16-book/fhp-vrrp.html) | "**Note** If a VRRP group is the IP address owner, its priority is fixed at 255 and cannot be reduced through object tracking." The same page: "The owner is the router that has the virtual router address as its physical interface address." |
| Same guide, sample `show vrrp` output | `Priority is 255`, then `Master Router is 172.24.1.1 (local), priority is 255` - for a router whose configured priority cannot have been 255, since the command refuses it. |
| [Cisco Nexus 5600 Unicast Routing Configuration Guide, Configuring VRRP](http://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus5600/sw/unicast/7x/unicast_n5600_config/l3_vrrp.html) | "The default is 100 for backups and **255 for a master that has an interface IP address equal to the virtual IP address**." The same sentence appears in the Nexus 3000 guide. |
| [Cisco IOS XE 17 Network Services Configuration Guide, Configuring VRRP](http://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/ntw-servs/b-network-services/m_fhp-vrrp-0.html) | "You can configure the priority of each virtual router backup with a value of 1 through 254"; the owner note above; and the `show vrrp brief` field table describing `Pri` as "VRRP priority number for this group" rather than "the configured priority". |
| [Cisco IOS XE First Hop Redundancy Protocols Command Reference, `show vrrp`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/command/fhp-cr-book/fhp-s1.html) | The field table for `own` ("IP address owner") and the same `show vrrp brief` sample. |
| [Cisco ASR 900 First Hop Redundancy Protocols Configuration Guide, VRRPv3](https://www.cisco.com/c/en/us/td/docs/routers/asr903/software/guide/ip/17-1-1/b-fhp-xe-17-1-asr900.pdf) | A `show vrrp detail` sample that states the value and its cause in one line: `Priority is 255 (owner mode)`, `Master Router is FE80::...(local), priority is 255`. |
| [RFC 5798 §5.2.2](https://datatracker.ietf.org/doc/html/rfc5798) (and [RFC 9568](https://www.rfc-editor.org/rfc/rfc9568.html)) | "The value of 255 (decimal) is reserved for the router that owns the IPvX address ... The range 1-254 (decimal) is available for VRRP routers backing up the virtual router." |
| [Cisco NCS 540 IP Addresses and Services Configuration Guide, VRRP](https://www.cisco.com/c/en/us/td/docs/iosxr/ncs5xx/ipaddress/78x/b-ip-addresses-cg-78x-ncs540/m-implementing-vrrp-ncs5xx.html) | "When the virtual router group IP address is the same as the IP address of the physical interface of any router in the VRRP group, then such router becomes the *IP address owner* and the VRRP group operates in the *Owner* mode" - the phrase the console's note now uses. |

## What is known, and how sure

* **The group runs at 255 when this router owns the virtual address: documented, three times over.**
  Cisco says the value is "fixed at 255" for an owner, says the default is "255 for a master that has
  an interface IP address equal to the virtual IP address", and RFC 5798 reserves the value for exactly
  that router. This engine has voted that way since VRRP was modelled (`VRRP_OWNER_PRIORITY`,
  `candidateList()`); only the reporting disagreed with it.
* **The detail view prints 255 for an owner: documented by two Cisco samples.** One is IPv4
  (`Priority is 255`, `Master Router is 172.24.1.1 (local), priority is 255`), one is IPv6 and names
  the mechanism (`Priority is 255 (owner mode)`). Both are outputs of an owner-mode group, whose
  configured priority is necessarily the default 100 or something in 1-254.
* **Ownership is a configuration fact, not a measurement: inferred, but from stated rules.** The owner
  is defined by "has the virtual router address as its physical interface address", which is a fact
  about the configuration. So the number does not depend on an election having run, and this console
  prints 255 even with no simulator attached - where the state column honestly says `Backup`, because
  without a vote it has nothing better. Cisco's own phrase "owner mode" describes the group's mode
  rather than a per-packet measurement, which is why the note says "owner mode".
* **A shut port that still holds the address is still the owner: inferred.** The address stays
  configured when the interface is shut, and the ownership rule is about addresses. Real IOS would
  print the group `Init` with the same priority; nothing in the documents read here separates the two
  facts, so the engine keeps them separate in the two columns rather than inventing a third state.
* **The configured value must survive: documented.** `vrrp <vrid> priority` is where the typed number
  lives, `show running-config` prints it, and a group that is not the owner must still run at it. The
  change touched the display and the election's record only; the stored priority is untouched.

## What the engine did

* `engine/cli.js` `_showVrrp()` printed `g.priority` (the configured value, default 100) in the `Pri`
  column for every group, including one whose interface address was in `g.ips`. A router that had just
  outranked a 254 in the election showed `100` in the table explaining the result.
* `engine/simulator.js` `computeVrrp()` recorded the same configured number three more ways: on each
  verdict's `candidates` list, on `masterPriority`, and on the `vrrp` timeline event that `web/app.js`
  renders as `priority <n>`. So the timeline could announce "priority 100" about a router that was
  master *because* it had 255.
* `engine/vrrp.js` derived the owner's 255 inside `candidateList()` and threw the number away, so no
  caller could report it without re-deriving the rule.

## What changed

* `engine/vrrp.js`: `isOwner()` and a new `effectivePriority()` are exported (the predicate the
  election already used is now the one callers ask), and `electMaster()` returns a `candidates` list
  carrying both numbers - `priority` (in force) and `configured` (typed) - plus `owner`.
* `engine/simulator.js`: the verdict's `candidates`, `masterPriority` and the `vrrp` event's
  `priority` are the election's numbers, not the configured ones.
* `engine/cli.js`: the `Pri` column prints the priority in force; an owner's row is followed by one
  note under the table - `% VRRP group 7 on Gi0/0: this device holds 10.0.0.1, so it is the address
  owner and its priority is 255 (owner mode) - vrrp 7 priority cannot set that value`. The refusal
  for `vrrp 7 priority 255` is unchanged, and the note says so before anyone tries it.
* `docs/CLI.md`: the `show vrrp` section gains a **Pri** bullet stating both numbers and where each one
  comes from.
* `test/show-vrrp-owner-priority.test.js` (28 checks): owner prints 255 and is master, a backup prints
  its configured 254, the note names the held address and the refused value, `vrrp 7 priority 255` is
  still refused with `1-254` quoted and leaves the group at 100, an owner configured 150 prints 255
  while `show running-config` keeps `vrrp 7 priority 150`, the verdict carries both numbers, a group
  with no simulator prints 255 with no invented state, a shut owner stays at 255 in `Init` while the
  backup takes over at 254, and a group where nobody owns the address prints configured values with no
  note.

## What remains unresolved

* **What IOS's `show vrrp brief` Pri column prints for an owner.** No reliable transcript was found.
  The candidates in hand are either about a group with no owner at all (`Ethernet1/0 1 100 3609  P
  Master`), or internally inconsistent in a way that disqualifies them: the IOS XE 17.x guide's own
  sample shows `Own` = `Y` on a row that is `Backup` and on a second group that is `Backup`, and three
  third-party lab guides propagate a table with `Y` in the `Own` column on every row - which is the
  `Pre` column's value in the wrong place. A capture of `show vrrp brief` from a box whose interface
  address equals the VIP would settle it in one line.
* **Whether IOS prints the owner's 255 with the port shut.** The samples found are all of a healthy
  owner. The engine's choice - 255 in `Pri`, `Init` in `State` - follows from the ownership rule being
  about configured addresses, but it is an inference and is recorded as one above.
* **Whether `show vrrp detail`'s `(owner mode)` suffix survives on platforms that also print a
  configured priority.** Only the VRRPv3 samples carry the suffix; the IPv4 sample carries the bare
  `Priority is 255`. The console keeps the suffix in its note rather than in the column, so a
  transcript that contradicts it costs one sentence, not a table layout.

## What would settle the rest

One `show vrrp brief` and one `show vrrp` from a router whose `vrrp <vrid> ip` equals its interface
address (a 2960/3560 or an ISR would do), plus the same two commands from a router whose group
interface has been shut down without removing the address.
