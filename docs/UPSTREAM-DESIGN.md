# Upstream, Transit and Multihoming

**Status:** design specification — not yet implemented.
**Issue:** #30 — "The internet is a single RJ45 port: no multihoming, no PON/coax/DSL upstream".
**Audience:** whoever implements it. Every rule names the file, the function and the
assertion that proves it.
**Verified against:** `d399dff`, node v24 (first measured at `319b875`; every figure
was re-run at the later commit and is unchanged). Line numbers are pinned to
`d399dff` — and this tree moves under you while you work: `engine/cli.js` gained 73
lines, `engine/topology.js` 20 and `engine/media.js` 50 during the writing of this
document. **Every anchor therefore names the function as well as the line**; when
the numbers disagree, the function wins and `grep -n 'function name'` is the truth.

Measurements that back every claim here are in
[`research/incoming/upstream-probe.json`](../research/incoming/upstream-probe.json).
They were produced by running the real engine; nothing under `engine/`, `web/`,
`server/`, `devices/` or `config` was modified to obtain them.

---

## 0. Status check before you read the design

This page was written against `d399dff`, and the tree has moved under it — including on the very
problem it describes. Measured on the current tree before touching anything else:

| Claim in §1 | Then | Now |
|---|---|---|
| "there is no cellular medium anywhere in the model" | true | **false** — `wwan` is a cage, with **141** ports across the catalogue (recounted by deriving every port's cage; this row has said 122 and then 155 as the catalogue grew) |
| "of 54 ports named `wwan*`/`lte*`/`5g*`/`nr*`, 53 resolve to the Wi-Fi antenna cage" | true | **157** such ports, and **123 of them now resolve to `wwan`** — the name-first rule in `inferCage()` (P1, #129) claims them before the wireless-type rule can. **33** still land on `antenna` and **1** on `rj45`, a port whose name says modem and whose spec says copper. This row read "104 on `wwan`, 33 still on `antenna`, 1 on `rj45`" before that fix landed |
| one RJ45 is the only way to the internet | true | **false** — `coax` (**164** ports), `dsl` (**437**), `powerline` (**12**) and `usb` (0 in use) are all cages now, out of **24** cage kinds carrying ports (of **26** defined — `lc-apc` and `usb` have none on this tree) |
| `routeTo()` returns one route, so two defaults are not multihoming | true | **still true** — two `ip route 0.0.0.0 0.0.0.0` lines are both stored and `routeTo('8.8.8.8')` answers `{ via: '203.0.113.1', … }`, the first one, with `iface: null` because the next hop is resolved later |
| ^ the cage counts above | | every port's cage comes from `derivePortHardware(port, spec)` over `effectiveInterfaces(spec)`, **not** from the raw `connector` field — **10,289 of 17,030** ports declare neither `connector` nor `cage`, so a raw count answers `?` for 60% of the catalogue and none of these figures |

Recount all four numbers with one script; it prints 17,030 ports and **24 cages** on this tree — and that
24 is a different number from the **26** cages the rest of the docs quote, because the script asks which
cage kind a port *derives* rather than which kinds exist. `CAGES` defines 26; the two with no port are
`lc-apc` and `usb`, so `t.size` is 24. Both statements are true of this tree and neither is a typo:

```bash
node -e '
const {loadCatalog,effectiveInterfaces}=require("./devices/registry");
const {derivePortHardware}=require("./engine/media");
const t=new Map(); let n=0;
for(const s of loadCatalog(require("path").resolve("devices")))
  for(const p of effectiveInterfaces(s)||[]){ n++; const h=derivePortHardware(p,s)||{};
    const c=String(h.cage||"?"); t.set(c,(t.get(c)||0)+1); }
console.log("ports",n,"cages",t.size,"wwan",t.get("wwan"),"dsl",t.get("dsl"),"coax",t.get("coax"),"powerline",t.get("powerline"));'
```

| a `pon` port against `cloud/eth0` is refused | true | **true**, though the surface differs: `Topology.connect()` **throws**, prefixed with both endpoints — `UFiber OLT 4/gpon1 <-> UniFi Cloud Gateway Fiber/WAN: Cannot mate SC/APC to RJ45 (incompatible connectors).` — while `validateLink()` returns the same fault as `E_CONNECTOR_MISMATCH` without throwing. Anything that matches on the message must allow for that `<device>/<port> <-> <device>/<port>: ` prefix |

So the medium half of this design has largely landed, and the routing half — one default slot, no policy,
no failover — has not. The sections below are kept as the specification they are, but read §1 as the
state of the world at `d399dff`, not today. Any figure in this page that contradicts the table above is
history; the table was measured, the prose was not re-run.

---

## 1. The problem, measured

The lab reaches "the internet" by cabling to `devices/generic/generic-cloud.json`.
That device is:

| Fact | Value | Source |
|---|---|---|
| Ports | **1** (`eth0`) | probe `A_the_cloud_port_today` |
| Cage | `rj45`, family `copper` | `derivePortHardware()` |
| Speed caps | 10 / 100 / 1000 / 2500 / 5000 / 10000 Mbps | `CAGE_MEDIA.rj45` |
| Media offered | all 6 copper BASE-T entries | `CAGE_MEDIA` at `media.js:486` |

So every lab in the world terminates on an RJ45 socket, and the *only* thing a
router can do with its fibre WAN is nothing: a `pon` port against `cloud/eth0`
is refused with `E_CONNECTOR_MISMATCH` (probe `C_pon_to_cloud`).

Worse, there is no cellular medium anywhere in the model. Of **54** ports in the
catalogue named `wwan*`/`lte*`/`5g*`/`nr*`, **53** declare `type: "wireless"` and
therefore resolve to the **Wi-Fi antenna** cage:

```
devices/peplink/max-br1-pro-5g.json  wwan0  type=wireless  ->  cage antenna,
    media [wireless-2.4, wireless-5, wireless-6]        (probe B_a_5g_router_today)
```

Cabling that 5G modem to the internet gives
`E_WIRELESS_TO_WIRED: A wireless radio cannot be cabled to a wired port.`
A Peplink MAX BR1 Pro 5G is modelled as a box with a 2.5G copper WAN and a Wi-Fi
radio where its modem should be.

### 1.1 The routing table has one default slot

`Device.routeTo()` (`device.js:545`) returns **one** route object. Two
`ip route 0.0.0.0 0.0.0.0 <gw>` lines are both stored, and the second is never
consulted:

```
config.routes = [ {gw 203.0.113.1, iface wan1}, {gw 198.51.100.1, iface wan2} ]
routeTo('8.8.8.8')  ->  { iface: 'wan1', via: '203.0.113.1', ad: 1, prefix: 0 }
```

Four scenarios, one change each, same lab (probe `E_failover_matrix`):

| Scenario | Egress used | Outcome |
|---|---|---|
| both links up | `wan1` | dies at ISP A (it has no route onward) |
| `Link.state = "down"` on wan1 | `wan1` | **identical trace** — the data path never reads `Link.state` |
| `iface.enabled = false` on wan1 | *nothing* | `drop: no usable egress interface`, while a valid second default sits in `config.routes` |
| ISP A unplugged (no IP) | `wan1` | silence: ARP is never answered, no switch to wan2 |

`_deliver()` (`simulator.js:3314`) checks `iface.enabled` (`:3319`) and reads
`iface.peer` (`:3323`). When this section was written it never asked whether the *link* was up, and
`web/app.js:1613` printed a State field in the link inspector that the engine ignored — so the
`Link.state = "down"` row above really did trace identically. **Both halves have since been fixed**
(`test/link-state.test.js` is the guard), and re-measuring the same two-switch line is the proof: the
path answers `Success rate is 100 percent (4/4)` while the middle link is up, `0 percent (0/4)` with
`Request timed out` once it is down, and 100 percent again after it comes back. The refusal is now data
rather than silence — `sim.setLinkState(<linkId>, 'down')` answers
`{"ok":true,"changed":true,"state":"down","atMs":0,"reconvergeAtMs":30000,"affects":["d1","d2"]}`, and
`_deliver()` drops with `reason: 'link down'` at `simulator.js:3329`. Read the matrix above as the
state of the tree the design was written against, not as a description of this one.

### 1.2 Asymmetry is already data, and dead

Ten media entries carry `upstreamMbps` — DOCSIS 3.1 is 10000 down / 1000 up,
GPON is 2488 down / 1244 up, and `MEDIA` carries the downstream rate at the `gpon-*`
entries (`media.js:199-200, 211, 219`) with `xgspon-*` at 9953 (`:210, 212-213, 220`).
Grepping `engine/`,
`web/`, `server/` and `test/` for `upstreamMbps` returns **only those ten
declarations**. Nothing consumes it. A GPON line and a 10G LAN cable carry
packets identically, and no surface anywhere says "this line is asymmetric".

### 1.3 Nothing in the model is a *service*

A link is `{type, mediaId, speedMbps, duplex, lengthM, lagId, patchCord, state}`
(`link.js:24-34`). There is no place to say "this coax is DOCSIS 3.1 at
1000/200 from ISP B, IPoE, CGNAT". Two ISP defaults are indistinguishable, so
`W_DEFAULT_SHADOWED`-class mistakes cannot even be described, let alone caught.

---

## 2. What must not break

Five contracts, each already guarded by an existing test. Any patch that violates
one is wrong even if it makes issue #30 work.

> **Numbers in this table are the phase-0 baseline, not today's tree.** C4 and C5 quote
> "878 models" and "the 61-suite chain" — the catalogue has since grown to **1,661 models across
> 247 vendors** and `npm test` now runs well over a hundred suites. The criterion is the *mechanism*
> each row names (the round-trip test, the cable matrix, the invariants suite), not the count beside
> it.

| # | Contract | Guard |
|---|---|---|
| C1 | A topology saved before this change loads and reloads identically | `test/topology-roundtrip.test.js`, `test/server-persistence.test.js` |
| C2 | Every cable that mates today still mates, at the same medium and rate | `test/cable-matrix.test.js` (an explicit cageA×cageB verdict table — the specification, not a snapshot) |
| C3 | `routeTo()` keeps its signature and single-route return | **10 call sites** in `simulator.js` today, measured as `grep '\.routeTo(' engine/simulator.js \| grep -vc '//'` — and note the three counts differ, which is why this row keeps going stale: `grep -c 'routeTo('` returns **13** (it matches prose and comments), `grep -c '\.routeTo('` returns **11**, and only the comment-filtered count is **10**. The criterion is the signature `routeTo(dstIp)` returning one route or `null`, which the ARP, next-hop and TTL paths all depend on |
| C4 | A device with no upstream configuration behaves exactly as today | new `test/upstream-baseline.test.js` (phase 0) |
| C5 | No device spec gains a required field; all models load (1,661 today, 878 when this was written) | `test/hardware-invariants.test.js`, and the whole `npm test` chain (61 suites then, 229 now) |

The design below is shaped by C3 and C4 more than anything else.

---

## 3. The model: three layers, one new word

The word is **service**. An upstream is not a device and not a media family; it is
a *contract attached to a link* that says what the far end sells and how it is
delivered.

```
   router                access node                provider edge           "internet"
 ┌────────┐  fibre   ┌──────────┐   PON ODN   ┌───────────┐  transit  ┌────────────┐
 │ Gi0/0  ├──────────┤  ONT     ├─────────────┤ OLT / BNG ├───────────┤  PoP       │
 │ (sfp+) │          │ (sc-apc) │             │           │           │  (many     │
 └────────┘          └──────────┘             └───────────┘           │   ports)   │
    link.service = { technology:'gpon', down:2488, up:1244, ... }      └────────────┘
```

The middle of that ladder already exists as catalogue hardware — 30 OLTs
(`adtran/sdx-6320`, `fiberhome/an5516-01`), 31 ONTs (`calix/803g`,
`adtran/sdx611`) and 43 modems (`arris/cm8200`, a DOCSIS 3.1 CPE). The design does
not invent them. It makes three things expressible:

One box does **not** exist: there is no CMTS, DSLAM or BNG model in the catalogue.
On a coax or DSL lab, the provider edge's `coax0`/`dsl0` port therefore stands in
for the headend. That is an approximation and §9 says so; adding a CMTS is a
catalogue task (a JSON file), not an engine change.

1. **A provider edge with a port per family** — so a fibre WAN has somewhere to go.
2. **A cellular radio that is not a Wi-Fi radio** — the only media family that is
   genuinely missing.
3. **A service on the link** — so "DOCSIS 3.1, 1000/200, ISP B, CGNAT" is data.

### 3.1 Layer 1 — add the cellular family

`media.js:54 MEDIA` holds **89** entries across **nine** families — copper 7, fiber 31,
fibre-channel 16, coax 6, dsl 3, powerline 4, dac 7, console 6, wireless 9 (counted today; the line
number is still 54, but the numbers in this paragraph have moved twice since it was written: it said
57 entries and eight families, and the related note that `docs/PHYSICAL_LAYER.md` §2 still said 53 is
obsolete — that page now carries 89/9/26). Add a **tenth** family:

```js
// ---- cellular: licensed radio, no cable ----
// A modem's antenna is not a Wi-Fi antenna: an LTE radio and an 802.11 radio
// share no medium, no band and no licence. They get their own family and their
// own cage so the existing three-test ladder refuses the pair for the right reason.
'lte-cat6':   { name: 'LTE Cat 6',    family: 'cellular', connector: 'antenna', speedMbps: 300,  upstreamMbps: 50,  maxRangeM: null, radio: true },
'lte-cat20':  { name: 'LTE Cat 20',   family: 'cellular', connector: 'antenna', speedMbps: 2000, upstreamMbps: 150, maxRangeM: null, radio: true },
'5g-nr-sub6': { name: '5G NR Sub-6',  family: 'cellular', connector: 'antenna', speedMbps: 2500, upstreamMbps: 300, maxRangeM: null, radio: true },
'5g-nr-mmw':  { name: '5G NR mmWave', family: 'cellular', connector: 'antenna', speedMbps: 5000, upstreamMbps: 600, maxRangeM: null, radio: true },
```

Cage, mate table, media and speeds — `CAGES` at `media.js:314`, `CAGE_MATE` at `:413`,
`CAGE_MEDIA` at `:486`, `CAGE_SPEEDS` at `:642`:

```js
CAGES.cellular     = { name: 'Cellular radio', family: 'cellular', label: 'LTE / 5G radio' };
CAGE_MATE.cellular = ['cellular'];          // a licensed radio mates only another licensed radio
CAGE_MEDIA.cellular = function () {
  return ['lte-cat6', 'lte-cat20', '5g-nr-sub6', '5g-nr-mmw'];
};
CAGE_SPEEDS.cellular = function (maxMbps) {
  return [300, 2000, 2500, 5000].filter(function (v) { return v <= maxMbps; });
};
```

`derivePortHardware()` (`media.js:875`) needs **no** change: the band special-case
is `if (cage === 'antenna')` (`:967`), and `cellular` is not `antenna`, so a cellular port
keeps the media its cage lists. That is the whole reason for a separate cage
instead of reusing `antenna` (see §10, rejected alternatives).

`inferCage()` (`media.js:767`, running to `:829`) gains, next to the subscriber-access lines (coax at
`:787`, PON at `:809`):

```js
if (type === 'cellular' || type === 'lte' || type === 'nr' || type === '5g' || type === 'wwan') return 'cellular';
// A port NAMED for a modem but declared 'wireless' is a spec bug, not a Wi-Fi radio.
// wwan0 on a 5G router is a modem, and modelling it as 2.4/5/6 GHz Wi-Fi is how
// it became uncabled in the first place.
if (type === 'wireless' && /^(wwan|lte|nr\d|5g|cellular|modem)/i.test(name)) return 'cellular';
```

**This changes 53 existing ports.** They stop being Wi-Fi radios and stop mating
Wi-Fi APs. That is the intended repair, but it is a catalogue-wide behaviour
change and must land with the migration: the 53 ports also get `"type":
"cellular"` written into their specs, and the audit gets a rule
(`cellular-not-radio`, mirroring `wireless-not-antenna` in
`scripts/audit-port-types.js`). Then the `inferCage` name heuristic is a safety
net, not the mechanism.

### 3.2 Layer 2 — the provider edge has one port per family

New device, `devices/generic/generic-transit.json`:

```json
{
  "vendor": "generic",
  "model": "generic-transit",
  "label": "Internet / Transit Provider (multi-service PoP)",
  "category": "upstream",
  "capabilities": ["l3-forward", "transit"],
  "interfaces": [
    { "name": "eth0",  "type": "ethernet",  "speed": "10G" },
    { "name": "sfp0",  "type": "ethernet",  "speed": "10G", "cage": "sfp+" },
    { "name": "pon0",  "type": "pon",       "connector": "sc-apc", "speed": "10G", "class": "xgspon" },
    { "name": "coax0", "type": "coax",      "speed": "10G" },
    { "name": "dsl0",  "type": "dsl",       "speed": "300M" },
    { "name": "nr0",   "type": "cellular",  "speed": "5G" }
  ]
}
```

`generic-cloud` **stays exactly as it is**, so every saved topology keeps loading
(C1) and the palette keeps its familiar entry. `generic-transit` is additive:
registers in `devices/registry.js:7` (`CATEGORY_ORDER`, which already carries `'upstream'`),
`web/app.js:116` (`CAT_LABELS`, with the order beside it at `:127`), `device.js:89 CAPABILITIES` (add `'transit'`).

Three intentional omissions:

- **No `traffic` capability, no prefix list.** This is a PoP, not a BGP speaker;
  it answers ARP and forwards, exactly like `generic-cloud` does today. A lab
  that wants real transit policy uses the existing BGP model (`engine/bgp.js`)
  between two routers it configures, not this device.
- **No per-medium speed on `nr0`.** A cellular "port" has no cable; `speed: "5G"`
  parses to 5000 Mbps and `CAGE_SPEEDS.cellular` clamps it to the media the cage
  offers.
- **One device, six ports** rather than six cloud devices: the lab picks *how it
  reaches the internet* at the cable, which is where every other hardware choice
  in this project is made.

### 3.3 Layer 3 — the service block on the link (the core of the design)

This is the "upstream as a first-class link type" part. New optional field on
`Link` (`link.js:8`), defaulting to `null` exactly the way `patchCord` does:

```js
this.service = o.service || null;   // null = a plain LAN cable (today's behaviour)
```

```jsonc
{
  "kind": "broadband",              // transit | broadband | cellular | mpls | leased-line
  "provider": "ISP-B",              // free text; two lines from one provider is legal
  "technology": "docsis31",         // gpon | xgspon | docsis30 | docsis31 | vdsl2 | adsl2 | nr | lte | ethernet
  "downMbps": 1000, "upMbps": 200,  // the SOLD rate, not the medium's class rate
  "session": "ipoe",                // static | dhcp | pppoe | ipoe
  "cgnat": true,                    // carrier NAT: inbound port-forwards cannot work
  "ipv6": { "pd": 56 },             // delegated prefix length, or null
  "mtu": 1500,
  "class": "residential"            // residential | business | sla (display + validation only)
}
```

**Why the link and not the interface.** A service is what the *connection* is:
re-cabling the same line to a different port must not lose it, and one router may
hold two lines from the same provider. It also follows the precedent already set
by `mediaId`/`lengthM`/`patchCord`, all of which describe the connection rather
than either end. `Topology.connect()` already threads `opts` into `new Link()`
(`topology.js:389`), so the plumbing is one line in, one line out
(`serialize()` at `link.js:60`, restore at `topology.js:570` in `Topology.fromJSON()`, which rebuilds each
link through `connect({force: true})` at `:597-602`).

The local identity of a WAN — its name, address, preference — belongs to the
*router*, and lives in device config (§4.4).

### 3.4 What a lab looks like afterwards

```jsonc
// dual-homed edge: fibre primary, cable backup
{ "deviceId": "edge", "iface": "Gi0/0", "to": "ont1",
  "service": { "kind":"broadband", "provider":"ISP-A", "technology":"gpon",
               "downMbps":2488, "upMbps":1244, "session":"ipoe" } }
{ "deviceId": "edge", "iface": "Gi0/1", "to": "cm1",
  "service": { "kind":"broadband", "provider":"ISP-B", "technology":"docsis31",
               "downMbps":1000, "upMbps":200, "session":"dhcp", "cgnat":true } }
{ "deviceId": "edge", "iface": "wwan0", "to": "tower1",
  "service": { "kind":"cellular", "provider":"MVNO-C", "technology":"nr",
               "downMbps":2500, "upMbps":300, "session":"ipoe" } }
```

Three upstreams, three media families, one router — and the cable to each carries
its own contract.

---

## 4. Multihoming semantics

### 4.1 Selection order (normative)

`routeTo()` keeps its signature (C3) and becomes a thin wrapper. New method on
`Device`, `routeCandidates(dstIp)`, returns an **ordered array**.

Order, first difference wins:

| # | Key | Value |
|---|---|---|
| 1 | prefix length | longest match (unchanged) |
| 2 | administrative distance | connected `0`, static `distance \|\| 1`, eBGP `20`, OSPF `110`, iBGP `200`, default-gateway `254` |
| 3 | metric | static `metric \|\| 0`; OSPF keeps its cost; BGP keeps MED-then-local-pref (inside `bgp.js`) |
| 4 | route type | connected > static > bgp > ospf > default-gateway |
| 5 | egress name | lexicographic, so the result is deterministic across runs and machines |

```js
routeTo(dstIp) {                       // unchanged for all 7 call sites
  const c = this.routeCandidates(dstIp);
  return c.length ? c[0] : null;
}
```

Two behavioural changes hide in there, both deliberate:

- **`config.routes[i].distance` is honoured** (`device.js:571` currently hard-codes
  `ad: 1`). That is what makes a floating static possible:
  `ip route 0.0.0.0 0.0.0.0 198.51.100.1 wan2 200`.
- **The default gateway becomes a candidate in the list** rather than a
  `if (!best)` fallback (`device.js:606`). Today a host's default gateway can
  never lose to anything; with AD 254 it still loses to nothing, so C4 holds —
  but it can now be *listed*, compared and displayed.

### 4.2 Eligibility: what makes a candidate dead

A candidate is **eligible** when all of these hold:

| Test | Where | Notes |
|---|---|---|
| egress interface exists and `enabled` | `device.isInterfaceUsable(name)` (new, `egressFor` neighbour) | today's only check |
| **the link on that port is up** | `Simulator._linkAt(devId, ifaceName).isUp()` (`simulator.js:849`, called at `:3328`) | `Link.state === 'up'`; `blocked` (STP) is already separate |
| if `wan.track` is set: the tracked target has answered within `failAfter` runs | new `Simulator.trackState` | opt-in, like `ip sla` / `track ip route` |

The third is deliberately **not** on by default, because a static default route
on real hardware does not fail over when the far end goes quiet — it fails over
when the interface goes down, or when something *tracks* the path. Modelling
"magic ARP liveness" would teach the wrong lesson. It is the single most
important honesty decision in this document, and it is why §9 says failover is
cause-driven, not time-driven.

### 4.3 Three modes

`config.multipath` (default `'primary'`):

| Mode | Behaviour | What the lab proves |
|---|---|---|
| `primary` | first *eligible* candidate wins; every other is standby | a router with two default routes and one path |
| `failover` | as `primary`, plus a `wan-failover` event naming the reason and the dead candidate | dual-homing, failover and return |
| `ecmp` | among candidates **equal** on prefix/AD/metric, bucket by `lag.hashFrame()` (`lag.js:128`) | load sharing, and that a flow keeps its path |

`ecmp` hashes the flow tuple, never the packet: `(srcIp, dstIp, proto, srcPort,
dstPort)`, or `(icmp.id, icmp.seq)` for echo. `hashFrame` is already order-
independent and deterministic, which is what makes an ECMP test assertable at all.

**Flow affinity.** `engine/flow.js` keeps a connection table; when a flow opens,
record the egress WAN on it (`flow.wanIface`) and keep using it for the life of
the flow, even if candidate order changes. Real CPE behaves this way, and without
it a re-run of a ping would move a live TCP session to the other ISP.

### 4.4 What the simulator shows

Four new event types, all additive to the existing schema (`_emit`, `simulator.js:256`):

```jsonc
{ "type":"wan-select", "dev":"edge", "dst":"8.8.8.8", "wan":"wan1", "via":"203.0.113.1",
  "ad":1, "metric":0, "mode":"primary",
  "candidates":[
    {"iface":"wan1","via":"203.0.113.1","ad":1,  "metric":0,"eligible":true, "why":"up"},
    {"iface":"wan2","via":"198.51.100.1","ad":200,"metric":0,"eligible":true, "why":"standby"}]}

{ "type":"wan-failover", "dev":"edge", "from":"wan1", "to":"wan2",
  "reason":"link-down", "detail":"Link l7 state=down" }          // or track-failed / iface-down

{ "type":"wan-dead", "dev":"edge", "wan":"wan1", "via":"203.0.113.1",
  "reason":"track-failed", "run":"ping#4" }

{ "type":"wan-ecmp", "dev":"edge", "wan":"wan2", "hash":0.417,
  "flow":"f3" }
```

The existing `route` event (`simulator.js:3741`) gains `ad`, `metric`, `wan` and
`candidates` — purely additive, so `web/canvas.js` ignores what it does not know.

**One source of truth.** `Simulator.wanState(devId)` returns the same structure
that `wan-select` emits, and both the console and the inspector render from it.
Otherwise the event log and `show wan` drift, which is how the `Link.state` field
in the inspector came to be a decoration.

REST (`server/index.js`, next to `/validate-link` at line 350):

- `GET  /api/topologies/:name/upstreams` → per device: `{ wans:[{iface, service,
  iface address, ad, metric, eligible, chosen}], default, backup, mode }`.
- `POST /api/topologies/:name/failover-test { deviceId, down:["wan1"], dst }` →
  runs a ping with an override set of dead ports and returns
  `{ before:{egress}, after:{egress}, events }`. **It does not mutate the
  topology** — the override is passed into the run, so a test can hammer it and a
  user cannot wreck their lab by clicking.

CLI (`engine/cli.js`):

- `ip route DEST MASK GW [IFACE] [DISTANCE]` — one optional numeric token after
  the interface (`_ipRoute()` at `cli.js:3269` — the same line in `HEAD` and in the worktree, see below).
`% Invalid distance` outside 1..255.

  **Today that fourth word is refused outright**, so the work is replacing a refusal rather than
  widening a parse. Measured on a router with three free ports, for `250`, `1` and `256` alike:

  ```
  Router-d1(config)#ip route 10.9.0.0 255.255.0.0 10.0.0.9 250
  % "250" is not an interface on Router-d1
  % The fourth word is an interface, not a distance - this model has no per-route administrative distance (AD is per source: connected 0, static 1, OSPF 110, eBGP 20)
  % Interfaces: Gi0/0, Gi0/1, Gi0/2
  ```

  The refusal is deliberate and explains itself: this model keeps one AD per *source*, so a
  per-route distance has nowhere to live until the routing table grows a per-row field. Adding
  `[DISTANCE]` therefore touches `device.js` before it touches the parser.
- `show ip route` gains `[AD/Metric]` and a trailing `WAN` column
  (`cli.js:9426`, legend at `:9412`, `device.routesTable()` at `device.js:752`).

  The **AD column is already there** — `show ip route` prints `Prefix  AD  Gateway  Interface` and
  a connected route reads `AD 0` — so what is missing is the per-route metric, the `WAN` column,
  and a distance worth printing in the column that exists.
- `show wan summary` — the table a human actually wants:

```
WAN    Provider  Technology  Media        Down/Up        Session  AD   State
wan1   ISP-A     gpon        gpon-sc-apc  2488/1244 Mbps ipoe     1    up (chosen)
wan2   ISP-B     docsis31    docsis-31    1000/200 Mbps  dhcp     200  up (standby)
wwan0  MVNO-C    nr          5g-nr-sub6   2500/300 Mbps  ipoe     250  down: no SIM
```

UI (`web/app.js`): the link inspector (`:892-925`) gains a **Service** block
(provider, technology, down/up, session, CGNAT, IPv6 PD) editable exactly like
`lengthM` is today — `PATCH /links/:id { service }` re-validating through the
same `revalidate` path (`validation.js:476`). The device inspector gains a **WAN**
panel that lists candidates in order with the dead ones greyed and the reason
shown, plus a "Test failover" button calling the endpoint above. On the canvas,
an upstream link is drawn with its technology's colour and a dashed stroke for
cellular (there is no cable), and a router whose WAN has no default route gets a
`no upstream` badge.

---

## 5. Data model changes

### 5.1 Device spec (`devices/**/*.json`)

| Field | Where | Shape | Notes |
|---|---|---|---|
| `category: "upstream"` | device | string | new value; `registry.js:7` and `web/app.js:116`+`:127` must learn it |
| `capabilities: [..., "transit"]` | device | string | new token in `device.js:89 CAPABILITIES` |
| `"type": "cellular"` | interface | string | replaces the 53 mislabelled `wwan*` ports |
| `"class": "xgspon"` | interface | string | optional hint for the link picker's default service |
| `"sim": false` | interface | boolean | optional; a modem with no SIM cannot come up (rule `E_SIM_ABSENT`, §6.2) |
| `"track": {...}` | interface | object | optional; see §5.4 |

Nothing above is **required**, so all 878 existing specs load unchanged (C5).

### 5.2 Link (`engine/link.js`)

| Field | Type | Default | Serialized |
|---|---|---|---|
| `service` | object \| null | `null` | yes — `serialize()` at `link.js:60` |
| `state` | `'up' \| 'down' \| 'blocked'` | `'up'` | yes (already) — **now means something** |

`state` becomes authoritative in the data path, which is a behaviour change:
`_deliver()` must refuse to carry a frame across a `down` link and emit
`{type:'link-down', ...}`. Consequence for C1: a saved topology that has a link
at `state:'down'` will currently pass traffic and afterwards will not. Recommendation:
`fromJSON` keeps the value verbatim, and the release note says so; a topology in
that state is a bug in the file, not a compatibility promise.

### 5.3 `Topology.connect()` options

`{ mediaId, lengthM, duplex, lagId, patchCord }` → add `service`, `force`
(already accepted). Threaded at `topology.js:370` (verdict), `:389`
(construction), `:597-602` (restore), and accepted by `POST /links`
(`server/index.js:386-410`) and `POST /validate-link` (`:416`).

### 5.4 Device config (`device.js:157-184`)

```js
this.config = {
  // ...existing keys unchanged...
  wans: [],                  // [{ iface, id, provider, preference, distance,
                             //    session, track:{type,target,failAfter} }]
  multipath: 'primary',      // 'primary' | 'failover' | 'ecmp'
  ecmpHash: 'l3l4'           // 'l2' | 'l3' | 'l3l4'  (reuses lag.js policies)
};
this.config.routes[i] = { dest, mask, gw, iface, distance, metric };
```

**The trap:** `Device.serialize()` (`device.js:817-904`) and `Device.hydrate()`
(`:907-973`) are **white-lists**. A config key that is not named in both places
is silently dropped on save/reload — which would make `wans` and `multipath`
vanish on the first browser refresh, and the failure looks like "the UI forgot my
setting" rather than "the serializer forgot a field". Add both lines in the same
commit as the config key, and let `test/topology-roundtrip.test.js` prove it.

### 5.5 CLI grammar additions

```
ip route DEST MASK GW [IFACE]                   shipped — _ipRoute() at cli.js:3269, config mode only
ip route DEST MASK GW [IFACE] [DISTANCE]        refused by design, with a message (see below)
ip wan <iface> provider <name>                  new  (sets config.wans entry)
ip wan <iface> distance <1-255>
ip wan <iface> session <static|dhcp|pppoe|ipoe>
ip wan <iface> track <target-ip> [fail-after <n>]
no ip wan <iface> [track]
show wan summary | show wan detail <iface>
show ip route                                   AD column already ships; metric is the missing half
```

Measured on a router in this tree, not inferred from the block above. The three-word form is shipped and
needs `configure terminal` — typed at the exec prompt it answers `% Unrecognized command`, which reads like a
missing command rather than a wrong mode. The four-word form with a distance is **refused**, and the refusal
is the interesting part because IOS accepts the same line and treats the fourth word as an AD:

```
R1(config)#ip route 10.99.0.0 255.255.255.0 1.1.1.1 250
% "250" is not an interface on R1
% The fourth word is an interface, not a distance - this model has no per-route administrative distance
  (AD is per source: connected 0, static 1, OSPF 110, eBGP 20)
% Interfaces: eth0, eth1, serial1, serial2, wwan0
R1(config)#ip route 10.98.0.0 255.255.255.0 1.1.1.1
Route added: 10.98.0.0/24 via 1.1.1.1
```

So the `[DISTANCE]` work order is not "unimplemented", it is "deliberately absent, with a message pointing at
row 21". And `show ip route` already prints an AD column — the static row above reports `AD 1` at
`cli.js:9426`/`:2408` — so of the two fields this row asks for, only the metric is still missing.

---

## 6. Validation

Two levels, matching the two questions a lab asks: *can this cable be this
service?* and *does this router's set of upstreams make sense?*

### 6.1 Link level — new codes in `RULES` (`validation.js:59-142`)

Fired from `validateConnection()` after the physical verdict is settled
(i.e. after `let mate = canMate(...)` at `validation.js:553`), because a service
on an impossible cable is not worth judging.

| Code | Severity | Condition | Message shape |
|---|---|---|---|
| `E_NO_UPSTREAM` | error | `service` declared but **neither** end terminates one: no `transit` capability, category not `upstream`/`cloud`, and not an access node (`olt`, `ont`, `modem`, `splitter`) | `<a> <-> <b> declares a <kind> service, but neither end terminates one.` |
| `E_SERVICE_MEDIA` | error | the declared `technology` cannot run on the negotiated medium — `docsis31` on fibre, `gpon` on copper, `nr` on coax | `<tech> cannot arrive on <medium>; <tech> needs <family>.` |
| `E_SERVICE_RATE` | error | `downMbps`/`upMbps` exceeds the medium's class rate (`docsis-31` is 10000/1000, GPON 2488/1244) | `A <down>/<up> Mbps line exceeds what <medium> can carry (<mDown>/<mUp>).` |
| `E_ASYMMETRY_IMPOSSIBLE` | error | `upMbps > downMbps` on a medium that is physically asymmetric | `<medium> is asymmetric; an upstream rate above the downstream rate is not a service it can sell.` |
| `E_SESSION_CONFLICT` | error | `service.session = 'pppoe'\|'dhcp'` and the local interface also has a static `ip` | `... is configured for <session>, so a static address on <iface> will not survive the session.` |
| `E_CELLULAR_TO_WIRED` | error | a `cellular` cage against any non-`cellular` cage | (canMate will already refuse; this names it, mirroring `E_WIRELESS_TO_WIRED`) |
| `E_CELLULAR_NO_TOWER` | error | a `cellular` link whose far end is neither an `upstream`/`transit` device nor an access node | `A cellular radio can only associate with a base station or a provider edge.` |
| `E_SERVICE_MTU` | error | `service.mtu` below 576 (IPv4) or 1280 (IPv6 configured) | `<mtu> is below the minimum MTU for <v4/v6>.` |
| `W_SERVICE_ASYMMETRY` | warning | `downMbps !== upMbps` | `<down>/<up> Mbps is asymmetric; upstream capacity is the binding constraint for <n>% of typical traffic.` |
| `W_SHARED_MEDIUM` | warning | chosen medium has `shared: true` (`docsis-*`, `moca-*`, `homeplug-*`, `ghn*`) | `<medium> is a shared segment; this lab models it point-to-point, so contention is not simulated.` |
| `W_RATE_BELOW_MEDIA` | warning | sold rate far below the media class rate (e.g. 100M on XGS-PON) | `Selling <x> on a <class> line is legal, but nothing in the lab will show the line's real ceiling.` |
| `W_PPPOE_APPROXIMATED` | warning | `session: 'pppoe'` | `PPPoE is modelled as session state; no PADI/LCP exchange is simulated.` |

Two rules must **not** go here: anything about default routes or NAT (they are not
properties of one cable) and anything about a device's address plan. That is §6.2.

### 6.2 Topology level — new `validateUpstreams(topo)`

A new function in `validation.js`, exported through `engine/index.js`, returning
the same issue shape `{ code, message, severity, deviceId, iface }`.

It needs no change to `validateTopology()`: `collectIssues()` already flattens
nested arrays (`validation.js:797-801`), so the server calls

```js
validation.validateTopology([ linkIssues, validation.validateUpstreams(topo) ])
```

and counts come out right.

| Code | Severity | Condition | Why it matters |
|---|---|---|---|
| `E_DEFAULT_NO_EGRESS` | error | a default route whose `gw` is on no connected subnet **and** has no `iface` — `egressFor()` returns null | guaranteed `drop: no usable egress interface` on every packet |
| `E_WAN_SUBNET_OVERLAP` | error | two WAN interfaces' subnets overlap | source selection and return path both break |
| `E_WAN_SAME_GATEWAY` | error | two WANs resolve to the same next hop | two routes over one cable is not multihoming |
| `E_TRACK_TARGET` | error | a `track` target is only reachable via the route being tracked | a tracking loop that fails on the first packet |
| `E_CGNAT_PORTFORWARD` | error | a static NAT / port-forward rule on a WAN whose `service.cgnat` is true | inbound cannot work by construction |
| `E_WAN_NO_DEFAULT` | error | an interface with `role:'wan'` and an IP, and no default route at all | its LAN is islanded |
| `E_NAT_EGRESS_MISMATCH` | error | a PAT rule's `insideGlobal` is not an address on any WAN that `routeCandidates()` would choose for the rule's outside scope | the current NAT ordering cannot see this yet — see §8 "Risks", item 3 |
| `W_DEFAULT_SHADOWED` | warning | two default routes with **equal** AD and metric and `multipath !== 'ecmp'` | **the exact bug the probe found**: one of them can never be selected |
| `W_FLOATING_STATIC` | warning | a backup default with higher AD, and the primary has no `track` and no protocol | it can only take over on a physical link-down — say so |
| `W_SINGLE_HOMED` | warning | a device with `transit`/`upstream` capability and exactly one WAN | legal; but the lab cannot demonstrate failover |
| `W_PROVIDER_SAME` | warning | both default routes resolve to links with the same `service.provider` | a dual-homed lab that shares one provider has not removed the single point of failure |
| `W_WAN_NO_SERVICE` | warning | a WAN interface cabled to an upstream device, with no `service` on the link | today's labs land here — must stay a warning, never an error (C4) |
| `W_IPV6_PD_NONE` | warning | IPv6 configured on the LAN, but no upstream `service.ipv6.pd` | the LANs have v6 with nothing to route it to |
| `E_SIM_ABSENT` | error | a `cellular` interface declared `"sim": false`, or with no `imsi`, carrying a service | the radio is licensed, registered and billed through a SIM; without one the line is up and dead |

Severity rules of thumb used above, deliberately: **error** only when the
configuration cannot work at all; **warning** when it works but the lab will
mislead. `W_WAN_NO_SERVICE` being a warning is what keeps every existing lab
silent-and-valid.

---

## 7. Code anchors

Every edit this design needs, by function (not just line — see the header).
Rows marked ✅ are implemented; the rest are still the work order.

The six cellular-cage rows were built for issue #129 as a prerequisite, with one deliberate
deviation from this design: the cage is `wwan` and it mates with nothing. See row 3.

**Reading the Anchor and Today columns.** They answer different questions and are maintained
differently. *Anchor* names the symbol and the line it sits on **in this tree** — `CAGES` is at
`media.js:314` today, not at 157, because `MEDIA` above it grew by four wireless entries and pushed
everything down. The header used to say "at `d399dff`", which contradicted that sentence and was never
true of this column: re-measured row by row on the current tree, the eleven `media.js` anchors are still
exactly where this page put them (`MEDIA` 54, `CAGES` 314, `CAGE_MATE` 413, `cagesMate()` 455,
`CAGE_MEDIA` 486 with `wwan` 489 / coax 609 / dsl 617 / powerline 622, `CAGE_SPEEDS` 642, `inferCage()`
767, `derivePortHardware()` 875, `canMate()` 1230), while every anchor outside that file had slid
— `simulator.js` by as much as 1,900 lines, `validation.js`, `topology.js`, `link.js`, `device.js` and
the two `cli.js` rows by between 4 and 2,000 — so the column was a mixture of today and of the tree the
page was written on. The numbers below are the measured ones.

One anchor moved under its own row's meaning: row 21's static loop no longer hard-codes `ad: 1`. It
scores `Device.ADMIN_DISTANCE.static` at `device.js:571`, so the *Today* column's "`ad: 1` hard-coded"
is history — but the numeric-distance override the Change column asks for (`numOr(r.distance, 1)`) is
still absent, which is why the row stays a work order rather than a tick.

Recount any of it in one line:

```sh
grep -n "^const CAGES\|^const CAGE_MATE\|^const CAGE_MEDIA\|^const CAGE_SPEEDS" engine/media.js
grep -n "^function inferCage\|^function derivePortHardware\|^function canMate" engine/media.js
```

*Today* is a **snapshot of the tree this design was written against** (`d399dff`): "19 cages",
"64 media, 8 families". Those numbers are deliberately frozen — they are the before-picture the
migration is measured from, and rewriting them as `CAGES` grows would erase the evidence that the
work was needed. Today's tree has 26 cages and 89 media; `docs/CONNECTORS.md` carries the live count
and its own recount one-liners.

**Re-measured at `405c4138`, the whole table at once: all thirty-five anchors still land.** The eleven `media.js`
ones are where they were (`MEDIA` 54, `CAGES` 314, `CAGE_MATE` 413, `cagesMate()` 455, `CAGE_MEDIA` 486,
`CAGE_SPEEDS` 642, `inferCage()` 767, `derivePortHardware()` 875, `canMate()` 1230), and the ones that had
slid when this paragraph was last rewritten — `simulator.js`, `validation.js`, `topology.js`, `link.js`,
`device.js`, `server/index.js`, `web/app.js`, `devices/registry.js` and the two `cli.js` rows — have stayed
put since. Thirty-four match the named symbol inside a ±2-line window; the thirty-fifth (`cli.js:2408 show ip
route`) matches on content rather than spelling, because the line there renders the `Prefix AD Gateway
Interface` table rather than containing the words.

Re-swept on 2026-11-12 across the **whole page** rather than just that table: **87** file-and-line citations, every
one of them landing on the symbol or content its row names. The three `registry.js:7` citations are
`devices/registry.js`, not an `engine/` file, which is why a sweep scoped to `engine/ server/ web/` reports them
missing.

The `HEAD`-versus-worktree question that used to hang over the `cli.js` citations on this page is settled, and worth
stating with a threshold: the writer's uncommitted `engine/cli.js` work starts at the hunk on line **9,688**, and the
highest `cli.js` line this page cites is **9,426**, so all three (`:2408`, `:3269`, `:9426`) are identical in both and
the caveat applies to nothing here. Citations past ~9,700 in that file would need the worktree, which is why
[ROADMAP.md](ROADMAP.md) records the eight-line offset at `_helperAddress`.

The *Today* column's other counts are frozen with it, which is worth saying because two of them have moved
and a reader should not take them for the current tree: `device.js:157 config` has **18** keys now, not 17 —
`scionAs` (SCION ISD-AS membership) is the addition — and a `Link` owns **12** fields, not 8, because
`lagId`, `patchCord`, `state` and `stateSinceMs` have landed since. `validation.js:59 RULES` is still
exactly **20** codes and `device.js:89 CAPABILITIES` still exactly **15** tokens, so the frozen column is not
uniformly stale: it is a snapshot, and three of its numbers happen to still be true.

| # | Anchor (this tree) | Today | Change |
|---|---|---|---|
| 1 | `MEDIA` at `media.js:54` | 64 media, 8 families | ✅ done (#129): `lte`, `lte-a`, `5g-sub6`, `5g-mmwave` |
| 2 | `CAGES` at `media.js:314` | 19 cages | ✅ done (#129): added as **`wwan`**, not `cellular` — the name says what the port is, not what technology happens to use it |
| 3 | `CAGE_MATE` at `media.js:413` | `antenna:['antenna']` | ✅ done **differently**: `wwan` mates with **nothing**, including itself. Two 5G modems in a lab are two subscribers to a network neither contains, not a cable between them — `['cellular','cellular']` would have let a lab draw that link |
| 4 | `CAGE_MEDIA` at `media.js:486`, coax `:609` / dsl `:617` / powerline `:622` / wwan `:489` | coax/dsl/powerline/antenna fns | ✅ done (#129): the `wwan` fn offers the generations the rate can reach, and always at least `lte` |
| 5 | `CAGE_SPEEDS` at `media.js:642` | per-cage speed fns | ✅ done (#129): `[maxMbps]` — the modem's category **is** the rate |
| 6 | `inferCage()` at `media.js:767` | no cellular branch | ✅ done (#129): name-first (`wwan*`, `wan5g`, `lte*`, `nr5g`, `modem*`), checked **before** the wireless-type rule that was claiming these ports for Wi-Fi |
| 7 | `derivePortHardware()` at `media.js:875` | `cage==='antenna'` band special-case | **no change** — verify cellular is not caught |
| 8 | `canMate()` at `media.js:1230`, `cagesMate()` at `:455` | 3-test ladder | **no change** — service checks live in validation |
| 9 | `validation.js:59 RULES` | 20 codes | +12 (§6.1); `SEVERITY_BY_CODE` at `:144` follows automatically |
| 10 | `validation.js:553 let mate = canMate(...)` | physical verdict only | insert service checks after this block, before medium selection at `:588` |
| 11 | `validation.js:885 validateTopology()` | takes a flat/nested issue list | **no change** — pass a second array |
| 12 | `validation.js:904` exports, `engine/index.js:11,28` | `{ validateConnection, validateTopology, RULES }` | add `validateUpstreams`, `SERVICE_TECHNOLOGY` table |
| 13 | `link.js:9 constructor` / `:60 serialize()` | 8 fields | add `service` |
| 14 | `topology.js:122 validateLink()` | passes mediaId/lengthM/patchCord | pass `service` |
| 15 | `topology.js:347 connect()` / `:389 new Link()` | 7 opts | thread `service` |
| 16 | `topology.js:554 serialize()` / `:570 fromJSON()` / `:599` the link restore | link fields | carry `service` |
| 17 | `topology.js:415 setLinkLength()` | only length is editable | generalise to `patchLink(id, {lengthM, service})` |
| 18 | `device.js:89 CAPABILITIES` | 15 tokens | add `'transit'` |
| 19 | `device.js:157 config` | 17 keys | add `wans`, `multipath`, `ecmpHash` |
| 20 | `routeTo()` at `device.js:545` | one route, `better()` closure | add `routeCandidates()`, keep `routeTo()` as wrapper |
| 21 | `device.js:560-574` static loop | `ad: 1` hard-coded | `ad: numOr(r.distance, 1)`, `metric: numOr(r.metric, 0)` |
| 22 | `device.js:606-612` default gateway | `if (!best)` fallback, ad 254 | becomes a candidate in the list |
| 23 | `device.js:738 egressFor()` | first interface in subnet | keep; add `isInterfaceUsable()` for liveness |
| 24 | `device.js:752 routesTable()` | no AD/metric | add `ad`, `metric`, `wan` columns |
| 25 | `device.js:817 serialize()` / `:907 hydrate()` | white-list | add the three config keys — **both** |
| 26 | `simulator.js:3314 _deliver()` | checks `enabled` + `peer` | also `link.isUp()`, emit `link-down` |
| 27 | `simulator.js:3080 _sendIcmp()`, `:3142 _sendTransport()` | `routeTo()` once | candidate loop + `wan-select` |
| 28 | `_forwardL3()` at `simulator.js:3699` (`routeTo()` at `:3717`) | `routeTo()` once | candidate loop; **move NAT after the route** or flag it (§8) |
| 29 | `simulator.js:3920 pathMtu()`, `:3909 _pickDestIp()`, `:4081 openFlow()` | single route | use `routeTo()` (unchanged) — they want *a* path, not the preferred one |
| 30 | `simulator.js:256 _emit` / `:169 reset()` | 40-odd event types | 4 new types; `trackState` map in `reset()` |
| 31 | POST `/links` at `server/index.js:386`, POST `/validate-link` at `:416` | 5 fields | `service`; new `/upstreams`, `/failover-test` |
| 32 | `cli.js:3269 ip route` | `[iface]` only; a numeric fourth word is refused | `[distance]` |
| 33 | `cli.js:2408 show ip route` | `Prefix AD Gateway Interface` (AD per source) | per-route metric, WAN column; new `show wan` |
| 34 | `web/app.js:115-130` palette labels, `:973` inspector open, `:1613` its State row | no service UI | Service block, WAN panel, failover button |
| 35 | `devices/registry.js:7`, `web/app.js:116` (labels) and `:127` (order) | 10 categories | add `upstream` |

---

## 8. Phased plan

Each phase is shippable, each phase ends with the suite green, and no phase
requires a later phase to be correct.

### P0 — baseline gate (no behaviour change)

Add `test/upstream-baseline.test.js` asserting **today's** facts, so that every
later phase has something to break:

- two equal static defaults → `routeTo()` returns the first;
- `Link.state='down'` does not stop a frame (`_deliver` ignores it);
- `generic-cloud` has one port, cage `rj45`;
- a `wwan0` port resolves to `antenna`;
- `upstreamMbps` is present on the media entry and absent from every code path.

*Tests:* the new suite; `npm test` unchanged.

### P1 — cellular family + provider edge + catalogue migration

Media entries, cage, mate table, `inferCage`, `generic-transit.json`, the 53-port
`type: cellular` migration, the audit rule.

*Tests:* extend `cable-matrix.test.js` with the `cellular` rows (cellular↔cellular
OK; cellular↔antenna / ↔rj45 / ↔sfp+ refused with a code and a message);
`hardware-invariants.test.js` gains `cellular → cellular`; `audit:ports` clean;
a new assertion that all 57 existing media mate exactly as before (the C2 guard);
`missing-devices.test.js` still loads the catalogue.

### P2 — `link.service` + link-level validation

Field on `Link`, plumbing through `connect`/`serialize`/`fromJSON`/API, the 12
codes from §6.1, UI service step in the picker, Service block in the inspector.

*Tests:* service round-trips through `topology-roundtrip.test.js` (P2 gate: a
topology with three different services saves and reloads byte-identically); a
table-driven `test/upstream-service.test.js` where every code fires once and each
near-miss does not; `validate-link` API returns them in `verdict.errors`;
`ui-dom-contract.test.js` finds the new fields; `cable-length.test.js` unaffected.

### P3 — route candidates, AD, metric

`routeCandidates()`, `distance`, `metric`, `show ip route` columns,
`W_DEFAULT_SHADOWED`, `E_DEFAULT_NO_EGRESS`. **No failover yet** — a shadowed
default is *reported*, not fixed.

*Tests:* an ordering table (prefix beats AD, AD beats metric, metric beats name);
a floating static is present but not selected; `show ip route` golden output;
`W_DEFAULT_SHADOWED` fires on the two-equal-defaults lab and stays silent under
`multipath:'ecmp'`; the P0 baseline test flips its two-default assertion, which is
the point.

### P4 — liveness and failover

`Link.state` in `_deliver`, `isInterfaceUsable`, `track` objects, `wan-select` /
`wan-failover` / `wan-dead` events, `/failover-test`, the WAN panel.

*Tests:* the four-case matrix from §1.1 becomes four assertions (down link →
`wan2` used; disabled interface → `wan2` used; dead tracking target → `wan2` used
and `wan-failover` emitted with `reason:'track-failed'`; no track + silent far end
→ **still `wan1`**, because that is what real gear does); flow affinity (a flow
opened on wan2 stays on wan2 after the primary returns); ECMP determinism (same
tuple → same bucket across two runs, different tuples spread); `wan-select`
schema; `/failover-test` does not mutate the topology (compare `serialize()`
before/after).

### P5 — topology validation, NAT egress awareness, console

`validateUpstreams`, `E_NAT_EGRESS_MISMATCH`, NAT moved after routing behind
`nat.egressAware`, `show wan`, the no-upstream badge.

*Tests:* each §6.2 code fires once; `validateTopology([links, upstreams])`
counts both sources; a dual-WAN flow's `nat-outbound` uses **the egress WAN's**
address when `egressAware` is on and the rule's `insideGlobal` when it is off
(the approximation is asserted, not hidden); `E_CGNAT_PORTFORWARD` refuses a
port-forward on a CGNAT line; `show wan summary` golden output.

### P6 — docs and examples

`docs/PHYSICAL_LAYER.md` §2 (families) and §3 (mate ladder) gain cellular;
`docs/ARCHITECTURE.md` gains an "Upstream and multihoming" subsection next to
"Transport flows"; `examples/build-examples.js` gains `lab5-dual-homed-edge.json`
(fibre primary, cable backup, cellular third, one failing over in the log);
`README.md` feature list.

*Tests:* `examples` script round-trips every lab; the new example's ping log is
asserted to contain one `wan-failover`.

### Risks this plan carries

Ranked by how much of the tree they can break, with the mitigation each phase
already contains.

**1. `routeTo()`'s return shape (P3).** It is the routing brain for pings, flows,
path MTU, destination-IP picking and the CLI, and every one of those call sites
assumes "one route or null". The mitigation is structural: `routeCandidates()`
carries the new logic, `routeTo()` becomes `return routeCandidates(dst)[0]`, and
C3's six call sites are untouched. The risk that remains is *silent*: a caller
that should have used the candidate list keeps using the first route and never
fails over. Guard: P4's four-case matrix asserts on the **egress port**, not on
`routeTo()`'s return, so a stale caller shows up as a wrong port.

**2. Making `Link.state` authoritative (P4).** `_deliver()` currently ignores it,
so any topology — or test fixture, or example — that stores `state: 'down'`
starts carrying different traffic than it did yesterday. This is the one change
that can make a previously working lab "break" without anyone editing it. The
mitigation: `state` stays `'up'` by default everywhere, only an explicit `'down'`
or `'blocked'` is dead, and every file in `examples/` plus
`test/topology-roundtrip.test.js` must pass before the phase closes. If any
example turns out to carry a `down` link, that is a fixture bug and gets fixed in
the fixture, not by weakening the rule.

**3. NAT runs before routing (P5).** `_forwardL3()` calls `_natOutbound()`
(~`1898`) *before* `dev.routeTo()` (~`1904`), and `nat.translateOutbound(table,
pkt, step)` takes no interface argument at all — so on a dual-homed edge the
inside global is whatever the rule says, regardless of which WAN the packet then
leaves by. Fixing the ordering changes `test/nat.test.js` expectations, which is
why it is behind `nat.egressAware` and lands after failover, with
`E_NAT_EGRESS_MISMATCH` arriving in the same phase rather than warning about a
fault the engine cannot yet produce.

A fourth, smaller trap: `Device.serialize()`/`hydrate()` are white-lists (§5.4),
so a new config key silently disappears on reload. It is not a *high* risk — it
is a high *annoyance* — and the mitigation is one line in each function in the
same commit as the field.

---

## 9. What is approximation, and what a reader must not conclude

This is the section to read before believing a screenshot.

1. **Shared segments are point-to-point.** DOCSIS, MoCA, G.hn and the DSL binder
   are all `shared: true` in the catalogue and all modelled as one cable. There is
   no contention, no oversubscription ratio, no upstream scheduler. A 1000/200
   DOCSIS class is a *rate*, not a promise that a neighbour halves it.
2. **PON split ratio affects loss, not capacity.** `optical.ponBudget()` already
   budgets the splitter; nothing schedules. No DBA, no GEM ports, no OMCI.
3. **Cellular has no RF.** The "link" to a tower is a drawing of an association.
   No RSRP/SINR, no cell load, no handover, no carrier aggregation, and — the
   obvious one — **a modem has no cable**. `maxRangeM: null` says so. Cabling to a
   `nr0` port is a UI convenience, and the dashed stroke is the honest part.
4. **The headend on coax and DSL is the PoP port itself.** There is no CMTS,
   DSLAM or BNG in the catalogue (43 modems are all CPE, 30 OLTs are all PON), so
   a DOCSIS service terminates on `generic-transit/coax0` standing in for a CMTS.
   Nothing downstream of that port is modelled — no service group, no upstream
   scheduler, no line card. A PON lab can be built fully (ONT + OLT are real
   models); a coax or DSL lab cannot, yet.
5. **DSL rate is a fixed class, not a function of loop length.** Real VDSL2 falls
   off with distance; here 300 Mbps is 300 Mbps at 10 m and at 1000 m. The engine
   *has* `lengthM` and could derive it — deliberately out of scope, because a
   derived rate would need a per-vendor attenuation model and would be wrong in a
   more convincing way than a flat class.
6. **Failover is cause-driven, not time-driven.** There are no timers, no
   hold-down, no BFD intervals, no route dampening. "Failover in 3 s" cannot be
   expressed; the switch happens on the next packet of the same run. A lab can
   prove *that* traffic moved, never *how fast*.
7. **A static default does not fail over to a silent far end.** With no `track`
   object, only the interface or link going down moves traffic. That is true of
   real hardware and it is why `track` exists — but a reader who expects ARP
   magic will be surprised in the good direction.
8. **PPPoE is a flag.** No PADI/PADR/PADS, no LCP/CHAP, so "my PPPoE session
   won't come up" cannot be diagnosed — only "this line is declared PPPoE".
9. **Prefix delegation is a number.** `service.ipv6.pd: 56` is metadata; there is
   no DHCPv6-PD exchange. The LAN's v6 addressing still comes from RAs
   (`engine/ra.js`).
10. **CGNAT is a prohibition, not a translation.** The carrier's NAT is outside the
   lab; the flag only makes inbound port-forwards impossible to get right, and
   says so at validation time.
11. **AD values are a convention** (connected 0, static 1, eBGP 20, OSPF 110, iBGP
    200, default-gateway 254) that mirrors Cisco's. They are compared only among
    routes this engine learns; OSPF and BGP still install a single best path even
    under `multipath:'ecmp'` — multipath across *protocols* is not in this design.
12. **ECMP is per-flow hashing of a synthetic tuple.** No per-packet spraying, and
    no rehash-on-failure beyond "recomputed on the next run".
13. **Rate is metadata, not simulation.** A 10G PON and a 100M VDSL2 cost the same
    step. `upstreamMbps` stops being dead data in P2 but it never becomes a
    bottleneck model. `engine/flow.js` has byte counters; using them to *pace* a
    flow is a separate design.

What this design *does* claim: every upstream a real edge can have is now
expressible, cabled through the medium it really uses, and the routing decision
over several of them is inspectable, testable and honest about when it will and
will not fail over.

---

## 10. Alternatives considered and rejected

| Alternative | Why not |
|---|---|
| Give `generic-cloud` six ports and stop there | Fixes the symptom (a port to cable to) and none of the cause: no service data, no two-provider lab, no multihoming, and it silently changes a shipped device other topologies point at |
| Model "the internet" as an implicit prefix (`0.0.0.0/0` always exists) | Removes the cable that `validateConnection()` exists to judge, and makes "no upstream" indistinguishable from "upstream down" |
| A new `Link.type: 'upstream'` | `type` is the legacy string that says 'media' (`link.js:23`, `topology.js:221`); it is not what distinguishes an upstream. Two DOCSIS links differ by *service*, not by type |
| Put the service on the interface instead of the link | Re-cabling loses it, and one router cannot hold two lines from one provider. `lengthM`/`patchCord` already set the precedent the other way |
| Reuse the `antenna` cage for cellular | Wi-Fi and LTE would share a cage, so the refusal would be `E_NO_COMMON_MEDIA` ("no shared medium") instead of naming the real problem, and `derivePortHardware`'s band logic (`cage === 'antenna'`) would have to learn an exception |
| Derive WAN liveness from ARP by default | Teaches a behaviour real static routing does not have. Opt-in `track` is the honest version |
| One cloud device per family (`cloud-pon`, `cloud-docsis`, …) | Six palette entries for one concept, and no way to express "the same ISP, two technologies". The multi-port PoP plus the existing OLT/CMTS/DSLAM/ONT hardware covers the real ladder |
| Make `routeTo()` return an array | Breaks 6 call sites in `simulator.js` and C3. `routeCandidates()` + a wrapper costs nothing and lets each caller opt in |

---

## 11. Decisions needed before implementation

1. **`inferCage` vs spec migration (P1).** Recommendation: migrate all 53 ports to
   `type:"cellular"` **and** keep the name heuristic as a safety net, gated by the
   new audit rule. Alternative — heuristic only — leaves the specs lying.
2. **`role: 'wan'` mandatory or inferred?** Recommendation: a link with a
   `service` implies a WAN role for validation purposes; `interface.role` stays
   for UI grouping and dual-role cages (`test/port-roles.test.js` must keep
   passing untouched).
3. **Is `service` editable after `connect()`?** Recommendation: yes, via a
   generalised `setLinkLength()` (`topology.js:415` → `patchLink`), because
   "I bought a faster line" is the most common change a lab needs.
4. **Where does `E_NAT_EGRESS_MISMATCH` live before NAT is egress-aware?** It can
   only be a *prediction* while `_forwardL3` translates before routing.
   Recommendation: ship it in P5 together with the `nat.egressAware` flag, not
   earlier — a warning about a fault the engine cannot yet have is noise.
5. **Does a cellular link count as "cabled" for `E_PORT_IN_USE`?** Recommendation:
   yes — one association per radio, one cable per port, same rule. A modem with
   two SIMs is two interfaces, not two links on one.
