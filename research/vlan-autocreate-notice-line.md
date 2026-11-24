# The auto-create notice on `switchport access vlan`: one line, or two

**Question (one, narrow).** A switch that is handed `switchport access vlan 22` when VLAN 22 has never
existed prints an error and creates the VLAN anyway. How many *lines* does the box use for that: one
`% Access VLAN does not exist. Creating vlan 22`, or the sentence broken after `exist.` with
`Creating vlan 22` starting at the left margin on the next line?

**Verdict: one line, and adopted.** Cisco's own transcripts print the whole thing on one line, and the
two-line form this console printed until now is a *renderer's* wrap that got transcribed as if it were the
box's newline - the same sentence comes back from a search snippet broken after `exist.` and from the
document's own text layer unbroken. The console now prints one line; the evidence and the reason the pair
looked plausible for as long as it did are below.

## The device's own output

Catalyst 9300, *Layer 2 Configuration Guide, Cisco IOS XE 17.14.x*, "Example: Configuring an IEEE 802.1Q
Tunneling Port" - the code block as the page serves it, whose other lines are each their own line, so the
block is not re-flowed:

```
Device(config)# interface gigabitethernet1/0/7
Device(config-if)# switchport access vlan 22
% Access VLAN does not exist. Creating vlan 22
Device(config-if)# switchport mode dot1q-tunnel
Device(config-if)# exit
Device(config)# vlan dot1q tag native
```

(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-14/configuration_guide/lyr2/b_1714_lyr2_9300_cg/configuring_ieee_802_1q_tunneling.html>)

Catalyst 9500, *17.12* chapter of the same name, read out of the PDF's **text layer** rather than out of a
rendered page: the line is one line there too, and its neighbours on the page run past 90 characters, so the
extraction is not wrapping short.

(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/17-12/configuration_guide/lyr2/b_1712_lyr2_9500_cg/configuring_ieee_802_1q_tunneling.pdf>)

## Where the two-line form comes from

Search the same sentence and it comes back as two lines, in this shape and in every reproduction of this
example that a search engine excerpted:

```
% Access VLAN does not exist.
Creating vlan 22
```

Three things say that break is the excerpting, not the box:

1. **The same document yields both forms.** The 9500 PDF is one line in its text layer and two lines in the
   search snippet of the same URL. So does a third-party page: `m-suta.com`'s VLAN/routed-port walkthrough
   shows `% Access VLAN does not exist.` / `Creating vlan 10` in a snippet and
   `% Access VLAN does not exist. Creating vlan 10` in the page's own body
   (<https://m-suta.com/zitakulab-ciscokensho-vlan-routed/>).
2. **The break cannot be the terminal.** It lands after `exist.` in every two-line rendition regardless of
   the prompt in front of the command - `Device(config-if)#` (22 columns), `S1(config-if)#` (15),
   `Sw(config-if)#` (17) - and the whole sentence is 43 characters, far inside the 80 columns an IOS console
   uses. A terminal wrap would have to fall at the same *column*; these all fall at the same *word*.
3. **The `%` covers the whole sentence.** The notice is part of the error the box raises while the command
   is being applied ("If you assign an interface to a VLAN that does not exist, the new VLAN is created" -
   *Software Configuration Guide, Cisco IOS Release 15.2(2)E (Catalyst 2960 ...)*, "Assigning Static-Access
   Ports to a VLAN", <https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-2_2_e/configuration/guide/b_1522e_2960_2960c_2960s_2960sf_2960p_cg/m_1522e_vlan_vlan_2960s_cg.html>).
   A message that begins `%` and continues, unprefixed, two lines later would be a second message with no
   prefix - and the Cisco small-business CLI guide's wording for the same behaviour is a single sentence in
   the same shape ("If the VLAN does not exist, it is created", *Catalyst 1200/1300 CLI Guide*, VLAN
   Commands, <https://www.cisco.com/c/en/us/td/docs/switches/campus-lan-switches-access/Catalyst-1200-and-1300-Switches/cli/C1200-cli/vlan-commands.html>).

The transcripts that made the pair look real are all excerpt-shaped: the NetAcad 3.2.2.5 lab PDF, the
ccnacookbook "Router On A Stick" lab PDF, the Cisco Learning Network thread *VLAN Switch Port Mode Access*
(<https://learningnetwork.cisco.com/s/question/0D53i00000Ksye3CAB/vlan-switch-port-mode-access>), a Netmiko
discussion where a user quotes the message mid-sentence
(<https://github.com/ktbyers/netmiko/discussions/3304>), and several CCNA blogs. Each shows the break at
`exist.`, which is one wrap width, not one device's cursor.

## What is inferred, and what is not

* **Inferred, and now modelled:** the box prints one line. The console's own receipt (`Access VLAN 22 on
  Gi1/0/1`) still follows it, because that line is this console's voice for every write
  (`docs/CLI.md`, "The first member creates the interface"), not the vendor's.
* **Not inferred, deliberately:** that every `% ... Then something else` pair in the corpus is one line. The
  EtherSwitch router's refusal is genuinely two *messages* - `%Access VLAN 12 does not exist.` and
  `Please add it to vlan database` - and the second is a sentence of its own, not the tail of the first
  (`research/vlan-on-a-router.md`). The rule adopted here is about this sentence, not about every pair.
* **Not claimed:** that the VLAN is always created. The same command on a box whose extended-VLAN path is
  refused prints a different message entirely (`research/extended-vlan-creation-vtp.md`).

## What was changed

* `engine/cli.js` - `switchport access vlan <n>` on a VLAN that does not exist prints
  `% Access VLAN does not exist. Creating vlan <n>` as one line, then the console's receipt. The citation at
  the call site now names the 9300 17.14 and 9500 17.12 transcripts and says why the two-line form was
  believed.
* `test/vlan-auto-create.test.js` - the first assertion is now the whole sentence, and the replay test's
  "this `%` line is information, not a rejection" filter matches the one-line form (15 checks).
* `test/switchport-mode.test.js` (32 checks), `test/switchport-negation.test.js` (46 checks),
  `test/config-roundtrip.test.js` (47 checks) - the same constant and comment corrected where they exempt
  the auto-create notice during a config replay.

## What would settle what is left

1. One **raw** session log - `terminal length 0`, a paste into a file rather than a blog - of
   `switchport access vlan 22` on a 2960/9300 in a VLAN-less config. Every capture found here is either a
   vendor document (authoring tool, not a terminal) or a hand-retyped page, and that is the one gap: no byte
   capture exists in this evidence set.
2. The 12.2-era wording. The two 17.x guides above agree with each other, but the 12.2(52)SE 3750 chapter
   this console used to cite could not be re-read at its text layer (the page 404s and the PDF extraction
   returns only the chapter's front matter), so whether a 2008 box broke the sentence is unverified - and
   Packet Tracer, which is not the target, is widely reported to print it as two.
