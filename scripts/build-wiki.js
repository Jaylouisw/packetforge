'use strict';
// Wiki page sources live in the repo (docs/wiki) and are pushed to the Forgejo wiki by
// scripts/publish-wiki.js. The wiki is a separate git repository, so the pages are kept
// here where they can be reviewed in a PR like any other documentation change, and
// published with one command.
//
// Usage: node scripts/build-wiki.js   (writes docs/wiki/*.md from this list)
//        node scripts/publish-wiki.js (pushes docs/wiki to the wiki repo)
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'docs', 'wiki');

const pages = {};

pages['Home.md'] = `# PacketForge wiki

An open-source, vendor-agnostic network simulator: build a topology out of real hardware
models, cable it with parts that exist, and find out what the packet actually does.

- **[Getting started](Getting-Started)** - clone, run, build your first lab in five minutes.
- **[Requesting hardware](Requesting-Hardware)** - a device is missing? This is how it gets added, and how you know it is accurate.
- **[Simulation fidelity](Simulation-Fidelity)** - what the engine really does, what it approximates, and what it does not do at all.
- **[Contributing](Contributing)** - the rules that keep the catalogue honest.

## What this project is for

Cisco Packet Tracer teaches Cisco. PacketForge aims at the thing a lab actually needs:
**any** vendor's box, modelled at the level where engineering decisions live - which cage is
on which port, which optic mates with which ferrule, what a cable that cannot exist would
mean if it did.

The catalogue holds **1,661 device models from 247 vendors**, from ONTs and OLTs to PTP radios,
switches, servers, printers, cameras and phones. It is JSON: one file per model, no code
changes to add one. \`node scripts/audit-devices.js\` prints that count on its first line, so the
number is a command rather than a memory.

## The two questions the project answers

**"Can I cable this?"** Every link is checked against the physical layer: connector, cage,
media, speed negotiation, ferrule polish, optical budget, cable length. A cable that cannot
exist is refused with a reason, not silently allowed.

**"What happens then?"** ARP, IPv4/IPv6 (including SLAAC), ICMP, VLANs, LAG, STP, LLDP, port
security, DHCP, NAT, ACLs, VRRP, OSPF, BGP and DNS in the data path, with per-hop latency --
and transport flows, which let you aim a specific TCP or UDP flow at a destination and read back
which rule or missing route stopped it.

SCION is the exception in that list, and it is worth knowing before you build a lab around it:
what is modelled is the **path**, not the traffic. \`pingScion()\` computes beacons, composes
UP/CORE/DOWN segments and picks a winner by hop count or latency, and it emits \`scion-path\` /
\`scion-hop\` events — but it puts **no frames on the wire** and never consults the routing table,
so it answers "is there a beaconed path, and which one wins" rather than "does a packet traverse
it". [Simulation-Fidelity](Simulation-Fidelity) carries the citation for that.

If the documentation ever disagrees with the code, [Simulation-Fidelity](Simulation-Fidelity)
is the one that is right.
`;

pages['Getting-Started.md'] = `# Getting started

PacketForge has **no runtime dependencies**. Node 18 or newer and a browser is the whole
list - no npm install, no Docker, no database.

\`\`\`bash
git clone https://git.jayw.uk/jaylouisw/packetforge.git
cd packetforge
node server/index.js          # http://localhost:8000
\`\`\`

Nothing to install: the server serves the UI from \`web/\` and keeps topologies as JSON files.

## Your first lab

1. Drag two hosts and a switch out of the palette onto the canvas.
2. Click a port, then click the port on the other device. The cable is checked before it is
   made - if the two cages cannot meet, you get the reason instead of a broken link.
3. Open a host's config and give it an address; give the other host an address in the same
   subnet.
4. Use **ping** from one host to the other.

If ping works, ARP resolved, the switch learned, and the frames went both ways - the packet
animation shows the path.

## Things worth trying early

- **A cable that should be impossible.** Mate an SC/UPC PON port to an SC/APC one. It
  refuses, and names the hybrid patch cord that resolves it, by part number.
- **A slower optic than the port allows.** Put a 1G SFP in a 10G SFP+ cage: the link comes
  up at 1G, because that is what would happen.
- **\`npm run smoke\`** - drives the HTTP API end to end, the way the UI does. It spawns its own
  server on a free port with a throwaway data directory, so it is safe to run while your own lab
  is open, and it touches nothing on disk.

## Where things live

| Path | What it is |
| --- | --- |
| \`devices/\` | the catalogue: one JSON file per model |
| \`engine/\` | the simulator: physical layer, L2/L3, routing, protocols |
| \`web/\` | the canvas UI, plain JavaScript, no build step |
| \`docs/\` | architecture, CLI, registry format, and the honest capability matrix |
| \`examples/\` | runnable labs |
`;

