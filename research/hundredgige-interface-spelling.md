# How does IOS XE spell a 100G interface: `HundredGigE` or `HundredGigabitEthernet`?

**Question (one, narrow).** The display table expanded the type `hu` onto `HundredGigabitEthernet`, the
word the FSOS catalogue uses for its own 100G cages. Does a Cisco IOS XE box print that word, or the
shorter `HundredGigE` - and are the neighbouring high-speed types spelled the same way?

**Verdict: `HundredGigE` (abbreviation `hu`), and no IOS capture prints `HundredGigabitEthernet`.** IOS XE
does not spell this one out. Its configuration guides list the interface types as `TwentyFiveGigE or twe`,
`FortyGigabitEthernet or fo`, and `HundredGigE or hu` in the same sentence - the 40G word is long and the
100G word is not. A Catalyst 9500 prints `interface HundredGigE1/0/2` in `show running-config`, and
`HundredGigE1/0/1 is up, line protocol is down` from `show interfaces`. `HundredGigabitEthernet` is a real
interface name, but it is a *different vendor's* (FSOS, in this catalogue), and those ports carry the word
already, so they pass through the display rule untouched.

The console had the 100G row one word too long: a C9500-24Y4C's four cages came out
`HundredGigabitEthernet1/0/1` (27 characters, pushing the address cell past the header's 23-column field)
where a box prints `HundredGigE1/0/1` (18, inside it). The same error reached `show running-config`, whose
stanza header is the one place no vendor sample disagrees about.

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 9300 Interface and Hardware Components Configuration Guide, IOS XE 17.10 (PDF)](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-10/configuration_guide/int_hw/b_1710_int_and_hw_9300_cg.pdf) | The type list, one sentence: `Gigabit Ethernet (GigabitEthernet or gi)`, `2.5-Gigabit Ethernet (TwoGigabitEthernet or tw)`, `5-Gigabit Ethernet (FiveGigabitEthernet or fi)`, `10-Gigabit Ethernet (TenGigabitEthernet or te)`, `25-Gigabit Ethernet (TwentyFiveGigE or twe)`, `40-Gigabit Ethernet (FortyGigabitEthernet or fo)`, `100-Gigabit Ethernet (HundredGigE or hu)`. The four types that are spelled out end in `GigabitEthernet`; the two that are not end in `GigE`. |
| [Catalyst 9600 Interface and Hardware Components Configuration Guide, IOS XE 17.17 (PDF)](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/17-17/configuration_guide/int_hw/b_1717_int_and_hw_9600_cg.pdf) | The same pairing: `25-Gigabit Ethernet (TwentyFiveGigE or twe)`, `40-Gigabit Ethernet (FortyGigabitEthernet or fo)`, and `100-Gigabit Ethernet (HundredGigE or hu) for 100Gbps`. Its port-numbering sentence uses `FortyGigabitEthernet1/0/1`. |
| [Cisco IOS XE 17 Interface Characteristics Configuration Guide (C9350/C9550)](https://www.cisco.com/c/en/us/td/docs/switches/lan/c9000/infra/interface-characteristics/interface-characteristics-configuration-guide.html) | Extends the pattern: `50-Gigabit Ethernet (FiftyGigabitEthernet or fif)` … `100-Gigabit Ethernet (HundredGigE or hu)` … `400-Gigabit Ethernet (FourHundredGigE or fou)`. Its own example numbers the 400G cages as `Fou1/0/25`, not `FourHundredGigabitEthernet1/0/25`. |
| [Catalyst 9500 QoS Configuration Guide, IOS XE 26.x (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/26-x/configuration_guide/qos/b_26x_qos_9500_cg.pdf) | A running-config transcript, which is the decisive one for the stanza header: `Device# show running-config interface HundredGigE1/0/2` answers `interface HundredGigE1/0/2`. |
| [Cisco Community, "Link lights just blinking on and off"](https://community.cisco.com/t5/switching/link-lights-just-blinking-on-and-off/td-p/4839239) | A live 9500-32C on IOS XE 17.06.04: `HundredGigE1/0/1 is up, line protocol is down (notconnect)` / `Hardware is Hundred Gigabit Ethernet, address is 9c54.1650.1fc1`. The hardware is called Hundred Gigabit Ethernet; the interface is called `HundredGigE`. |
| [Cisco ASR 1000 Modular Ethernet Line Card Troubleshooting, IOS XE 16.7](https://cisco.com/c/en/us/td/docs/interfaces_modules/shared_port_adapters/configuration/ASR1000/modular_ethernet_linecard/xe-16-7/asr1000-melc-cfg-16-7/asr1000-melc-troubleshooting-melc.html) | `Router# show interfaces HundredGigE 1/0/0` → `HundredGigE1/0/0 is up, line protocol is up`. The same guide writes the 10G block as `TenGigabitEthernet0/0/0`, so the short 100G word is not a generic ASR convention. |
| [Catalyst 9600 Layer 2/3 Command Reference, IOS XE 17.2 - UDLD interface types](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/17-2/command_reference/b_172_9600_cr/layer_2_3_commands.html) | The keyword table a parser reads lists `GigabitEthernet`, `TenGigabitEthernet`, `TwentyFiveGigE`, `HundredGigE` (and `FortyGigabitEthernet` elsewhere) as valid interface types. `HundredGigabitEthernet` is not a keyword in it. |

**The counter-evidence, and why it does not overturn the verdict.** The Catalyst 9600 26.x guide's breakout
section describes the breakout ports in prose as `HundredGigabitEthernet slot/0/port/[1-4]`, and one example
in that same document types `interface HundredGigabitEthernet1/0/27` - while another example in the same
document types `interface HundredGigE3/0/5`. So Cisco's own documents contain both words. The type list is
the stronger evidence: it is the sentence that defines the CLI keyword and the abbreviation (`HundredGigE or
hu`), it agrees across three product families, and every transcript of a box *printing* a name uses
`HundredGigE`. The prose spelling is read as a documentation habit inherited from the breakout table, not as
a second accepted interface name - `HundredGigabitEthernet1/0/27` does not parse on a box whose type keyword
is `HundredGigE`.

**A second spelling this settles.** `FourHundredGigE` (abbreviation `fou`) and `FiftyGigabitEthernet`
(`fif`) follow the same split, and neither is in the catalogue today, so nothing in the engine uses them.
`TwoGigabitEthernet` (`tw`) and `FiveGigabitEthernet` (`fi`) are not in the catalogue either: a 9300 mGig
port in this model is `Gi`-named, so no row is affected. They are recorded here so the next 400G/50G entry
does not re-derive the pattern from one word.

## What is known, inferred, unresolved

**Known.** IOS XE's interface type for a 100G port is `HundredGigE`, abbreviated `hu`. `FortyGigabitEthernet`
(`fo`) and `TwentyFiveGigE` (`twe`) are already spelled the way IOS XE spells them. A 9500's running-config
stanza and `show interfaces` block both print `HundredGigE<slot>/<subslot>/<port>`. FSOS prints
`HundredGigabitEthernet`, and its catalogue names are that word.

**Inferred.** That the expansion applies to every view the engine derives from one port name - brief table,
running-config stanza, ARP and OSPF interface cells - because they all pass through `displayName()`. No
vendor sample contradicts that for 100G, but only the running-config stanza and the `show interfaces` block
are directly evidenced above.

**Unresolved.**

* **The `show ip interface brief` cell for a 100G port.** No capture with a 100G row in that table was
  found; every Cisco sample of the command shows GigabitEthernet rows. Worse, one live Cat9k transcript
  prints `Te1/1/1` and `Fo1/1/1` *short* in that table beside `TwentyFiveGigE1/1/1`
  ([Cisco Community](https://community.cisco.com/t5/switching/can-access-internet-but-can-t-ping-8-8-8-8/td-p/4833672)) -
  so the table may abbreviate some high-speed types after all, which would make the 100G cell `Hu1/0/1`
  rather than `HundredGigE1/0/1`. This run prints the long form, for the same reason every other row in the
  table is long: it is the interface's name. If the abbreviation turns out to be real, the brief table needs
  its own rule (which types abbreviate, and on which platforms) and this note and
  `research/interface-brief-name-spelling.md` both need revising.
* **The 40G row's width.** `FortyGigabitEthernet1/0/1` is 26 characters, past the 23-column field, and no
  capture of a 40G row in `show ip interface brief` was found either. Whether IOS shifts the rest of the row,
  widens the field or truncates is unmeasured; the engine shifts, as it always has.
* **Cisco IOS (not XE) 100G naming.** Every source above is IOS XE. Classic IOS on a 100G line card
  (`HundredGigabitEthernet` on some ASR 9000 IOS XR images, `HundredGigE` on XR) is a different family and
  not modelled separately; this console imitates the Catalyst IOS/IOS XE family, which is where the
  catalogue's 9500 sits.

**What would settle the open ones.** One `show ip interface brief` from a box with a 100G port (a 9500-32C
or 9600 with a 100G line card), and the same from a box with a 40G port, so the Interface cell and the
column shift can be read off the same screen.

## What changed

* `engine/iface-name.js` - `DISPLAY_ABBREV`'s `hu` entry is now `HundredGigE`; the type alias table already
  folded `hu`, `hundredgige` and `hundredgigabitethernet` onto one key, so every typed spelling still
  resolves to the port. The panel name is untouched (`Hu1/0/1` is still the catalogue key).
* `test/hundredgige-spelling.test.js` (24 checks) - the expansion on its own, the C9500-24Y4C brief row
  (`HundredGigE1/0/1`, address cell at column 23, no `HundredGigabitEthernet` anywhere), the running-config
  stanza header, all five typed spellings reaching the port, and an FSOS box keeping its own
  `HundredGigabitEthernet0/1` row.
* `test/interface-brief-name-spelling.test.js` - its expansion-table case for `Hu1/0/1` now expects the
  vendor's word.
* `research/interface-brief-name-spelling.md` - the `hu` row in its inference list and its width example are
  corrected: `HundredGigE1/0/1` is 18 characters and fits the field, so the 100G name never was the overflow
  case that note assumed. `FortyGigabitEthernet1/0/1` (26) still is.
