# The duplex a box reports for a port with no link

**Question (one, narrow).** `show interfaces <port>` printed `duplex: full` for every port, including a socket
with nothing plugged into it. Does a Catalyst report a duplex for a port whose link is down — and if so, which
duplex: the setting, or one negotiated?

**Verdict: the *setting*, and the setting's default is `auto`.** A `notconnect` port reads
`Auto-duplex, Auto-speed, media type is 10/100/1000BaseTX`; the same block on a port whose link is up reads
`Full-duplex, 1000Mb/s`. So the field is two-valued by link state, and this console printed the second value for
the first case — a duplex no link had agreed to, one space after a rate already marked `(auto)`.

| port | `show interfaces` in the vendor's sample | the setting |
| --- | --- | --- |
| `down, line protocol is down (notconnect)` | `Auto-duplex, Auto-speed, media type is 10/100/1000BaseTX` | auto (default) |
| `up, line protocol is up (connected)` | `Full-duplex, 1000Mb/s, media type is 10/100/1000BaseTX` | auto, resolved |
| after `duplex half` at 100 Mb/s | `Half-duplex, 100Mb/s` | half |

## The evidence

* **The vendor's own sample of the command, on a `notconnect` port.** Catalyst 2960-XR, IOS 15.2(6)E,
  *Interface and Hardware Commands*, `show interfaces`:
  `GigabitEthernet3/0/2 is down, line protocol is down (notconnect)` … `Auto-duplex, Auto-speed, media type is
  10/100/1000BaseTX`
  <https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15_2_6_e/command_reference/b_1526_2960xr_cr/interface_and_hardware_commands.pdf>
* **The default is `auto`.** Same platform family, `duplex` (Catalyst 2960-X 15.2(7)E): "Command Default: The
  default is auto for Fast Ethernet and Gigabit Ethernet ports", and `auto` is described as "The port
  automatically detects whether it should run in full- or half-duplex mode, depending on the attached device
  mode"
  <http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr/interface_and_hardware_commands.html>
  The 2960-L book states the same default for Gigabit ports
  <https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960l/software/15-2_7_e/command_reference/b_1527_2960l_cr.pdf>.
* **Three independent field captures, same two words.** Auvik's physical-connectivity walkthrough
  (`GigabitEthernet1/0/2 is down … (notconnect)` → `Auto-duplex, Auto-speed, media type is 10/100/1000BaseTX`)
  <https://www.auvik.com/franklyit/blog/verifying-physical-connectivity/>; a Cisco Community thread on a 3750
  whose `show interfaces status` row for the same port reads `notconnect 6 auto auto 10/100/1000BaseTX`
  <https://community.cisco.com/t5/switching/switchport-down-can-t-get-it-active/td-p/2962118>; and a
  FastEthernet port on a 3560 (`Auto-duplex, Auto-speed, media type is 10/100BaseTX`)
  <https://community.cisco.com/t5/network-management/fastethernet-port-showing-down-down/td-p/2133747>.
* **The box separates the two facts by name.** The 2960-X `show hardware led port duplex` sample prints
  `Administrative Duplex: auto` beside the operational one — the administrative value is what an operator set,
  and it is `auto` before anybody sets anything
  <http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr/interface_and_hardware_commands.html>.

## What this console did, and what changed

`Interface.duplex` is written as `'full'` when a port is built, and `_linkRateLine()` printed it. Nothing else
reads it for the *rendering*: the data plane, the LAG member check (`E_LAG_DUPLEX_MISMATCH`) and
`W_DUPLEX_MISMATCH` all read the resolved value, and `duplex auto` deliberately stores `'full'` because "what a
link decides in this engine is full duplex"
(`engine/cli.js`, `_duplex`).

The change keeps `iface.duplex` exactly as it was and adds `iface.duplexMode` — the *setting*, `auto` by
default — which the block prints while the port is not up. Consequences, all pinned by
`test/interface-duplex-when-link-down.test.js`:

* an uncabled port reads `duplex: auto`; a cabled one reads the resolved `full`;
* `duplex full` on a dead port reads `full` (the setting), `duplex auto` reads `auto`;
* `show running-config` now writes the setting, so a typed `duplex full` is in the config — it was invisible
  before, because the line was keyed on the resolved value, which is `full` for both `full` and `auto`;
* a saved lab keeps a non-default setting and a port left at `auto` grows no key in the document.

## What is inferred, and what is unresolved

* **That a shut port also prints `Auto-duplex`.** Every capture found is `notconnect` (no link). A shut port
  (`disabled`) is printed by the same block and no sample in hand shows the duplex line for one; the model prints
  the setting there too, which is the same rule by the same reasoning.
* **The duplex of an SFP cage with a fibre optic.** `duplex` and `speed` are not in that port's parser at all
  (research/1000base-x-cage-duplex-and-speed.md), so the field is a statement about a command the box does not
  have. This console still accepts both on such a port and still prints a duplex; that note explains why the
  engine cannot tell a fibre cage from a `1000BASE-T` module in the same cage.
* **`duplex auto` on a Fast Ethernet port whose peer does not autonegotiate** resolves to *half* on real
  hardware ("setting the port to **auto** has the same effect as specifying **half** if the attached device does
  not autonegotiate the duplex parameter"). This engine has no non-autonegotiating peer, so it never resolves
  half, and the mismatch warning it would raise never fires. One capture of a Cisco-to-fixed-full link would
  settle the wording of the warning, not the rule.
