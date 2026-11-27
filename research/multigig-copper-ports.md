# The multi-gig copper jacks on three small-office switches: RJ-45, and a ladder that starts at 100

**Question (one, narrow).** Issue #1398 counts template ports whose connector nothing declares.
Three more specs on that list — `trendnet/TEG-S380`, `zyxel/XGS1250-12` and `qnap/QSW-M2108-2C` —
present 2.5G/5G/10G over twisted pair, and their ports declared only a rate. Does each spec say what
the jack is, and does every port train at every rate the engine inferred for it?

**Verdict: the cage inference was right, the ladder was not — again.** All three are copper boxes,
so `inferCage()` guessing RJ-45 never contradicted anything visible. But the inferred ladder is
`CAGE_SPEEDS.rj45` from bottom to top, so a multi-gig jack that starts at 100 Mb/s was handed
**10BASE-T** as well. Before this pass, cabling a 10BASE-T-only device into `TEG-S380/port1`
*succeeded at 10 Mb/s* on a jack that cannot train below 100:

```
PRE-FIX  TEG-S380/port1   caps [10,100,1000,2500]                       ->  10BASE-T link: ok, 10 Mbps
PRE-FIX  XGS1250-12/port9 caps [10,100,1000,2500,5000,10000]            ->  10BASE-T link: ok, 10 Mbps
PRE-FIX  QSW-M2108-2C/9   caps [10,100,1000,2500,5000,10000]            ->  10BASE-T link: ok, 10 Mbps
```

This is the failure `#1628` fixed on the Netgear multi-gig copper ports; these three are the same
shape on the access side rather than the uplink side.

## Evidence

No new datasheet fetch: each spec's own `description` already enumerates the rate set its copper
ports run, and the transcription into the port is what was missing.

| Spec | Description's port row | Template / port declares |
| --- | --- | --- |
| `devices/trendnet/teg-s380.json` | "8x 100M/1G/2.5G RJ45" | `rj45`, `[100,1000,2500]` (8) |
| `devices/zyxel/xgs1250-12.json` | "8x 1G RJ45 plus 3x 100M/1G/2.5G/5G/10G RJ45 and 1x 10G SFP+" | `rj45`, `[10,100,1000]` (1-8); `port9-11`: `rj45`, `[100,1000,2500,5000,10000]` |
| `devices/qnap/qsw-m2108-2c.json` | "8x 2.5G RJ45 plus 2x 10GbE SFP+/RJ45 combo ports ... 10G/5G/2.5G/1G/100M on copper" | `rj45`, `[100,1000,2500]` (1-8); `9`,`10`: `rj45`, `[100,1000,2500,5000,10000]` |

The floors agree with the media the descriptions name. `2.5gbase-t`, `5gbase-t` and `10gbase-t` are
the `engine/media.js` rows for those rates, defined over twisted pair, and none of them is
10BASE-T. The Zyxel 1G jacks keep `10` because a 1000BASE-T jack does train at 10; the 2.5G jacks do
not, because the rate set the description lists for them starts at 100M.

## What this pass did not touch, and why

A scan for the same shape — an RJ-45 port whose inferred ladder contains both `10` and a rate of
2.5G or above — finds 43 ports in nine specs. The six left alone state the jack but not its floor:

| Spec | Multi-gig copper ports | Description says |
| --- | --- | --- |
| `mikrotik/RB5009UPr+S+IN` | `eth1` | "1x 2.5G RJ45" |
| `netgate/8200` | `LAN1-4` | "4x 2.5G RJ45 LAN" |
| `paloalto/PA-1420` | 8x 1G/2.5G/5G | "8x 1G/2.5G/5G" |
| `sophos/XGS 136` | `Port11-12` | "2x 2.5G RJ45 PoE" |
| `sophos/XGS 4300` | `Port5-8` | "4x 2.5G RJ45" |

"2.5G RJ45" names the top of the jack, not its bottom, and a 2.5GBASE-T PHY that also does 10BASE-T
is a real part. Declaring `100` there would be this run inventing a floor, which is the same sin in
the other direction. Those six need a datasheet row that lists the supported speeds, then the same
two-line declaration. They stay on #1398's count.

## What changed

- `devices/trendnet/teg-s380.json`, `devices/qnap/qsw-m2108-2c.json`,
  `devices/zyxel/xgs1250-12.json`: `portTemplate` and the explicit multi-gig interfaces now carry
  `connector: "rj45"` and their own `speedCaps`.
- `test/multigig-copper-ports.test.js`: 35 assertions. The declaration, the generated ports, the
  refused 10BASE-T peer on every multi-gig jack, the 100M/1G/2.5G/5G/10G links that must still
  come up, the 1G jacks that must keep 10, and the combo cage (copper side 10GBASE-T, SFP+ side
  still fibre).

Twenty-five of the 35 fail on the pre-fix tree.

## One defect found on the way, deliberately not fixed here

`sophos/XGS 3100` has `PortF1` declared as `type: ethernet, speed: 10G` with no connector, and the
spec's own description calls it one of "2x 10G SFP+ (PortF1-PortF2)". `inferCage()` reads 10G as
ambiguous and picks RJ-45, so the switch's first fibre uplink presents as a copper jack: an LC lead
into it is refused as a connector mismatch, and an RJ-45 lead into it is accepted, on a cage that
physically has no jack. That is the opposite error to this pass's ladder bug (cage wrong, not
ladder wrong) and it needs its own test, so it is left for the next pass on #1398. The same spec's
`PortF3`/`PortF4` are declared 10G SFP+ while the description calls them 1G SFP.
