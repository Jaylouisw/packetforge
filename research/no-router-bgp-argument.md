# `no router bgp` with no AS — incomplete, or a delete?

**Question (one, narrow).** Is the AS number in `no router bgp <as>` a required argument on an IOS-like
box, and what does this console do with the three words on their own?

**Verdict: required, and the box does not act on a half-typed line.** Both Cisco command references spell the
no-form as `no router bgp autonomous-system-number`, with the number outside any brackets, and the CLI's
documented answer to a line that is missing a required keyword or value is `% Incomplete command.` — a parser
message, printed before any handler for the command runs. This console took the three words and cleared the
process: `no router bgp`, Enter, and the local AS, the neighbours and the `router bgp` stanza in
`show running-config` were gone. An operator who typed the command and stopped to look the number up had
already deleted the configuration they were about to name.

## What PacketForge printed

The `no router bgp` branch of the config-mode dispatch (`engine/cli.js`) looked at two words and nothing else:

```
R1(config)#router bgp 65001
R1(config)#neighbor 10.0.12.2 remote-as 65002
R1(config)#no router bgp
BGP disabled
R1(config)#
```

and the process, its neighbour and its stanza were gone. A bare `no router bgp` on a box with no process
answered `BGP disabled` too. The console's own command index already disagreed with the handler: the
`no`-form catalogue entry is `{ match: ['router', 'bgp'], syntax: 'no router bgp <as>', effect: 'removes the
BGP process' }`, i.e. it declared the argument the branch ignored — the same split between a documented
grammar and the code that answers it that #1666, #1675 and #1685 were.

## The evidence

