# `show spanning-tree` on a box that is not a bridge: what does the device say?

**Question (one, narrow).** A router does not run spanning tree - it never joins an election, so it has no
bridge ID, no root and no port states. What exactly does an IOS/IOS XE router print when asked
`show spanning-tree`, and what did this console print instead?

**Verdict: known, and adopted.** The box answers with one line, at the left margin, ending in a full stop:

```
Router#show spanning-tree
No spanning tree instance exists.
```

The console printed a sentence of its own - `Spanning tree is not running on this device: it is not a bridge
(no L2 forwarding).` That sentence is true and it explains itself, but no device prints it: an operator who
diffs a lab against a router sees words the router never says. It is now the box's line.

## Evidence

| Source | Platform | Prints |
| --- | --- | --- |
| [Cisco Community, "ISR4000 series with switch module - no spanning tree instances exist"](https://community.cisco.com/t5/switching/isr4000-series-with-switch-module-no-spanning-tree-instances/td-p/3416173) | ISR 4331 + SM-X-ES3-24-P, IOS XE 16.6.3 | `LAB-RTR-01#show spanning-tree` → `No spanning tree instance exists.` — with `spanning-tree vlan 1,5,10,15 priority 0` in the running config, so the box *accepted* the config and still has no instance. The same post shows `show spanning-tree vlan 5` → `Spanning tree instance(s) for vlan 5 does not exist.` |
| [Cisco Community, "Spanning tree issue on C1111 router"](https://community.cisco.com/t5/routing/spanning-tree-issue-on-c1111-router/m-p/5330961) | C1111, IOS XE 17.x | `R1#show span` → `No spanning tree instance exists.` Then `spanning-tree mode rapid-pvst` and the same command prints a real `G0:VLAN0003` block - so the sentence is "no instance", not "no support". A C1121-4P in the same thread behaves the same way. |
| [Cisco Community, "Spanning tree on ISR router bridged port BDI"](https://community.cisco.com/t5/switching/spanning-tree-on-isr-router-bridged-port-bdi/td-p/3214295) | ISR, IOS XE, bridge domain configured | `show spanning-tree` → `No spanning tree instance exists.` — even with `service instance ... bridge-domain 1` on two ports. |
| [Cisco, "Using PPP Half-Bridging to Connect Routed and Bridged Networks" (doc 10381, PDF)](https://www.cisco.com/c/en/us/support/docs/wan/point-to-point-protocol-ppp/10381-ppp-half-bridging.pdf) | 7200-class router, IOS 12.x | `Saturn#show spanning-tree` → `No spanning tree instances exist.` with the vendor's own annotation: "This router does not run full bridge, so spanning tree does not run on this router" |
| [Cisco Community, "L2TPv3 and Spanning-tree MST"](https://community.cisco.com/t5/routing/l2tpv3-and-spanning-tree-mst/td-p/2455820) | 1841 routers, IOS 15.x | `L2TPv3-1# sh spanning-tree` → `No spanning tree instances exist.` (both ends) |
| [Cisco Community, "No spanning tree instance exists in 2960x switch"](https://community.cisco.com/t5/switching/no-spanning-tree-instance-exists-in-2960x-switch/td-p/3045285) | Catalyst 2960-X, IOS 15.2 | `No spanning tree instance exists.` — a *switch*, with no link in an operational state. Answer: "For each VLAN, at least one link has to be operational to bring the associated STP instance up." |
| [Cisco Networking Academy, CCNP SWITCH 6.0 lab PDF (mirror)](https://speetis.fei.tuke.sk/TechnologieNaBazePrepinanychSieti/Cvicenia/EN_SWITCH_SLM_v6_0.pdf) | Catalyst switch, all ports shut | `Switch# show spanning-tree` → `No spanning tree instance exists.`, then `no shutdown` on every port and the tree appears |

The sentence is not a refusal: it carries no `% ` prefix, it is not followed by the caret, and the prompt comes
back unchanged. What varies is the noun's number.

## What is known

1. **The words are `No spanning tree instance exists.`** - capital `N`, no prefix, trailing full stop, one line,
   at the left margin, on every IOS XE router capture found. Nothing else is printed: no header, no bridge
   priority line, no port table with no rows.
2. **The plural is the older router wording.** Both samples of `No spanning tree instances exist.` are routers
   on IOS 12.4-15.x (an 1841 and a 7200-class box). Every IOS XE router sample - 16.6.3 and 17.x - is singular,
   and so is every switch sample from 12.2 onward.
3. **The same sentence has a second cause on a bridge.** A switch whose VLAN has no instance up - all ports
   shut, no link operational, or `no spanning-tree vlan` - prints the identical line. So the sentence means
   "no instance exists", and a router is one of the reasons that can be true.
4. **A per-VLAN query has its own wording**: `Spanning tree instance(s) for vlan 5 does not exist.` That is a
   different question and a different sentence; this console refuses per-VLAN STP by design.
5. **Configuring spanning tree on a router does not produce a tree.** The ISR 4331 in the first capture has
   `spanning-tree vlan ... priority 0` and still answers with the one line; the C1111 needed a mode change
   before its switch module's VLANs produced a block.

## What is inferred

* PacketForge's predicate for "may this device be a bridge at all" is `Device.isL2()` - the same one
  `computeStp()` uses, and the one that stopped a router being handed a root it never elected (#1399). That
  predicate and the vendor's sentence describe the same state, so the sentence goes where the predicate is
  false, and nowhere else.
* The singular is the right form for this model. The console imitates one platform class with one opinion per
  command (`research/stp-mode-default.md` made the same call about `ieee` vs `rstp`), the IOS XE form is the
  one every current capture prints, and the plural belongs to releases the catalogue does not model as a
  console.
* Writing `instances` when a single-tree device is asked would be the wrong kind of accuracy: this model runs
  one tree, so "instance" is also the truthful number here.

## What changed

* `engine/cli.js` - the non-bridge branch of `show spanning-tree` prints `No spanning tree instance exists.`
  and returns. Nothing else moved: a bridge still prints its header, its bridge priority, its root and its port
  table, and the "not measured" branch for a lab that has never been simulated is untouched.
* `test/stp-no-instance-wording.test.js` (14 checks) - the line is exactly the vendor's, on a router and on a
  host model; no `%`, no root, no election, no protocol word, no empty port table; the plural is not printed;
  and a cabled pair of switches still prints its tree.
* `test/report-sweep.test.js` - the two assertions that pinned the old sentence now pin the vendor's, and the
  header comment records why.
* `docs/CLI.md` - the "a box that is not a bridge" bullet quotes the new line and names this note.

## What remains unresolved

* **Which side of the plural split is a release and which is a platform family.** No 12.4/15.x *switch* sample
  prints the plural, and no 15.x *router* sample prints the singular, so "IOS 12.x/15.x routers said
  `instances`" is the pattern rather than a proven rule.
* **A bridge with no live instance.** A switch with every port shut prints the same one-line answer on the
  hardware, and this console still prints a header plus `No ports are bridging: this device is not part of an
  L2 loop.` That is a separate question - "when does a VLAN's instance come up" needs per-VLAN instance state,
  which this model deliberately does not have - so it was left alone rather than half-answered here.
* **Where the sentence sits relative to a `%` warning** when the box also logs a message at the same moment
  (for example an interface event mid-command). No capture shows an interleaved log line, so nothing was
  modelled for it.

## What evidence would settle it

1. `show version` + `show spanning-tree` from one IOS 15.2 router (an ISR G2, say) and one IOS 12.4 router,
   to date the plural form instead of inferring it from two posts.
2. The same pair of commands from an IOS XE router with `spanning-tree mode pvst` (the 802.1D spelling a
   router accepts) - if the plural returns, the number follows the mode rather than the release.
3. A capture of `show spanning-tree` on a 2960-X with no cables at all *and* `show vlan brief` beside it, to
   confirm the switch prints the identical line for the "no instance up" cause rather than a different one.
