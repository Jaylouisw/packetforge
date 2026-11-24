# The bare `switchport` line: a documented inverse, an empty answer, and a LAN Base box that may not have either

**Question (one, narrow).** A Catalyst operator types `switchport` at `(config-if)#` with no keywords. What has
the box been told to do, and what does it print? And on a LAN Base switch - the 2960 family this catalogue is
full of - does that pair of commands exist at all, or does the image refuse it? The third part is about this
repo: what did PacketForge answer that line before this run, and is the new answer a claim the evidence carries?

**Verdict, first half: the bare form is a real command, the inverse of `no switchport`, and it prints nothing
because there is nothing to print.** Five Cisco IOS/IOS XE command references give the same syntax line and the
same default. This console answered it with `% Unrecognized switchport command: ` - the operator's word *was* the
command, so the sentence ended at its colon, which reads as a console that has never heard of a line the vendor
documents everywhere. It now answers with one sentence naming the port, what the command is for and that nothing
changed. `test/bare-switchport.test.js` (23 checks) pins it, including the part that matters: the bare form does
not become a second way to wipe a port.

**Verdict, second half: unresolved, and the engine was not changed for it.** Cisco's LAN Base notes say the
command "is not supported" on that feature set, the 2960 family's own command reference documents the pair and
then says the positive form "is not used on platforms that do not support Cisco-routed ports", and the one
real-hardware capture of a LAN Base box refusing it shows an *apply-time* sentence
(`Command rejected: not allowed on this interface.`) rather than the parse error a missing command gives. Which
of those a 2960 actually prints is not settled by anything public I could find, so PacketForge still accepts
`no switchport` on every box that switches - 285 of the catalogue's 423 switches carry no `l3-forward` - and this
note is what the next attempt should start from.

## Evidence

* **Catalyst 9300 command reference, IOS XE 16.5.x, Layer 2/3 Commands, `switchport`** -
  [cisco.com](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/16-5/command_reference/b_165_9300_cr/b_165_9300_cr_chapter_0111.html).
  "To put an interface that is in Layer 3 mode into Layer 2 mode for Layer 2 configuration, use the switchport
  command in interface configuration mode. To put an interface in Layer 3 mode, use the no form of this command."
  Syntax `switchport` / `no switchport`, "This command has no arguments or keywords", default "all interfaces are
  in Layer 2 mode", and the note "This command is not supported on running the LAN Base feature set."
