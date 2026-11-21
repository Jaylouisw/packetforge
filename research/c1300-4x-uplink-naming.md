# A Catalyst 1300's four 10G cages: `Gi1/0/25`, or `Te1/0/1`?

**Question (one, narrow).** A Catalyst 1300 `-4X` model carries four 10G SFP+ uplinks above 16, 24 or 48
copper ports. What does its CLI call those four cages - the downlink group continued (`Gi1/0/25`-`28` on a
24-port), or `Te1/0/1`-`4` in a band of their own? The catalogue said the first on the strength of a
datasheet port count; the sibling Catalyst 1000 `-4X` note left exactly this question open for the
small-business family (`research/c1000-4x-uplink-naming.md`, "The small-business neighbours").

**Verdict: `Te1/0/1`-`Te1/0/4`** - 10-gigabit type word, module 0, numbers restarting at 1. Cisco's
Catalyst 1300 CLI guide says it in prose and shows it in a command sample, and the 1300X guide for the
next release repeats the prose word for word. The `-4G`/`-2G` siblings are a different case and keep the
continued numbering; nothing in this note renumbers them.

## The document that states the naming

Catalyst 1300 CLI Guide, *Introduction*, section "Managing Ports Via CLI"
(<https://www.cisco.com/c/en/us/td/docs/switches/campus-lan-switches-access/Catalyst-1200-and-1300-Switches/cli/C1300-cli/introduction.html>):

> To access a port interface on units that support stacking, type "interfaceGigabitEthernetX/0/Z (for
> 1gig interfaces), or "interface TenGigabitEthernetX/0/Y for 10gig ports with X (1-4) being the stack
> ID, **Y for the uplink ports number (1-4)**, and Z for the downlink port number; Z is between 1- 48
> even for the units that have less than 48 ports.

