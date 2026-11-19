# A port on VLAN 1002: may an access port be assigned to one of the four media-default VLANs?

**Question (one, narrow).** `switchport access vlan 1002` — the first of the four VLANs a switch is born
with (1002-1005, FDDI/Token Ring defaults, `act/unsup` in `show vlan brief`). Does an IOS-like box accept
the command and put the port in that row, or refuse it? This console refuses it, and the refusal is a
choice nobody has checked: [vlan-media-defaults.md](vlan-media-defaults.md) listed the question as open.

**Verdict: unresolved, and the console keeps refusing — but two claims around that refusal were wrong and
are corrected here.** The vendor documents the *range* of ids an access VLAN may name (`1 to 4094`, which
includes 1002-1005) and says the reservation is about media type, not about membership; no Cisco document
and no transcript in hand says what the command does. `show vlan`'s `act/unsup` is **not** evidence that no
port may join — the word is not even defined in the vendor's own field table — so `docs/CLI.md`'s sentence
"no port may be assigned to one … which is the fact behind `% VLAN id 1002 is reserved`" overstated the
record and is rewritten to call the refusal what it is: this model's decision, awaiting a capture. No
engine code changed.

## What the vendor documents

| Source | Says |
| --- | --- |
| [Catalyst 2960-X 15.2(6)E configuration guide, *Configuring VLANs* (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/configuration_guide/b_1526e_consolidated_2960x_cg/m_vlan_vlan_cg_2960-x.pdf) | "VLANs are identified by a number from 1 to 4094. VLAN IDs 1002 through 1005 are reserved for Token Ring and FDDI VLANs." Its `vlan vlan-id` step says "The available VLAN ID range for this command is 1 to 4094", and "Enter a new VLAN ID to create a VLAN, or enter an existing VLAN ID to modify that VLAN." Its `switchport access vlan` step says "Valid VLAN IDs are 1 to 4094." |
| [Catalyst 3560 12.2(25)SEA guide, *Configuring VLANs*](http://www.cisco.com/en/US/docs/general/Test/dwerblo/broken_guide/vlans.html) | The range table itself: `0, 4095` **Reserved**, "For system use only. You cannot see or use these VLANs"; `1` Normal, the Cisco default; `2-1001` Normal, "For Ethernet VLANs"; `1002-1005` **Normal**, "Cisco defaults for FDDI and Token Ring. You cannot delete VLANs 1002-1005"; `1006-4094` Extended. Plus the nearest thing to a rule: "Make sure you assign LAN ports to a VLAN of the appropriate type. Assign Ethernet ports to Ethernet-type VLANs." That is advice to the operator, not a statement of a refusal — no message, no outcome. |
| [Catalyst 9200 16.11 configuration guide, *Configuring VLANs*](https://www.cisco.com/c/dam/en/us/td/docs/switches/lan/catalyst9200/software/release/16-11/configuration_guide/vlan/configuring_vlans.html) | The identical two step descriptions twelve releases later — the `vlan` command's range is 1-4094 with no carve-out, and the access-VLAN step accepts "Valid VLAN IDs … 1 to 4094". |
| [Cisco Connected Grid Ethernet Switch Module guide, *VLAN Configuration*](https://www.cisco.com/c/en/us/td/docs/routers/connectedgrid/switch_module_swcg/cgr-esm-configuration/config_vlans.html) | The only sentence that gives a *reason* to keep Ethernet ports away: "The reserved VLANs 1002 to 1005 are not Ethernet VLANs." Also "If you assign an interface to a VLAN that does not exist, the new VLAN is created" — the access door validates by existence, which these four pass. |
| [Catalyst 9000 private-VLAN guide](https://www.cisco.com/c/en/us/td/docs/switches/lan/c9000/lyr2-fwd/vlan/vlan-configuration-guide/configure-private-vlan.html) | The counter-example that shows Cisco *does* spell out an exclusion when one exists: "You cannot configure VLAN 1 or VLANs 1002 to 1005 as primary or secondary VLANs." No such sentence exists for access-VLAN assignment, in any of the platform guides above. |
| [Cisco IOS LAN Switching Command Reference, `show vlan`](https://www.cisco.com/c/en/us/td/docs/ios/lanswitch/command/reference/lsw_book/lsw_s2.html) | The Status field is defined as "active or suspend, act/lshut or sus/lshut, or act/ishut or sus/ishut" — the table **omits** `act/unsup` while its own sample output prints `1003 trcrf-default act/unsup`. The vendor never says what the word means. |
| [Cisco, *Configure Inter VLAN Routing with an External Router* (PDF)](https://www.cisco.com/c/en/us/support/docs/lan-switching/inter-vlan-routing/14976-50.pdf) | A live box in a worked example: `1002 fddi-default act/unsup` … `1005 trnet-default act/unsup`, every one with an **empty** Ports column while VLAN 1 and the user VLANs carry ports. A default box, so this shows the usual state, not what a refusal would look like. |

## What is known

1. **The ids are in range for the command.** Both the `vlan` command and the `switchport access vlan`
   command are documented as taking 1-4094; the four media defaults sit inside that span and the reserved
   ids the standard really does exclude (0 and 4095) sit outside it. A refusal therefore cannot be a range
   refusal, and this console's refusal is not one — it names the four ids and calls them media defaults.
2. **They exist from power-on**, so the other documented refusal — "if you assign an interface to a VLAN
   that does not exist, the new VLAN is created" — cannot apply either: there is nothing to create.
3. **Their difference is media type.** The one vendor sentence that explains them is "not Ethernet VLANs".
4. **Cisco states an explicit exclusion where one is intended** (private VLANs, above). None is stated for
   static-access membership, in six guides spanning classic IOS to IOS XE 17.x.

## What is inferred

* **`act/unsup` does not mean "no port may join".** The vendor's field table does not list the value at all;
  the reading "active/unsupported" is community gloss, and "unsupported" most plausibly describes the
  *media type* on hardware that has no FDDI/TR ports, which is a property of the VLAN rather than a rule
  about membership. A row could therefore print a port and still read `act/unsup`; no capture shows either
  way, because nobody in the sources above tried.
* **A box probably accepts the command and the traffic is dead.** That is how the platform treats other
  media-mismatched configuration (accept, store, never forward), and it is consistent with the advisory
  "make sure you assign … the appropriate type". This is inference from the shape of IOS behaviour, not
  from a transcript, so it is not implemented.

## Unresolved

* **The outcome and its wording.** No transcript of `switchport access vlan 1002` (or 1003-1005) was found:
  not in the platform configuration guides, not in the two command references, not in the Cisco Community
  and Learning Network threads searched. So it is unknown whether the box prints nothing, prints a warning,
  auto-creates nothing because the VLAN exists, or refuses with a sentence.
* **Whether the port then appears in the 1002 row of `show vlan brief`,** and what `show interfaces <port>
  switchport` reports for `Access Mode VLAN`.
* **Whether `vlan 1002` alone is accepted** (entering `(config-vlan)#` for an existing default) and whether
  `name` may then change `fddi-default`. The `vlan` command's documented range argues the first half is
  accepted; the second half has no evidence either way. This console refuses the id at the first word, which
  is the same unverified choice as the access-VLAN refusal, made one door earlier.
* **VTP.** On a box in VTP server mode the set of VLANs is the domain's; this model has none, so only the
  transparent/standalone case could be modelled anyway.

## What would settle it

One session on a Catalyst 2960/9300 (Ethernet-only, standalone, VTP transparent or off), captured whole:

```
conf t
interface Gi1/0/5
 switchport mode access
 switchport access vlan 1002        <- the answer, verbatim
end
show vlan brief                    <- does Gi1/0/5 sit in the 1002 row?
show interfaces Gi1/0/5 switchport <- Access Mode VLAN, Administrative Mode
show running-config interface Gi1/0/5
show interfaces status err-disabled
```

and, in the same session, `vlan 1002`, `name test`, `end`, `show vlan brief`. Two more captures would make
the rule general rather than one platform's: the same commands on a box whose image still ships FDDI/TR
support, and on an IOS XE 17.x 9200/9300 for the current wording.

## What was changed

* `research/vlan-media-defaults.md` — its open question "Whether a port may be assigned to one" now points
  here, and the sentence that read `act/unsup` as "the switch saying no port can be configured into them"
  is corrected: the status word is not that statement.
* `docs/CLI.md` — the paragraph beside `% VLAN id 1002 is reserved` no longer claims the table is the fact
  behind the refusal. It says the four rows are media defaults, that the refusal is this model's decision
  because no port can carry FDDI/TR here, and that no capture settles what a box does — citing this note.
* No engine code, no test, no catalogue change: the evidence does not support one, and the current refusal
  is at least consistent with the one documented reason (media type) even though its outcome is unwitnessed.
