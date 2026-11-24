# A 1000BASE-X cage has no `duplex` and no `speed`: what the switch answers, and why this console cannot ask which cage it has

**Question (one, narrow).** On a Catalyst whose port is a 1000BASE-*x* or 10GBASE-*x* SFP cage, are `duplex`
and `speed` commands at all, and what does the box print when an operator types one? Can PacketForge refuse
them honestly from what it already stores about a port?

**Verdict: the two words are not in that port's parser, so the box answers `% Invalid input detected at '^' marker.`
- but the engine cannot decide which ports are those, and the field reports disagree about the
copper module that fits the same cage. Nothing in the engine was changed.** The known half is the vendor
sentence; the undecidable half is the port's optic, which PacketForge does not store.

## What PacketForge does today

Measured on `04c906f7` with two catalogue models and nothing configured. First a 1G SFP cage
(`C1000-24FP-4G-L`, `Gi1/0/25`, `hardware.family = optical`, `speedCaps = [1000]`):

```
sw1(config-if)#duplex full         ->  Duplex full on Gi1/0/25
sw1(config-if)#duplex auto         ->  Duplex auto (full) on Gi1/0/25
sw1(config-if)#speed 1000          ->  Speed 1G on Gi1/0/25
sw1(config-if)#speed auto          ->  Speed auto-negotiation on Gi1/0/25
sw1(config-if)#speed 100           ->  % Gi1/0/25 does not support 100M - it supports 1G
```

and then a 10G SFP+ cage (`C1300-24T-4X`, `Te1/0/1`, `speedCaps = [1000, 10000]`):

```
sw1(config-if)#duplex full         ->  Duplex full on Te1/0/1
sw1(config-if)#speed 1000          ->  Speed 1G on Te1/0/1
sw1(config-if)#speed auto          ->  Speed auto-negotiation on Te1/0/1
sw1(config-if)#speed 100           ->  % Te1/0/1 does not support 100M - it supports 1G, 10G
```

Both commands take effect: `show interfaces` afterwards reads `duplex: full`, and `speed: 1Gb/s (forced)` on
`Gi1/0/25` in the run where a rate was forced. So the console does not merely accept the words - it writes a
state the rest of the model then reports, for a setting the hardware does not have.

The reason a refusal is not a two-line change is in the port object. `_speed()` in `engine/cli.js` decides
from `iface.hardware.speedCaps` and `_duplex()` from the same ladder; neither knows what is plugged in. An
interface carries `name, type, speed, hardware, mac, ip, duplex, speedMbps, mtu` and a dozen more keys, but **no media id**; the media
id lives on the *link*, so a rule keyed on it would make the CLI grammar change as a cable is plugged and
unplugged - a worse lie than accepting a no-op.

## What is known