Three facts in one sentence: the 10G ports are `TenGigabitEthernet`, they are 10G-specific (the 1G
interfaces are `GigabitEthernet`), and their number is the *uplink* number, 1 to 4 - not the downlink
number continued. The Catalyst 1300X CLI Guide (release 4.10.0.xx) carries the identical paragraph
(<http://cisco.com/c/en/us/td/docs/switches/campus-lan-switches-access/Catalyst-1300x/CLI_Release_4_10_0_xx/c1300x-cli-guide/introduction.html>),
so this is the family's rule, not one release's slip.

## The document that shows it in command output

The same guide's *Ethernet Configuration Commands*, `show interfaces status`
(<https://www.cisco.com/c/en/us/td/docs/switches/campus-lan-switches-access/Catalyst-1200-and-1300-Switches/cli/C1300-cli/ethernet-configuration-commands.html>):

```
switchxxxxxx#  show interfaces status
                                        Flow  Link   Back     Mdix
Port   Type      Duplex  Speed Neg      ctrl  State  Pressure Mode
------ --------- ------  ----- -------- ----  ------ -------- --
gi1/0/1  1G-Copper  Full   1000  Disabled Off   Up     Disabled Off
gi1/0/2  1G-Copper  --     --     --      --    Down   --       --
te1/0/1  10G-Copper --     2500   --      --    Down   --       --
```

The table mixes `gi1/0/N` copper rows with a `te1/0/1` row whose port number is **1**, in the same view,
on the same box. If the cages continued the copper group this row would read `te1/0/25` on a 24-port.
The guide's port-capability table repeats the name on its own line - `te1/0/1` / `10G-Copper` /
`Enable` / `Slave` / `10000f, 5000f, 2500f,1000f` - so the 10G cage also takes a 1G module, which is what
the catalogue records in `speedCaps`.

A third page, *Stack Commands*, fixes the type word in the stack's own vocabulary: "**uplink**
*uplink-type* - The type of uplink ports of the unit. Supported values are: **te** (for device with
Tengigabitethernet uplink ports), **none** ..." and "if **network** port type is set to gi or tw,
**uplink** port type must be set to te"
(<https://www.cisco.com/c/en/us/td/docs/switches/campus-lan-switches-access/Catalyst-1200-and-1300-Switches/cli/C1300-cli/stack-commands.html>).
The uplink bank is a `te` bank by the vendor's own vocabulary.

The model inventory itself - 16/24/48 copper ports plus "4x 10 Gigabit SFP+ uplink" - is in the C1300
data sheet
(<https://www.cisco.com/c/en/us/products/collateral/switches/catalyst-1300-series-switches/nb-06-cat1300-ser-data-sheet-cte-en.pdf>)
and the model comparison page
(<https://www.cisco.com/c/en/us/products/switches/catalyst-1300-series-switches/models-comparison.html>).
The data sheet prints a *total* Ethernet port count (28 for a 24-port 4X); that count is where the
catalogue's old numbering came from, and it is not evidence about the CLI: a port total cannot say which
type word or which first number the box uses.

## What the console did, measured

One session on the catalogue's `C1300-24P-4X`, before the change:

```
SW>show interfaces Te1/0/1
% No interface Te1/0/1 on Cisco Catalyst 1300 C1300-24P-4X-SW
SW>show interfaces Gi1/0/25
Gi1/0/25 (ethernet, 10G), MAC 0200.0000.0018
  speed: 10Gb/s (auto), duplex: full
```

Two defects in two lines, the same pair the Catalyst 1000 note found on its own `-4X` spec: a
10-gigabit cage wearing a `GigabitEthernet` name, and the name Cisco's guide prints refused as a port
that does not exist. `show ip interface brief` listed 28 rows ending `Gi1/0/25`-`Gi1/0/28`, so a lab built
from that table cabled its fibre uplinks with copper names. Each of the seven `-4X` specs carried a
`notes` sentence that justified the numbering by the data sheet's port total - the inference, not a
document, and the sentence now quotes the CLI guide instead.

## What changed

* `devices/cisco/c1300-16p-4x.json`, `c1300-24fp-4x.json`, `c1300-24p-4x.json`, `c1300-24t-4x.json`,
  `c1300-48fp-4x.json`, `c1300-48p-4x.json`, `c1300-48t-4x.json` - the four cages are `Te1/0/1`-`Te1/0/4`.
  Nothing else moved: still the same copper template, still four `sfp+` cages at 10G with `speedCaps`
  1000/10000, still the same PoE budget, switching capacity and console port. The `notes` sentence that
  read the data sheet's port count as a numbering rule is replaced by the CLI guide's two statements.
* `test/c1300-4x-uplink-naming.test.js` - 31 checks over all 19 Catalyst 1300 specs: every `-4X` cage is
  `Te1/0/1`-`4` at SFP+/10G, the 16-port model restarts at 1 rather than at 17, the socket count is
  unchanged (24 copper + 4 cages + console), `show interfaces Te1/0/1` and the long spelling reach the
  cage, both interfaces of the old name are refused, `show ip interface brief` holds 28 rows with
  `TenGigabitEthernet1/0/1` among them, `interface Te1/0/1` lands in `(config-if)#`, the `-4G`/`-2G`
  siblings keep `Gi1/0/25`-`28` and `Gi1/0/17`-`18`, a Catalyst 1000 `-4X` keeps `Te1/0/1`-`4` and a
  9200L keeps `Te1/1/1`-`1/4`, and a link made on the corrected name comes up.
* No engine code changed: the console already resolved `Te1/0/1` by type word, so only the catalogue
  was wrong.

## What is known, inferred, unresolved

**Known.** On a Catalyst 1300 the 10G SFP+ cages are `TenGigabitEthernet1/0/Y` with Y the uplink number
1-4: the guide says so in prose (two releases), prints a `te1/0/1` 10G row beside `gi1/0/N` copper rows,
and calls the uplink bank `te` in its stack vocabulary. A data sheet's port total is not a naming rule.

**Inferred.** That the same rule holds on the 16-port `-4X` (no capture of that model's `show interfaces
status` was found; only the family sentence covers it) and on the `C1300X` models. That a `-4G`/`-2G`
model's 1G SFP cages continue the copper group (`Gi1/0/25`-`28`), which is what the catalogue keeps: the
guide's Z range "1-48 even for the units that have less than 48 ports" describes the gigabit interfaces,
but no sample of a `-4G` box's cage name was read.

**Unresolved.**

* **Whether a 4X box also answers to `Gi1/0/25`.** On a Catalyst 9200 both type words reach one physical
  port ("all Ten1/1/1 and Twentyfive1/1/1 are references to the same physical interface"), and the C1000
  note left the same question open for its own chassis. This model refuses the old name - a lookup keyed
  by type word can only have one. A transcript of `interface Gi1/0/25` on a 4X unit would settle it.
* **The silkscreen.** The drawn faceplate labels a connector group from its port names, so these four now
  read `1`-`4` rather than `25`-`28`. No straight-on photograph or hardware-guide plate of a C1300 4X
  front panel was checked here; the C1000 note records the same gap.
* **The C1200 family.** The same CLI guide is titled for "Catalyst 1200 and 1300", and the C1200 `-4X`
  SKUs (e.g. `C1200-48P-4X`) print the same "4x10GE SFP+ uplink". No C1200 spec is in the catalogue, so
  there was nothing to rename and nothing measured; if one is added, the family sentence says `Te1/0/1`-`4`.
* **Stack members.** The guide's X is the stack unit (1-4), so a member 2 cage would be `Te2/0/1`. This
  model has no stacking, so only X=1 is modelled.

**What would settle the rest.** On one `C1300-24P-4X`: `show interfaces status` (does it print
`te1/0/1`-`4` and no `gi1/0/25`?), then `configure terminal` / `interface Gi1/0/25` (accepted or
refused?), then `show running-config interface Te1/0/1`. One transcript closes the first two items; a
front-panel photograph closes the third.
