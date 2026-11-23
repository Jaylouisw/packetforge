# An empty allowed list is not an error: reconciling `validatePortConfig()` with `none`

**Question (one, narrow).** Now that the console accepts `switchport trunk allowed vlan none` and stores the empty
list, what should `engine/vlan.js`'s `validatePortConfig()` say about that same list - an error
(`E_TRUNK_NO_VLANS`), or a legal configuration?

**Verdict: legal, and the error is gone.** The command reference defines the word as exactly this state - "**none**
specifies an empty list" - and the console already prints it (`allowed none`), prints it back
(`switchport trunk allowed vlan none`) and drops every VLAN on it in the data path. The validator was the last
surface that called the state impossible. It now reports nothing for it, and a list that cannot be *parsed* is
still an error.

## How the three surfaces disagreed

| Surface | Before this run | After |
| --- | --- | --- |
| CLI (`switchport trunk allowed vlan none`) | accepted, stores `[]` - since `research/trunk-allowed-vlan-none.md` | unchanged |
| Printer (`show interfaces`, `show running-config`) | `allowed none`, `switchport trunk allowed vlan none` | unchanged |
| Data plane (`classifyEgress()`) | drops every VLAN on `[]` | unchanged |
| Validator (`validatePortConfig({ mode: 'trunk', allowedVlans: [] })`) | `ok: false`, `E_TRUNK_NO_VLANS: "trunk port has an empty allowed VLAN list"` | `ok: true`, no errors |

The contradiction was invisible from the console because no command path validates a *whole* port config: the
`switchport` commands check the single field they write (`accessVlan`, `nativeVlan`, `voiceVlan`) and never hand the
assembled port to the validator. It was visible to anything that used the exported API - an importer, a board
lint, a test - and it was recorded as an open item by the run that taught the console the word
(`research/trunk-allowed-vlan-none.md`, "What is unresolved", third bullet).

## Evidence

| Source | Says |
| --- | --- |
| [Cisco, *Command Reference, Cisco IOS XE 17.13.x (Catalyst 9300) - VLAN Commands*, `switchport trunk`](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-13/command_reference/b_1713_9300_cr/vlan_commands.html) | "The vlan-list format is `all \| none \| [add \| remove \| except] vlan-atom`: **all** specifies all VLANs from 1 to 4094. This is the default. ... **none** specifies an empty list." The same text is in the 17.12-17.16 books. |
| [Cisco, *CBS 250/350 CLI guide - VLAN commands* (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/csbms/CBS_250_350/CLI/cbs-250-cli/vlan-commands.pdf) | "**none** - Specifies an empty VLAN list. The port does not belong to any VLAN." - a second Cisco CLI family saying what the state is, not that it is invalid. |
| [Catalyst 9200, IOS XE 17.15.x, *Configuring VLAN Trunks*](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-15/configuration_guide/vlan/b_1715_vlan_9200_cg/configuring_vlan_trunks.html) | the command an operator is told to type carries `none` in its syntax line, beside `all` and `remove`. |
| `research/trunk-allowed-vlan-none.md` (this repository) | the word is accepted, stored and printed; its third open item is this reconciliation. |

## What changed

* `engine/vlan.js` - the `E_TRUNK_NO_VLANS` branch is removed, and with it the `listParseFailed` flag that existed
  only to keep the two reports from doubling on one bad list. A list that fails to parse still reports the parser's
  own errors; the empty list reports nothing, because it is the documented `none`.
* `test/vlan.test.js` - the one expectation that asserted the error now asserts `{ ok: true, errors: [], warnings: [] }`,
  and two checks were added: a trunk whose list cannot be parsed is still an error, and two `none` trunks are
  compatible while `none` against `all` is not (the link-compatibility check already read the empty list correctly -
  its reason strings say "different allowed VLAN lists (all against none)").

## What is not changed, and why

* **No warning.** A trunk that carries nothing is usually a mistake, but a box says nothing when it is configured
  and prints nothing about it afterwards, so a warning here would be this console inventing advice the device does
  not give. The state is visible where an operator looks for it: `allowed none` in `show interfaces`, the line in
  `show running-config`, and a ping that goes nowhere.
* **`E_NATIVE_NOT_ALLOWED` still skips an empty list.** The native VLAN cannot be "not in" a list that allows
  nothing; the membership error is about a configured VLAN that is missing from a list, and there is no list.

## What remains unresolved

Nothing about this state. The two open items in `research/trunk-allowed-vlan-none.md` are about other captures
(`show interfaces trunk` on a really-trunking port, and the `remove 1-4094` path); both are hardware questions, not
validator ones.
