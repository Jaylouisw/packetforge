# `show ip interface brief`: when does the Interface cell abbreviate the type word?

**Question (one, narrow).** The Interface column of `show ip interface brief` is 23 characters wide, and
every published capture prints `GigabitEthernet1/0/1` in full. But a Catalyst 9300-48UXM's own table also
prints `Te1/1/1`, `Tw1/0/1` and `Fo1/1/1` - the abbreviated types - in the same listing as
`TwentyFiveGigE1/1/1` in full. Is there a rule that decides which rows are abbreviated, or is the table
simply inconsistent?

**Verdict: one rule, the column's own width.** A type is spelled out when the full name fits in less than
23 characters, and abbreviated when it does not: `GigabitEthernet1/0/1` (20) and `TwentyFiveGigE1/1/1` (19)
print long; `TenGigabitEthernet1/1/1` (23), `TwoGigabitEthernet1/0/1` (23) and `FortyGigabitEthernet1/1/1`
(25) print `Te`, `Tw` and `Fo`; a subinterface follows the same boundary (`GigabitEthernet0/0/1.10`, 23,
prints `Gi0/0/1.10`). Every row in every capture below lands on that boundary, and no list of "types that
abbreviate" can explain 10G short beside 25G long on the same box.

This settles the question `research/interface-brief-name-spelling.md` and
`research/hundredgige-interface-spelling.md` both left open ("whether the command abbreviates any
high-speed type at all"), and the second note's 40G width question: IOS neither shifts, widens nor
truncates the 26-character `FortyGigabitEthernet1/0/1`, it abbreviates it to `Fo1/0/1`.

## What the vendor prints

Cisco, *Programmability Configuration Guide* - Zero-Touch Provisioning, IOS XE 17.1 through 17.18. The
same scripted session, on a C9300-48UXM, prints this table in every release checked:

```
*** Executing show ip interface brief ***
Interface              IP-Address      OK? Method Status                Protocol
Vlan1                  unassigned      YES unset  administratively down down
GigabitEthernet0/0     10.127.128.3    YES DHCP   up                    up
Tw1/0/1                unassigned      YES unset  down                  down
...
Te1/0/48               unassigned      YES unset  up                    up
...
Te1/1/6                unassigned      YES unset  down                  down
Fo1/1/1                unassigned      YES unset  down                  down
Fo1/1/2                unassigned      YES unset  down                  down
TwentyFiveGigE1/1/1    unassigned      YES unset  down                  down
TwentyFiveGigE1/1/2    unassigned      YES unset  down                  down
Loopback100            10.10.10.10     YES TFTP   up                    up
```

* IOS XE 17.1: <https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/prog/configuration/171/b_171_programmability_cg/zero_touch_provisioning.html>
* IOS XE 17.4: <http://www.cisco.com/c/en/us/td/docs/ios-xml/ios/prog/configuration/174/b_174_programmability_cg/zero_touch_provisioning.pdf>
* IOS XE 17.11: <https://bxin.cisco.com/c/en/us/td/docs/ios-xml/ios/prog/configuration/1711/b_1711_programmability_cg.pdf>
* IOS XE 17.14: <https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/prog/configuration/1714/b_1714_programmability_cg.pdf>
* IOS XE 17.18: <https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/prog/configuration/1718/b-1718-programmability-cg.pdf>

Four different type words on one box, and the short/long split is not a type list: 10G and 40G are short,
1G and 25G are long. The lengths are 23, 25, 20 and 19.

A live Catalyst 9200 (IOS XE 17.x) prints the same split, and its other views print the name in full - the
contrast is the proof that the abbreviation belongs to this table and not to the interface's name:

```
9200CX_HQ_ASA_GATEWAY#show ip int brief
Interface              IP-Address      OK? Method Status                Protocol
Vlan1                  4.x.x.169       YES NVRAM  up                    down
GigabitEthernet1/0/1   unassigned      YES unset  down                  down
...
Te1/0/5                unassigned      YES unset  down                  down
...
Te1/1/1                4.x.x.142       YES NVRAM  up                    up
9200CX_HQ_ASA_GATEWAY#show ip route
C        4.36.97.140/30 is directly connected, TenGigabitEthernet1/1/1
9200CX_HQ_ASA_GATEWAY#show running-config
interface TenGigabitEthernet1/1/1
```

* <https://community.cisco.com/t5/routing/can-i-use-9200-as-an-edge-router/td-p/4997913>
* Two more 9200 transcripts with the same row: <https://community.cisco.com/t5/switching/unable-to-telnet-catalyst-9200-but-able-to-connect-through-other/td-p/4951264> (`Te1/1/1 unassigned YES unset up up`) and <https://community.spiceworks.com/t/config-suggestions-for-cisco-9200-switch/793596>.

A subinterface is spelled the same way, on Cisco Press's router-on-a-stick example: the parent is long, the
children - whose full names are 23 characters - are short.

```
R1# show ip interface brief | include up
GigabitEthernet0/0/1    unassigned      YES unset  up                    up
Gi0/0/1.10              192.168.10.1    YES manual up                    up
Gi0/0/1.20              192.168.20.1    YES manual up                    up
Gi0/0/1.99              192.168.99.1    YES manual up                    up
```

* <https://www.ciscopress.com/articles/article.asp?p=3089357&seqNum=5>

The sharpest capture is an ISR 1921's table, already quoted by
`research/interface-brief-subinterface-order.md`, because it contains the 22/23 edge on one screen:

```
Router ISP>sh ip int brie
Interface              IP-Address      OK? Method Status                Protocol
GigabitEthernet0/0/0   192.168.5.25    YES NVRAM  up                    up
GigabitEthernet0/0/1   unassigned      YES NVRAM  up                    up
GigabitEthernet0/0/1.1 10.10.10.2      YES NVRAM  up                    up
GigabitEthernet0/0/1.2 172.18.10.2     YES NVRAM  up                    up
Gi0/0/1.600            10.20.10.2      YES NVRAM  up                    up
```

`GigabitEthernet0/0/1.1` and `.2` are 22 characters and are spelled out; `.600` would be 24 and is
abbreviated. Together with the 23-character `Te1/1/1` row above, that fixes the boundary at 23: 22 long,
23 short.
(<https://community.cisco.com/t5/other-network-architecture-subjects/cisco-router-1921-problem/td-p/4716312/page/2>)

## The arithmetic

| full name | characters | printed | source |
| --- | --- | --- | --- |
| `GigabitEthernet1/0/1` | 20 | long | ZTP 9300, 2960 captures |
| `TwentyFiveGigE1/1/1` | 19 | long | ZTP 9300 |
| `GigabitEthernet0/0/1` | 20 | long | Cisco Press, 1921 |
| `HundredGigE1/0/1` | 16 | long (inferred) | no brief capture; the running-config stanza is `HundredGigE1/0/2` (`research/hundredgige-interface-spelling.md`) |
| `TenGigabitEthernet1/1/1` | 23 | `Te1/1/1` | ZTP 9300, live 9200 |
| `TwoGigabitEthernet1/0/1` | 23 | `Tw1/0/1` | ZTP 9300 |
| `FortyGigabitEthernet1/1/1` | 25 | `Fo1/1/1` | ZTP 9300 |
| `GigabitEthernet0/0/1.10` | 23 | `Gi0/0/1.10` | Cisco Press, 1921 |
| `GigabitEthernet0/0/1.1` | 22 | long | 1921 community capture |
| `GigabitEthernet0/0/1.600` | 24 | `Gi0/0/1.600` | 1921 community capture |

The header's Interface field is 23 columns, and a 23-character value would leave no space before
`IP-Address`. So the rule is read as: print the full name while it is shorter than the field, abbreviate at
or past the field. It reproduces every row above, on four platforms and both name shapes (physical and
subinterface).

## What is known, inferred, unresolved

**Known.** `Te`, `Tw`, `Fo` and `Gi` rows in `show ip interface brief` are abbreviated exactly when their
full names reach 23 characters: 19-, 20- and 22-character names print in full, 23-, 24- and 25-character
names are abbreviated (ZTP captures, 9200 transcripts, Cisco Press, the 1921's `.1`/`.600` rows). The
abbreviation is a property of this table: `show running-config` and `show ip route` on the same box print
`TenGigabitEthernet1/1/1`.

**Inferred.** That the decision is the field width rather than an internal interface-descriptor limit that
happens to be 23. The two readings cannot be separated by the captures in hand; both reproduce every row.
`HundredGigE1/0/1` being long is inferred from the rule, not read from a brief capture.

**Unresolved.** A vendor whose word this table does not know is printed unchanged - an FSOS
`HundredGigabitEthernet0/1` (25) stays 25 characters and pushes the row right, because inventing an
abbreviation for another vendor's type would be worse than a wide row. Whether non-IOS platforms
abbreviate on their own width rule is untouched, and no 100G row in this table has been captured.

## What changed

* `engine/iface-name.js` - `briefName(name)`: `displayName()` first, then the panel spelling when the long
  name is 23 characters or more. `BRIEF_NAME_WIDTH = 23` names the constant.
* `engine/cli.js` - the `show ip interface brief` row prints `briefName(i.name)`. No other view changed:
  `show running-config`, `show interfaces`, `show vlan`, the MAC table and the EtherChannel summary keep
  the spellings their own captures show.
* `test/interface-brief-type-abbreviation.test.js` (32 assertions) - the 23-character boundary on a
  C9200L-24P-4X (`Te1/1/1`), the long cases on a C9500-24Y4C / C9200L-24PXG-2Y / C2960X, the subinterface
  on an ISR 4331 (`Gi0/0/0.10`), column alignment at 23, the untouched running-config stanza, both
  spellings reaching one port object, and the helper's table.
* Suites that asserted the old spelling in this table were corrected, not weakened: their subject (which
  port number is listed) is unchanged, and their regexes now name the row a box prints -
  `c1000-4x-uplink-naming`, `c1300-4x-uplink-naming`, `c9200l-uplink-numbering`,
  `interface-brief-name-spelling`, `interface-brief-subinterface-order`, `subinterface-number`.
* `docs/CLI.md` - the brief-table section states the boundary and shows `Gi0/0/0.10` under its parent.

## What would settle the rest

1. A 100G brief capture (`Hu1/0/1` or `HundredGigE1/0/1`), to confirm the inferred long row - the one
   length the boundary rule predicts but no capture contains.
