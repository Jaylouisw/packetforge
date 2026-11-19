# Is a router's console port an interface? What three views print for it

**Question (one, narrow).** On a Cisco-style router that has both a console and an auxiliary port, do
`show ip interface brief`, `show interfaces` and `show running-config` print anything for those two sockets -
and may an address be configured on one with `interface Console` / `ip address`?

**Verdict: known, and adopted.** No box prints an interface row, a block or a stanza for either socket, and no
`interface Console` name exists to open. PacketForge printed all three, and accepted an address on the socket.
The rule now lives in one predicate (`engine/device.js` `isConsoleLine()`) and is applied at four doors.

## What PacketForge did before (run on the 2811 in `devices/cisco/2811.json`)

```
Cisco 2811 # show ip interface brief
FastEthernet0/0        unassigned      YES unset  down                  down
FastEthernet0/1        unassigned      YES unset  down                  down
Serial0/0/0            unassigned      YES unset  down                  down
Serial0/0/1            unassigned      YES unset  down                  down
Console                unassigned      YES unset  down                  down      <-- invented
Aux0                   unassigned      YES unset  down                  down      <-- invented

# show interfaces
Console (console, 1G), MAC 0200.0000.0004                                        <-- invented
  speed: 1Gb/s (auto), duplex: full                                              <-- invented

# show running-config
interface Console                                                                <-- invented
!
interface Aux0
!
```

It went further: `configure terminal` / `interface Console` / `ip address 10.9.9.9 255.255.255.0` was accepted
and the address then appeared in the brief table as `Console 10.9.9.9 YES manual down down` - an address on an
RS-232 socket that, after this note's change, no table would show.

The scope is not one model: 233 of the 2,356 catalogued models declare a console socket in `interfaces`
(683 sockets). They are there deliberately - the faceplate draws them and the physical layer already treats
them as out-of-band (`engine/media.js` `canMate()`: "a console port is not a data port", plus a baud-rate
negotiation between two consoles) - but the interface tables never asked the question.

Note the fabrication is two layers deep: `Interface` defaults `this.speed = spec.speed || '1G'`, so a socket
with no speed of its own was printed as a gigabit port, and `Topology` assigns every port a MAC, so the console
got one too.

## What the box prints

Cisco tech note 19065, *Sync-Async Ports for Async Modem Dial-in On Cisco 1600, 1700, 2600, and 3600
Platforms* (IOS 12.1, a 3640 with console and aux), is the one capture that shows every view at once. Its
`show running-config`:

```
interface Loopback0
 ip address 1.1.1.1 255.255.255.0
!
interface Ethernet0/0
ip address 10.10.10.1 255.255.255.0
!
interface Serial3/0
 no ip address
...
line con 0
line 104
...
line aux 0
 password <removed>
 login
line vty 0 4
 password <removed>
 login
!
end
```

No `interface Console`, no `interface Aux0`: the sockets live in the `line` section. Its `show line`:

```
    Tty  Typ    Tx/Rx      A  Modem  Roty AccO AccI   Uses  Noise  Overruns   Int
 *    0  CTY     -  -      -    -     -     0     0      0/0         -
 I   104 TTY 115200/115200 - inout    -     -     -      0    0      0/0      Se3/7
    129 AUX  9600/9600    -    -     -     -     -      0    0      0/0        -
```

The console is line 0, type `CTY`, with **no** Tx/Rx; the auxiliary port is line 129, type `AUX`, at
`9600/9600`. `show users` on the same box prints `*  0 con 0 ... idle 00:00:00`. And the interface tables on
it are `Loopback0`, `Ethernet0/0`, `Serial3/0`-`Serial3/7` - the two sockets appear in neither
`show ip interface brief` nor `show interfaces`.

The modern shape is the same. Cisco 4000 Series ISRs Software Configuration Guide, IOS XE 16.10, *Basic
Router Configuration*, prints a factory `show running-config` whose interface list is GigabitEthernet0/0/0
through GigabitEthernet0 (the management port) and which closes with:

```
line con 0
stopbits 1
line vty 0 4
login
!
end
```

again with no interface named after the console.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco tech note 19065, *Sync-Async Ports for Async Modem Dial-in* (IOS 12.1, 3640)](http://cisco.com/c/en/us/support/docs/dial-access/asynchronous-connections/19065-sync-async.html) | `show running-config` holds `line con 0` and `line aux 0` and no interface for either; `show line` prints `* 0 CTY` and `129 AUX 9600/9600`; `show users` prints `0 con 0`; the interface list is Loopback0/Ethernet0/0/Serial3/x |
| [Cisco 4000 Series ISRs Software Configuration Guide, IOS XE 16.10, *Basic Router Configuration*](http://cisco.com/c/en/us/td/docs/routers/access/4400/software/configuration/xe-16-10/isr4400swcfg-xe-16-10-book/basic_router_configuration.html) | Factory `show running-config`: interfaces are GigabitEthernet0/0/0-0/0/3 and GigabitEthernet0; then `line con 0` / `stopbits 1` / `line vty 0 4` / `login` / `end` |
| [Cisco Connected Grid Routers 2010 Hardware Installation Guide, *Preparing for Router Installation*](http://cisco.com/c/en/us/td/docs/routers/access/2000/CGR2010/hardware/installation/guide/CGR2010_HIG/Preinstall.html) | "The default parameters for the console port are 9600 baud, 8 data bits, no parity, and 1 stop bit." The same page names the aux port as an EIA/TIA-232 asynchronous socket, and notes the console does not support hardware flow control (so a modem belongs on the aux port) |
| [Cisco IOS Interface and Hardware Component Command Reference, `show ip interface brief`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-s5.html) | Sample on a router: `GigabitEthernet0/0/0` … `GigabitEthernet0/0/3`, `Serial1/0/0`, `GigabitEthernet0` - no console/aux row |
| [Cisco 1100 Series ISR Software Configuration Guide, *Slot and Subslot Configuration* (PDF)](http://www.cisco.com/c/en/us/td/docs/routers/access/isr1100/software/configuration/guide/isr1100-sw-config/slot_and_subslots.pdf) | `show ip interface brief` on an ISR 1100 (which has a console port): GigabitEthernet0/0/0-0/1/7, Wl0/1/8, Cellular0/2/0-1, Loopback3/50/100, Port-channel2, Vlan1 - no console row |
| `engine/media.js` `canMate()` (this repo) | "a console port is not a data port"; two consoles negotiate a baud rate, not a line rate |

A caveat recorded rather than glossed: the 2811 itself has no cisco.com `show ip interface brief` capture in
hand. The 2811's port list (Fast Ethernet 0/0, Fast Ethernet 0/1, Serial 0/0/0, Serial 0/0/1) comes from the
Cisco-authored CCNA lab `6.4.3.5 Lab - Building a Switch and Router Network` (© Cisco, "This document is Cisco
Public"), which is hosted by a third party and whose text layer would not extract here. The rule does not rest
on that document: it rests on the 3640 capture, where the console, the aux port and the interface list are all
visible in one paste.

## What is known

1. The console and aux sockets are **lines**, configured under `line con 0` / `line aux 0`, reported by
   `show line` (types `CTY` and `AUX`) and `show users` (`con 0`).
2. They are **not** interfaces: no `interface Console` block exists in a running-config, no row in
   `show ip interface brief`, no block in `show interfaces`. `show interfaces` on that 3640 shows
   `Serial3/7 is up, line protocol is up / Hardware is CD2430 in async mode` - a *data* port that happens to
   carry an operator session, which is the closest a console gets to being an interface and still is not one.
3. Their rate is a **baud rate**, 9600 by default (8 data bits, 1 stop bit, no parity), not a line rate; the
   aux port may be set higher (the same guide allows up to 115200 for a modem).

## What is inferred

* Because the catalogue stores the socket as a port (`type: "console"`) for the faceplate's sake, the rule has
  to be applied by the views rather than by deleting the port. Deleting it would remove the connector from the
  panel and the console cable from the topology, which are both real.
* A device's `show interfaces` count therefore equals its **data** ports: a box with 4 data ports and 2
  console sockets prints 4 blocks. Two existing sweeps that counted `dev.interfaces.size` were adjusted rather
  than the rule being weakened (`test/counters-agreement.test.js`, `test/port-name-arguments.test.js`).
* The refusal `interface Console` prints is this console's own sentence, not IOS's. On a box the name does not
  resolve at all and the parser answers `% Invalid input detected at '^' marker.`; reproducing the caret line
  would claim a syntax error for a name that is well-formed, and this console has no `line` mode to point the
  reader at, so it names the line and where a box keeps its settings instead.

## What is unresolved

* **`line con 0` is not a mode here.** After this change the socket has no configuration surface at all: it
  cannot be given a baud rate, an exec-timeout, a password or `logging synchronous`, and there is no
  `show line` to read it back from. Modelling the line (and `show line` / `show users`) is a feature, not a
  fidelity fix, and it is not started.
* **USB console ports.** Some ISRs have a USB console alongside the RJ-45. The catalogue types every socket it
  records as `console` today (no `type: "usb"` port exists in any model), so the predicate covers `console`
  only. If a future spec types a USB console as `usb`, it will still print as an interface.
* **A saved lab that already has an address on a console socket** (possible before this change): the address
  stays on the port object and is now printed by no view. Whether the topology loader should strip it, warn, or
  leave it is undecided; the honest reading is that such a document describes a box that cannot exist.
* **`show interfaces` on a device whose only ports are console/USB** would now print nothing at all. No model in
  the catalogue is in that state; what a box would print for a terminal server whose "interfaces" are async
  lines (`show interfaces` on an async line does print a block, because an async line *is* interface `Async0`)
  is a different question and is not answered here.
* **What a box prints for `show interfaces console`** was not found in any capture. Cisco's own naming for the
  line in that view is `line con 0`; no transcript of the interface form exists, which is consistent with the
  name not resolving.

## What would settle the rest

1. A `show line` / `show users` / `show running-config | include ^line` capture from a 2811 or 2901 alongside a
   `show ip interface brief`, in one paste - that would close the 2811 caveat above.
2. A Cisco page that documents `show interfaces` on an **async line** (`Async1`), which is the one case where a
   terminal line does get an interface block, and would decide whether `line con 0` deserves the same treatment
   if the line mode is ever modelled.
3. A capture of `show interfaces console` (or its refusal) on any IOS release.

## What changed (2026-11-19)

| Surface | Before | Now |
| --- | --- | --- |
| `show ip interface brief` | `Console` / `Aux0` rows with `unassigned YES unset down down` | no row for either socket |
| `show interfaces` | a block per socket, with a MAC, a 1 Gb/s rate and a duplex | no block; `show interfaces Console` answers in one sentence |
| `show running-config` | `interface Console` / `interface Aux0` stanzas | no stanza (the config's own `!` separators are unchanged) |
| `interface Console` | opened the socket, accepted `ip address` | refused in one sentence, session stays in config mode |
| the port itself | in `device.interfaces` | still there - faceplate, cable and topology unchanged |

One predicate, `isConsoleLine(port)` in `engine/device.js`, exported and used at those four doors, so the rule
cannot drift between them. `test/console-is-a-line-not-an-interface.test.js` pins the 2811 case, both refusal
sentences, that a data port is unaffected, and sweeps all 233 models that declare a console socket (683
sockets) to prove no interface view prints one. Nothing else was modelled: no `line` mode, no `show line`, and
no other `show` view was touched (a probe over `show vlan`, `show spanning-tree`, `show power inline`,
`show lldp`, `show ip route`, `show arp`, `show mac address-table`, `show etherchannel summary`, `show ip ospf`,
`show ip bgp`, `show ip dhcp`, `show ip dns`, `show vrrp` and `show ip nat translations` on the same 2811
prints no console or aux line, before or after).