| Source | Says |
| --- | --- |
| [Catalyst 2960-X Consolidated Command Reference 15.2(7)E, Interface and Hardware Commands, `duplex`](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr/interface_and_hardware_commands.html) | "Duplex options are **not supported** on the 1000BASE*-x* or 10GBASE*-x* (where *-x* is -BX, -CWDM, -LX, -SX, or -ZX) small form-factor pluggable (SFP) modules." The same page's default line: "The default is half for 100BASE*-x* (...) SFP modules." |
| [Catalyst 2960-X 15.2(6)E, same chapter, `duplex`](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/command_reference/b_1526_2960x_cr/interface_and_hardware_commands.html) | The keyword table makes the rate rule explicit - `half`: "Enables half-duplex mode (only for interfaces operating at 10 or 100 Mb/s). You cannot configure half-duplex mode for interfaces operating at 1000 or 10,000 Mb/s." - and repeats the SFP sentence. |
| [Catalyst 2960-X 15.2(7)E, same chapter, `speed`](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr/interface_and_hardware_commands.html) | "You cannot configure speed on the 10-Gigabit Ethernet ports." And the sentence that keeps the cage from being the unit: "Except for the 1000BASE-T small form-factor pluggable (SFP) modules, you can configure the speed to not negotiate (`nonegotiate`) when an SFP module port ... does not support autonegotiation." |
| [Catalyst 1000 15.2(7)Ex, Interface and Hardware Commands, `speed`](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst1000/software/releases/15_2_7_e/command_reference/b_1527e_1000_cr/interface_and_hardware_commands.html) | "You cannot configure speed on 10-Gigabit Ethernet ports." Same platform family as the C1000 measured above, one release later. |
| [Cisco Community, "don't permit entry duplex full command in a gigabitethernet interface"](https://community.cisco.com/t5/switching/don-t-permit-entry-duplex-full-command-in-a-gigabitethernet/m-p/1197646) | A 2960/3560 on 12.2(35)SE5, interface Gi0/2: `duplex?` -> `% Unrecognized command`; `duplex full` -> `% Invalid input detected at '^' marker.`; `speed` -> the same line. The OP reports the port is copper ("no, don't is fiber is utp pair twister"); a responder reports the opposite outcome on another switch: "I was able to change duplex and speed on another switch which had a gigabit copper sfp." |
| [Cisco Community, "catalyst 4500-X SFP issues"](https://community.cisco.com/t5/network-management/catalyst-4500-x-sfp-issues/td-p/3829432) | TenGigabit ports with 10G fibre SFPs: `speed 1000` -> `% Invalid input detected at '^' marker.` and `duplex full` -> the same line. A copper GLC-T in the same chassis is reported to accept `speed 1000, duplex full`. |
| [Dell Community, N3000 `duplex full`](https://www.dell.com/community/en/conversations/networking-general/linking-existing-switch-stack-with-new-switches-via-fiber/647f8c57f4ccf8a8dec9bc3d) | A different OS, the same shape: `duplex full` -> `% Invalid input detected at '^' marker.`, explained as "There is not a duplex command on the N3000 since full duplex is the only supported option." The word is absent from the parser, not refused by a rule. |
| [Catalyst 2960-X 15.2(2)E Interface Characteristics configuration guide](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_2_e/consolidated_guide/configuration_guide/b_1522e_consolidated_2960x_cg/m_int_inter_cg.pdf) | "The 1000BASE-T SFP modules operate at 10, 100, or 1000 Mb/s in full-duplex mode or at 10 or 100 Mb/s in half-duplex mode" - the sentence that keeps a *cage* rule from being true. |

## What is inferred

* `% Invalid input detected at '^' marker.` is the parser's answer, not a policy refusal: the two words are
  simply not in that interface's command tree, which is why `duplex?` answers `% Unrecognized command` instead
  of listing keywords. A console that prints an explanatory sentence here is choosing to be more helpful than
  the box, the same trade `consoleIsALine()` already makes (`engine/cli.js:44-56`).
* The vendor's *rate* rule and its *module* rule are different rules, and PacketForge already implements the
  first: `half` above 100 Mb/s is refused with a real sentence (`research/half-duplex-is-10-100.md`), and
  `speed 100` on a 1G ladder is refused from `speedCaps`. What is missing is only "there is no such command
  here at all".
* The 10G half is the cleaner of the two: "You cannot configure speed on 10-Gigabit Ethernet ports" is a
  statement about a *port*, not a module, so `speed 1000` and `speed auto` on `Te1/0/1` are wrong whatever is
  in the cage. The 1G half is not, because a 1000BASE-T module in the same cage has three rates.

## The census that blocks a cage-keyed rule

Measured over the whole catalogue (`loadCatalog` over 2,358 models, every interface built through `Topology`):

| Class | Ports |
| --- | --- |
| Optical ports | 8,840 |
| ...that declare at least one copper module in `hardware.media` (`*-t`, `*-t-sfp`, `dac-*`) | 7,848 |
| ...whose ladder reaches below 1G (the 100BASE-FX class, where `duplex` *is* configurable) | 644 |
| ...that are exactly 1G-only | 855 |
| ...that reach above 1G | 7,524 |

So 89% of the optical cages in the catalogue accept a copper module, and `hardware.media` cannot say which
module is in the cage now. A rule keyed on `family === 'optical'` would refuse `duplex` on 7,848 ports where a
GLC-T makes it legal; a rule keyed on the cable's media id would make the grammar depend on whether a cable is
plugged in. The only cages it could decide without lying - the one-rate fibre-only ones - are mostly PON, OTN
and 40G/100G line ports where `duplex` is not part of the OS at all.

## What is unresolved

1. **Whether a 1000BASE-T SFP in a 1G SFP cage really accepts `duplex` and `speed` on a Catalyst.** The
   hardware guide says the module runs 10/100/1000, the 4500-X thread says the copper module takes the
   commands, and the 2960 thread says the copper module did not. No transcript in hand shows `duplex ?` with a
   named module inserted, so the two reports cannot be separated into platform, release or module.
2. **What a 2960X with an *empty* SFP cage does** - the parser line, or a specific "media type is not present"
   message. The 2960X `show interfaces` prints "media type is Not Present" for an empty cage, but no capture
   shows the configuration attempt.
3. **Whether `nonegotiate` is the one `speed` word a fibre SFP does take.** The 15.2(7)E text offers it for SFP
   ports "except for the 1000BASE-T" modules, which reads as fibre-only; this console has no `nonegotiate`
   keyword at all.

## What would settle it

Two transcripts, one per module, on the same 2960X port, with no other commands between:

```
show interfaces Gi1/0/25 | include media type
configure terminal / interface Gi1/0/25 / duplex ? / speed ? / duplex full / speed 1000 / end
```

once with a GLC-SX-MM and once with a GLC-T, then the same on a `Te` port of a 10G platform. The `duplex ?`
answer is the whole question: a keyword list means the word is configurable and the cage rule is false; an
empty answer or `% Unrecognized command` means the word is absent. Until then the console keeps accepting both
commands as no-op settings, and `research/half-duplex-is-10-100.md` keeps the rate rule that *is* settled.

## Why nothing was changed

The engine change would be a refusal, and no available predicate for it is true of the box it would be
imitating: `family` over-refuses 7,848 ports, `speedCaps` under-refuses every 1G cage, and the link's media id
would make a port's grammar depend on a cable. The honest state is the one recorded here plus the measured
transcript above, so the next run that wants this rule starts from the module question instead of the cage.