pages['Requesting-Hardware.md'] = `# Requesting hardware

The catalogue is the project. If a device is missing, that is a bug and we want it filed.

## How to ask

Open a **[device request](https://git.jayw.uk/jaylouisw/packetforge/issues/new?template=device_request.yml)**
with:

- **vendor and exact model number** - the string printed on the box, e.g. \`CRS326-24G-2S+RM\`
- **a link to the vendor's own documentation** - the datasheet or hardware guide, not a shop page
- **which ports you actually care about**, if not all of them

That is enough. You do not need to write JSON.

## What happens next

1. The request is checked against the vendor's documentation: port counts, connector per
   port, speed ladder, PoE budget, and anything the box claims that a simulator must respect.
2. A spec is written as \`devices/<vendor>/<model>.json\`, and three things check it before it
   can merge. \`scripts/audit-port-types.js\` runs first inside \`npm test\` and walks every port
   with **twelve rules** (\`unknown-cage\`, \`copper-connector-fibre-cage\` and
   \`fibre-connector-copper-cage\`, \`ethernet-not-data\`, \`pon-not-optical-connector\`,
   \`console-not-console\`, \`coax-not-coax\`, \`dsl-not-dsl\`, \`powerline-not-powerline\`,
   \`wireless-not-antenna\`, \`template-undeclared-hardware\`, and \`port-name-declared-twice\`)
   and refuses to let a red finding reach the test runner at all. The last one is the quiet
   one: the expanded port list puts \`portTemplate\` ports first and explicit \`interfaces\`
   after, and the interface map is keyed by name -- so an explicit port that reuses a name the
   template already generated leaves a device one port short, with the earlier declaration
   silently absorbed. Only that rule can see it: the catalogue invariant reads
   \`spec.interfaces\`, and a template name is not in there.
   Then \`test/hardware-invariants.test.js\` runs over the whole
   catalogue, not a fixture, with **25 assertions** named for the mistake that caused each one
   (\`no port is declared twice in a spec\`, \`every combo pair names its partner symmetrically\`,
   \`every ethernet port has at least one usable medium\`, \`no port claims a line rate its cage
   cannot carry\`, \`no optical cage accepts a copper medium\`, \`no device has zero interfaces\`).
   \`test/spec-vs-description.test.js\` reads the prose against the ports and fails on a device
   that promises ports or PoE it does not have.
3. The spec records the datasheet URL it was built from, so a later reader can check the claim
   rather than trust it. It is **recommended, not enforced**: 1,313 of the 1,661 specs carry a
   \`sourceUrl\` and 20 more carry the older \`source\` spelling, so 1,333 point at a datasheet
   somewhere; the remaining 328 are tracked as missing rather than refused. Those three numbers
   move as the catalogue grows, so re-count rather than quote -- \`grep -rl\` counts files, not keys, and
   overcounts by 24 on this tree, because a few specs mention the key in a note. Measure that overcount
   against the 1,313 key count, not the 1,333: listing the files under devices that mention the key prints
   1,337, and 1,337 - 1,313 is the 24 quoted here. Comparing the grep total with 1,333 instead makes a
   correct claim look wrong by twenty, which is how it reads the first time:

   \`\`\`bash
   node -e "const l=require('./devices/registry').loadCatalog(require('path').resolve('devices')).filter(d=>!d.error);const u=l.filter(d=>d.sourceUrl).length,o=l.filter(d=>!d.sourceUrl&&d.source).length;console.log(l.length,'specs,',u,'sourceUrl,',o,'source,',l.length-u-o,'neither')"
   # 1661 specs, 1313 sourceUrl, 20 source, 328 neither
   \`\`\`

## What "accurate" means here

A device is modelled port by port, not by marketing category:

- the **connector** each port really has (RJ45, SFP, SFP+, SFP28, QSFP28, SC/APC, coax, ...)
- the **speeds** it really negotiates, including the ones the datasheet omits
- **shared and combo ports** - an RJ45/SFP pair is one port position, not two ports
- **PoE**: which ports are PSE, the per-port limit and the total budget

Where a datasheet genuinely does not say something, the spec records that it is unknown
rather than filling the gap with a plausible number. A simulator that guesses teaches the
guess.

## If it is not in the catalogue at all

Some things are out of scope on purpose: anything that cannot be described by ports and
links. Everything else - printers, cameras, TVs, phones, smart meters, EV chargers - is fair
game, and increasingly already there.
`;

