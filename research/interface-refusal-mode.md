# A refused `interface <name>` inside interface mode: which mode are you left in?

**Question (one, narrow).** Typing `interface Fa9/9` on a box that has no slot 9 is refused. If the line is
typed at `(config)#`, nothing is at stake: the session was already there. If it is typed at `(config-if)#`
- the way a config is pasted, or the way an operator moves from port to port without an `exit` - where does
the next prompt sit? On the port that was open, or one level up at `(config)#`?

**Verdict: on the port that was open. A refusal changes nothing.** IOS validates the line at the parser and
prints the caret before anything is executed, so the mode is not touched by a line that never ran. This
console moved the session to `(config)#` *first* and asked the config-mode door afterwards, so the refusal
was reported one level up from where it was typed:

```
s1(config-if)#interface Fa9/9
% Interface not found: Fa9/9
s1(config)#                       <- this console, before
```

and the next line - a `description`, a `no ip address` - was accepted at `(config)#` as an unknown config
command, or worse, applied to something else. A box answers the same refusal and leaves the cursor where it
was:

```
s1(config-if)#interface Fa9/9
% Invalid input detected at '^' marker.
s1(config-if)#
```

## Known: a refused line does not change mode

Four independent captures, none of them about this command, all of them showing the same rule - the prompt
after the error is the prompt before it:

| Source | Capture | What it shows |
| --- | --- | --- |
| [Cisco IOS Configuration Fundamentals Configuration Guide 12.2SR, *Using the Cisco IOS CLI*](https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/configuration/guide/12_2sr/cf_12_2sr_book/cf_cli-basics.html) | `Router# configure termiMal` / `^` / `% Invalid input detected at '^' marker.` / `Router#` | a caret error at privileged EXEC, and the `#` prompt still there afterwards |
| [Cisco Community, *"switchport trunk encapsulation" not supported in Cat4500 IOS XE 3.5*](https://community.cisco.com/t5/switching/quot-switchport-trunk-encapsulation-quot-not-supported-in/td-p/2734528) | `SW1(config-if)# switchport trunk encapsulation dot1q` / `^% Invalid input detected at '^' marker.` / `SW1(config-if)# switchport trunk allowed vlan 259,260` / `SW1(config-if)# switchport mode trunk` | a refusal **inside interface mode**, with the two lines after it still typed at `(config-if)#` |
| [Cisco Community, *Can't access a Catalyst 2960-L smart managed switch*](https://community.cisco.com/t5/switching/can-t-access-a-catalyst-2960-l-smart-managed-switch/td-p/3931432) | `Switch#config t` / `^` / `% Invalid input detected at '^' marker.` / `Switch#` | the same at privileged EXEC: the refused `config t` did not open `(config)#` |
| [Cisco Community, *ASA 5512 internet connection*](https://community.cisco.com/t5/routing/asa-5512-internet-connection/td-p/2659463) | `NHSFW(config)# cap capout ...` / `ERROR: % Invalid input detected at '^' marker.` / `NHSFW(config)#` / the same line retyped | a refusal at global config leaves global config, and the retype is accepted |

The mode table is the second half of the same fact: the *Exit Method* column of Cisco's mode summary names
only `exit`, `end` and Ctrl-Z as ways out of a configuration mode (`cf_cli-basics.html`, "Summary of Main
Cisco IOS Command Modes" table; the same table stands in the Catalyst 2960-X consolidated command
reference). A parse error is not on that list, and the error table beside it says only that "the caret (^)
marks the point of the error" - it describes a diagnostic, not a state change.

**Known: an interface number outside the platform's range is refused, not opened.** "If you enter a value
that is outside the allowed range for the specific type of interface, the value is not accepted"
([Catalyst 3850 *Interface and Hardware Component* configuration guide, IOS XE 3SE](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst3850/software/release/3se/int_hw_components/configuration_guide/b_int_3se_3850_cg.pdf)).
So the name in `interface Fa9/9` is a value the parser rejects, which is the first rule's case.

## Inferred, not known

* **That the refusal is worded with the caret.** Every capture above is a caret error, but none of them is
  a *refused interface name* - the closest is `Switch(config)#interface gigabitEthernet 0` → caret →
  `Switch(config)#` in an operator's pasted lab transcript (scribd copy of a classroom worksheet,
  https://www.scribd.com/document/676031942/Switch), which is a weak source and is not leant on here. The
  project does not print the caret in any case - it quotes the offending input instead and keeps the
  sentence readable (`research/parse-error-caret.md`) - so the wording is unchanged by this run. What is
  inferred is only the *mode*, and it is inferred from two facts that are each documented: a caret error
  does not move the session, and an out-of-range interface is a caret error.
* **That the interface context survives, not just the mode.** The transcript above shows the prompt; it does
  not show which port the *next* command lands on. This console keeps `this.iface` as it was, which is the
  only reading consistent with a box: nothing was executed, so nothing about the selected interface changed.
  A capture that refuses a port name and then sets a `description` and reads `show running-config` would
  settle it directly.

## Unresolved, and what would settle it

* **A valid-looking name that is not present.** On IOS the *virtual* interface types are created by the
  `interface` command (`interface Vlan 20`, `Loopback 0`, `Tunnel 1`, `Port-channel 5`), while a *physical*
  name is checked against the platform's inventory. This console refuses every name that is not on the
  device's panel and creates only dot1q subinterfaces - behaviour this run did not touch. Whether a switch
  creates a physical name it does not have (some do, showing it `down`), and which platforms do, is a
  separate question. **What would settle it:** `interface GigabitEthernet0/9` on a 2960X-24TS (which stops at
  Gi0/2), followed by `show running-config interface Gi0/9`, on 15.2 and on 17.x.
* **A refused *subinterface* on a real box.** `interface Gi0/0.5000` here is refused by the VLAN-range check
  (`% VLAN out of range: 5000`, this console's own sentence). No capture of a box refusing a VLAN id above
  4094 in a subinterface name was found; the parse shape (caret, no mode change) is assumed to be the same,
  and the fix treats it the same because it is the same door.

## What changed

* `engine/cli.js`, `_ifaceMode()` - the `interface`/`int` line no longer commits the step down to
  `(config)#`. The mode is set to `config` only for the duration of the call into the config-mode door, and
  put back if the door did not open a port (it sets `MODE_IFACE` itself on success, including for a newly
  created dot1q subinterface). A refusal now leaves the session exactly where the line was typed, from
  `(config-if)#`, from `(config-subif)#`, and for the incomplete `interface` line alike.
* `test/interface-refusal-mode.test.js` - 27 checks: the prompt after a refused name at `(config-if)#` and
  at `(config-subif)#`, that the next `description` lands on the port under the cursor and not on a
  neighbour or a parent, the incomplete line, the config-mode case (unchanged, now pinned), and that a name
  the box *can* open still moves the session - full name, abbreviated head, and a subinterface.
* `docs/CLI.md` - the interface-mode section says what a refusal leaves behind.

## Why this is fidelity and not a new feature

`interface <name>` inside interface mode already existed and already switched ports; the only question was
what its refusal does to the session. Nothing new is configurable and no view gains a column.
