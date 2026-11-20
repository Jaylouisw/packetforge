# Teltonika's PoE switches: what the total is, and which sockets it is spent on

**Question (one, narrow).** `scripts/audit-poe-budget.js` names seven Teltonika switches that source power on at
least one port and cannot say how much (six with no budget at all, and `tsf000` with one). Does the vendor publish
a total PoE power budget for each, what is it, and - the second row of the same table - which ports is it printed
against?

**Verdict: every one of them publishes both rows in one datasheet table, and the totals are 120, 60, 240, 240, 300
and 300 W.** The port row is the half the engine got wrong without any spec changing: a copper port on a device
that claims `poe-pse`, with no `poeOut` key, is inferred to be a 15.4 W 802.3af PSE (`engine/media.js`,
`isPoePse`). On four of these models that inference invented outlets the vendor does not fit - both uplinks, and
the twelve plain ports of the mixed 24-port variant. A phantom PSE costs nothing while the box has no budget
(`computePoe()` opens with `if (!dev.poeBudget) continue;`); the moment a budget is added they become spendable,
so the budget and the port census had to be fixed in the same pass.

## What the vendor publishes

| Model | Total PoE budget (at PSE) | PoE ports | Per-port ceiling | Source (read 2026-11-20) |
| --- | --- | --- | --- | --- |
| TSW100 | **120 W** | "Port 1- 4" of five | 30 W | [TSW100 datasheet 2023-v1.3](https://teltonika-networks.com/cdn/products/2023/01/63b81b1aa5d306-16407609/datasheet/626552-tsw100-datasheet-2023-v13.pdf); headline repeated on [the product page](https://teltonika-networks.com/products/switches/tsw100) |
| TSW101 | **60 W** | "Port 1 - 4" of five | 30 W | [TSW101 datasheet v1.30](https://www.farnell.com/datasheets/4785183.pdf); flyer: "5 x 10/100/1000 Ethernet ports: 4 x PoE, 1 x Uplink" |
| TSW200 | **240 W** | "Port 1 - 8" | 30 W | [TSW200 datasheet 2024-v1.0](https://teltonika-networks.com/cdn/products/2023/01/63b81b2e79f7f3-21486183/datasheet/tsw200-datasheet-2024-v10.pdf) |
| TSW202 | **240 W** | "Port 1 - 8" | 30 W | [TSW202 datasheet 2024-v1.1](https://teltonika-networks.com/cdn/products/2023/08/64e896612f9829-30532758/datasheet/tsw202-datasheet-2024-v11-profinet.pdf); QSG: "Max PoE power budget at PSE 240 W*" |
| SWM280 | **300 W** | "Port 1-12" of 24 | 30 W | [SWM280 datasheet v1.02](https://teltonika-networks.com/cdn/products/2025/03/67d1527c4482d2-16554631/datasheets-and-flyers-pdfs/swm280-datasheet-v102.pdf) |
| SWM282 | **300 W** | "Ports 1-24" | 30 W | [SWM282 datasheet v1.0](https://teltonika-networks.com/cdn/products/2025/03/67d14588252b07-13183319/datasheets-and-flyers-pdfs/swm282-datasheet-v10.pdf) |
| TSF000 (budget already present) | 120 W | 4 of five | 30 W | [Teltonika wiki, TSF000](https://wiki.teltonika-networks.com/view/TSF000) |

Three of the totals are exactly the port count times 30 W (TSW100 4x30, TSW200 8x30, TSW202 8x30): full fill lands
on the ceiling with nothing spare, so the budget never binds before the per-port class does. Two bind hard -
SWM282's 24 x 30 W wants 720 W out of a 300 W supply, and its 12-port sibling wants 360 W out of the same 300 W -
which is the case worth having in a catalogue: on those two the total, not the port, decides the tenth device.

## What the engine did

* Six rows carried no `poe` block, so `dev.poeBudget` fell through the model-name parser, found no number, and
  `show power inline` answered `budget not modelled on <dev>: the ports are reported, the power they could supply
  is not`.
* Four rows carried **phantom PSE ports** - sockets with no PoE hardware that the engine's class inference had
  turned into 15.4 W 802.3af sources:
  * `tsw100` eth0 - the uplink (the vendor's installation drawing: "Connect your main internet router/modem to
    TSW100 LAN port number 5");
  * `tsw101` eth5 - the uplink;
  * `tsf000` eth0 - the fifth port of a five-port box with four PoE outputs;
  * `swm280` eth12-eth23 - the twelve *plain* Gigabit ports of the mixed variant, which is the whole difference
    between it and SWM282.
  A 300 W budget spread over twenty-four outlets, twelve of which have no PoE hardware, is a box that can power a
  camera from a port that cannot.
* `tsw101` and `swm282` said `"poeOut": true` on their PSE ports - "this port sources power", with no wattage -
  while the vendor prints 30 W a port. Both now carry the number, the same shape as their siblings.

## What changed

* Six `poe` blocks (`budgetW`, `sourceUrl`, a note quoting the datasheet rows), and `"poeOut": false` on the
  fourteen copper ports that are not PSEs (2 uplinks + 12 plain ports on SWM280), so the inference has an answer
  instead of a silence.
* `test/teltonika-poe-budget.test.js` (89 checks): each total, its source document and the quoted row; the PSE
  count per model against the vendor's "Port 1-n"; every plain copper port declared rather than inferred; the
  `Available:` line for all seven; the non-PSE sockets refusing with "cannot supply power (it is not a PSE port)";
  the cable that exhausts each binding budget refused with `E_POE_BUDGET` and the total quoted in the sentence
  (TSW101 60 W: two ports; SWM280/SWM282 300 W: ten ports); the three full-fill models funding every port with
  nothing refused; and a refused port reading `power-deny` under a `Used:280.5(w) Remaining:19.5(w)` line.
* `scripts/audit-poe-budget.js` silent cohort: **55 -> 49**.

## What is inferred, and what remains unresolved

1. **Which physical socket is port 1.** The catalogue names ports `eth0..` or `eth1..`; the datasheets name
   "Port 1-n". `tsw100` numbers from `eth0` with the uplink there, `tsw101` from `eth1`, `swm280` from `eth0`.
   The mapping `ethN = port N` is the reading used, and on TSW101 it is the vendor's own ("4 x PoE, 1 x Uplink",
   with the PoE row "Port 1-4") that fixes which end the uplink is. Panel artwork for the other chassis would
   confirm the start index but not change the count.
2. **TSW100's 120 W is a chassis ceiling, not what the box in the carton does.** The datasheet footnote:
   "*Provided power supply only allows 60 W PoE power budget at PSE, to reach maximum 120 W at PSE >130 W power
   supply must be used"* - the bundled adapter is 48 V / 1.3 A (62.4 W). This simulator has no field for "which
   PSU is fitted", so the chassis figure is what is modelled and the caveat lives in the note. A lab that wanted
   to teach the bundled-adapter limit would need a supply field.
3. **TSW101's budget is supply-dependent and the single field cannot hold both.** The v1.5 datasheet footnotes
   "30 W (max.) @ 12 VDC for total PD consumption; ... 60 W (max.) @ 24 VDC". 60 W - the ceiling - is modelled;
   a 12 V vehicle system funds half of it. Same missing field as (2).
4. **The cable check reserves more than the allocation spends.** `validateLink()` reserves each port's ceiling
   (30 W) when a PD is cabled, while `computePoe()` allocates the PD's nameplate draw (25.5 W for an 802.3at
   Type-2 device). On a 300 W SWM280 the eleventh 25.5 W device is refused at *cable* time (11 x 30 = 330 W) yet
   the engine would fund it at allocation time (280.5 W). One of the two is wrong about a real box: hardware
   reserves the class, then delivers the negotiated draw, so refusing the cable is the stricter of the two and
   the one a lab notices. This predates the budgets added here (it reproduces on any aruba CX with a budget) and
   was left alone: settling it needs a capture of a real PSE refusing an *allocation* while accepting the cable,
   which no document in hand shows.
5. **`poeOut: false` as the marker for "copper, not a PSE".** Nine MikroTik and Ubiquiti specs already use it, so
   this is an existing convention rather than a new one, but the engine's own comment for the inference rule
   describes the declared/guessed distinction without naming the spelling. A port that says `false` is not a
   silence to be filled, and `hardware.poeOutDeclared` follows it.