pages['Simulation-Fidelity.md'] = `# Simulation fidelity

The authoritative, file-and-line-cited answer lives in
**[docs/SIMULATION.md](https://git.jayw.uk/jaylouisw/packetforge/src/branch/main/docs/SIMULATION.md)**,
which is written from \`engine/*.js\`. This page is a summary; when the two disagree, that one
is right.

## Modelled

- **Physical layer**: cages, media, transceivers, ferrule polish (UPC/APC), optical budget,
  cable length, speed negotiation, PoE.
- **Layer 2**: MAC learning, VLANs (access/trunk/native, voice VLAN), LAG, STP, LLDP,
  port security with its violation modes and aging (\`switchport port-security …\`, \`clear port-security\`).
- **Layer 3**: IPv4 and IPv6, ARP/ND, ICMP, static routes, longest-prefix match, IPv6 first-hop
  configuration (\`ipv6 nd ra enable|disable\`, \`ipv6 nd ra managed|other-config\`,
  \`ipv6 nd ra lifetime <s>\`, \`ipv6 nd prefix <prefix>/<len> [valid <s>] [preferred <s>]\`,
  \`ipv6 nd suppress-ra\`) with SLAAC on the hosts. Those are **global** verbs even when typed inside an
  interface block, and the prefix form wants the keywords: \`ipv6 nd prefix 2001:db8::/64 3600 1800\` is
  refused (*expected [valid <seconds>] [preferred <seconds>]*) while the same line works with the
  intervals left off. A prefix on an interface with no address inside it is never actually sent, and
  \`show ipv6 nd\` says so in a line of its own.
- **Services**: DHCP client and server, NAT (static, dynamic pool and PAT — all three translated in
  the data path and visible in \`show ip nat translations\`; static and PAT rules can be written from the
  console with \`ip nat inside source …\`, but a pool-based dynamic rule still comes from the topology
  JSON, because \`ip nat pool\` is refused), ACLs, VRRP.
- **Routing**: OSPF (areas, SPF, passive interfaces), BGP (eBGP/iBGP, split horizon).
- **Naming and overlay**: DNS, SCION.
- **Flows**: a transport flow can be opened against a destination and inspected rather than
  inferred from pings — \`flow open <dst> [port <n>] [bytes <n>] [proto tcp|udp] [sport <n>] [at <ms>]\`,
  with \`show flows\` and \`show flows counters\` reading back what the data path did.
  The instant syntax needs care. The help row writes it \`[at <ms>|converged]\`, which means \`at\` followed by
  either value. \`at converged\` is accepted by every command that advertises it, and a **bare** \`converged\`
  is accepted by the state shows — \`show ip route\`, \`show ipv6 route\`, \`show ospf\`, \`show bgp\`, \`show arp\`,
  \`show vrrp\`, \`show lldp\`, \`show dhcp binding|pool\`, \`show mac address-table\`, \`show spanning-tree\` — where
  the first line of the answer says which instant it rebuilt for. It is refused by the three commands that take a
  destination first: \`ping\`, \`traceroute\` and \`flow open\`, and \`traceroute\`'s refusal lists \`converged\`
  among the values it expects while rejecting it. The command
  is also **exec-only** — typed in configuration mode it answers \`% Unrecognized config command\`, and \`do flow open\`
  is refused too, because \`do\` carries reads only. A refused flow
  names its code, which is the difference between "it did not work" and "here is which rule or
  missing route stopped it".

## Approximated

Documented in the matrix, with the reason. Two worth knowing before you build a lab around
them: convergence **is** timed - STP listening/learning, OSPF hello plus the SPF hold, VRRP
master-down and the DHCP exchange all have durations, and the schedule re-bases from the instant
a cable is pulled - but a question is answered *as of* an instant, so no hello is ever lost and
no timer ever expires on its own. Queueing is not modelled: a link is either passing traffic or
it is not.

## Not modelled

Also listed there, in full. If a feature is not in the matrix, assume it is not modelled and
ask [in an issue](https://git.jayw.uk/jaylouisw/packetforge/issues) rather than assuming.
`;

