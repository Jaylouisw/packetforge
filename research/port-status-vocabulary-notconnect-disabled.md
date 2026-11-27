# `notconnect` or `disabled`: the word a Catalyst uses for a dead port, and which view says it

**Question (one, narrow).** A port can be dead in two ways this console already tells apart — enabled with
nothing plugged in, or shut down by hand. When the box describes those two ports, does it ever use the
word `down`, or does it use `notconnect` and `disabled` — and which of its three status views uses which
word?

This asks only for the *vocabulary*, not for any view this console lacks: `show interfaces status` is
refused here and stays refused until somebody builds it, and no plan for it exists yet —
`docs/plans/interfaces-trunk-view.md` is the neighbouring view and `research/show-interfaces-trunk-shape.md`
its evidence. The vocabulary matters before the view exists, because two of the three answers are already
printed by code that is in the tree.

**Verdict: `down` is the word of exactly one of the three views — `show ip interface brief` — and the other
two use `notconnect` / `disabled`. The `show interfaces` parenthetical is the status view's word, borrowed,
and it is image-dependent: the 2960 command reference prints the bare line, the Catalyst 1000 / 4500
references and every live capture in hand print the parenthetical.**

| The port is... | `show interfaces status`, `Status` cell | `show interfaces <port>`, line 1 | `show ip interface brief` |
| --- | --- | --- | --- |
| up/up | `connected` | `is up, line protocol is up (connected)` | `up` / `up` |
| enabled, no link | `notconnect` | `is down, line protocol is down (notconnect)` | `down` / `down` |
| shut down | `disabled` | `is administratively down, line protocol is down (disabled)` | `administratively down` / `down` |
| err-disabled | `err-disabled` (cause in the `err-disabled` form) | `is down, line protocol is down (err-disabled)` | `down` / `down` |
| an SVI, shut down | *not listed — the view is physical ports only* | `Vlan34 is administratively down, line protocol is down` — **no parenthetical** | `administratively down` / `down` |

So the reason word never appears in the brief table: `down`/`down` is what a real box prints for "no cable",
and this console is already right to print exactly that. The vocabulary lives in the two views PacketForge
does not have, and in a parenthetical this console's `show interfaces` block does not use because that block
is not IOS-shaped at all.

## The captures

### One lab, both faults, on a 2960

