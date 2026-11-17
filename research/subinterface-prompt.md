# Inside a subinterface: what the prompt says

**Question (one, narrow).** After `interface Gi0/0.10` — the port-with-a-dot that router-on-a-stick is
built from — what does an IOS box print in front of the cursor?

**Verdict: `<hostname>(config-subif)#`.** A subinterface is its own configuration mode on a box, with its
own prompt, and it is not the `(config-if)#` its parent port prints. This console had one interface mode
and printed `(config-if)#` inside a `Gi0/0.10`, so a pasted router-on-a-stick transcript came back wearing
a prompt no box produces. `engine/cli.js` `prompt()` now asks the interface object the mode was entered
on, and `test/subinterface-prompt.test.js` holds the answer.

## Known: every capture agrees, and the guides name the mode as a separate one

Cisco's task tables are written as step → command → *Example*, and the examples are captured lines:

| source | captured line |
|---|---|
| IOS XE, *Access Node Control Protocol* (step 7/8) | `Router(config-subif)# encapsulation dot1q 100 second-dot1q 200`, `Router(config-subif)# exit` |
| IOS, *IEEE 802.1Q-in-Q VLAN Tag Termination* | `Router(config)# interface gigabitEthernet1/0.100` … `Router(config-subif)# encapsulation dot1q 101 second-dot1q 1001` |
| IOS XE 16.11, *PPPoE QinQ Support* | `Router(config)# interface gigabitethernet1/1/0.100` → `Router(config-subif)# encapsulation dot1q 101 second-dot1q 1001` |
| ASA 5500, *Configuring Ethernet Settings and Subinterfaces* | `hostname(config)# interface gigabitethernet0/1.100` → `hostname(config-subif)# no shutdown` |

* https://www.cisco.com/c/en/us/td/docs/routers/ios-xe/security-vpn/security-vpn/m_ancp-xe.html
* https://www.cisco.com/en/US/docs/ios/lanswitch/configuration/guide/lsw_ieee_802.1q.html
* https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/bbdsl/configuration/xe-16-11/bba-xe-16-11-book/bba-pppoe-qinq-xe.html
* https://www.cisco.com/c/en/us/td/docs/security/asa/asa72/configuration/guide/conf_gd/intrface.html

The step text says it too: `interface type number.subinterface` "enters subinterface configuration
mode", which is a name for a mode, not for a place inside interface mode.

## Known: the mode is decided by the interface entered, not by where you came from

One TAC knowledge-base transcript walks the whole boundary, and it is the case the test pins —
`interface GigabitEthernet0/1.50` from a `(config-subif)#` stays in `(config-subif)#`, while
`interface GigabitEthernet0/1` from that same prompt lands in `(config-if)#`:

```
Router1(config)#interface GigabitEthernet0/0.10
Router1(config-subif)# encapsulation dot1Q 10
Router1(config-subif)# interface GigabitEthernet0/0.11
Router1(config-subif)# encapsulation dot1Q 11
Router1(config-subif)#interface GigabitEthernet0/1
Router1(config-if)# no ip address
Router1(config-if)#interface GigabitEthernet0/1.50
Router1(config-subif)# encapsulation dot1Q 50
```

* https://community.cisco.com/t5/networking-knowledge-base/configuring-ip-helper-address-to-issue-ip-address-from-dhcp/tac-p/5286519
* Router-on-a-stick write-up using the same spelling: https://learningnetwork.cisco.com/s/article/fundamentals-of-vlan-s-router-on-a-stick

That is why the implementation asks `interfaces.get(this.iface).type === 'subinterface'` rather than
testing the typed name for a dot: the mode belongs to the object, and a dotted name that is not a
subinterface must not borrow the spelling.

## Inferred, not known

* **The prompt does not depend on the parent's media.** The captures cover Ethernet parents (routers) and
  a port-channel-capable ASA; no capture of a dot1q subinterface under a serial or tunnel parent was
  found. The engine treats every `parent.vlan` alike, which is the low-risk reading.
* **Switches.** No capture of `interface Gi1/0/1.10` on a Catalyst was found; the platform is not where
  subinterfaces are normally used, and the model's subinterfaces are created for routers and L3 switches
  the same way.

## Unresolved, and what would settle it

* **No capture from a box in hand.** As with the DHCP-pool prompt, this rests on published captures and
  pastes, not on a session this project ran. One screenshot of `Router(config-subif)#` from a physical
  router would close it; the change is a single string if it went the other way.
* **The other sub-mode prompts are still flat.** IOS also has `(config-router)#` for `router bgp`/`router
  ospf` and `(config-vlan)#` for `vlan <id>`; this console enters one flat `(config)#` for both. Those are
  separate questions with their own prompts to pin, and the `vlan` one would change a prompt this console
  prints today.
* **A refused `interface <name>` drops the session to `(config)#`.** Found while testing this, and left
  alone as a different question: from `Gi0/0` or `Gi0/0.10`, `interface Gi9/9` prints
  `% Interface not found: Gi9/9` and then prompts `(config)#` — a box reports the error and leaves you in
  the mode you were in. Nothing in this run depended on it, and pinning the wrong behaviour in a test
  would have been worse than reporting it. A transcript of a mistyped `interface` on a real box is the
  evidence that would settle the wording and the mode both.
