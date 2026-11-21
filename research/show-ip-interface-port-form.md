# `show ip interface <port>`: the box's port form, and what this console answered instead

**Question (one, narrow).** A Cisco box documents the view as `show ip interface [type number] [brief]`. This
console answered `show ip interface` (bare) with the per-port detail block, but `show ip interface Gi0/0` with
`% Invalid show command: ip interface Gi0/0` - the sentence a misspelt view gets, about a view the console prints
and a port it knows. So: is the port form a real IOS syntax, what does it print, and what should this console
answer for it?

**Verdict: known, and adopted.** The port form is the vendor's own syntax, and it prints the same IP-characteristics
block the bare form prints, for the one interface named. This console has no separate IP-characteristics block -
its IP view *is* its interface detail view - so the port form now reaches that block for one port, exactly as the
bare form already did (alias, not a second implementation).

## The syntax, from the vendor

* Cisco IOS Interface and Hardware Component Command Reference, `show ip interface`
  (<https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-s5.html>): "To display the
  usability status of interfaces configured for IP, use the `show ip interface` command in privileged EXEC mode.
  `show ip interface [type number] [brief]`", with `type` - "(Optional) Interface type", `number` - "(Optional)
  Interface number".
* Catalyst Supervisor Engine 32 PISA IOS Command Reference 12.2ZY, `show ip interface`
  (<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst6500/ios/12-2ZY/command/reference/cmdref/show2.html>):
  "If you specify an optional interface type, you see only information on that specific interface", with the
  capture

  ```
  Router# show ip interface vlan 1
  Vlan1 is up, line protocol is up
    Internet address is 10.6.58.4/24
  ```

  - a switch, a port name, and the block narrowed to that port.
* Cisco TAC E-Learning reprint of the command reference
  (<https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_ip_interface.htm>)
  prints the same shape for `show ip interface hssi 5/0/0.1` (a subinterface), so the argument is a port name in
  the same spellings the interface views take.

## What a box prints for one port that this console does not model

The port form is the IP-characteristics block, not the hardware block: `Internet address is ...`,
`Broadcast address is ...`, `Address determined by setup command`, `MTU is 1500 bytes`, `Helper address is not
set`, `Directed broadcast forwarding is enabled`, `Multicast groups joined: ...`, `Outgoing access list is not
set`, `Inbound access list is not set`, `Proxy ARP is enabled`, `Security level is default`, `Split horizon is
enabled`, the four ICMP lines, fast/SSE switching, Router Discovery, IP accounting, TCP/IP header compression,
and the probe/gateway-discovery lines (the E-Learning capture above, IOS 11.2/12.x wording).

This console keeps state for the address, the mask and the ACL bound in each direction; it keeps none for MTU,
helper address, directed-broadcast forwarding, proxy ARP, split horizon, ICMP policy, or the switching paths. A
block that printed those lines would be inventing them, so the port form answers with the console's own per-port
block - `status`, `ip: <addr>/<len>`, `switchport`, `speed`/`duplex`, counters - in which the address line is the
one fact the IP view is asked for.

## What changed

`engine/cli.js`: `SHOW_IP_BARE_ALIASES` (`interface` -> `interfaces`) now answers the port form and any tail word
as well as the bare form; `brief` keeps its own door, and a tail the detail view cannot use is answered in that
view's words (the same way `show ip arp <address>` is answered by `show arp`). Before, only a line of exactly two
words was rewritten, so every longer spelling fell through to `% Invalid show command`.

`test/show-ip-interface-port-form.test.js` pins: the block for one port is byte-identical to `show interfaces
<port>`; the spelled-out type (`GigabitEthernet0/0`) reaches the same port; an unknown port gets the console's
missing-port sentence, not "invalid command"; `show ip interface brief` and `show ip interface brief <port>` are
unchanged; a tail word after a port is answered by the detail view; and `?` after the view names the detail view's
usage.

## What remains unresolved

* **Type and number as two tokens.** A box accepts `show ip interface fastEthernet 0/1`; this console's interface
  door takes one token, so the split spelling is still refused ("% No interface fastEthernet 0/1 on ..."). The same
  gap exists on `show interfaces fastEthernet 0/1` and is not new here; what would settle it is a decision about
  the port-name parser, not about this view.
* **Which lines a 2960 image prints.** The captures in hand are a 6500 12.2ZY reference, an 11.2/12.x TAC reprint
  and a Nexus rendering. A terminal capture from the 2960 15.2E image the catalogue targets would fix the exact
  line set and order, if anyone ever models the IP-characteristics block; nothing here depends on it today.
