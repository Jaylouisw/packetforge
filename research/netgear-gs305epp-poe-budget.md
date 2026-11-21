# GS305EPP: 120 W over four PoE+ ports, and the fifth port is not one of them

**Question (one, narrow).** The NETGEAR GS305EPP is a 5-port gigabit switch sold as "4 PoE+ ports".
How much power can it supply in total, and does its fifth socket source power at all?

**Verdict: 120 W, over ports 1-4 only; port 5 is the unpowered uplink.** The catalogue had neither
fact. It carried no `poe` block (so `show power inline` answered "budget not modelled"), and the
engine's PoE inference filled the missing `poeOut` on **all five** RJ45 ports, including the uplink:
`ge5` came back as a 15.4 W PSE port. That is the defect this note records - a port the vendor calls
"an Ethernet (uplink) port" was offering to power a camera.

## What the vendor publishes

| Source | Says |
| --- | --- |
| [GS305EP/GS305EPP/GS308EP/GS308EPP data sheet](https://www.netgear.com/images/datasheet/switches/GS305EP_GS305EPP_GS308EP_GS308EPP_DS.pdf) (4 pp, text layer) | PoE table, column order `GS305EP / GS305EPP / GS308EP / GS308EPP`: `10/100/1000 RJ45 Copper Ports` = **5 / 5 / 8 / 8**; `# of PoE ports` = **4 / 4 / 8 / 8**; `# PoE+ 802.3at Ports` = **4 / 4 / 8 / 8**; `Total PoE/PoE+ Budget` = **63W / 120W / 62W / 123W**. The per-port ceiling is in the highlights: "802.3at PoE+ standard supporting up to 30W per port". |
| [GS305EP/GS305EPP/GS308EP/GS308EPP user manual](https://www.downloads.netgear.com/files/GDC/GS305EP/GS305EP-EPP_GS308EP-EPP_UM_EN.pdf) (99 pp), "Hardware" | "Models GS305EP and GS305EPP: The switches provide 5 Gigabit Ethernet copper ports with **4 ports supporting up to 30W PoE+ (802.3at) per port**"; "Model GS305EPP: The maximum PoE power budget of the switch across all active ports is **120W**." |
| Same manual, "LEDs" | "On models GS305EP and GS305EPP, **ports 1 through 4 are PoE+ ports. Port 5 is an Ethernet (uplink) port.**" |
| [NETGEAR product page, GS305EPP](https://www.netgear.com/business/wired/switches/easy-smart/gs305epp/) | "5 x 10/100/1000 RJ45 Copper Ports (Auto Uplink)" and "**4 x PoE+ 802.3at Ports**"; "PoE Budget - **120**". |
| [NETGEAR press release, 2020-09](https://investor.netgear.com/releases/news-details/2020/NETGEAR-Debuts-Four-New-Plus-Switches-With-Advanced-Features-and-a-Low-Cost-of-Entry/default.aspx) | Model table: `GS305EPP` - port count **5**, total PoE budget **120W**, PoE+ ports **4**. The 63 W row is `GS305EP`. |

There is no ambiguity to resolve here, only one number that is easy to misread: the 63 W in the
data sheet belongs to the GS305EP, the non-P version of the same 5-port body. The GS305EPP's supply
is 54 V / 2.4 A (129.6 W input), which is consistent with a 120 W PoE budget and would not be with 63 W.

## Why the fifth port mattered

`engine/media.js` derives `poeOut` when a spec is silent:

```js
const carriesPower = port.cage === 'rj45' || port.cage === 'combo';
if (port.poeOut === null && port.poeIn === null && carriesPower) {
  if (isPoePse(dev, port.name)) port.poeOut = 15.4;     // 802.3af default
```

and `isPoePse()` returns true for **every** RJ45 port when the device's category is `switch` (or
`l3-switch`) and its capabilities include `poe-pse`. That rule is right for an access switch whose
ports are all PoE, and wrong for the one uplink socket on a small PoE switch - the vendor's own
manual draws the distinction the rule misses. The spec can only make that distinction by saying
`"poeOut": false`, which it now does on `ge5`.

The budget matters for the same reason from the other side: 4 x 30 W = 120 W exactly, so on this box
the PSU is not the binding constraint and a full PoE+ fill is legitimate. With no `poe` block, the
allocator skipped the device entirely (`computePoe()` starts with `if (!dev.poeBudget) continue`), so
"the switch has 120 W" was not a claim the engine could answer at all.

## What the engine did, measured

Before the change, on `9edeb5bf` (main), a lone GS305EPP:

```
sw1# show power inline
Interface Admin  Supplied
ge1       auto   not measured
ge2       auto   not measured
ge3       auto   not measured
ge4       auto   not measured
ge5       auto   not measured
budget not modelled on NETGEAR GS305EPP-sw1: the ports are reported, the power they could supply is not
```

Five rows for a four-PSE box, and no wattage anywhere. The derived hardware said
`ge5: {"poeOut": 15.4, "poeOutDeclared": false}` - an engine guess, not a vendor claim.

After:

```
sw1# show power inline
Available:120.0(w) Used:0.0(w) Remaining:120.0(w)
Interface Admin  Oper       Power   Device
                            (Watts)
--------- ------ ---------- ------- -------------------
4 ports with nothing plugged in: ge1, ge2, ge3, ge4

sw1# show power inline ge5
% ge5 on NETGEAR GS305EPP-sw1 cannot supply power (it is not a PSE port)
```

## What changed

* `devices/netgear/gs305epp.json`: `poe.budgetW = 120` with the user manual as `poe.sourceUrl` and
  both sentences quoted in `poe.note`; `ge5` is `"poeOut": false`; the description names the budget
  and the unpowered uplink; `notes` records the data-sheet column order so the 63 W/120 W pair is
  not re-mixed.
* `test/netgear-gs305epp-poe.test.js`: 25 checks - the spec's budget and source, four PSE ports and
  one that is not, `poeBudget === 120` with source `research`, four 25.5 W access points all funded,
  a PD cabled to `ge5` drawing nothing, and the two CLI renderings above.

## What this note does not claim

No per-port PoE class beyond `PoE+`: the vendor states 802.3at, 30 W. No PoE on `ge5` under any
configuration: the manual says it is the uplink port, and the data sheet counts 4 PoE ports on a
5-port body. No `802.3bt`: the GS305EPP is an 802.3at switch, and its 120 W budget is 4 x 30 W, not a
Type 3/4 allotment.
