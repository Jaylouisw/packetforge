# `show interfaces trunk` — the four blocks, where each column starts, and which ports appear

**Question (one, narrow).** When a Cisco-style switch is asked `show interfaces trunk` with no interface
named, which ports does it list, and what exactly does the table print — the four blocks, the header cells and
the column they start at, and what a row says when one of its lists is empty?

This is step 1 of `docs/plans/interfaces-trunk-view.md` ("capture the shape, research only"). It closes no
issue and changes no engine code: step 2 of that plan is a new view and needs Jay's approval.

**Verdict.** The *which ports* half is settled by a vendor sentence, and it is not "every port configured as a
trunk": **only ports that are operationally trunking are listed**, and a switch with none answers with no
output at all — not an empty header. The *shape* half is settled for a trunking port by two IOS XE command
references whose spacing survives extraction, and they agree on every column start; a named interface is a
different question and prints the four blocks even when the port is not trunking. Two things are **not**
settled: the word in the `Status` column for a named but non-trunking port (`not-trunking` in one reference,
`other` in three others, the same sample carried forward), and whether a long VLAN list wraps.

## The shape, character for character

Catalyst 9300 command reference, IOS XE 17.15, `show interfaces` → `trunk`
(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-15/command_reference/b_1715_9300_cr/interface_and_hardware_commands.html>):

```
Device# show interfaces gigabitethernet1/0/1 trunk

Port        Mode             Encapsulation  Status        Native vlan
Gi1/0/1     on               802.1q         other         10

Port        Vlans allowed on trunk
Gi1/0/1     none

Port        Vlans allowed and active in management domain
Gi1/0/1     none

Port        Vlans in spanning tree forwarding state and not pruned
Gi1/0/1     none
```

Catalyst 9600 command reference, IOS XE 17.7, same page
(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/17-7/command_reference/b_177_9600_cr/interface_and_hardware_commands.html>) —
same width, different word in `Status`:

```
Device# show interfaces FortyGigabitEthernet6/0/4 trunk

Port        Mode             Encapsulation  Status        Native vlan
Fo6/0/4     auto             802.1q         not-trunking  1

Port        Vlans allowed on trunk
Fo6/0/4     1

Port        Vlans allowed and active in management domain
Fo6/0/4     1

Port        Vlans in spanning tree forwarding state and not pruned
Fo6/0/4     1
```

Four blocks, each preceded by one blank line, no blank line between rows, and nothing after the last row. The
section headers reuse the same 12-wide `Port` field as block 1 (`Port` + eight spaces), which is why they start
at column 12 and not at a width of their own.

## Widths: two published layouts, one of them current

| field | IOS XE starts at | width | older 12.2 starts at | width |
| --- | --- | --- | --- | --- |
| Port | 0 | 12 | 0 | 10 |
| Mode | 12 | 17 | 12 | 13 |
| Encapsulation | 29 | 15 | 25 | 15 |
| Status | 44 | 14 | 40 | 14 |
| Native vlan | 58 | — | 54 | — |

The XE numbers come from the two transcripts above (the header is 69 columns; a row stops after the native
VLAN, so `Gi1/0/1     on               802.1q         other         10` is 60, not 69). The older layout is the
Catalyst 4500 12.2(25)SG configuration guide
(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/25sg/configuration/guide/conf/layer2.pdf>),
whose transcript also shows the `Mode` values that need the narrower field:

```
Port      Mode         Encapsulation  Status        Native vlan
Fa5/8     desirable    n-802.1q       trunking      1
Port      Vlans allowed on trunk
Fa5/8 1-1005
```

Note the trap in that one: its section-2 row is `Fa5/8 1-1005` with a single space, and its section header is
ten wide, so reproducing *that* document character for character would misalign every VLAN list. Two
generations of IOS XE references agree with each other on 12/17/15/14, and they are the ones that agree on the
section headers too, so the XE form is the one to pin. (The same choice — IOS XE wording over the older 6500
form — was already made for the `show etherchannel summary` legend.)

