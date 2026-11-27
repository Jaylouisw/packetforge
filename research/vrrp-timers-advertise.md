# The VRRP advertisement interval: which word the box puts in front of it

**Question (one, narrow).** What is the Cisco IOS spelling of the command that sets a VRRP group's
advertisement interval — and does the form PacketForge accepted, `vrrp <vrid> advertise <seconds>`,
exist on any box?

**Verdict: known, and adopted.** The box's syntax is `vrrp group timers advertise [msec] interval`. There
is no `vrrp <group> advertise` — the interval is a *timer*, and `timers` is a required keyword, not a
decoration. PacketForge had it the other way round: `vrrp 1 timers advertise 3` was answered
`% Unrecognized vrrp command`, while `vrrp 1 advertise 3` was accepted, documented in `docs/CLI.md`, and
— the part that actually bites — **printed into `show running-config`**. A config saved from the device
therefore carried a line no device would take back.

Three doors now speak the box's keyword: the set form, the `no` form, and the line the printer writes.
The old form is refused where it is typed, with the right one in the sentence, and changes nothing.

## The vendor's own words

| Source | Says |
| --- | --- |
| [Cisco IOS First Hop Redundancy Protocols Command Reference, `vrrp timers advertise`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/command/fhp-cr-book/fhp-v1.html) | Syntax `vrrp group timers advertise [msec] interval` / `no vrrp group timers advertise [msec] interval`; "To configure the interval between successive advertisements by the virtual router master in a VRRP group, use the vrrp timers advertise command in interface configuration mode. To restore the default value, use the no form of this command." Example: `Router(config-if)# vrrp 1 timers advertise 4` |
| [First Hop Redundancy Protocols Configuration Guide, IOS XE 16.12, *Configuring VRRP*](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/configuration/xe-16-12/fhp-xe-16-12-book/fhp-vrrp.html) | The configuration sample: `vrrp 1 priority 120`, `vrrp 1 authentication text cisco`, **`vrrp 1 timers advertise 3`**, `vrrp 1 timers learn`, `vrrp 1 ip 10.1.0.10`, and a second group at **`vrrp 5 timers advertise 30`** |
| [Configuring VRRP, Cisco IOS 12.2SY](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/configuration/12-2sy/fhp-12-2sy-book/fhp-vrrp.pdf) | The task list: "8. vrrp group timers advertise [msec] interval" and "9. vrrp group timers learn"; the step's example `Router(config-if)# vrrp 10 timers advertise 110`; and the millisecond note: "Although the VRRP protocol as per RFC 3768 does not support millisecond timers, Cisco routers allow you to configure millisecond timers" |
| [FHRP Configuration Guide, IOS XE 16.12.1 (ASR 900), *Configuring VRRP*](https://www.cisco.com/c/en/us/td/docs/routers/asr903/software/guide/ip/16-12-1/b-fhp-xe-16-12-asr900/m_fhp-vrrp.html) | The same two lines in the same sample (`vrrp 1 timers advertise 3`, `vrrp 5 timers advertise 30`), and the sentence that a group's interval is set with the `vrrp timers advertise` command |
| [FHRP Configuration Guide, IOS XE 17 (C9000), VRRP](https://www.cisco.com/c/en/us/td/docs/switches/lan/c9000/lyr3-fwd/fhrp/fhrp-configuration-guide/vrrp.html) | Interface mode: `Device(config-if)# vrrp 10 timers advertise 110`. There is also a `(config-if-vrrp)` submode on some images where the same word leads: `Device(config-if-vrrp)# timers advertise 1000` |

Five documents, one spelling. `timers` appears in the syntax line of the command reference, in every
configuration example, and in the name of the command itself (`vrrp timers advertise`), which is what the
command reference's own index and cross-references call it.

## What PacketForge did before this run

Measured on `e75e5c45`, `generic-router`, `Gi0/0`, one group (42) with `10.0.0.254`:

```
r1(config-if)#vrrp 42 timers advertise 3
% Unrecognized vrrp command: vrrp 42 timers advertise 3
r1(config-if)#vrrp 42 advertise 3
VRRP group 42 advertises every 3 s
r1#show running-config
interface GigabitEthernet0/0
 ip address 10.0.0.1 255.255.255.0
 vrrp 42 ip 10.0.0.254
 vrrp 42 advertise 3
```

Three separate defects, one cause:

1. **The accepted spelling is not a command on any box** (above).
2. **The refused spelling is the only one a box has**, so an operator copying a vendor example — or the
   output of `show vrrp`, whose `Master Advertisement interval is 1.000 sec` is described in the command
   reference as "configured with the vrrp timers advertise command" — hit a refusal.
3. **The printer wrote the invented line.** `test/config-roundtrip.test.js` replays the config the console
   prints, but it replayed *this console's* config, so the round trip passed while the line it round-tripped
   was one a 2960, an ASR or a C9000 would refuse. Round-trip is a property of the printer and the parser
   agreeing, not of either agreeing with a box.

## What changed

* `engine/cli.js` — `_vrrpIfaceCommand()` takes `timers`:
  * `vrrp <vrid> timers advertise <seconds>` sets `advertSec`, with the same receipt as before
    (`VRRP group 42 advertises every 3 s`).
  * `vrrp <vrid> timers` and `vrrp <vrid> timers advertise` are **short lines**, answered
    `% Incomplete command: vrrp <vrid> timers advertise <seconds>` rather than reporting `(none)` as a bad
    interval (docs/CLI.md, "A short line is not a wrong value").
  * `vrrp <vrid> timers <anything else>` is refused, and the sentence names the form this console has.
  * `vrrp <vrid> timers learn` is a **real keyword** (`vrrp group timers learn`, in the same task list as
    the interval) and is refused as *not modelled*, with the interval form in the sentence: the engine
    derives a group's timers from its own configuration and has no advertisement to learn one from.
  * `vrrp <vrid> timers advertise msec <interval>` is refused as *not modelled*. It is a different fact —
    a sub-second interval — and reading `msec 500` as 500 seconds would be a silent lie. The model does
    hold centiseconds (`advertCs`, at the RFC 5798 25 cs floor) for topology files; the console has no way
    to write that form, and none is invented here.
  * `vrrp <vrid> advertise <seconds>` is refused with
    ``% `vrrp 42 advertise 3` is not a command: the advertisement interval is `vrrp 42 timers advertise
    <seconds>` ``. The group is untouched — no interval written, no empty group created, since a refusal on
    a bare port must not leave a virtual router behind.
* `engine/cli.js` — the `no` door: `no vrrp <vrid> timers advertise` restores the vendor default of 1 s
  (unchanged receipt); `no vrrp <vrid> advertise` is refused with the whole-second form in the sentence
  rather than resetting a timer the operator did not name; the can-unset list in the unknown-word refusal
  now reads `priority, preempt, timers advertise`.
* `engine/cli.js` — `_runningConfig()` prints ` vrrp <vrid> timers advertise <seconds>`, the line a box
  prints, so the config a lab saves is one a box (and this parser) reads back.
* `test/vrrp-timers-advertise.test.js` (new, 31 assertions): the accepted form and the stored value, the
  master-down interval moving with it (`3 × 3 s + skew` = 9.609), the printed line and its paste-back onto a
  fresh device, the old spelling refused without changing the group or creating one, the short lines, the
  unknown word, `timers learn`, `msec`, the three bad intervals, the `no` form, and the disappearance of
  the line when the value is back at its default.
* `test/vrrp-no-form.test.js`, `test/config-roundtrip.test.js` — the fixtures type the box's spelling and
  read the new line; the can-unset assertion follows the new list.
* `docs/CLI.md` (VRRP section: syntax block, the `no` transcript, the can-unset line, and a paragraph with
  the sources), `docs/CONVERGENCE.md` (the timer table's one settable timer).

## What remains unresolved, and what would settle it

* **The refusal a real box gives the invented line.** No capture was found of `vrrp 42 advertise 3` on
  any image. By analogy with every other unrecognised keyword in an interface block it is the parser's
  caret form — `% Invalid input detected at '^' marker.`, with the `^` under `advertise` — but that is
  inference, and it is the same console setting question `research/parse-error-caret.md` leaves open. This
  console refuses in its own voice instead (it *names* the word and prints the form that works), which is
  the documented product decision; the sentence adopted here is that voice, not a transcript.
  **Would settle it:** one console capture of `vrrp 1 advertise 3` on a 2960 or an ASR.
* **What a millisecond interval looks like in the two views.** The syntax has `[msec]`, so
  `vrrp 1 timers advertise msec 500` is real, and the IOS XE 16.12 guide adds a wrinkle worth recording:
  "the primary advertisement value displayed in the show vrrp command output on the backup routers is
  always 1 second because the packets on the backup routers do not accept millisecond values". So the
  master may print `Advertisement interval is 1000 msec` while its backup prints `1.000 sec` for the same
  group. Neither view is modelled here, and the `msec` form is refused rather than half-modelled.
  **Would settle it:** a pair of `show vrrp` captures (master and backup) from one lab with a ms interval.
* **The config line for a millisecond value.** Is it `vrrp 1 timers advertise msec 500`, or a seconds
  figure with a fraction? No capture shows a running-config with a ms interval. Nothing here depends on
  it: no value this console can hold has a fraction.
* **`timers learn`.** The keyword is real ("Configures the router, when it is acting as virtual router
  backup for a VRRP group, to learn the advertisement interval used by the virtual primary router"). What
  a learned group prints — the XE sample shows `Master Advertisement interval is 1000 msec (learned)` —
  and whether it overrides a configured interval are not modelled. **Would settle it:** a `show running-config`
  from a backup configured with `vrrp 1 timers learn`, to see whether the interval line is printed at all.
* **Keyword abbreviation inside the block.** IOS abbreviates keywords, so `vrrp 1 tim adv 3` is very
  likely accepted (the vrrp sub-keywords are `ip`, `priority`, `preempt`, `authentication`, `timers`,
  and `tim` is unique among them). This console abbreviates only at positions where it holds a complete
  word table (research/command-word-abbreviation.md), and it holds none after `vrrp`, so the shortening is
  refused here. **Would settle it:** a capture of `vrrp 1 tim adv 3` and of `vrrp 1 t adv 3` (the second
  decides whether `t` is unique or ambiguous against nothing).
* **The `(config-if-vrrp)` submode.** Some IOS XE images configure VRRP in a submode where the line is
  `timers advertise 1000` with no group number (C9000 FHRP guide, step 11). This console has one VRRP
  syntax, in interface mode, per group; the submode is a different shape of the same fact and is not
  modelled.
