# Plan: the default route is chosen three times, and the data plane takes the dead one

Status: forward plan, no code. Measured on `c4b00fe0`, 2026-11-27. Closes **no** open issue on its own;
it is the first half of `#30`'s P3/P4 in [`docs/UPSTREAM-DESIGN.md:658-684`](../UPSTREAM-DESIGN.md) with
no new device, no new field and no tracking. Scope: `engine/device.js:1078`, `:1311`, `:1368`, `:1507-1532`,
`engine/cli.js:7164-7172`, `test/route-selection.test.js`, `test/show-ip-route.test.js`. No healthy lab changes.

## What exists today

**One rule, three implementations.**

| surface | code | rule |
|---|---|---|
| forwarding | `Device.routeTo()` `engine/device.js:1078` | longest prefix, then lowest distance; a static at 255 is skipped (`:1105`); **never asks whether the row can carry** |
| `installed` and `(not installed: ...)` | `routesTable()` `engine/device.js:1507-1522` | *"Strictly lower wins; a tie keeps the earlier row, which is the order routeTo() tries them in"* - distance only |
| `Gateway of last resort is ...` | `engine/cli.js:7167` | a third filter: distance-sorted, drops `r.unusable` and `>= 255`, and deliberately ignores `shadow` (`:7165`: *"it is the one `routeTo()` would fall through to once the unusable row cannot be used"*) |

That last sentence is false. Measured on `generic/generic-router` - `Gi0/0` 10.0.0.1/24, `Gi0/1` 10.1.0.1/24,
a PC at 10.1.0.2 as the distance-1 default and a PC at 10.0.0.2 as the distance-5 default:

- **both up** - line names `10.1.0.2`, that row is `installed`, `routeTo('8.8.8.8')` returns `10.1.0.2`: agree.
- **`shutdown` on Gi0/1** -

```
Gateway of last resort is 10.0.0.2 to network 0.0.0.0
S*  0.0.0.0/0 [1/0] via 10.1.0.2  (next hop 10.1.0.2 would leave by Gi0/1, which cannot carry: administratively down)
S*  0.0.0.0/0 [5/0] via 10.0.0.2  (not installed: the S* route for this prefix has distance 1)
```

  `routeTo('8.8.8.8')` still returns `{ via: '10.1.0.2', ad: 1 }`. One view names 10.0.0.2 as the gateway
  and the row beneath it says it is not installed.
- **cable `state = 'down'` to 10.1.0.2** (both ports up) - the same rows, and `ping 8.8.8.8` from 10.0.0.10
  answers `no ARP reply from 10.1.0.2 (dropped by r1)` - the sentence `test/routes-agreement.test.js:1-20`
  was written to kill, on a box holding a live default at distance 5.

**The invariant is already asserted, in healthy labs only.** `test/route-selection.test.js:221` and `:239`
assert `routeTo().via === winner.gw` for the installed row, and `:235` asserts exactly one is installed. No
case there shuts the winner's port, so all three agree by accident. `routes-agreement.test.js:238` pins
panel-to-console on `unusable`; nothing pins console to data plane.

## What is missing, ranked

1. **Usability is not part of selection for forwarding** (`device.js:1078`). A lab with a live distance-5
   default fails over to nothing.
2. **`installed` is decided by distance alone** (`:1519`), so `show ip route` prints a row it calls "not
   installed" as the gateway of last resort.
3. **The rule has three homes**, and `cli.js:7165` documents a fall-through the code does not perform.
4. Out of scope: **far-end silence must still not fail over** (no port fault, no cable fault). That is
   tracking, `UPSTREAM-DESIGN.md` P4, and needs Jay's approval.

## Steps

1. **`installed` means "the first candidate that can carry" (M).** In `routesTable()`, call `routeNote()`
   (`:1311`, today at `:1532`) before the per-prefix pass, then walk each group in (distance, insertion)
   order and take the first row with `unusable === false`; when none can carry, keep today's distance
   winner, so a connected row on a dead port is unchanged. The shadowed row's sentence must name the reason
   it lost (distance decided nothing here), and the 10.0.0.0 row stops reading "not installed". The
   `Gateway of last resort` line then agrees untouched, because its filter already reads `unusable`.
2. **`routeTo()` reads the same walk (M).** `routeTo(dstIp, topo)` uses the topology all 8 call sites
   already hold (`engine/simulator.js:1732,3043,3076,3871,3938,4094,4112,4252`); with no `topo` it keeps
   today's answer and says so in the comment. Then the distance-5 default carries the ping in both measured
   shapes. Add the shut-port and link-down labs to `route-selection.test.js` and assert all three surfaces
   name one gateway.
3. **One filter, not three (S).** `cli.js:7167`'s `fallback` becomes "the installed default"; `:7164`'s
   claim becomes true or is deleted. Pin the reworded row in `show-ip-route.test.js` as a golden.
4. **Note for RIP (S).** `rip-distance-vector.md:81` adds a `ripRoutes` branch to `routeTo()` after OSPF;
   it must obey the can-carry rule rather than become a fourth filter.

## Risks and tests

- Real gear removes a static route when its **egress interface** goes down and keeps it when only the far
  end is silent - so step 2 fails over on `administratively down` and `link down`, and must not on "no ARP
  reply". `UPSTREAM-DESIGN.md:684` asserts the same rule for tracking.
- `routeTo` is hot and topo-less; a call site that forgets `topo` silently reverts the rule. Test through
  `simulator.ping()`, not the accessor alone.
- Calling `routeNote()` earlier must not reword a healthy row: `routes-agreement.test.js` (the panel reads
  the same rows), `route-candidate-default.test.js:33` (a 254 default stays shadowed by distance),
  `route-next-hop-unreachable.test.js` scenario C (the line names the reachable hop), `show-ip-route.test.js`,
  `ospf.test.js` for an OSPF route over a dead port, then `npm test`.
- Total M: steps 1 and 2 are one PR each, step 3 rides with 2.
