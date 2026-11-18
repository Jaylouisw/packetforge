# When a PoE budget runs out, which ports lose power?

**Question (one, narrow).** A PSE has a budget smaller than the sum of what is plugged into it. Which ports does
it power - and does a budget that *exactly* equals the draw of N ports fund all N?

**Verdict: the ports are served in port-number order, and an exact fit is a fit.** The engine sorted the port
**names** with `Array.prototype.sort()`, and string order is not port order: a 24-port switch served `1/1/10`,
`1/1/11` and `1/1/12` before `1/1/2`, so the tens were powered and the twos went dark. The same walk compared
watts as binary floats, so five 12.95 W devices on a 64.75 W budget funded four. Both are fixed; the allocation
now walks the ports numerically and accounts power in milliwatts.

## What is known

Cisco states one ordering for PoE allocation, and states it in terms of **port numbers**, in the "Configuring
PoE" chapter that every Catalyst family reprints:

> If a power supply is removed and replaced by a new power supply with less power and the switch does not have
> enough power for the powered devices, the switch denies power to the PoE ports in auto mode **in descending
> order of the port numbers**. If the switch still does not have enough power, the switch then denies power to
> the PoE ports in static mode in descending order of the port numbers.
>
> If the new power supply supports more power than the previous one and the switch now has more power available,
> the switch grants power to the PoE ports in static mode **in ascending order of the port numbers**. If it still
> has power available, the switch then grants power to the PoE ports in auto mode in ascending order of the port
> numbers.

* Catalyst 3650, 15.2(4)E and later — https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3650/software/release/37e/consolidated_guide/b_37e_consolidated_3650_cg/configuring_poe.html
* Catalyst 3850, IOS XE 3.2/3.3SE — https://www.cisco.com/en/US/docs/switches/lan/catalyst3850/software/release/3.2_0_se/multibook/configuration_guide/b_consolidated_config_guide_3850_chapter_011010.html
* Catalyst 9300, 16.6 — https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/16-6/configuration_guide/int_and_hw/b_166_int_and_hw_9300_cg/b_166_int_and_hw_9300_cg_chapter_0110.html

The same chapter is equally clear that the *general* case is not ordered at all:

> If there is not enough available PoE, or if a device is disconnected and reconnected while other devices are
> waiting for power, **it cannot be determined which devices are granted or are denied power**.

and that a port is normally served the moment it is detected:

> If the switch discovers a powered device connected to the port and if the switch has enough power, it grants
> power, updates the power budget, turns on power to the port **on a first-come, first-served basis** ...

and, in the command reference, `power inline`:

> Allocation is first-come, first-serve.
> (Catalyst 2960-XR Consolidated Platform Command Reference, 15.2(7)E —
> https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15_2_7_e/command_reference/b_1527e_2960xr_cr.pdf)

Two further ordering rules sit beside it and are **not** modelled here: static-mode ports are funded before
auto-mode ports ("The switch allocates power to a port configured in static mode before it allocates power to a
port configured in auto mode"), and power priority decides who is shed first — "Low-priority ports are the first
to be shut down under load-shedding ... high-priority ports are shut down in descending order of port numbers
until power consumption returns to normal" (Catalyst 3650 chapter above; `power inline port priority high|low`,
default `low`).

## What PacketForge did

`Simulator.computePoe()` promised port order in its own comment ("Powered devices are served in port order until
the budget runs out") and then sorted the names as strings, subtracting float watts. Measured in this worktree —
one Aruba CX 6000 (370 W), twelve UCG-Ultra powered devices on ports 1/1/1 to 1/1/12, budget set to five devices'
worth:

```
served: 1/1/1+ 1/1/10+ 1/1/11+ 1/1/12+ 1/1/2- 1/1/3- ... 1/1/9-
powered count 4
```

Two defects in one walk: the ports were served in string order (1, 10, 11, 12, 2, 3 ...), and a budget of exactly
5 x 12.95 W powered four, because `12.95 * 5 - 4 * 12.95` is `12.949999999999996` in IEEE 754 and the fifth
comparison (`remaining >= draw`) failed by 4e-15.

`web/app.js` carries a display mirror of the allocation (the browser cannot `require` the engine) with the same
`.sort()` and the same float comparison, so both surfaces agreed with each other and disagreed with the hardware.

## What changed

* `engine/iface-name.js` gains `comparePortNames()` (and `portRuns()`): a natural comparison that walks the name
  in runs, numbers as numbers and everything else as folded text. `1/1/2` sorts before `1/1/10`, `eth2` before
  `eth10`, `Port 9` before `Port 10`, while `GigabitEthernet0/2` still sorts before `TenGigabitEthernet1/1/1`.
  It is the same comparator `show` output wants, so it lives with the other port-name rules rather than in the
  simulator.
* `Simulator.computePoe()` sorts with it and keeps its budget in **milliwatts** (`Math.round(w * 1000)`), which
  is the unit a real budget is counted in; the reported `draw`, `used` and `remaining` figures stay in watts.
* `web/app.js` `poeSummary()` gets the same comparator and the same milliwatt arithmetic, so the panel and the
  engine still agree port by port.
* `test/poe-allocation-order.test.js` (26 assertions) pins the comparator, the serving order, the denial order,
  the exact-fit case, the one-hundredth-of-a-watt-short case and what `show power inline` prints;
  `test/ui-render.test.js` gains the 1/1/10-versus-1/1/2 panel comparison and `test/poe-agreement.test.js` gains
  the same arrangement among its cross-implementation cases.

## What is inferred, not published

* **That an order is needed at all.** Cisco says the outcome of an over-subscribed boot "cannot be determined",
  because a real box serves devices as they are detected. In a lab every port comes up at once, so the simulator
  must pick an order; the only order the vendor documents (ascending port number) is the defensible one, and it
  is also the one the code already claimed.
* **That "port number" is the number in the name.** No document defines what a port number is for a
  `TenGigabitEthernet1/1/1` beside a `GigabitEthernet0/2`; the run-by-run comparison reproduces the panel order
  (all downlinks, then the uplinks) without asserting anything about slot numbering.
* **That the first port that does not fit is the one refused.** The visible behaviour - the higher-numbered ports
  are the ones left dark - is what the vendor's descending-order sentence describes.

## What remains unresolved

1. **Class-based reservation.** A real box reserves the *class maximum* when it powers a device, not the device's
   measured draw: "The initial power allocation is the maximum amount of power that a powered device requires ...
   the initial allocation for Class 0, Class 3 and Class 4 powered devices is 15.4 W". This engine reserves
   `poeIn` (12.95 W for the PDs here). So a real 24-port 370 W switch funds 24 class-3 phones (24 x 15.4 =
   369.6 W) where this model would fund 28; the two agree only for a device whose declared draw is its class
   maximum.
2. **Priority and static mode.** `power inline port priority`, `power inline static` and `power inline never` are
   not commands here, so the load-shedding order (low priority first, then high priority by descending port
   number) cannot be exercised. Section 6.3 of `docs/SIMULATION.md` lists priority as absent.
3. **Load shedding itself.** Nothing in the model ever removes power from a port that already has it: there is no
   power-supply failure, no hot-inserted PD that forces a re-allocation, and no policing.

**What would settle them.** A `show power inline` capture, with the budget stated, from a 24-port box that is
over-subscribed at boot: it would show whether the dark ports are the highest-numbered ones, and whether a
class-3 device reserves 15.4 W (the `Power` column) or its measured draw.