pages['Contributing.md'] = `# Contributing

The most useful contribution is a **device spec**, and it does not require touching code.

## Adding a device

1. Copy an existing file in \`devices/<vendor>/\` with a similar shape.
2. Fill in what the vendor's documentation states, and record the documentation URL.
3. Run the gates:

\`\`\`bash
node test/hardware-invariants.test.js
node scripts/audit-port-types.js
node scripts/syntax-check.js
node scripts/check-control-bytes.js
node scripts/check-node-surface.js
node scripts/check-canonical-urls.js
\`\`\`

Those two are the gates that ask questions only a spec can answer — 25 invariants over the catalogue and a
contradiction sweep ("No port contradicts its declared type."). The last four are the cheap checks CI runs
first, and two of them can bite a spec: \`node scripts/check-control-bytes.js\` refuses a stray control
byte, which is what a copy-paste out of a PDF can leave behind, and \`node scripts/check-canonical-urls.js\` refuses
a project URL that is not \`https://git.jayw.uk/jaylouisw/packetforge\`, which is easy to paste in from a
mirror. The other two — \`check-node-surface.js\` and \`syntax-check.js\` — are about JavaScript and
rarely fire on a JSON-only change. See \`docs/CI.md\` for the full list; green locally is not the same as
green in CI unless you ran the same set.

4. Open a PR. Say which datasheet you used, and say anything the datasheet does not answer.

## The rules that keep the catalogue honest

- **Never invent a port to make a count come out right.** If a datasheet says eight ports and
  the model has six, say so in the PR rather than adding two.
- **Never remove a port you cannot disprove.** Absence of evidence is not a correction.
- **A shared port position is one port.** An RJ45/SFP combo pair is a single position with
  two possible connectors, not two ports.
- **Unknown is a value.** If the PoE budget or the speed ladder is genuinely unpublished, say
  it is unknown; do not infer it from the model name.
- **A test that has to change to fit your change is telling you something.** Read it before
  you edit it.

## Code contributions

\`engine/\` is plain CommonJS with no dependencies, and every feature has a suite that asserts
behaviour rather than implementation. Before opening a PR:

\`\`\`bash
npm test        # two guards, then every suite
npm run smoke   # 18 checks, the HTTP API end to end
\`\`\`

If the change makes a documented limitation untrue, update \`docs/SIMULATION.md\` in the same
PR - the matrix is a promise about the engine, and a stale one is worse than none.
`;

pages['_Sidebar.md'] = `**PacketForge**

- [Home](Home)
- [Getting started](Getting-Started)
- [Requesting hardware](Requesting-Hardware)
- [Simulation fidelity](Simulation-Fidelity)
- [Contributing](Contributing)

---

- [Repository](https://git.jayw.uk/jaylouisw/packetforge)
- [Request a device](https://git.jayw.uk/jaylouisw/packetforge/issues/new?template=device_request.yml)
`;

fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const name of Object.keys(pages)) {
  fs.writeFileSync(path.join(OUT, name), pages[name], 'utf8');
  n++;
}
console.log('wrote ' + n + ' wiki pages to docs/wiki/');