iTechVista's CCNA lab shuts a port down and then turns the far-end NIC off, reading the same two commands
each time. The four strings are on one page, from one image
(<https://itechvista.com/blogs/cisco-ccna-labs/read-a-switch-port-s-status-line-to-find-a-shut-port-a-dead-nic-a-duplex-mismatch-and-a-speed-mismatch>):

```
S1# show interfaces status
Port Name Status Vlan Duplex Speed Type
... Fa0/1 and Fa0/24 read `connected` and every other port reads `notconnect`
S1(config)# interface fa0/1
S1(config-if)# shutdown
S1# do show interfaces status        ->  Fa0/1 reads `disabled`
S1# do show interfaces fa0/1         ->  FastEthernet0/1 is administratively down, line protocol is down (disabled)
S2# show interfaces fa0/1            ->  FastEthernet0/1 is down, line protocol is down (notconnect)
S1# show interfaces fa0/24           ->  FastEthernet0/24 is up, line protocol is up (connected)
```

The page's own prose is the rule in one sentence: "`administratively down` only ever comes from the
`shutdown` command"; "notconnect means no link signal".

### The same three words, independently, from an IOS XE box

A scripted `sh int | in down` sweep pasted on r/Cisco (mixed chassis, one session) prints the same three
strings side by side, including the one place `down` still appears — an SVI
(<https://www.reddit.com/r/Cisco/comments/s7rrgd/port_audits/>):

```
Vlan1 is administratively down, line protocol is down , Autostate Enabled
GigabitEthernet1/0/2 is down, line protocol is down (notconnect)
GigabitEthernet1/1/2 is administratively down, line protocol is down (disabled)
```

Line two is the word this note is about; line one is the SVI exception *and* a suffix no other capture
carries (` , Autostate Enabled`, with the space before the comma).

### An SVI has no parenthetical, and the status view has no SVI

pinglabz's SVI field guide shuts a physical port down and then an SVI on the same switch
(<https://www.pinglabz.com/fixing-cisco-vlan-interface-down.md>):

```
SW1#show interfaces GigabitEthernet1/1
GigabitEthernet1/1 is administratively down, line protocol is down (disabled)
SW1#show interfaces Vlan34
Vlan34 is administratively down, line protocol is down
SW1#show interfaces Vlan37
Vlan37 is up, line protocol is up
```

and its `show interfaces status` table lists physical ports only (`Gi1/0/1 User-PC1 disabled 10 a-full
a-1000 10/100/1000BaseTX`). Cisco Press's routed-port chapter says the same in a comment inside the sample
output — "Only ports related to the example are shown; the command lists physical only" — which is the
evidence that an SVI has no row there to carry a word at all
(<https://www.ciscopress.com/articles/article.asp?p=2990405&seqNum=4>).

### The status view's header and its other words

Catalyst 2960 and 2960-S Switch Command Reference, 15.0(1)SE, `show interfaces status`, Examples
(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_1_se/command/reference/cr_2960/cli2.html>):

```
Port Name Status Vlan Duplex Speed Type
Fa1/0/1 connected routed a-half a-100 10/100BaseTX
Fa1/0/2 notconnect 121,40 auto auto 10/100BaseTX
Fa1/0/4 notconnect 18 auto auto Not Present
Gi1/0/2 notconnect 1 auto auto unsupported
```

`Type` prints `Not Present` when nothing is in the cage and `unsupported` for a non-Cisco optic — the
reference states the second in as many words: "A status of unsupported in the Type field means that a
non-Cisco small form-factor pluggable (SFP) module is inserted in the module slot." Two VLAN ids in one cell (`121,40`) are the access VLAN and its voice VLAN, which is the `Vlan` column's business, not this
question's. The Catalyst 4500 reference is the one that prints a shut port in this table —
`Gi1/1 disabled routed full 1000 missing`, `Fa5/1 disabled routed auto auto 10/100BaseTX` — and documents
the err-disabled form separately: "When at least one VLAN on a port is error-disabled the output for the
`show interfaces status` command will display `* vl-err-dis*` in the VLAN column"
(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/XE3-11-0E/command/reference/xe-311-cmd/show1.html>),
whose `err-disabled` header is `Port Name Status Reason Err-Disabled VLANs`.

### Where the parenthetical is missing

Cisco's own 2960 command reference (12.2(44)SE, and the 15.2(1)E 2960-S book's equivalent example) prints
the bare line in its
`show interfaces` example, with the full block around it — the `Hardware is` line is not trimmed, only the
parenthetical is absent:

```
Switch# show interfaces gigabitethernet0/2
GigabitEthernet0/2 is down, line protocol is down
Hardware is Gigabit Ethernet, address is 0009.43a7.d085 (bia 0009.43a7.d085)
```

(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_44_se/command/reference/cr/cli2.html>)
The Catalyst 1000 reference, 15.2(7)E — the same platform family — prints
`GigabitEthernet3/0/2 is down, line protocol is down (notconnect)` for the equivalent port
(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst1000/software/releases/15_2_7_e/command_reference/b_1527e_1000_cr/interface_and_hardware_commands.html>),
<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst1000/software/releases/15_2_7_e/command_reference/b_1527e_1000_cr/interface_and_hardware_commands.html>),
and a live 9500 on IOS XE 17.06.04 printed `HundredGigE1/0/1 is up, line protocol is down (notconnect)`
(recorded in `research/hundredgige-interface-spelling.md`). One more suffix exists for a working port — the
2960 book's TDR example, `is up, line protocol is up (connected: TDR in Progress)` — which shows the
parenthetical is a slot for a qualifier, not a fixed enum.

## What is inferred, not documented

No vendor table defines the parenthetical. The mapping above is inferred from the captures, and the
inference is that the parenthetical is the `show interfaces status` word with `connected`/`notconnect`/
`disabled`/`err-disabled` as its values — the same four words, in the same order of causes, printed by two
different commands from one state machine. The one collision worth naming: on a **serial** line `(disabled)`
means something else entirely — "a high error rate has occurred due to a telephone company service
problem" — while `Serial x is administratively down, line protocol is down` carries no parenthetical at all
(Cisco, *Troubleshooting Serial Lines*, Table 15-1:
<https://www.cisco.com/en/US/docs/internetworking/troubleshooting/guide/tr1915.html>). So the word
`disabled` is view- and media-dependent, and must not be read as "shut down" outside a switch port.

## What PacketForge prints today

Measured on `c85d3bbf` with the 8-port `generic-switch`, a cable on Fa0/1 and `shutdown` on Fa0/2:

```
sw1#show interfaces Fa0/1
Fa0/1 (ethernet, 1G), MAC 0200.0000.0000
  status: up, protocol: up
sw1#show interfaces Fa0/2
Fa0/2 (ethernet, 1G), MAC 0200.0000.0001
  status: administratively down (shut down), protocol: down
sw1#show interfaces Fa0/3
Fa0/3 (ethernet, 1G), MAC 0200.0000.0002
  status: down (no cable), protocol: down

sw1#show ip interface brief
Interface              IP-Address      OK? Method Status                Protocol
FastEthernet0/1        unassigned      YES unset  up                    up
FastEthernet0/2        unassigned      YES unset  administratively down down
FastEthernet0/3        unassigned      YES unset  down                  down

sw1#show interfaces status
% `status` is a view, not a port: this console has no `show interfaces status`. `show interfaces` prints every port's status and protocol, one block each.
```

Three observations, all of them *correct as they stand*:

1. **The brief table is faithful.** `down`/`down` for the unplugged port and `administratively down`/`down`
   for the shut one is what the captures in this note print. Nothing to change.
2. **The `show interfaces` block is not IOS-shaped**, by design: `Fa0/1 (ethernet, 1G), MAC ...` with an
   indented `status:` line is this project's own block, so the parenthetical has no place to go until the
   block is rewritten — which is a feature, not this increment.
3. **The interface verdict already knows the difference the box words**: `engine/device.js` `ifaceStatus()`
   returns `reason: 'shut down'` / `'no cable'` / `'link down'` / `'peer shut down'` / `'inactive'`, and
   `web/faceplate.js` `portState()` already paints an empty socket `notconnect` while keeping its status
   text as `down (no cable)`. The word is in the tree; only the console view that prints it is missing.

## The rules a future `show interfaces status` should print

Derived from the table at the top, and stated as a mapping from the reason this engine already computes —
no new state is needed:

| `ifaceStatus()` | Status cell |
| --- | --- |
| `status: 'up'` | `connected` |
| `reason: 'shut down'` | `disabled` |
| `reason: 'no cable'`, `'link down'`, `'peer shut down'`, `'peer missing'` | `notconnect` |
| `reason: 'inactive'` (access VLAN gone) | unresolved — no capture in hand; the port is up and enabled but forwards nothing |
| shut down and cabled | `disabled`, not `notconnect`: the admin state wins |

The `inactive` row is why this note stops short of code: a deleted access VLAN is a state the captures here
do not show, and printing `notconnect` for it would tell the reader to check a cable that is fine.

## Still open

- **Whether the parenthetical is a version feature or a documentation habit.** The 2960 CR prints the bare
  line for a physical port with the rest of the block intact; the 1000/4500 books and every live capture
  print the parenthetical. Settle it with `show interfaces fa0/1` on a 2960 running 12.2(55)SE and
  on one running 15.0(2)SE, both with a cable pulled.
- **What an SVI prints in the parenthetical's place on each image.** `Vlan34 ... is down` (no suffix) and
  `Vlan1 ... is down , Autostate Enabled` (a suffix, comma and all) are both captures. A third image would
  say whether the suffix is conditional on autostate being overridden.
- **The err-disabled causes** (`psecure-violation`, `link-flap`, ...) — the header is captured, the list of
  causes is not, and no feature in this engine can produce one yet.
- **`notconnect` on a port whose access VLAN is gone.** One capture of `show interfaces status` on a port
  in that state would close the one row above the code cannot answer.

Not researched here: the `Name` column (the description, empty when none is set), the `Vlan` column's comma
form for voice VLANs, and the `err-disabled` sub-view.
