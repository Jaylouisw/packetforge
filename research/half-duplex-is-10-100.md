# Half duplex on a Gigabit port: does the box take `duplex half`, and what does it say when it will not?

**Question (one, narrow).** On an IOS-like box, is `duplex half` configurable on a port that can run at
1000 Mb/s or faster, and — the other direction of the same rule — can a port sitting in half duplex be forced
to a Gigabit rate afterwards?

**Verdict: both are refused, and this console accepted both.** `duplex half` was stored on any Ethernet port
whatever its ladder, and `speed 1000` was then accepted on a half-duplex port, so `show interfaces` printed

```
  speed: 1Gb/s (forced), duplex: half
```

— a state no Cisco box will build, and one the standard permits only in a form Cisco does not implement.
The rule is now enforced at both commands, with the rate named in each refusal, and a 10/100-only port still
takes `duplex half` at auto because its ladder never reaches the rate that is forbidden.

## What is known

The command reference states the constraint in the `half` option's own description, identically on more than
one platform:

> `half` — Enables half-duplex mode (only for interfaces operating at 10 or 100 Mb/s). You cannot configure
> half-duplex mode for interfaces operating at 1000 or 10,000 Mb/s.

* Catalyst 2960-X, *Interface and Hardware Commands*, 15.2(7)E —
  http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr/interface_and_hardware_commands.html
* Catalyst 9500, same command, 17.11 —
  http://cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/17-11/command_reference/b_1711_9500_cr/interface_and_hardware_commands.pdf
  (adds 2.5 Gb/s and 5 Gb/s to the list of rates that cannot be half duplex)

The configuration guide says the same thing about the port, rather than the option:

> Gigabit Ethernet (10/100/1000-Mbps) ports support all speed options and all duplex options (auto, half, and
> full). However, Gigabit Ethernet ports operating at 1000 Mbps do not support half-duplex mode.

* Catalyst 2960, *Configuring Interface Characteristics*, 12.2(25)FX —
  https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_25_fx/configuration/guide/2960scg/swint.html

And the vendor's own troubleshooting note carries the console transcript, which is the part a simulator has to
reproduce — first the refusal, then the way round it, then the reverse refusal:

```
Switch_1(config)#interface twentyFiveGigE 1/0/2
Switch_1(config-if)#duplex half
% Duplex cannot be set to half when speed autonegotiation subset contains 1Gbps,2.5Gbps,5Gbps or 10Gbps
```

> Only interfaces with a speed of 100 can accept the half duplex configuration:

```
Switch_1(config-if)#speed 100
Switch_1(config-if)#duplex half
Switch_1(config-if)#
Switch_1(config-if)#speed 1000
Cannot change speed to 1000Mbps when in half duplex
Switch_1(config-if)#end
```

* Cisco TAC, *Configure and Verify Ethernet 10/100/1000Mb Half/Full Duplex Auto-Negotiation*, document ID
  10561, updated 6 Nov 2025 — https://www.cisco.com/c/en/us/support/docs/lan-switching/ethernet/10561-3.html

Note the second message has no `%` prefix in the capture. This console prefixes every refusal with `%`, so the
wording is its own; what is adopted is the rule, not the punctuation.

The same note is the authority for calling this a **vendor** rule rather than a law of Ethernet:

> While Cisco devices only support full-duplex, the IEEE 802.3z standard does have support for half-duplex
> GigabitEthernet.

So 802.3z defines a half-duplex Gigabit mode; Cisco's implementations do not support it. A non-Cisco box could
legitimately accept what this console now refuses — the refusal belongs to the IOS-like behaviour being modelled,
not to the physics.

## What was wrong here, measured

Before the change, on a generic 8-port 1G switch:

```
(config)#interface Fa0/1
(config-if)#duplex half
Duplex half on Fa0/1
```

and `show interfaces Fa0/1` then read `speed: 1Gb/s (auto), duplex: half`. The `W_DUPLEX_MISMATCH` warning
that `docs/CONNECTORS.md` promises needs a half end, so the previous test built its mismatch at 1 Gb/s — the
one arrangement the vendor rules out. That test now forces both ends to 100 Mb/s first, which is the classic
mismatch a technician actually meets.

## What changed

* `engine/media.js` — `HALF_DUPLEX_MAX_MBPS = 100`, the one place the ceiling is stated.
* `engine/cli.js` — `_duplex()` refuses `half` when the port can run above 100 Mb/s *now* (the forced rate if
  one is set, otherwise the top of its ladder, because an autonegotiating port may reach it), and names that
  rate and the `speed 100` that makes the command legal. `_speed()` refuses a rate above 100 while the port is
  half duplex, and refuses `speed auto` in the same state when the ladder reaches Gigabit — otherwise auto would
  quietly undo the duplex. The ladder check runs first, so `speed 10000` on a 1G port is still answered as
  "does not support 10G".
* `test/speed-duplex.test.js` — both refusals, the `speed 100` path, the auto path, and a 10/100-only control
  (Cisco 2811) proving the rule is about the rate and not the word.
* `test/lag-member-checks.test.js` — its duplex-mismatch fixture now forces 100 on both members.

## What remains unresolved

* **Fibre cages.** The command reference adds: "Duplex options are not supported on the 1000BASE-*x* or
  10GBASE-*x* … SFP modules." That is a second rule — a cage rule, not a rate rule — and it is not implemented.
  It cannot be decided from the cage alone in this model, because a 1000BASE-T module in the same cage *does*
  support duplex at 10/100 (Catalyst 2960 hardware guide: "The 1000BASE-T SFP modules operate at 10, 100, or
  1000 Mb/s in full-duplex mode or at 10 or 100 Mb/s in half-duplex mode"). The rule has to ask what is in the
  cage, so it belongs with the media model, not with the console.
* **A link built through the API.** `connect()` accepts a `duplex` option and `server/index.js` passes a request
  body's `duplex` straight into it, so a saved topology could still describe a 1 Gb/s half-duplex link without
  going through the console. What a reload should do with one is a separate decision.
* **Half duplex arriving by negotiation.** The 2960-X note says half duplex is supported on a Gigabit interface
  "if the duplex mode is auto and the connected device is operating at half duplex". This model's link verdict
  never negotiates to half, so that path does not exist here yet; if it is added, it is the one legitimate way a
  100 Mb/s half link appears on a Gigabit port.
