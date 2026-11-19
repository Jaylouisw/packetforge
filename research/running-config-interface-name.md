# The `interface` stanza header in `show running-config`: the panel spelling or the type word in full?

**Question (one, narrow).** The printed configuration has one stanza per port. What does the header of
that stanza say — the catalogue's short spelling (`interface Gi1/0/1`), the spelling the operator typed
(`interface gi 1/0/1`), or the vendor's full type word (`interface GigabitEthernet1/0/1`)? And does a
subinterface keep its tag after whichever one it is?

**Verdict: known, and adopted.** A box prints the type word in full, and prints the same header however
the `interface` command was typed. This console printed the panel spelling — 28 `interface Gi1/0/1` …
`interface Gi1/0/28` stanzas on a 2960-X — so the file an operator pastes into a ticket, diffs against a
backup, or compares with a real box named one port two ways in one session, because `show ip interface
brief` had already been taught to spell the type out. The stanza header now goes through the same
`displayName()` the brief table uses. The panel name is unchanged as the key: every lookup, every cable
and the stored config object keep it, `show interfaces` still heads its block with `Gi1/0/1` (that block
is this console's own shape, and a tested rule owns the spelling there), and the printed file replays
byte-identically.

## What the vendor prints

| Source | Shows |
| --- | --- |
| [Cisco support doc 113260, *Configure Catalyst 2960/2950 Series Switches with Voice VLAN*](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-2950-series-switches/113260-voice-vlan-00.html) | The command is typed `Switch# show running-config interface fastEthernet 0/6` and the answer is headed `interface FastEthernet0/6` — typed with a space and lower-case `fastEthernet`, printed capitalised and joined. A second capture on the same page, `show running-config interface fastEthernet 0/8`, comes back `interface FastEthernet0/8`. |
| [IOS XE 17.14.x Catalyst 9200 command reference, Interface and Hardware Commands](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-14/command_reference/b_1714_9200_cr/interface_and_hardware_commands.html) (the 17.7, 17.8, 17.12 and 26.x books of the same chapter print the same block) | `Device# show running-config interface gigabitethernet1/0/1` → `Building configuration...` / `Current configuration : 284 bytes` / `!` / `interface GigabitEthernet1/0/1` / `switchport trunk encapsulation dot1q` … — the typed name lower-case, the stanza header capitalised and long. |
| [Cisco 4000 Series ISRs Software Configuration Guide, Basic Router Configuration — Default Configuration](http://www.cisco.com/c/en/us/td/docs/routers/access/4400/software/configuration/guide/isr4400swcfg/bm_isr_4400_sw_config_guide_chapter_0110.html) | A whole default `show running-config`: `interface GigabitEthernet0/0/0` / `no ip address` / `negotiation auto` / `!` / `interface GigabitEthernet0/0/1` / … / `interface GigabitEthernet0` (the management port) — the full word on a router, including the port whose number is bare. |
| [Cisco, *Dynamically Configuring DHCP Server Options*](https://www.cisco.com/c/en/us/support/docs/ip/dynamic-address-allocation-resolution/22920-dhcp-ser.html) | A mixed file: `ip dhcp pool Central` … `!` / `interface FastEthernet0/0` / `ip address 10.0.0.1 255.255.255.0` / `duplex auto` / `speed auto` / `!` / `end`. The DHCP pool stanza and the interface stanza are both headed the way the box spells them, not the way they were typed. |
| [research/interface-brief-name-spelling.md](interface-brief-name-spelling.md), and the captures it cites (2960 lab, 9200, 8100, 4000 ISR) | The same rule already settled for `show ip interface brief`: every published capture prints `GigabitEthernet1/0/1`, `FastEthernet0/1`, `Vlan1`, `Port-channel1`. Two views of one box, one spelling. |

The counter-example that keeps the rule honest is about **case**, not about length: the
[Cisco 4000/1100 Series *Slot and Subslot Configuration* chapter](https://www.cisco.com/c/en/us/td/docs/routers/access/4400/software/configuration/xe-16-12/isr4400swcfg-xe-16-12-book/slot_and_subslot_configuration.html)
prints the same stanza as `interface gigabitEthernet0/0/0` — lower-case `g` — where the 4000 default
configuration on the same product line prints `interface GigabitEthernet0/0/0`. Both spell the type in
full; they disagree on its first letter.

## What this console printed

Measured on `21d1fe76`, `C2960X-24TS-L`, nothing configured:

```
! PacketForge running-config
hostname Catalyst 2960X-24TS-L-sw1
interface Gi1/0/1
!
interface Gi1/0/2
!
...
interface Gi1/0/28
!
end
```

and on an `ISR 4331`, `interface Gi0/0/0`. The name is the catalogue key and the panel's silkscreen, and
`research/interface-brief-name-spelling.md` had explicitly left `show running-config` on it when the brief
table was expanded; that note's sentence "the catalogue key, the lookup table and `show running-config`
are unchanged" recorded a decision, not a measurement of what a box prints.

## What changed

* `engine/cli.js`: the stanza header is `'interface ' + displayName(i.name)`. One line; the body lines
  (`description`, `ip address`, the `switchport` order, `clock rate`, `encapsulation dot1q`, the VRRP and
  OSPF lines) are untouched, and so are the `!` separator and `end`.
* `engine/iface-name.js`: unchanged. `displayName()` already expanded `gi/ge/fa/te/twe/fo/hu/se/vl/lo/po`,
  leaves `eth`/`et`/`ma` alone and returns a name it does not know as it found it, which is what keeps
  Ubiquiti's `Port 1` and `SFP+ 1` and RouterOS's `eth1` correct-by-silence.
* `test/running-config-interface-name.test.js` (34 checks): every stanza on a factory 2960-X long and none
  abbreviated; three typed spellings (`gi 1/0/1`, `GigabitEthernet 1/0/2`, `g1/0/3`) all printed as
  `interface GigabitEthernet…` with their description inside the right block; a subinterface as
  `interface GigabitEthernet1/0/3.10` with its tag inside; a 4331's `GigabitEthernet0/0/0` and
  `GigabitEthernet0`; a VRP `GE0/0/1` printed as `GigabitEthernet0/0/1`; `Port 1`, `SFP+ 1` and `eth1`
  untouched; the config headers and the `show ip interface brief` rows naming every port the same way; the
  file replaying byte-identically; `show interfaces` still heading its block with the panel spelling.
* Tests that located a stanza by the short name now locate it by the printed name or by `portKey()`
  (`running-config-stanza-separator`, `running-config-switchport-order`, `config-roundtrip`,
  `subinterface-state`, `subinterface-prompt`, `l3`, `acl-vlan-interface`, `serial-clock-survives-save`,
  `iface-type-prefix`, `iface-type-spelling`). `config-roundtrip`'s generic "every configured value
  appears" sweep now also accepts a value in its expanded spelling, because `config.vrrp[].interface` holds
  `Gi0/0/0` while the stanza it belongs to is headed `GigabitEthernet0/0/0`.
* `docs/CLI.md`: the naming paragraph now says which view prints which spelling, and the "paste it back"
  invariants gained the stanza-header rule.

## What is inferred, and what is unresolved

* **The capitalisation.** This console prints `GigabitEthernet` in both views, because the brief table
  already did and two views of one box must agree. Cisco's own pages disagree between chapters
  (`GigabitEthernet0/0/0` in the 4000 default configuration, `gigabitEthernet0/0/0` in the 4000/1100 slot
  chapter), so the case is per-release or per-platform and none of the captures in hand is a diff of the
  two. A capture from one named release would let the table carry a case per platform; nothing here
  invents one.
* **Types the table does not know.** `XGE0/0/1` (Huawei 10GE), `Twe`/`Fo`/`Hu` spellings that a panel may
  carry differently, and any vendor word outside the eleven entries are printed as the catalogue has them.
  Whether VRP prints `XGigabitEthernet0/0/1` where its panel says `XGE0/0/1` is not evidenced here.
* **An EtherChannel bundle has no stanza at all.** A box prints `interface Port-channel1` with its own
  config; this console prints none, for the bundle or its members' `channel-group` line only. That is a
  separate gap and was not touched.
* **No SVI stanza.** `interface Vlan1` exists on every Catalyst and is absent here; `research/
  svi-vlan1-default-state.md` records it as a feature, not a wording fix.
* **The lines inside the stanza.** The 4000 default configuration prints `no ip address` and
  `negotiation auto` in a port stanza that has nothing configured; this console prints nothing but the
  header and `!`. Whether a 2960-X prints either line on a factory port is a separate question, and not
  one this run had evidence for.