| Source | Says |
| --- | --- |
| [Cisco IOS IP Routing: BGP Command Reference, `router bgp`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_bgp/command/irg-cr-book/bgp-n1.html) | `router bgp autonomous-system-number` / `no router bgp autonomous-system-number` — the number is in neither the command's keyword list nor its brackets, and the entry's own example of moving to another AS is the two-line `no router bgp 200` then the new process. |
| [Cisco IOS XE 3SE (Catalyst 3850) BGP command reference, `router bgp`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_bgp/command/iproute_bgp-xe-3se-3850-cr-book/iproute_bgp-xe-3se-3850-cr-book_chapter_0100.html) | The same syntax on IOS XE: `no router bgp autonomous-system-number`, "No BGP routing process is enabled by default." |
| [Cisco NCS 4000 / IOS XR command reference, `router bgp`](https://www.cisco.com/c/en/us/td/docs/routers/ncs4000/software/reference/guide/otncommandreferenceguide/bgp-route-reflector-commands.html) | The family's exception, and the contrast that makes the IOS form mean something: IOS XR writes `no router bgp [as-number]`, with the number in brackets. IOS does not. |
| [Cisco, *Using the Command-Line Interface*, "Understanding CLI Error Messages", Table 3](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst1000/software/releases/15_2_7_e/command_reference/b_1527e_1000_cr/using_the_command_line_interface.html) (also [2960-X](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/command_reference/b_1526_2960x_cr/using_the_command_line_interface.html), [Catalyst 9400 17.13](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9400/software/release/17-13/command_reference/b_1713_9400_cr/using_the_command_line_interface.html), [Catalyst 9600 17.12](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/17-12/command_reference/b_1712_9600_cr/using_the_command-line_interface.html)) | `% Incomplete command.` = "You did not enter all the keywords or values required by this command." One row, four platform families, the same sentence — so the box's answer to a line that stops before a required argument is a documented message, not a behavioural guess. |
| [Cisco IOS IP Routing: BGP Command Reference, `neighbor` / `router bgp` notes](https://www.cisco.com/c/en/us/td/docs/ios/iproute_bgp/command/reference/irg_book/irg_bgp4.html) | The reference's own prose treats the removal as a command that names the process: "Remove support for autonomous system number 200 before configuring number 300", with `no router bgp 200` as the line that does it. |

## What is known

1. The AS is a required argument of the no-form on both IOS and IOS XE; it is optional only on IOS XR, which
   says so with brackets.
2. A line missing a required value is answered `% Incomplete command.` — one space after the `%`, a full
   stop, no keyword echo — and the command does not run.
3. The removal is a delete of a named process: the vendor's own instructions always carry the number, and
   `no router bgp <old-as>` followed by `router bgp <new-as>` is the documented way to move a router to a new
   AS (see also research/bgp-second-router-as.md).
4. The range the argument accepts is the same one the create path accepts (1–4294967295); the console already
   refuses `router bgp 0` with `% Invalid AS number "0"`.

## What is inferred rather than witnessed

* **The exact parser path.** No capture in hand shows `no router bgp` typed bare on a live box; the claim is
  that the argument's absence is the missing-value case the error table describes, which follows from the
  syntax line but is not itself a paste. **What would settle it:** one paste of `no router bgp` alone in
  `(config)#` on a box with a process, followed by `show running-config | section router bgp`.
* **The wording this console uses.** The vendor prints `% Incomplete command.`; this console spells
  incomplete commands `% Incomplete command: <syntax> (<what did not change>)` in about thirty places
  (`no vlan`, `ip route`, `hostname`, `vrrp`, `switchport trunk allowed vlan` …), because a lab needs to know
  which argument is missing. That house style is kept, and the line names the running AS so the operator can
  retype the command without looking it up. The *fact* (nothing is removed) is the box's; the sentence is the
  console's.
* **`% Invalid AS number` rather than `% Invalid input detected at '^' marker.`** A box given `no router bgp
  foo` points a caret at `foo`. This console has no caret parser (research/parse-error-caret.md) and already
  refuses a bad AS by value on the create path, so the no-form runs the same check and prints the same line,
  which is the only way the two paths cannot disagree about what an AS number is.
* **Leading zeros.** `no router bgp 065001` is taken as 65001, because the create path's `parseInt` takes it
  that way and one process is being named. Not witnessed.

## What remains unresolved

* **A mismatched AS.** No capture in hand shows `no router bgp <other>` on a box running `<as>`: whether the
  box refuses the deletion, ignores the argument and removes the process, or answers with the same
  `BGP is already running; AS is <as>` line it prints for the forward form. This console ignores the argument
  — the number names the one process it models — and `test/no-router-bgp-argument.test.js` now pins that, so a
  future change is a decision rather than a drift. **What would settle it:** one paste of `no router bgp
  <other-as>` on a box running BGP, followed by `show ip protocols`.
* **`no router bgp <as>` with no process to remove.** This console still answers `BGP disabled`, a receipt
  for a deletion that removed nothing. What a box prints there (silence, or `% BGP not active`, the line its
  *show* commands use — research/bgp-not-active-refusal.md) is not witnessed, and the receipt was left alone
  rather than guessed at.
* **NX-OS and IOS XR.** NX-OS's no-form takes the same required number (`no router bgp autonomous-system-number`),
  but NX-OS also gates the whole feature behind `feature bgp`; IOS XR brackets the argument. Neither is
  modelled here and neither is claimed.

## What changed

* `engine/cli.js`, config-mode dispatch: `no router bgp` with no third word returns
  `% Incomplete command: no router bgp <as> (BGP is still running as <as>)` — or
  `(there is no BGP process to remove)` when nothing is configured — and changes nothing. A third word that is
  not an AS in 1–4294967295 returns `% Invalid AS number "<x>"`, the create path's own check, before the delete
  runs. A valid number still removes the process and still answers `BGP disabled`.
* `test/no-router-bgp-argument.test.js` (17 checks): the incomplete line with and without a process; the
  neighbour, the running AS, `show ip bgp summary` and `show running-config` all intact afterwards; four bad
  values (`foo`, `0`, `4294967296`, `-1`) refused with the process intact; the normal delete unchanged; the
  second delete still answering `BGP disabled`; the mismatched AS still removing (pinned as unresolved); and
  `065001` taken as 65001.
* `test/bgp-wire.test.js`: the teardown line was `no router bgp` and is now `no router bgp 65002`, which is
  what the test meant (R2's AS) and now the only form the console accepts.
* `docs/BGP-POLICY.md` §9.3: the rule in prose, and the command table's `no router bgp` row carries the two
  refusals. The `cli.js` dispatch citation was re-pointed at the branch's new extent.
