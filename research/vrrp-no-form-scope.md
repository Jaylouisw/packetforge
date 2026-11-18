# What a `no` line on a VRRP group undoes: the group, or one setting?

**Question (one, narrow).** `no vrrp <vrid> <word>` - does the word after the vrid name *part* of the
group, so that the line undoes that part and the virtual router stays, or is the vrid all the line
reads, so that any `no` naming a group deletes it? The console did the second, and it is the one place
where that answer is visible in its own output: `show running-config` prints `  no vrrp <vrid> preempt`
for a group whose preemption is off, so the console was writing a config line it read back as a
deletion.

**Verdict: the sub-keyword is an attribute, and only the bare form removes the group.** `no vrrp <vrid>
preempt` turns preemption off, `no vrrp <vrid> priority` restores 100, `no vrrp <vrid> advertise`
restores 1 second, and `no vrrp <vrid>` alone removes the group. Adopted for those three words; a word
outside them is refused rather than guessed at.

## The evidence

| Source | Says |
| --- | --- |
| [Cisco IOS First Hop Redundancy Protocols Command Reference, `vrrp preempt`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/command/fhp-cr-book/fhp-v1.html) (PDF: [fhp-cr-book.pdf](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/command/fhp-cr-book.pdf)) | "To configure the router to take over as master virtual router ... use the **vrrp preempt** command in interface configuration mode. **To disable this function, use the no form of this command.**" Syntax: `vrrp group preempt [delay minimum seconds]` / `no vrrp group preempt`. Default: the router preempts. |
| Same reference, `vrrp priority` and `vrrp timers advertise` | Both carry a `no` form that restores the default rather than removing the group; `priority` default 100, `timers advertise` default 1 second ("The default is 1 second", "The default interval of 1 second is configured"). |
| [Cisco IOS IP Application Services Configuration Guide, Configuring VRRP](https://community.cisco.com/legacyfs/online/legacy/0/8/1/8180-VRRP.pdf) | The sample interface block for Router B lists **`no vrrp 100 preempt`** and then `vrrp 100 ip 10.1.0.100` - the `no` line precedes the group's own address line and the group is configured afterwards, so it cannot have been a deletion. |
| [Cisco community, "VRRP and HSRP pre-empt"](https://community.cisco.com/t5/switching/vrrp-and-hsrp-pre-empt/td-p/715143) | An operator types `vrrp 1 priority 100` then `no vrrp 1 preempt` on a live group; the reply discusses what the group does in the election ("will never become the active router unless its peer goes out of service"), not a group that has gone. |
| [Arista EOS, VRRP and VARP](https://www.arista.com/jp/um-eos/eos-vrrp-and-varp) | States the distinction in one line for an EOS box with the same command shape: "The **no vrrp** command removes all VRRP commands for the specified virtual router from *running-config*" - i.e. the bare form is the removal; `no vrrp 15 preempt` disables preempt mode ("This command disables preempt mode for the virtual router 15 on vlan 20"). |
| [Cisco IOS, `show vrrp` field descriptions](https://www.cisco.com/c/en/us/td/docs/ios/ipapp/command/reference/iap_s5.html) | The detail view has a `Preemption is` field ("Preemption is either enabled or disabled") and the brief view a `Pre` column, so preemption is a setting a box *reports* on a group it still has. |

## What was wrong here

`_ifaceMode()` read `tokens[2]` as the vrid and dropped every group with that vrid on the port, never
looking at `tokens[3]`, while `_vrrpIfaceCommand()`'s own `no` branch (`return null` on the `no` head)
was unreachable from the only call site. Two consequences, one of them silent:

* `no vrrp 42 preempt` printed `VRRP group 42 removed from Gi0/0` and took the virtual gateway with it,
  so there was no way to configure preemption off at all;
* the printer writes `  no vrrp <vrid> preempt` whenever `preempt === false`
  (`engine/cli.js`, `_runningConfig`), and reading that line back deleted the group it described - the
  paste-back property `test/config-roundtrip.test.js` exists to hold (#1230) was broken for exactly the
  state the console could not otherwise reach.

## What changed

* `engine/cli.js`, `_ifaceMode()`: the bare `no vrrp <vrid>` still removes; `no vrrp <vrid> preempt`
  answers `VRRP group <vrid> preempt disabled`, `... priority` answers `... priority reset to 100`,
  `... advertise` answers `... advertises every 1 s`; any other word is refused by name,
  `% Unrecognized vrrp command: ... (this console can unset: priority, preempt, advertise - no vrrp <vrid>
  removes the group)`, so a guess never deletes a group.
* `test/vrrp-no-form.test.js` (new, 27 assertions): the receipts, the survival of the group and its
  untouched neighbours, the paste-back, the refusal, the bare removal.
* `test/config-roundtrip.test.js`: a fixture that configures `preempt: false` with `priority 120` from
  the console, prints the config, and asserts the group comes back with both values.
* `docs/CLI.md`, VRRP section: the syntax list and the paragraph that documented the deletion as the
  only `no` form.

## Unresolved, and what would settle it

1. **Nothing reads `preempt` during an election.** `Simulator.computeVrrp()` calls `electMaster()`,
   which elects from the candidate list alone; `groupState()` - the one function that models a
   rejoining router with preemption off (`incumbent-keeps`) - is called only by tests. So a group with
   preemption off behaves, for now, exactly like one with it on: the flag is stored, printed, and
   validated, and no packet changes. Settling it needs a convergence path that remembers the previous
   master between passes, which is a change to the simulator rather than to this branch of the parser -
   deliberately left out (docs/plans/undo-granularity.md says "no forwarding or election change").
2. **How `show vrrp` should report it.** Two documented shapes disagree, and this console has neither
   column. IOS 15.x's `show vrrp brief` header is `Interface Grp Prio Time Own Pre State Master addr
   Group addr` with `Pre` holding `P` when preemption is enabled and *empty* when it is disabled
   ("P indicates that preemption is enabled. If this field is empty, preemption is disabled",
   [iap_s5.html](https://www.cisco.com/c/en/us/td/docs/ios/ipapp/command/reference/iap_s5.html)), same page's
   sample: `Ethernet1/0 1 100 3609   P Master 10.0.0.4 10.0.0.10`. IOS XE 16/17's brief header is
   `Interface Grp A-F Pri Time Own Pre State Master addr/Group addr` with `Own` and `Pre` as `Y`/`N`
   ([fhp-s1.html](http://cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/command/fhp-cr-book/fhp-s1.html)),
   sample `Et1/0 1 IPv4 150 0 N Y MASTER 10.0.0.1(local) 10.0.0.10` - the same column printing `N`
   where 15.x prints nothing. Cisco's own 15.x page even carries both sentences ("P indicates..." and
   "Y indicates...") in one field table. Settling it needs one transcript of `show vrrp brief` from the
   platform this console is imitating, with preemption disabled on a group; until then the console has
   no column rather than one of two spellings chosen by guess.
3. **`no vrrp <vrid> ip <address>`.** Real IOS removes one virtual address, leaving the group if others
   remain. This console models a group with an address list and has no such removal; the line is
   refused as unrecognized, which is honest but is not the device's answer. It is a separate question
   (what the group's *last* address removal does - delete the group, or leave it addressless) and needs
   its own evidence.
