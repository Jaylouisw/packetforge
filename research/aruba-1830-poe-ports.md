# Which sockets on an Instant On 1830 PoE switch can source power?

**Question (one, narrow).** The Instant On 1830 PoE models are sold by how many of their copper
ports are PoE: the JL811A is "8G **4p** Class4 PoE", the JL813A "24G **12p**", the JL815A "48G
**24p**". Which sockets are the PSE sockets, what is the per-port ceiling on them, and what does the
switch do with a powered device plugged into a socket that is not one?

**Verdict: known, and it was wrong here.** On all three models the PoE ports are the *low-numbered*
ones - 1-4, 1-12 and 1-24 - and they are 802.3at Class 4, 30 W a port. The other copper sockets are
data only. The catalogue carried the split only in free text (the `poe.note` said "across ports 1-4")
and left every port object silent, so the engine's switch rule promoted *every* copper port of a
PoE-named switch: all 8/24/48 sockets became an inferred 802.3af PSE at 15.4 W. A powered device on
port 5 of a JL811A drew 12.9 W from a socket the datasheet says carries no power, the real PoE
sockets advertised 15.4 W instead of 30 W, and `show power inline` counted sockets that cannot
source a watt. The three specs now carry the vendor's split per port and
`test/aruba-1830-poe-ports.test.js` pins it.

## The evidence

