# `show interfaces <port> trunk`: the `Status` word when the port is not trunking

**Question (one, narrow).** Section 1 of `show interfaces <port> trunk` has a `Status` column. When the named
port is *not* trunking, what word does that column carry — `not-trunking` (as the Catalyst 9600 17.7 reference
prints) or `other` (as the 3850/9200/9300 references print) — and what decides between them?

`research/show-interfaces-trunk-shape.md` recorded this as **contradictory** and told step 2 of
`docs/plans/interfaces-trunk-view.md` not to print either candidate until a capture landed. This note brings
five captures from real boxes and answers it.

**Verdict: the two words are not rival spellings of one state — they partition it by operational state, and
every capture in hand fits one partition.**

- `trunking` — the port is an operational trunk.
- `not-trunking` — the link is **up** and the port is not trunking (static access, `off`, or a dynamic mode
  that did not negotiate a trunk).
- `other` — the link is **not up** (no cable / `notconnect`), so there is no operational trunking state to
  report, even though the port is administratively a trunk.

No vendor field table defines any of the three words; they are observed, not documented, which is why the
references disagree — each one pasted a sample from a different port state.

## The captures

### Link down, configured trunk, `other`

Cisco Learning Network, "show interface trunk status other" (Catalyst 3550, `switchport mode trunk`, cables
never run). The asker states the port state in the same post — *"Trunk failed to establish and interface
status is down/down (notconnect)"* — and prints:

```
Cat3550#show interfaces trunk
Port      Mode         Encapsulation  Status        Native vlan
Fa0/17  trunk    802.1q         other      1
Fa0/18  trunk    802.1q         other      1
Fa0/19  trunk    802.1q         other      1

Port      Vlans allowed on trunk
Fa0/17     1-4094
...
Port      Vlans allowed and active in management domain
Fa0/17     1-3,10
```

<https://learningnetwork.cisco.com/s/question/0D53i00000Kst6jCAB/show-interface-trunk-status-other>

Two facts worth keeping: the word is `other` on a **down** port whose administrative mode is trunk, and the
three VLAN blocks below still print their rows (`1-4094`, `1-3,10`) — a down port is not hidden from sections
2-4, only from the no-argument form (which lists operational trunks only).

The same case appears twice on r/Cisco and r/ccnp, with the port configured `switchport mode trunk` and
nothing plugged in: `Te1/0/1  on  802.1q  other  1` and `Gi1/0/2  on  802.1q  other  3`
(<https://www.reddit.com/r/Cisco/comments/1ach7j3/trunk_ports_are_not_being_configured_properly/>,
<https://www.reddit.com/r/ccnp/comments/pphz1k/configuring_switchports_as_trunk_properly/>).

### Link up, not trunking, `not-trunking`

Cisco Community, "Native VLAN mismatch discovered on switch" (Catalyst 2950, IOS 12.2). `Fa0/2` is
`switchport mode access` — the poster's own `show interfaces fa0/2 switchport` reads *Administrative Mode:
static access / Operational Mode: static access / Negotiation of Trunking: Off* — and CDP is exchanging
native-VLAN mismatch messages in **both** directions, so both ports are up:

```
switch#show interfaces fastEthernet 0/2 trunk
Port Mode Encapsulation Status Native vlan
Fa0/2 off 802.1q not-trunking 1
Port Vlans allowed on trunk
Fa0/2 2
...

switch#show interfaces fastEthernet 0/21 trunk
Port Mode Encapsulation Status Native vlan
Fa0/21 desirable 802.1q not-trunking 1
Port Vlans allowed on trunk
Fa0/21 1
```

<https://community.cisco.com/t5/routing/native-vlan-mismatch-discovered-on-switch/td-p/873374>

So an **up** port that is not trunking reads `not-trunking`, and the Mode cell for a static access port is
`off` — not `static access`, which is the same port's *Administrative Mode* in `show interfaces switchport`.

The same partition appears in Cisco's ISL support document: two live switches cabled together with DTP modes
that cannot form a trunk read `not-trunking`, and the page is explicitly about a link that is *"not
trunking"* rather than absent:

```
Switch-A#show interfaces fastethernet 2/1 trunk
Port Mode Encapsulation Status Native VLAN
Fa2/1 desirable negotiate not-trunking 1
Port VLANs allowed on trunk
Fa2/1 none
```

<https://www.cisco.com/c/en/us/support/docs/switches/catalyst-6000-series-switches/10682-2.html>

(Two incidental finds in that sample: `Encapsulation` can read `negotiate` when nothing is hard-set, and the
older IOS spells `switchport mode trunk` in the Mode column as `trunk`, which the 3550 capture above also
does. `on` is the current spelling.)

### Link up, trunking, `trunking`

A reply in the same CLN thread, two 2960-class switches cabled together with `switchport mode trunk`:

```
Switch#sh int trunk
Port        Mode             Encapsulation  Status        Native vlan
Fa0/15      on               802.1q         trunking      1
```

and the IOS XE Interface and Hardware Component Command Reference prints the negotiated-ISL form of the same
word: `Fa5/9 desirable n-isl trunking 1`
(<https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-s4.html>).

### The two command-reference samples, re-read

The pair that looked contradictory is consistent with the same rule once the rest of each sample is read:

| Reference | Row | Sections 2-4 | Reading |
| --- | --- | --- | --- |
| [Catalyst 9600 17.7 CR](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/17-7/command_reference/b_177_9600_cr/interface_and_hardware_commands.html) | `Fo6/0/4 auto 802.1q not-trunking 1` | `1` in all three | port up (forwarding VLAN 1), not trunking |
| [Catalyst 9300 17.15 CR](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-15/command_reference/b_1715_9300_cr/interface_and_hardware_commands.html) | `Gi1/0/1 on 802.1q other 10` | `none` in all three | nothing forwarding, administrative trunk |

`not-trunking` with VLAN 1 in the spanning-tree-forwarding block is an **up** port; `other` with every list
`none` is a port with nothing to report. The references are not disagreeing about the word; they are showing
two different port states.

## What is still not distinguishable

Two mechanisms produce exactly the observations above, and no capture in hand separates them:

1. **operational state** — up + not trunking -> `not-trunking`; not up -> `other`;
2. **administrative mode** — a port configured as a trunk (`on`/`trunk`) that is not operational -> `other`;
   anything else not trunking -> `not-trunking`.

Every capture above fits both. The state that would separate them — a port that is **up**, configured
`switchport mode trunk`, and not trunking — is nearly unreachable on a real box, because IOS documents that
mode as *"puts the interface into permanent trunking mode ... The interface becomes a trunk interface even if
the neighboring interface is not a trunk interface"* (2960-X VLAN configuration guide,
<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_2_e/vlan/configuration_guide/b_vlan_1522e_2960x_cg/b_vlan_152ex_2960-x_cg_chapter_0100.html>).
The nearest reachable case is `switchport mode trunk` + `switchport nonegotiate` facing `dynamic auto`, which
no capture here covers.

