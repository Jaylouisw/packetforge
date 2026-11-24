# `encapsulation dot1q <vid> [native]`: the optional word, and what it means on the wire

**Question (one, narrow).** A router subinterface is given `encapsulation dot1q <vlan-id>`. What may follow
the id, what does the one legal keyword do, and what does the box do with a word that is neither the id nor
that keyword?

**Verdict: one optional word, `native`, and it makes the subinterface the port's handler for untagged
frames.** The vendor's syntax is `encapsulation dot1q vlan-id [native]`; the parameter table says `native` is
"To make a subinterface the default handler of untagged packets coming to the port". A second word after the
id - including a second VLAN id - is not in the grammar at all. PacketForge read `tokens[1]` and silently
dropped everything else: `encapsulation dot1q 10 native` printed a receipt, wrote nothing to the config, and
left the subinterface tagging frames a real box sends untagged; `encapsulation dot1q 10 flurbish` was taken as
the plain form. Both are the silent-discard class #2004 closed for `ip name-server` and #1483 for
`clock rate`. The word is now read, applied, printed back and tested, and any other word is refused with the
state unchanged.

## Evidence

| Source | Says |
| --- | --- |
| [VLAN Configuration Guide, Cisco IOS XE 17.15.x (Catalyst 9600), *Configuring Layer 3 Subinterfaces*](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/17-15/configuration_guide/vlan/b_1715_vlan_9600_cg/configuring_layer_3_subinterfaces.html) | Syntax `encapsulation dot1q vlan-id [native]`; worked example `Device(config-subif)# encapsulation dot1q 201 native`; `native`: "To make a subinterface the default handler of untagged packets coming to the port, use this keyword." Restrictions: "Do not configure encapsulation on the native VLAN of an IEEE 802.1Q trunk without the native keyword. Always use the native keyword of the dot1q vlan command when the VLAN ID is the ID of the IEEE 802.1Q native VLAN." Also: "Untagged traffic and any tagged traffic or VLAN (not handled by the subinterface) that comes into the port are handled by the parent interface." |
| [Catalyst 9300 17.9, *Configuring Layer 3 Subinterfaces* (PDF)](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-9/configuration_guide/vlan/b_179_vlan_9300_cg/configuring_layer_3_subinterfaces.pdf) | The same syntax line, the same `native` description, the same "do not configure ... without the native keyword" restriction, and the same parent-handles-the-rest sentence. |
| [Catalyst 9400 17.15, *Configuring Layer 3 Subinterfaces*](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9400/software/release/17-15/configuration_guide/vlan/b_1715_vlan_9400_cg/configuring_layer_3_subinterfaces.html) | A third platform, word for word the same table and example (`encapsulation dot1q 201 native`). |
| [Cisco Press, *VLAN Routing with Router 802.1Q Trunks*](https://www.ciscopress.com/articles/article.asp?p=2990405&seqNum=2) | "The native VLAN can be configured on a subinterface, or on the physical interface, or ignored"; the two options for the native subnet are an address on the physical interface, or "an `ip address` on a subinterface and ... `encapsulation dot1q vlan-id native`"; "Each 802.1Q trunk has one native VLAN"; and the review question "is it configured correctly on the router either on a subinterface (with an `encapsulation dot1q vlan-id native` command) or implied on the physical interface?" |
| [Cisco IOS, *Configuring Routing Between VLANs with IEEE 802.1Q Encapsulation*](http://www.cisco.com/en/US/docs/ios/lanswitch/configuration/guide/lsw_cfg_vlan_encap.html) | `encapsulation dot1q vlan-id native` "Enables IEEE 802.1Q encapsulation of traffic on a specified subinterface in VLANs, and defaults to 1"; "**Note** If there is no explicitly defined native VLAN, the default VLAN 1 becomes the native VLAN 1." The same page states the untagged-frame rule: each port has a native VLAN "that specifies the VLAN assigned to receive untagged frames". |
| [Catalyst 9400 17.18 VLAN Commands](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9400/software/release/17-18/command_reference/b_1718_9400_cr/vlan_commands.html) | The `dot1q vlan native` note: "The native VLAN cannot be configured on a subinterface of the trunk interface" - a **platform** restriction recorded below, not the rule of the `encapsulation dot1q ... native` form the 9300/9400 configuration guides themselves document. |

The console's own refusal vocabulary for an unusable word ("takes ..., and the encapsulation is unchanged")
is the shape `speed 100 full` and `duplex full flurbish` already use; the vendor's parser answer for the same
line is `% Invalid input detected at '^' marker.`, which this console deliberately does not print
(`research/parse-error-caret.md`).

## What is known

- `native` is the only word the grammar puts after the VLAN id, and it is optional.
- Its meaning is untagged framing: that subinterface becomes the port's default handler for untagged packets,
  so frames it routes out leave untagged and untagged frames arriving are its.
- A trunk has **one** native VLAN, and the config can express it on the subinterface or on the physical
  interface - the two are alternatives for the same fact.
- With no explicitly defined native VLAN, VLAN 1 is the native VLAN.

## What changed

**`engine/cli.js`, `_encap()`.** The tail after the VLAN id is read:

* `native` is stored as `iface.encapNative = true`, and the parent port's native VLAN (and PVID) becomes the
  subinterface's VLAN. Nothing in the data plane needed a second rule: untagged ingress already asks
  `portPvid(parent)` and egress tagging already asks `classifyEgress(parent.vlan, vid)`, so setting the one
  value a box keeps makes both directions behave.
* Any other tail - `flurbish`, or a second number - is refused, naming the word and saying the encapsulation
  is unchanged; nothing is written and no receipt is printed.
* A second `native` on another subinterface of the same parent is refused, naming the subinterface that holds
  the claim and how to release it. Moving the claim silently would change a subinterface the operator did not
  name; the one-native-per-trunk rule is stated by Cisco Press.
* Typing the line again without the word releases the claim, and the parent returns to VLAN 1, the value the
  IOS guide gives when no explicit native VLAN exists.

**`engine/cli.js`, the running-config printer.** The subinterface stanza carries ` native` when it is set.
The parent does **not** grow a `switchport trunk native vlan <vid>` line from it: a router prints the fact on
the subinterface, and a second line would be a second place to edit one fact. The parent's own
`switchport trunk native vlan` line, when somebody typed one, still prints.

**`engine/cli.js`, `no interface <subif>`.** Removing a native subinterface takes the claim with it and
returns the parent to VLAN 1. A parent native VLAN set by hand is left alone.

**`engine/device.js`.** `encapNative` is created false on every subinterface, written to the document only
when true, and restored on load - a saved native subinterface must not come back tagged.

**`test/encapsulation-dot1q-native.test.js`** (new, 10 tests): the word applied, the parent's native VLAN and
PVID, the config line and the parent's single-line stanza, the refusal of a foreign word (and that the state
is untouched), the refusal of a word after `native`, the second-native refusal, the release by retyping, the
release by `no interface`, save/load, and the wire itself - a tagged VLAN 10 subinterface reaches a host
behind a trunk whose native VLAN is 1, while the same subinterface with `native` does not, because its frames
leave untagged and the far end files them under VLAN 1.

## What is inferred, and what remains open

* **The wording of the second-native refusal.** No capture of a box given `native` on a second subinterface
  was found. The rule ("one native VLAN per trunk") is documented; the mechanism - refusal, or the claim
  moving to the newer subinterface - is not. The console refuses, in its own words, and says how to release
  the first. A console capture of `encapsulation dot1q 20 native` beside an existing native subinterface
  would settle whether the real box refuses or moves the claim.
* **`native` and a parent address at the same time.** Cisco Press presents the subinterface and the physical
  interface as alternatives for the native VLAN, and the 9300/9400 guides note that traffic not handled by a
  subinterface falls to the parent. This console lets both exist; no capture of a box with an address on both
  the parent and a native subinterface was found, so nothing here decides which one answers.
* **The platform restriction.** The Catalyst 9600's own page states that `encapsulation dot1q native` is not
  supported on 9600X subinterfaces, and the 9400 command reference says the native VLAN cannot be configured
  on a subinterface of the trunk interface. Those are platform limits on top of a form the same product
  family's configuration guides document; the console models the documented router/9300/9400 behaviour, not a
  per-platform restriction it has no capability bit for.
* **`no encapsulation dot1q`.** The command reference documents a no-form ("To remove 802.1Q encapsulation
  for the subinterface, use the no form of this command"), and this console still answers
  `% Unrecognized interface command` to it. That is a missing grammar form, not a wrong answer to this
  question, so it was left for its own pass rather than half-added here.
* **The receipt.** A box prints nothing when the line is accepted; the console's
  `Subinterface Gi0/0.10 encapsulation dot1q 10 native` is its own receipt, in the shape every other
  accepted line here uses.