`Native vlan` is a bare VLAN number; no transcript in hand prints the VLAN's name in that column.

## Which ports appear

The command reference states it in the keyword description, verbatim: *"trunk (Optional) Displays interface
trunk information. If you do not specify an interface, only information for active trunking ports appears."*
(9300 17.15, and the 9600 17.7 reference repeats it word for word.)

A Cisco Learning Network thread confirms the operational consequence from a lab, in the asker's own words:
*"the show interface trunk command will just give info if there is at least one interface with trunking
establish, even if you configued some of the interfaces as trunk and the trunking hasn't got established you
wont get nothing"* — the port was configured as a trunk but had no cable, and
`show interfaces <port> switchport` reported *Operational Mode: down* while
`show interfaces trunk` printed nothing at all
(<https://learningnetwork.cisco.com/s/question/0D53i00000Kt0NxCAJ/show-interfaces-trunk>).

So all four of these are absent from the table even though each is a configured trunk:

- a trunk whose port is administratively down;
- a trunk with no cable (`notconnect`);
- a trunk whose far end never negotiated (both ends `dynamic auto`);
- a member port of a port-channel (see below — only the port-channel is listed).

And the answer when nothing is trunking is **no output**, not a header with no rows. That is inferred from the
thread above plus three independent teaching captures that treat "empty output" as the symptom of a trunk that
never formed; no vendor document states it. It is the one shape rule here that a capture would still improve.

By contrast, **naming an interface prints the blocks regardless**: both CR transcripts above are
`show interfaces <if> trunk` on a port that is *not* trunking (`other`, `not-trunking`) and both print all four
headers. So the filter is on the no-argument form only, and it is a filter on operational state, not on
configuration.

## A cell when the list is empty: `none`

`none` is a per-cell word in each of the three VLAN blocks, not a suppression of the row and not a blank:

```
Port        Vlans allowed on trunk
Gi1/0/1     none
```

with, in the same answer, a different row carrying a real list. A CCNA walkthrough of
`switchport trunk allowed vlan remove 5` prints exactly that mix — allowed `1-4,6-1005`, active `1,10`, and
`Fa0/1 none` under *Vlans in spanning tree forwarding state and not pruned*
(<https://study-ccna.com/configuring-allowed-vlans/>). The 9300 sample is the degenerate case where all three
lists are empty; the study-ccna one is the proof that `none` is produced list by list.

## Port-channels: `Po1` is the row, its members are not

Real IOS lists the logical interface and not its members. Two independent walkthroughs say so in as many
words — *"only the port-channel interface is listed, the physical interfaces do not appear at all in the output
of this command"*
(<https://itnetworkingskills.wordpress.com/2023/07/10/configure-verify-etherchannel-lacp-pagp/>, from Jeremy's
IT Lab's capture), and a second capture of the same command with the same conclusion
(<https://netstuts.com/StepbyStepTut/etherchannel-lacp>), whose table reads `Po1 on 802.1q trunking 999` over
the allowed list `10,20,30`.

**Packet Tracer disagrees, and it is worth writing down so nobody "fixes" this later from the wrong source.**
The NetAcad Packet Tracer lab 6.2.4 shows four member ports *and* `Po1` in the same table after the bundle
forms (<https://www.netacad.com/content/srwe/1.0/courses/content/m6/en-US/assets/6.2.4-packet-tracer---configure-etherchannel.pdf>),
and a 3560 lab guide prints `Fa0/7`-`Fa0/10` alongside `Po1`
(<https://studylib.net/doc/8112635/lab-3-5-configuring-etherchannel>). PacketForge's stated reference is real
device behaviour, so the IOS rule wins and the simulator's row set is `Po<N>` only.

## The `n-` in the Encapsulation column

`802.1q` and `n-802.1q` are different claims: the prefix means the encapsulation was **negotiated** rather than
configured. A Catalyst 4500 transcript pairs `desirable` with `n-802.1q` while `on` pairs with plain `802.1q`
(4500 12.2(25)SG guide above); a Learning Network thread states the rule from lab work — *"The 'n' simply means
the encapsulation type was negotiated because it was not explicitly set"* — and narrows it usefully: it is the
side that did not have `switchport trunk encapsulation dot1q` hard-set that shows the `n-`, even when both ends
are negotiating the trunk itself
(<https://learningnetwork.cisco.com/s/question/0D53i00000KswiXCAR/trunk-negotiation-output-with-desirable-and-auto-mode>).
Both modern XE samples show `on` + `802.1q`, consistent with that rule.

The ISL form is `n-isl`, seen in the VTP migration example where four ports in `auto`/`desirable` all read
`n-isl` or `n-802.1q` (<https://cisco.com/c/en/us/support/docs/lan-switching/vtp/81682-vtp-migration.pdf>).

## What PacketForge prints today

Measured on `be18b65d`, `generic-switch`, `Fa0/1` configured `switchport mode trunk` +
`switchport trunk allowed vlan 10,20`, no cable:

```
Switch# show interfaces trunk
% `trunk` is a view, not a port: this console has no `show interfaces trunk`. `show vlan brief` names each VLAN's ports, and `show interfaces <port>` prints the port's trunk settings.

Switch# show interface Fa0/1 trunk
% `show interfaces Fa0/1 trunk` is a view of Fa0/1, not a port name: this console has no `show interfaces Fa0/1 trunk`. ...
```

That refusal is truthful and stays truthful until the view exists, which is why this note does not touch
`engine/cli.js`. Note what it also shows: this model already holds a *configured* trunk that is not *trunking*
(`show interfaces Fa0/1` prints `switchport: trunk · native 1 · allowed 10,20` with `status: down (no cable)`),
so the future view cannot be built by walking `iface.vlan.mode === 'trunk'` alone — the port filter is the
link-state question above, and it would drop this port from the table exactly as a box does.

## What this note does not settle

| question | state | evidence that would settle it |
| --- | --- | --- |
| `Status` word for a named port that is not trunking | **contradictory.** `not-trunking` (9600 17.7) vs `other` (3850 16.12, 9200 17.9, 9300 17.15 — one sample copy-pasted across three references, so not three witnesses) | one `show interfaces <shut-or-DTP-pending-trunk> trunk` capture from a real box, plus one from a routed port |
| does a long allowed list wrap, and at what width/indent | **unresolved.** One community capture prints a ~200-character allowed list on a single line with no wrap (<https://community.cisco.com/t5/switching/show-intferaces-trunk-command/m-p/1322816>); no capture found at a narrow terminal | a capture on an 80-column session with >20 VLANs allowed, plus the same on `show vlan`'s Ports column for comparison |
| is "no output" literal (zero bytes) when nothing trunks | **inferred-high** from the CR sentence and three teaching captures; no direct vendor statement | `show interfaces trunk` on a factory-default switch, `wc -c` |
| section-header field width in older IOS (10 vs 12) | **doc noise.** The 12.2 4500 guide is internally inconsistent (10-wide section 2 header, single-spaced row); XE references agree on 12 | a preserved-space capture from a 12.2 box |
| whether a member of a port-channel ever appears as a row | **settled for IOS, contradicted by Packet Tracer** (see above) | nothing further needed; the PT divergence is a product difference, not ambiguity |
| does a non-Cisco vendor print this shape at all | **out of scope and not the same command.** Arista EOS has a `show interfaces trunk` with three header columns (`Port Mode Status Native vlan`) and different section titles (<https://www.arista.com/en/um-eos/eos-virtual-lans-vlans>); Nexus prints a boxed table with a `Port Channel` column | a decision about which platform a catalogue entry claims to be, not more evidence |

## If step 2 is approved, the rules this note pins

1. No argument: one row per port whose operational state is trunking, in port order; nothing else.
2. Nothing trunking: no output at all (no header, no blank line) — flagged inferred until captured.
3. One named interface: the four blocks are printed even when the port is not trunking.
4. Header starts: `Port` 0, `Mode` 12, `Encapsulation` 29, `Status` 44, `Native vlan` 58; rows stop after the
   native VLAN.
5. Each of blocks 2-4 is preceded by a blank line, is headed by `Port` + eight spaces + the section title, and
   prints one row per port already listed in block 1.
6. An empty list is the cell word `none`, per row per block, never a suppressed row.
7. `Mode` is the administrative mode (`on`, `auto`, `desirable`); `Status` is the operational word, and which
   word a non-trunking named port gets is the open question above — do not print either candidate until a
   capture lands.
8. `Encapsulation` is `802.1q` when hard-set; the `n-` prefix belongs to a negotiated encapsulation and this
   model has no DTP, so no `n-` can be honest here yet.
9. A port-channel is one row named `Po<N>`; members never get rows of their own.
10. `Native vlan` is a number, never a VLAN name.

## Sources

- Catalyst 9300 CR 17.15, Interface and Hardware Commands — keyword sentence and the `other` sample:
  <https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-15/command_reference/b_1715_9300_cr/interface_and_hardware_commands.html>
- Catalyst 9600 CR 17.7, same page — the `not-trunking` sample:
  <https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/17-7/command_reference/b_177_9600_cr/interface_and_hardware_commands.html>
- Catalyst 3850 CR 16.12 and Catalyst 9200 CR 17.9 — the same `other` sample, evidence that it is boilerplate:
  <https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3850/software/release/16-12/command_reference/b_1612_3850_cr/interface_and_hardware_commands.html>,
  <https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-9/command_reference/b_179_9200_cr/interface_and_hardware_commands.html>
- Catalyst 4500 12.2(25)SG configuration guide — older widths, `desirable` + `n-802.1q`:
  <https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/25sg/configuration/guide/conf/layer2.pdf>
- Cisco VTP migration example 81682 — `auto`/`desirable` + `n-isl`/`n-802.1q`, four-row table:
  <https://cisco.com/c/en/us/support/docs/lan-switching/vtp/81682-vtp-migration.pdf>
- Cisco inter-VLAN routing example 41260 — the four sections on a 3850 with active trunks:
  <https://www.cisco.com/c/en/us/support/docs/lan-switching/inter-vlan-routing/41260-189.html>
- Cisco 802.1Q trunking example 10599-88 — 3560 and 6500 transcripts, and the note that trunk ports are absent
  from `show vlan`:
  <https://www.cisco.com/c/en/us/support/docs/switches/catalyst-6000-series-switches/10599-88.html>
- Cisco Learning Network — empty answer until a trunk is established:
  <https://learningnetwork.cisco.com/s/question/0D53i00000Kt0NxCAJ/show-interfaces-trunk>
- Cisco Learning Network — what the `n-` prefix means:
  <https://learningnetwork.cisco.com/s/question/0D53i00000KswiXCAR/trunk-negotiation-output-with-desirable-and-auto-mode>
- Community capture with a ~200-character allowed list on one line:
  <https://community.cisco.com/t5/switching/show-intferaces-trunk-command/m-p/1322816>
- study-ccna — per-row `none` while other lists are populated:
  <https://study-ccna.com/configuring-allowed-vlans/>
- Real-IOS port-channel captures (only `Po1`): <https://itnetworkingskills.wordpress.com/2023/07/10/configure-verify-etherchannel-lacp-pagp/>,
  <https://netstuts.com/StepbyStepTut/etherchannel-lacp>
- Packet Tracer divergence (members + `Po1`):
  <https://www.netacad.com/content/srwe/1.0/courses/content/m6/en-US/assets/6.2.4-packet-tracer---configure-etherchannel.pdf>,
  <https://studylib.net/doc/8112635/lab-3-5-configuring-etherchannel>
- Arista EOS `show interfaces trunk` — a different shape under the same name:
  <https://www.arista.com/en/um-eos/eos-virtual-lans-vlans>
