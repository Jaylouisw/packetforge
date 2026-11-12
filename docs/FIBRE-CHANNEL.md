# Fibre Channel

Fibre Channel is a different network in the same socket. An 8G FC optic seats in an SFP+ cage
exactly as a 10GBASE-SR one does, the connector check passes, and the link still cannot carry a
frame. PacketForge models it as its own protocol family so that the physical fit and the frame
protocol are two separate questions, and a lab can build a SAN — or be told precisely why a cable
between a SAN switch and an Ethernet switch will never work.

## The rate ladder is not the number on the box

This is the part that surprises people, and the part the engine gets right. Fibre Channel frames
its payload, and which framing it uses changes the direction of the difference:

| Name | Line rate | Framing | Why |
|---|---|---|---|
| 2GFC | 2,125 Mbps | 8b/10b | line rate is **above** the name |
| 4GFC | 4,250 Mbps | 8b/10b | line rate is **above** the name |
| 8GFC | 8,500 Mbps | 8b/10b | line rate is **above** the name |
| 10GFC | 10,519 Mbps | 8b/10b | line rate is **above** the name |
| 16GFC | 14,025 Mbps | 64b/66b | line rate is **below** the name |
| 32GFC | 28,050 Mbps | 64b/66b | line rate is **below** the name |
| 64GFC | 57,800 Mbps | 64b/66b | line rate is **below** the name |
| 128GFC | 112,200 Mbps | 64b/66b | four 32G lanes |

So a "32G" port is 28.05 Gbit/s and a "2G" port is 2.125 Gbit/s. A model that read the name as a
bit rate would put a 64G port at 64000 Mbps, let it negotiate with a 100G Ethernet port, and be
wrong in both directions at once. `engine/media.js` carries the real rate in `speedMbps` and the
class in `fcRate` — and **only those two**. The Framing column is reference material, not a modelled
field: no media entry in the tree carries `encoding`, `framing` or `lineCode` (all eight `*gfc-sw`
entries have exactly the keys `name, family, connector, speedMbps, maxRangeM, fiber, wavelengthNm,
fcRate`), so nothing here can be checked against the engine and nothing in the engine changes if a
vendor switches line coding. Read the column as the reason the rates are what they are, not as data.

## Cages

Fibre Channel has its own cages rather than borrowing the Ethernet ones:

| Cage | Carries | Note |
|---|---|---|
| `fc-sfp` | 2G / 4G / 8G / 10G / 16G | the SFP+ socket, FC flavour |
| `fc-sfp28` | 8G / 16G / 32G | 32G needs the SFP28 width |
| `fc-sfpdd` | 16G / 32G / 64G | SFP-DD, for 64G |
| `fc-qsfp28` | 32G / 128G | four 32G lanes |

Sharing the Ethernet cages was the obvious shortcut and it is wrong: the cage supplies the
**default** rate ladder when a port declares none, so an Ethernet SFP+ port with no `speedCaps`
would inherit 8G/16G and an Ethernet-to-Ethernet link could negotiate a Fibre Channel rate. The
separate cages keep the two ladders apart while still mating physically — `cagesMate('sfp+',
'fc-sfp')` is `true`, because the hardware does.

### Checking this table against the engine

Every number above came from `engine/media.js`, and the one-liners are worth having because two of
them look broken if you read the tables as data. `CAGE_SPEEDS` and `CAGE_MEDIA` are **functions, not
objects** — `CAGE_MEDIA['fc-sfp']` is a function that *returns* the media list, so `JSON.stringify` on
it prints `undefined` and a reader can conclude the cage is unlisted when it is perfectly well listed:

```js
const m = require('./engine/media');
m.CAGE_SPEEDS['fc-sfp'](120000)   // [2125, 4250, 8500, 10519, 14025]
m.CAGE_MEDIA['fc-sfp']()          // ['2gfc-sw','2gfc-lw','4gfc-sw', … ,'16gfc-sw','16gfc-lw']
```

The `120000` in the first call is decoration, not a filter: `CAGE_SPEEDS['fc-sfp']` answers that same
five-element ladder for no argument at all, for `100` and for `1000000`. Every FC cage behaves that way —
`fc-sfp28`, `fc-sfpdd` and `fc-qsfp28` all answer their full ladder at `(1000)` — which is the cap table
further down, measured one row at a time.

The measured ladders and media, one row per cage:

| Cage | `CAGE_SPEEDS[cage](…)` | `CAGE_MEDIA[cage]()` |
|---|---|---|
| `fc-sfp` | `[2125, 4250, 8500, 10519, 14025]` — 2/4/8/10/16G | `2gfc-*`, `4gfc-*`, `8gfc-*`, `10gfc-*`, `16gfc-*` |
| `fc-sfp28` | `[8500, 14025, 28050]` — 8/16/32G | `32gfc-*`, `16gfc-*`, `8gfc-*` |
| `fc-sfpdd` | `[14025, 28050, 57800]` — 16/32/64G | `64gfc-*`, `32gfc-*`, `16gfc-*` |
| `fc-qsfp28` | `[28050, 112200]` — 32G/128G | `128gfc-*`, `32gfc-*` |

The media are named `2gfc-sw`, `8gfc-lw`, `128gfc-sw` — *not* `fc-2g` or `fc-8g`. Each exists in an
`-sw` (short wave) and `-lw` (long wave) flavour, and the speed is the line rate, not the marketing
number: `8gfc-sw` is `8500`, `16gfc-sw` is `14025`, `32gfc-sw` is `28050`, `64gfc-sw` is `57800`,
`128gfc-sw` is `112200`.

The four media lists are not all in the same order, which is worth knowing before you diff one of them
against a ladder and conclude a row is wrong: `fc-sfp` runs **ascending** (`2gfc` → `16gfc`), while
`fc-sfp28`, `fc-sfpdd` and `fc-qsfp28` run **descending**, highest rate first. The speeds agree in both
directions, and one command prints every row of both tables above:

```sh
node -e '
const m=require("./engine/media");
const j=JSON.stringify;
for(const c of ["fc-sfp","fc-sfp28","fc-sfpdd","fc-qsfp28"]){
  const sp=m.CAGE_MEDIA[c]().map(id=>(m.MEDIA[id]||{}).speedMbps);
  console.log(c.padEnd(10), j(m.CAGE_SPEEDS[c](1000)), "media", sp.join(","));
}
for(const c of ["rj45","wwan","combo","sfp"]) console.log(c.padEnd(10), j(m.CAGE_SPEEDS[c](1000)));'
```