| Source | Says |
| --- | --- |
| [HPE Networking Instant On 1830 Installation and Getting Started Guide](https://arubanetworking.hpe.com/techdocs/hardware/switches/1830/1830_IGSG.pdf), "1830 Switch Series PoE Power Delivery", the model table | `HPE Networking Instant On 1830 8G 4p Class4 PoE 65W Switch (JL811A)` / `65W` / **`Ports 1 - 4`** / `4` / `2`; `... 24G 12p ... 195W (JL813A)` / `195W` / **`Ports 1 - 12`** / `12` / `6`; `... 48G 24p ... 370W (JL815A)` / `370W` / **`Ports 1-24`** / `24` / `12`. The four columns are maximum PoE power, PoE port count, "Maximum Ports delivering at 15.4W" and "Maximum Ports delivering at 30W" - so 65 W funds four 15.4 W PDs or two 30 W ones, which is the arithmetic the engine already does at run time. |
| Same guide, front-panel figures for JL811A, JL813A and JL815A | The panel callouts separate the sockets by capability: `1 PoE & 1GbE RJ45 ports with Link/Status LED per port` and `2 1GbE RJ45 ports with Link/Status LED per port`; the SFP row is a further item on the 24G/48G. The split is drawn on the box, not only tabulated. |
| [Aruba Instant On 1830 Switch Series Data Sheet](https://www.also.com/ec/cms5/media/img/2900/microsites_9/hpe_8/aruba_3/aruba_instant_on_1/product_datasheet/ds_aio_1830switchseries.pdf), I/O ports and slots | `8 RJ-45 autosensing 10/100/1000 ports IEEE 802.3at Class 4 PoE (ports 1-4)` for the JL811A; `24 RJ-45 ... IEEE 802.3at Class 4 PoE (ports 1-12) ... 2 SFP 1GbE ports` for the JL813A; `48 RJ-45 ... IEEE 802.3at Class 4 PoE (ports 1-24) ... 4 SFP 1GbE ports` for the JL815A. The model-comparison row prints `Class 4 PoE 65W / 195W / 370W` against the same three SKUs. The standard is 802.3at and the class is Class 4, i.e. 30 W at the PSE. |
| [HPE Networking Instant On 1830 Installation, Safety and Regulatory Information](https://arubanetworking.hpe.com/techdocs/hardware/switches/1830/1830_SH_EN.pdf), PoE output table | `HPE Networking Instant On 1830 8G 4p Class4 PoE 65W Switch (JL811A)` / `(54Vdc, 0.56A) max.` / **`30W per port, 4 ports, total max. output power 65W`**. The per-port ceiling is 30 W and the count is 4 - the two facts the spec was missing. |

The IGSG also states the allocation model the engine's run-time accounting follows: "The PoE software
supports two power modes to allocate power by **Usage** (default) or Class. The default Usage mode
reclaims unused power for use by new PD connections...". That is why four 12.9 W APs fit a 65 W budget
in the run (4 x 12.9 = 51.6 W) even though the worst-case Class-4 reservation funds two.

## What this console did

Measured on the base commit, one JL811A, nothing configured, an Instant On AP11 on port 4 and another
on port 5:

```
sw1# show power inline
Available:65.0(w) Used:25.8(w) Remaining:39.2(w)
Interface Admin  Oper       Power   Device
--------- ------ ---------- ------- -------------------
4         auto   on         12.9    AP4
5         auto   on         12.9    AP5
6 ports with nothing plugged in: 1, 2, 3, 6, 7 (+1 more)
```

Port 5 is a data socket in the table and in the front-panel drawing, and it powered an AP. Every port
reported `poeOut = 15.4` (802.3af) rather than the 30 W Class 4 the sheet prints for ports 1-4, and
`show interfaces 5` reported the AP `status: up, protocol: up` on a socket that supplies no watts.

## What changed

* `devices/aruba/instant-on-1830-8g-4p-poe-65w.json`, `instant-on-1830-24g-12p-poe-2sfp-195w.json`
  and `instant-on-1830-48g-24p-poe-4sfp-370w.json`: ports 1-4 / 1-12 / 1-24 carry `poeOut: 30` and
  `poeOutClass: "PoE+"`; the remaining copper ports carry an explicit **`poeOut: 0`**. `0` is the
  spec's way of stating "this port sources nothing" - only a number is a decision, while `null` means
  "not stated" and would be re-inferred (`test/poe-inference.test.js` pins that rule). Each `poe`
  block gained `standard: "802.3at"` and `perPortW: 30`, and each file a `notes` field carrying the
  vendor rows and this reasoning.
* `test/aruba-1830-poe-ports.test.js` (47 checks): the budget and standard each spec states, the
  exact PSE port list on each model (1-4, 1-12, 1-24), 30 W and PoE+ on every PSE port, an explicit
  `0` on every data socket, no power on the SFP rows, an AP11 on a data socket staying dark while one
  on a PoE socket is powered at 12.9 W, four APs fitting the 65 W budget in the run (51.6 W used),
  and `show power inline` counting only the four PSE sockets.
* `research/aruba-1830-poe-ports.md` - this note.

## What remains unresolved

1. **The 1960 family has the same shape, with a second class in it.** `JL807A` is "24G 20p CL4 4p
   CL6 PoE 2XGT 2SFP+": 24 copper ports are PoE (20 at 802.3at, 4 at 802.3bt Class 6) and the two
   `XGT` 10G copper uplinks are not. The engine infers 15.4 W on **26** ports, so the four Class-6
   ports understate their ceiling (60 W) and the two uplinks overstate theirs (they should be 0). Its
   datasheet is the next note's evidence, not this one's: the split is 20/4 rather than half the
   ports, so the fix is a census of its own.
2. **The 1930 family is all-ports PoE, and only its per-port ceiling is short.** On the JL681A /
   JL683A / JL684A / JL686A every copper port is a PoE port, so the inferred set is right; the 15.4 W
   it infers is under the 30 W Class 4 ceiling the same series prints. Same fix, no port-subset
   question, not done here.
3. **The cabling guard charges capability, not draw.** `pseDraw()` in `engine/validation.js` sums each
   cabled PSE port's `poeOut` (now 30) against the budget, so cabling a third PoE device to a 65 W
   JL811A raises `E_POE_BUDGET` ("3 powered ports draw 90 W of a 65 W budget") even though the run
   powers four 12.9 W APs. That is the project's existing, documented choice -
   `test/arista-720xp-poe.test.js` pins the same worst-case gate on a 982 W switch - and it is honest
   as a worst case (the datasheet funds two 30 W PDs), but the guard and the run answer different
   questions. Whether a guard should charge the peer's draw instead is a separate engine question,
   not opened here.
4. **A data socket's PD is listed nowhere.** The AP on port 5 is connected but unpowered, and there
   is no `poe-deny` event and no `poeUnpowered` mark for it - a run-time denial on a PSE socket has
   both. A real box is silent too (it never classifies a PD on a socket that cannot source), so this
   may be right; what still looks least like a real box is the link staying `up` on an AP that has no
   power at all.

5. **The non-PoE 8G has a powered *input*, and no spec says so.** The same data sheet's I/O row
   reads `8 RJ-45 ... IEEE 802.3af Class 3 PD (port 1)` for the JL810A and `13W max Class 3 PD` in
   its power block, and the IGSG PoE table gives that model `13W` against `Port 1` where its PoE
   siblings list a budget and a port range. So port 1 of a JL810A can be powered *by* PoE - a
   Class 3 PD, 13 W - which is `poeIn`, not `poeOut`, and `devices/aruba/instant-on-1830-8g.json`
   declares neither. That is the mirror of this note's question (which sockets *receive* power, and
   what a PD's draw does to the upstream budget), so it is recorded here rather than acted on: the
   engine's `isPoePd()` gate and the 12.95 W `poeIn` default are subject to the same
   only-a-number-decides rule as the output side, and the JL812A / JL814A rows show the plain
   `IEEE 802.3 Type 10BASE-T ...` wording with no PD and no PoE, so they would stay untouched.