What would settle it: `show interfaces <port> trunk` on (a) that nonegotiate/auto pair with the link up, and
(b) a `dynamic auto` port with no cable — the second alone would falsify rule 1 if it printed
`not-trunking`, since it is down.

**For this engine the distinction does not matter**: there is no DTP, so the reachable states are exactly
link up + trunk configuration (trunking), link up + access (not trunking), and link down. Both readings give
the same word for all three, so step 2 can implement either without inventing a state.

## What PacketForge prints today

Nothing — measured on this commit, `generic-switch`, `Fa0/1` configured `switchport mode trunk` +
`switchport trunk allowed vlan 10,20`, cabled to a second switch with the same configuration:

```
sw1# show interfaces trunk
% `trunk` is a view, not a port: this console has no `show interfaces trunk`. `show vlan brief` names each
  VLAN's ports, and `show interfaces <port>` prints the port's trunk settings.

sw1# show interfaces Fa0/1 trunk
% `show interfaces Fa0/1 trunk` is a view of Fa0/1, not a port name: this console has no
  `show interfaces Fa0/1 trunk`. ...
```

No engine code changed: the view does not exist, and step 2 is a new view that needs approval
(`docs/plans/interfaces-trunk-view.md`). This note settles the one rule that step 2 was blocked on.

## What step 2 should print (the rules this note adds)

1. `Status` is `trunking` when the port's link is up and it is trunking; `not-trunking` when the link is up
   and it is not; `other` when the link is not up. A port that is shut or uncabled and configured as a
   trunk is still listed by the **named** form, with `other`.
2. The Mode cell is the trunk mode, not the switchport administrative mode: `on` for a configured trunk
   (current IOS), `auto`/`desirable` for the dynamic modes, `off` for a static access port. `static access`
   belongs to `show interfaces switchport` and must not appear here.
3. A port that appears in section 1 appears in sections 2-4 as well, even when its link is down (the 3550
   capture prints `1-4094` / `1-3,10` for three `notconnect` ports).
4. `Encapsulation` is a plain `802.1q` here; `n-802.1q` and `negotiate` are negotiated/unset states this model
   cannot be in, so neither may be printed (unchanged from the shape note).

## Still open

| question | state | evidence that would settle it |
| --- | --- | --- |
| up + administrative trunk + not trunking (nonegotiate vs auto) | **unresolved.** Both mechanisms fit every capture | a capture of that pair, plus `show interfaces <port> switchport` for operational mode |
| word for an **administratively down** port | **unresolved.** No capture; assumed to follow "not up" | `show interfaces <port> trunk` on a shut trunk port |
| word for an **err-disabled** trunk (BPDU guard, port-security) | **unresolved.** Link is up, forwarding is not | a capture of the same command on an err-disabled port |
| whether `other` is a fourth meaning ("unknown") on any platform | **unresolved.** Only the two states above are witnessed | a third state producing `other` with the link up |
