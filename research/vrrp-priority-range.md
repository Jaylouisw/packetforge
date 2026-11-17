# What a VRRP priority can be set to, and which value only the address owner may hold

**Question (one, narrow).** What is the range of `vrrp <vrid> priority` on a Cisco-style box, and is `255` a
value an operator can type?

**Verdict: settled, and the engine's ceiling was one too high.** The keyword accepts **1-254**. `255` is not
configurable at all: it is the priority a group takes when this router's interface address is one of the group's
virtual addresses, which this engine already models (`VRRP_OWNER_PRIORITY`). `0` is likewise not configurable -
it is the value a master puts in its last advertisement to release the group. The console here accepted 255 and
quoted "(1-255)" in its refusal, so it offered a priority that claims ownership of an address the router does not
own.

## What the vendor publishes

| Source | Says |
| --- | --- |
| [Cisco IOS First Hop Redundancy Protocols Command Reference, `vrrp priority`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/command/fhp-cr-book/fhp-v1.html) | "level - Priority of the router within the VRRP group. **The range is from 1 to 254.** The default is 100." The same page gives the group number as 1-255 - the two ranges are different, and only the group number reaches 255. |
| [Cisco IOS XE 17 FHRP Configuration Guide, VRRP](http://cisco.com/c/en/us/td/docs/switches/lan/c9000/lyr3-fwd/fhrp/fhrp-configuration-guide/vrrp.html) | "Configure each virtual device backup's priority from **1 to 254** using the priority command"; "The priority of a VRRP group, when it is the IP address owner, is set to a fixed value of **255**, which object tracking cannot reduce." |
| [Configuring VRRP, Cisco IOS Release 12.2SX](http://www.cisco.com/en/US/docs/ios-xml/ios/ipapp/configuration/12-2sx/Configuring_VRRP.html) | "You can configure the priority of each virtual router backup with a value of **1 through 254** using the vrrp priority command"; "By default, a preemptive scheme is enabled" - the preempt default the engine already has. |
| [NetworkAcademy.io, VRRP](https://www.networkacademy.io/ccna/network-services/virtual-router-redundancy-protocol-vrrp) | The parser's own answer, which is the piece the command reference cannot give: `R1(config-if)# vrrp 1 priority ?` -> `<1-254>  Priority level(default 100)`. The same page: "There are two special priority values that cannot be configured explicitly with the vrrp 1 priority [value] command, 0 and 255 ... You cannot configure 255 with the priority command." |
| [RFC 5798 §5.2.2](https://datatracker.ietf.org/doc/html/rfc5798) (and [RFC 9568](https://www.rfc-editor.org/rfc/rfc9568.html)) | Why the ceiling exists: "The value of 255 (decimal) is reserved for the router that owns the IPvX address ... The value of 0 (zero) is reserved for the Master router to indicate it is releasing responsibility ... The range 1-254 (decimal) is available for VRRP routers backing up the virtual router." |

Two independent vendor documents and a real `?` transcript agree on the same two numbers, and the RFC says why.
That is enough to enforce.

## What the engine did

* `engine/cli.js`, `vrrp <vrid> priority`: accepted `p >= 1 && p <= 255`, refused with
  `% Invalid priority: <n> (1-255)`.
* `engine/cli.js` help index and `docs/CLI.md` both advertised `priority <1-255>`; the docs line annotated it
  `# 255 = address owner`, which was true of the model and false of the command.
* `engine/vrrp.js` `validateGroup()` accepts 0-255, and that is **correct as the protocol model**: those are the
  values an advertisement on the wire may carry. Only the configuration door is narrower.
* `test/stated-range-is-the-enforced-range.test.js` had the wrong range on its own list - the suite that exists
  to catch a stated range drifting from the enforced one had been written from the same wrong number, so it
  agreed with the defect instead of finding it.

## What changed

* The CLI bound is `1..254`, and the refusal now states `(1-254)`.
* Help index, `docs/CLI.md` (command list and the stated-range table) and the stated-range sweep all say 1-254.
* `test/vrrp-priority-ceiling.test.js` (17 checks): 1 and 254 accepted; 255 refused with the range quoted; a
  refused 255 leaves the default 100 rather than becoming 254 and leaves an existing 200 alone; 0 and 256 refused
  at both ends; `show vrrp` prints the 254 that was accepted; `help` says `<1-254>` and no longer says `<1-255>`;
  and the library still accepts 255 and 0, so the protocol value was not banned with the command word.

## What is inferred, not published

The **wording** of the refusal. On a real box `255` falls outside the grammar, so the parser answers
`% Invalid input detected at '^' marker.` - that marker sentence is the parser's, and this console deliberately
does not copy it: its documented invariant is that a refusal quotes the range it enforces
(`test/stated-range-is-the-enforced-range.test.js`), which the marker line does not do. The range here is the
vendor's; the sentence is this simulator's.

## What remains unresolved

* **A transcript of `vrrp 1 priority 255` on a real IOS box.** Nothing in hand shows whether the refusal is the
  bare parser marker or a VRRP-specific line ("`% VRRP: ...`"). Evidence that would settle it: a console capture,
  not a configuration guide.
* **What an owner's `show vrrp` prints.** Cisco says the owner's priority "is fixed at 255"; IOS sample output for
  an owner shows `Priority is 255` with `Master Router is 10.1.1.1 (local), priority is 255`, while `show
  running-config` need not contain a priority line at all. This engine's `show vrrp` prints the *configured*
  priority in its `Pri` column, so a router that owns the virtual address prints `100` while the election gives it
  255. That is a separate display question with its own evidence to gather, and it was left alone here.
* **`no vrrp <vrid> priority <level>`.** The command reference writes the no-form with the level argument. This
  console's `no vrrp <vrid>` removes the whole group and nothing resets just the priority; whether IOS accepts a
  bare `no vrrp 1 priority` is not documented either way in the pages read here.