* **Catalyst 9300 command reference, IOS XE 16.6, Layer 2/3 Commands (PDF)** -
  [cisco.com](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/16-6/command_reference/b_166_9300_cr/b_166_9300_cr_chapter_0100.pdf).
  The same entry with the LAN Base note in its corrected wording ("not supported on devices running the LAN Base
  feature set"), plus the sentence the reset half rests on: "When you put an interface that is in Layer 2 mode into
  Layer 3 mode (or the reverse), the previous configuration information related to the affected interface might be
  lost, and the interface is returned to its default configuration." Also: "If an interface is configured as a
  Layer 3 interface, you must first enter the switchport command to configure the interface as a Layer 2 port."
* **Catalyst 9300 command reference, IOS XE 16.9 and 17.12, `layer_2_3_commands`** -
  [16.9](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/16-9/command_reference/b_169_9300_cr/layer_2_3_commands.html),
  [17.12](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-12/command_reference/b_1712_9300_cr/layer_2_3_commands.html).
  The same syntax line and the same LAN Base note two releases and four years apart, so the entry is maintained
  rather than a stray page.
* **Catalyst 9200 command reference, IOS XE 16.12, Layer 2/3 Commands** -
  [cisco.com](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/16-12/command_reference/b_1612_9200_cr/b_1612_9200_cr_chapter_0101.html).
  "Cisco IOS XE Fuji 16.9.2 - This command was introduced", the same usage guidelines, and no LAN Base note (the
  9200 has no LAN Base image): "You must use this command before assigning an IP address to a routed port", and
  "Entering the no switchport command shuts the port down and then reenables it".
* **Catalyst 3850 command reference, IOS XE 16.3, Layer 2/3 Commands (PDF)** -
  [cisco.com](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst3850/software/release/16-3/command_reference/b_163_consolidated_3850_cr/b_163_consolidated_3850_cr_chapter_01001.pdf).
  The identical usage guidelines plus "This command is not supported on devices running the LAN Base feature set."
  One platform family, one document, both the routed-port procedure and the image that cannot run it.
* **Catalyst 2960, 2960-S, 2960-SF and 2960-Plus command reference, IOS 15.2(4)E, `switchport` (PDF)** -
  [cisco.com](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-2_4_e/command/reference/cr_2960/cli3.pdf).
  The 2960 family's own book documents the pair - "Use the **switchport** interface configuration command with no
  keywords to put an interface that is in Layer 3 mode into Layer 2 mode for Layer 2 configuration"; "Use the
  **no switchport** command (without parameters) to set the interface to the routed-interface status and to erase
  all Layer 2 configurations" - and then adds the caveat that makes the pair conditional: "The **switchport**
  command without keywords is not used on platforms that do not support Cisco-routed ports."
* **Catalyst 2960-XR configuration guide, IOS 15.2(7)E, Configuring Interface Characteristics** -
  [cisco.com](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15_2_7_e/configuration_guide/b_1527e_consolidated_2960xr_cg/m_int_inter_cg.html).
  The other half of the 2960 name: on the XR (IP Lite) the routed port is real - step 4 of the procedure is "For
  physical ports only, enters Layer 3 mode", and "A routed port is a Layer 3 interface only and does not support
  Layer 2 protocols, such as DTP and STP." One chassis name sits on both sides of the rule, which is why the rule
  has to be per image and not per model.
* **Cisco IOS Interface and Hardware Component Command Reference, `switchport`** -
  [cisco.com](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-s7.html).
  The mainline book's entry for the families where the word is not new: "Use the no switchport command to put the
  interface into the routed-interface status and to erase all Layer 2 configurations" (3550/4000/4500), and for
  the 6500/7600 "cause all further Layer 2 configuration to be erased".
* **Cisco Community, "No switchport command", WS-C3750X-48P, License Level lanbase** -
  [community.cisco.com](https://community.cisco.com/t5/switching/no-switchport-command/td-p/4633455).
  The one real-hardware capture of a LAN Base box: `no switchport` under an interface answers
  `Command rejected: not allowed on this interface.` The command parsed; an apply-time check refused it.
* **Cisco Community, "Routing on 2960S", C2960-LANBASEK9-M 15.0(2)SE9** -
  [community.cisco.com](https://community.cisco.com/t5/switching/routing-on-2960s/td-p/2903604). The operator
  reports the switch "does not accept that command either", after `ip address` on the port was refused with
  `% Invalid input detected at '^' marker.` and `ip ?` listed no `ip address` subcommand. Reported, not
  transcribed: no words for the refusal itself.
* **Cisco Community, "no switchport command is not working in", WS-C2960X-48TD-L** -
  [community.cisco.com](https://community.cisco.com/t5/switching/no-switchport-command-is-not-working-in/td-p/2572881).
  "The 2960X doesn't support routed ports", and the routing it does have is SVI-only: "Static routing is supported
  only on switched virtual interfaces (SVIs) and not on physical interfaces." The invalid-input transcript in that
  thread is from a different poster's GNS3 box (`L3 SW1`, a 3640 image), not from the 2960X - it shows what a
  router image does with the word, and must not be read as the 2960's answer.

## What is known

1. The bare form is not a typo and not a prefix: four IOS XE books and the mainline interface book give it as a
   syntax line of its own, with "This command has no arguments or keywords" and the default "all interfaces are in
   Layer 2 mode". Its job is the mirror of `no switchport`: put an interface that is in Layer 3 mode back into
   Layer 2 mode.
2. It is documented *and* conditional. The 2960 family book carries it and then says the positive form "is not
   used on platforms that do not support Cisco-routed ports"; the 9300 and 3850 books carry it and then say it
   "is not supported" on the LAN Base feature set. Both sentences are in the same entries that define the command.
3. A LAN Base box that has the routing hardware still parses the word and refuses it with its own sentence:
   `Command rejected: not allowed on this interface.` - an *apply-time* refusal, not a parse error. `Command
   rejected:` is the shape the same switch uses for other "the line is real but this port may not have it" cases
   (`no switchport mode access` on an access port answers `Command rejected: An interface must be configured to
   the Access or Trunk modes to be configured to NoNegotiate.`, networkengineering.stackexchange.com question
   70916).
4. The reset half of the pair is documented for the platforms that do have routed ports: "the previous
   configuration information related to the affected interface might be lost, and the interface is returned to its
   default configuration", and entering `no switchport` "shuts the port down and then reenables it". So a mode
   change in either direction erases the port's Layer 2 settings on a box.
5. The 2960 name is on both sides of the rule. The plain 2960/2960-S/2960-X runs LAN Base (or LAN Lite) with
   static routing on SVIs only; the 2960-XR runs IP Lite and documents routed ports, with `no switchport` as step 4
   of the procedure. So "a 2960" is not one platform, which is the trap this question sets.

## What is inferred

* **That a LAN Base refusal is an apply-time check, not a missing word.** The 3750X capture shows the parser
  accepting `no switchport` and the interface refusing it. A word the parser does not know is answered in a
  different shape - "The Catalyst 2960 switch rejects these commands, and this message appears: ... `%Invalid
  input detected at '^' marker.`", one command at a time, in Cisco's own 2950-to-2960 upgrade appendix
  ([12.2(55)SE, `swupgrad.pdf`](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_55_se/configuration/guide/scg_2960/swupgrad.pdf))
  - so a LAN Base box answering `Command rejected:` is refusing an effect it understands, not a word it lacks.
* **That the 2960-XR guides and the 2960 guides are the same book family**, which is why `no switchport` appears
  in a document whose platform cannot route on physical ports: the routed-port step belongs to the XR, and the
  LAN Base caveat belongs to the plain chassis, and the reference publishes both for the family.
* **That bare `switchport` on a port already in Layer 2 mode is a no-op on every platform.** The command only
  moves an interface *out of* Layer 3 mode; there is no mode change to make, so there is nothing to erase and
  nothing to print. This is the inference the console now models, and it is the weakest link in this note: no
  capture in the evidence above shows the line typed on an already-Layer-2 port.

## What PacketForge did, and what changed

Before this run, `switchport` with no keywords fell through `_switchport()` to the handler's last line,
`'% Unrecognized switchport command: ' + t.join(' ')`, with `t` empty - so the console printed a sentence with
nothing after its colon, about a command five vendor books document. On a 3560 and on a 2960 alike:

```
sw1(config-if)#switchport
% Unrecognized switchport command:
```

It now answers, and changes nothing:

```
sw1(config-if)#switchport
% Fa0/1 is already a Layer 2 switchport: `switchport` returns a routed port to Layer 2 mode, and this console has no routed port - nothing changed
```

The sentence is this console's own, deliberately: a box prints nothing at all here, and a fabricated blank line
would be indistinguishable from a console that had swallowed the command. It names the port, says what the box
uses the word for, and says the state did not move. `test/bare-switchport.test.js` (23 checks) pins the answer,
its one-line shape, the fact that `show interfaces <port>` and `show running-config` are byte-for-byte unchanged
by it, that typing it twice says the same thing, that an unknown keyword is still quoted back, that `no
switchport` is still the whole-port reset, and that a router still gets its `l2-forward` refusal instead.

## Why the engine was not changed for the LAN Base half

Refusing `no switchport` on a box without `l3-forward` would be the honest model of "the LAN Base set does not
support this pair", and the evidence for *that rule* is good: two vendor books state it, one hardware capture
shows the refusal, and the 2960's routing is SVI-only in the vendor's own words. Two things stop it:

* **The sentence is not known.** The 3750X answered `Command rejected: not allowed on this interface.`; a
  platform whose parser lacks the word answers `% Invalid input detected at '^' marker.`; the 2960 family book
  says the positive form "is not used". Picking one and printing it as the vendor's words would be a guess
  dressed as a quotation, which is the failure this repo's refusal style exists to avoid.
* **The command is load-bearing here.** Bare `no switchport` is the only command that resets a whole port in this
  console (docs/CLI.md, "`no switchport …` removes one leaf"), and 285 of the catalogue's 423 switches have no
  `l3-forward`. Gating it would take the reset away from two thirds of the catalogue on the strength of a sentence
  nobody has transcribed. A replacement would have to land in the same change, which makes it its own run.

## What remains unresolved

1. **What a LAN Base 2960/2960-X answers to `no switchport`, word for word** - the apply-time sentence, the parse
   error, or silence with the port unchanged. The 2960-XR (IP Lite) accepts the pair, so a capture has to name the
   image, not the model.
2. **Whether bare `switchport` erases a configured port's Layer 2 settings on a real box.** The 9300 book says a
   mode change in either direction "might" lose the previous configuration. If a box does erase when the port is
   already in Layer 2 mode, this console's no-op is wrong in the other direction.
3. **Whether the pair is present at all on LAN Lite**, the third image on that chassis, which no document in the
   evidence above mentions.
4. **Whether one thread's claim that "in version 15.2(7) `no switchport` is already supported"** on a 2960-X is a
   release note someone read or a guess. If it is real, the rule is release-dependent, and a per-image capability
   in the catalogue would need `l3-forward` plus a release, which the device schema has no field for.
5. **What the console should do about `switchport ?`**, which still answers `% Unrecognized switchport command:
   ?` - the help key quoted back as a word. That is the same class of defect this run fixed for the bare form, and
   it was left alone to keep the change to one question.

## What would settle it

* **One console capture per image, on the same command sequence**: `show version` (for the image line), `show
  interfaces switchport` and `show running-config interface <port>` before, typed `switchport` and `no switchport`,
  and both views after. Four images settle it: 2960 LAN Lite, 2960/2960-X LAN Base, 2960-XR IP Lite, and one
  Catalyst that was born L3 (9300/9200) as the control.
* **The feature-set comparison tables** Cisco publishes per platform ("LAN Base", "IP Lite"), which state routed
  ports as a feature per image. That would let the catalogue carry the fact per model instead of the engine
  inferring it from `l3-forward`, which is a proxy: an L3 switch and a router both have it, and only one of them
  has a port that can leave Layer 2.
* **A 2960 capture of the pair succeeding**, if the 15.2(7)E claim holds - which would turn the rule from
  platform-dependent into release-dependent, and make the note's second verdict the wrong shape.

## What this changes for the reader of a lab

A 2960 lab that types `no switchport` to build a routed port now gets the same reset this console always gave, and
the reset is what a box with routed ports does to the port's Layer 2 configuration. What the console still cannot
tell the reader is that on *this* model the pair may not exist at all. `research/ip-address-on-l2-port.md` records
the other half of the same problem - an `ip address` on an L2 switchport, which this console accepts and never
answers for - and both notes point at the same missing catalogue fact: which ports of which models can stop being
switchports.