Run on 2026-11-12 it prints, one line per cage (the padding in the cage column is the script's): the
ladder `[2125,4250,8500,10519,14025]` for `fc-sfp` against media speeds
`2125,2125,4250,4250,8500,8500,10519,10519,14025,14025`, the three descending ladders beside their own
media, and then `[10,100,1000]`, `[1000]`, `[10,100,1000]`, `[1000,2500]` for `rj45`, `wwan`, `combo` and
`sfp` — every row of the cap table, with the FC ladders unchanged by the `1000`.

**The `maxMbps` argument is not honoured by the optical or FC ladders.** Measured, capping at 1000:

| Cage | `(1000)` returns | Honours the cap? |
|---|---|---|
| `rj45` | `[10, 100, 1000]` | yes — filters everything above |
| `wwan` | `[1000]` | yes — the modem's category *is* the rate |
| `combo` | `[10, 100, 1000]` | partly — drops 10000, and never offers 2500/5000 at all |
| `sfp` | `[1000, 2500]` | **no** — 2500 is above the cap |
| `fc-sfp` | `[2125, 4250, 8500, 10519, 14025]` | **no** — the whole ladder, cap ignored |

So a port's declared ceiling does not narrow its FC ladder the way it narrows a copper one. When you
need the negotiated result rather than the catalogue's ladder, ask `negotiateSpeed()` or read a link's
`speedMbps` after a run — `CAGE_SPEEDS` answers "what could this socket ever do", and for FC that is
the whole ladder by design.

## What is refused, and why

An FC port cabled to an Ethernet port refuses with `E_PROTOCOL_MISMATCH`:

```
SFP28 (FC) is a Fibre Channel port and SFP+ is Ethernet. The connector is the same LC/SFP family
and the optic will even seat, but Fibre Channel carries FC frames at its own rate ladder
(8/16/32/64G run at 8.5/14.025/28.05/57.8 Gbit/s) and an Ethernet port has no FC login, so no
frame ever crosses. Put an FC HBA or switch on the other end.
```

Two details worth keeping:

- The check runs **before** the BiDi explanation. Both are true of some pairs, and the protocol is
  the more fundamental reason: a user who has plugged an FC optic into a switch port needs to hear
  about the protocol, not about the shape of the strand.
- An FC optic in a **1G SFP** cage is refused on the *connector* instead, because it genuinely
  does not seat: `E_CONNECTOR_MISMATCH`, `Cannot mate SFP+ (FC) to SFP (incompatible connectors).`
  That string is not fixed — it names the **FC optic's own** connector, so grepping a page for it and
  finding a different one is not a bug. Measured against one 1G SFP cage (`ISR 4331` `Gi0/0/0-sfp`):

  | FC device | its cage | the message |
  |---|---|---|
  | `MDS 9148S` | `fc-sfp` | `Cannot mate SFP+ (FC) to SFP (incompatible connectors).` |
  | `G610`, `DS-6630B` | `fc-sfp28` | `Cannot mate SFP28 (FC) to SFP (incompatible connectors).` |
  | `G720` | `fc-sfpdd` | `Cannot mate SFP-DD (FC) to SFP (incompatible connectors).` |
  | `DS-6630B` `icl0` | `fc-qsfp28` | `Cannot mate QSFP28 (FC) to SFP (incompatible connectors).` |

  Only SFP+/SFP28/SFP-DD sockets take an FC module. The test suite pins the protocol answer
  against an SFP+ port and deliberately does not pin this one, because a connector refusal would
  prove nothing about the protocol — so the raw `cagesMate('sfp', 'fc-sfp')` matrix says `true`
  while the real pair refuses. `cagesMate` answers "could these sockets ever meet"; `canMate()` is
  what a link is actually judged by.

## Two FC ports link and negotiate down

A 64G port and a 32G port link at 28.05 Gbit/s: the faster port declares the whole ladder it can
run (`speedCaps`), and negotiation takes the highest rung both ends share, exactly as Ethernet does
with 1000/10000. Fibre Channel negotiates through 32/16/8, so this falls out of the same rule
rather than needing a special case. Measured over three pairs:

| pair | media offered | chosen | `speedMbps` |
|---|---|---|---|
| `MDS 9148S` 16G ↔ `MDS 9148S` 16G | `2g`, `4g`, `8g`, `10g`, `16g` | `16gfc-sw` | **14025** |
| `MDS 9148S` 16G ↔ `G720` 64G | `16g` only | `16gfc-sw` | **14025** |
| `G610` 32G ↔ `G720` 64G | `32g`, `16g` | `32gfc-sw` | **28050** |

Two things to read off that table, and one trap underneath it. The offer list is the intersection of the two
**cage ladders**, not of the two `speedCaps` arrays: an `fc-sfp` socket's ladder is `2/4/8/10/16G` and an
`fc-sfpdd` socket's is `16/32/64G`, they share only 16G, and that is why the 16G↔64G pair offers `16g`. The
giveaway is the first row, which offers `10g` although **neither** port lists 10519 in its `speedCaps` — the
ladder decides what appears, the caps do not. Same intersection from the other side: `MDS 9148S` (`fc-sfp`)
against `DS-6630B` (`fc-sfp28`, ladder `8/16/32G`) offers exactly `8g` and `16g`.

And `speedMbps` is the **negotiated line rate, not the medium's name**: 16G FC runs at 14.025 Gbit/s and 32G
at 28.05, so a link whose `mediaId` says `16gfc-sw` still reports `14025`. Reading the medium id as the rate
is off by ~12% on every FC rung.

The trap is that the offer list and the negotiated rate answer different questions and can disagree by 2×.
`QLogic 5800V`'s ordinary ports declare `[2125,4250,8500]` (only its four ISLs add 10519) and `MDS 9148S`
declares `[2125,4250,8500,14025]`; both are `fc-sfp`, so the offer is the whole ladder. Cabled with no
medium named, the pair picks `8gfc-sw` at 8500. Naming `16gfc-sw` explicitly is **accepted** — the link then
reports `mediaId 16gfc-sw` with `speedMbps` **8500**, because the 5800V port never declared 14025. Only a
medium outside the offer list is refused (`64gfc-sw` fails with 'is not supported by both'). So the medium
names the connector and the optics; the two ports decide the rate.

Rebuilt all three rows from the catalogue on 2026-11-12 rather than believing the table: a `Topology` with
`MDS 9148S` ×2, `G720` and `G610`, cabled port-to-port, gives `mediaId 16gfc-sw` with `speedMbps 14025`
for 16G↔16G, the same `16gfc-sw`/`14025` for 16G↔64G, and `32gfc-sw`/`28050` for 32G↔64G — every
value in the bold column as printed. The field is `mediaId`; `mediumId` and `media` do not exist on a link
object, so a probe that guesses either gets `undefined` and can look like a refusal that never happened.
The offered lists come from the FC media family, which is **16** ids — eight rungs from `2g` to `128g`,
each in `-sw` and `-lw` — inside the 89 media the engine carries overall.

## Devices

Seven devices carry **304** Fibre Channel ports between them, in all four `fc-*` cages: `fc-sfp` 72,
`fc-sfp28` 144, `fc-sfpdd` 80, `fc-qsfp28` 8 (measured with `derivePortHardware()` over `devices/`, which
also gives the per-port `speedCaps` the table below summarises). No single box spans the ladder, so which
box you pick decides which rates a lab can test: **2G** exists only on the two 8G-class boxes (MDS 9148S and
SANbox 5800V), **10G FC** only on the 5800V's four ISLs, **64G** on G720 and MDS 9124V, and **128G** only on
the DS-6630B's eight ICL ports. A "does FC negotiate down the whole ladder" test needs more than one device
in the lab.

All of it re-derived at `e562833c` — the totals, the cage split and the per-device arrays — because the sentence
above is a census and censuses rot. One command reproduces the whole thing:

```sh
node -e 'const r=require("./devices/registry"),m=require("./engine/media");let t=0;const g=new Map(),c={},d=new Set();for(const s of r.loadCatalog()){if(s.error)continue;for(const i of r.effectiveInterfaces(s)){const h=m.derivePortHardware(i,s)||{};if(!String(h.cage||"").startsWith("fc-"))continue;t++;d.add(s.model);c[h.cage]=(c[h.cage]||0)+1;const k=JSON.stringify(h.speedCaps);if(!g.has(k))g.set(k,0);g.set(k,g.get(k)+1)}}console.log(t,"FC ports on",d.size,"devices",JSON.stringify(c));for(const [k,v] of [...g].sort((a,b)=>b[1]-a[1]))console.log(v,k)'
```

It prints `304 FC ports on 7 devices {"fc-sfp28":144,"fc-sfpdd":80,"fc-sfp":72,"fc-qsfp28":8}` and then the
seven arrays, largest group first: 144 × `[8500,14025,28050]`, 56 × `[14025,28050,57800]`, 48 ×
`[2125,4250,8500,14025]`, 24 × `[8500,14025,28050,57800]`, 20 × `[2125,4250,8500]`, 8 × `[28050,112200]`, 4 ×
`[8500,10519]`. Re-run verbatim on 2026-11-12 and it prints that header and those seven lines exactly, in that
order, so the census is still a recipe rather than a remembered figure. Every figure in the table below matches, and **no array has a single rung** — the check that
keeps "64G is `[57800]`" from being plausible prose.

One caution when reading those seven lines: a line is a **cap array, not a device**. The 144 spans three boxes —
`G610` 24, `SN3600B` 24 and `DS-6630B` 96 — and `DS-6630B` appears twice, because its 96 line ports and its 8 ICL
ports carry different arrays. Per device the census reads `G610` 24, `G720` 56, `MDS 9124V` 24, `MDS 9148S` 48,
`DS-6630B` 104, `SN3600B` 24, `5800V` 24 — which is still 304, reached the other way round.

| Device | Ports | measured `speedCaps` (Mbps) |
|---|---|---|
| QLogic 5800V | 20 device ports at 2/4/8G + 4 ISL ports at 10GFC | 20 × `2125/4250/8500`, 4 × `8500/10519` |
| Brocade G610, HPE SN3600B | 24 × 32G | 24 × `8500/14025/28050` (per model) |
| Brocade G720 | 56 × 64G | 56 × `14025/28050/57800` |
| Cisco MDS 9124V | 24 × multispeed 8/16/32/64G | 24 × `8500/14025/28050/57800` |
| Cisco MDS 9148S | 48 × multispeed 2/4/8/16G | 48 × `2125/4250/8500/14025` |
| Dell Connectrix DS-6630B | 96 × 32G + 8 × 128GFC | 96 × `8500/14025/28050`, 8 × `28050/112200` |

The third column is the literal array each port carries, which is what makes drift visible: a device that
gains a rung, or a marketing rate that disagrees with its ladder, shows up here as a changed string rather
than as prose that still reads plausibly. Seven devices hold seven distinct arrays (the two 24 ×
`8500/14025/28050` boxes share one), and the cage per device is fixed — G610/SN3600B/DS-6630B in
`fc-sfp28` (DS-6630B's eight 128G ports in `fc-qsfp28`), G720 and MDS 9124V in `fc-sfpdd`, MDS 9148S and
the 5800V in `fc-sfp`.

The 5800V's 20G ISL figure is two 10GFC ports bonded, which this model expresses as two links
rather than one 20G port.

## What is not modelled

- **Fabric services.** No FLOGI/PLOGI, no fabric name server, no zoning, no FC-IP. A lab can cable a SAN
  but not configure one; the simulator's data path is Ethernet/IP. `git grep -in 'flogi\|plogi\|fcip\|zoning' -- engine/ server/ web/ test/`
  returns nothing, and the `name-server` the CLI does have is DNS: `ip name-server 8.8.8.8` at
  `engine/cli.js:1524`, which validates every word after the keyword as an IP address. Reading a "no name
  server" claim as contradicted by that command is the mistake this note is here to stop.
- **Optic part numbers.** `catalogue/optics/transceivers.json` has not been extended with FC
  transceivers, so an FC link is described by its rate class (SW/LW) rather than a vendor part. No entry
  in that file names an FC rung — the only `fibre` strings in it are `note` prose about MPO lane counts
  and OM3/OM4 reach, which is why a plain `grep fibre` there returns six lines and none of them is a part.
- **Credit-based flow control and BB credits.** An FC link's real carrying capacity depends on
  buffer-to-buffer credits, which the simulator does not count.

## Adding an FC device

1. Put the ports in an `fc-*` cage and declare `speedCaps` from the ladder — never the marketing
   name. Those caps are the rate classes the port actually negotiates, so copy a set that already
   exists rather than inventing one. Every set in the catalogue today, with the ports that carry it:

   | `speedCaps` | Ports | Where |
   |---|---|---|
   | `[8500, 14025, 28050]` | 144 | G610 (24), DS-6630B (96), SN3600B (24) — the 32G ladder |
   | `[14025, 28050, 57800]` | 56 | G720 — the 64G ladder, no 8G step |
   | `[2125, 4250, 8500, 14025]` | 48 | MDS 9148S — 16G down to 2G |
   | `[8500, 14025, 28050, 57800]` | 24 | MDS 9124V — 8G up to 64G |
   | `[2125, 4250, 8500]` | 20 | SANbox 5800V — 8G down to 2G |
   | `[28050, 112200]` | 8 | DS-6630B — 128G on a box described as 32G |
   | `[8500, 10519]` | 4 | SANbox 5800V — 8G and 10G FC on an 8G box |

   Reproduce the whole table — seven sets, 304 ports — in one command:

   ```bash
   node -e "const{loadCatalog}=require('./devices/registry');const g={};
     for(const s of loadCatalog('./devices'))for(const i of (s.interfaces||[])){
       if(!/^fc-/.test(i.connector||''))continue;
       const k=JSON.stringify(i.speedCaps||[]);g[k]=g[k]||{p:0,d:{}};g[k].p++;
       g[k].d[s.model]=(g[k].d[s.model]||0)+1;}
     for(const[k,v]of Object.entries(g).sort((a,b)=>b[1].p-a[1].p))
       console.log(k.padEnd(30),String(v.p).padStart(4),' ',Object.entries(v.d).map(([m,n])=>m+' ('+n+')').join(', '));
     console.log('total FC ports:',Object.values(g).reduce((a,b)=>a+b.p,0));"
   ```

   It prints the sets in descending port count and ends `total FC ports: 304`. Two readings to
   keep: it prints each device's **model**, so the pair above spelled `SANbox 5800V` comes back as
   `5800V`; and a set printed as `[57800]` would be the example the next paragraph says cannot
   exist — its absence from that output is the evidence, not this sentence.

   Note what is **not** in that table: no port declares `[57800]` on its own. A 64G-only port would,
   but every 57800 today sits inside a multispeed set, so an example written as "64G is `[57800]`" is
   describing a port that does not exist here. The last two rows are the ones to look at twice before
   copying them: 128G on a 32G switch and 10G FC on an 8G switch are both plausible as ISL or uplink
   ports and both suspicious as transcription, and `10519` is 10G FC's *line* rate (`10.51875` Gbit/s)
   rather than a round number somebody would type by hand.
2. Keep the marketing name in `speed` so the UI reads like the datasheet.
3. Say "Fibre Channel" (or the vendor's SAN branding) in the description. `test/spec-vs-description`
   uses that to know it should read "64G" as 57.8 Gbit/s, and `test/fibre-channel.test.js` uses the
   `fc-*` cages to check the port count against the description.
