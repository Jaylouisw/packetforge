# DHCP pool configuration mode: what the prompt actually says

**Question (one, narrow).** Inside DHCP pool configuration mode — the sub-mode `ip dhcp pool <name>`
puts you in — what does an IOS box print in front of the cursor?

**Verdict: `<hostname>(dhcp-config)#`.** The words are in that order, and no other sub-mode this console
has does it that way (`(config-if)#`, `(config)#`, `(config-router)#` all wear the `config-` prefix).
The console printed `Router(config-dhcp)#` — a plausible guess from the family shape, and a string no
router produces — so the prompt was corrected and `test/dhcp-pool-prompt.test.js` now holds it.

## Known: three Cisco configuration guides print the prompt inside a session capture

These are step tables whose *Example* column is a captured line, not prose about the mode:

| guide | captured line |
|---|---|
| Cisco IOS Release 12.4T, *Configuring the Cisco IOS DHCP Server* | `Router(dhcp-config)# network 172.16.0.0 /16`, `Router(dhcp-config)# lease 30`, `Router(dhcp-config)# end` |
| Cisco IOS XE 16.x / 17.x, *IP Addressing Configuration Guide* — Configuring the DHCP Server | `Device(dhcp-config)# network 172.16.0.0 /16`, `Device(dhcp-config)# utilization mark low 70 log` |
| Cisco IOS XE 3SE (Catalyst 3650), same chapter | `Device(dhcp-config)# host 172.16.0.1`, `Device(dhcp-config)# option 19 hex 01` |

* https://www.cisco.com/en/US/docs/ios/12_4t/ip_addr/configuration/guide/htdhcpsv.html
* https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_dhcp/configuration/12-4/dhcp-12-4-book/config-dhcp-server.html
* https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/ip-addressing/b-ip-addressing/m_config-dhcp-server-xe.html
* https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_dhcp/configuration/dhcp-xe-3se-3650-book/config-dhcp-server.html

Operator pastes all carry the same spelling, including the `?` listing taken from inside the mode:

* https://community.cisco.com/t5/routing-and-sd-wan/vlans-dhcp-pool-and-subnetting/td-p/4735058 — `Router(dhcp-config)#network 192.168.1.0 255.255.255.0`
* https://community.cisco.com/t5/switching/reserved-static-ip-on-pc/m-p/1024052 — "your promt will be router(dhcp-config)#"
* https://studylib.net/doc/9536958/4e_07_nat_dhcp_7_4_1 — Cisco Networking Academy lab capture, `R1(dhcp-config)#network …`
* A `?` listing taken from inside the mode — `Router(dhcp-config)#?` … `exit Exit from DHCP pool configuration mode` —
  appears in a lab handout at https://www.studocu.com/row/document/addis-ababa-institute-of-technology/reinforced-concrete-structures-i/dhcp-on-router-it-is-interesting-course/31400667

## The contradiction, stated plainly

Cisco's own documentation is not unanimous, and the other spelling is not from a forum:

* The **command reference** page for `ip dhcp pool` puts it in prose: "the configuration mode changes to
  DHCP pool configuration mode, which is identified by the **(config-dhcp)#** prompt."
  https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-i2.html
* The **Cisco 850/870** configuration guide *Configuring a LAN with DHCP and VLANs* types
  `Router(config-dhcp)#` in its step table. http://www.cisco.com/en/US/docs/routers/access/800/850/software/configuration/guide/dhcpvlan.html
* The **Cisco Business 350** switch CLI guide prints `switchxxxxxx(config-dhcp)#` throughout —
  a different operating system from IOS, and no evidence about a router either way.
  http://www.cisco.com/c/en/us/td/docs/switches/lan/csbms/CBS_250_350/CLI/cbs-350-cli-/dhcp-server-commands.html

**Inferred, not known:** the `(config-dhcp)#` form is the documentation template's habit rather than a
capture. Two things point that way. First, every *captured* line in the same doc family says
`dhcp-config` — the prose and the examples in the 12.4T guide disagree with each other, and only one of
them was pasted off a box. Second, the same 12.4T guide names the secondary-subnet sub-mode
`(config-dhcp-subnet-secondary)#` in prose while showing no capture for it: the "config-" prefix is what
the writer reaches for when there is no capture in front of them. No Cisco document shows a capture of a
router prompting `(config-dhcp)#`.

## What this run changed

* `engine/cli.js` — `prompt()` answers `host + '(dhcp-config)#'` for `MODE_DHCP_POOL`, with the evidence
  in the comment above it.
* `test/dhcp-pool-prompt.test.js` — six checks: the prompt itself, no space before the brace, the name
  comes from the hostname, the mode still behaves as a pool (`network`, `default-router`, `exit` back to
  `(config)#`, the pool still in `show running-config`), `end` reaches `#`, and the whole prompt ladder is
  asserted so a later mode cannot be invented with the `config-` prefix.
* `test/help-key-works-in-every-prompt.test.js` and `docs/CLI.md` carried the old spelling and were
  corrected with it; the Modes table in `docs/CLI.md` gained the row it never had.

## What remains unresolved

* **No capture from a box in hand.** The conclusion rests on published captures and pastes, not on a
  session this project ran. One screenshot of the prompt from a physical IOS router would turn the
  inference into an observation; the change is a single string if it goes the other way.
* **The other sub-mode prompts are not modelled.** IOS has `(config-router)#` for `router bgp`/`router
  ospf`, `(config-vlan)#` for `vlan <id>` and `(config-subif)#` for a subinterface. This console enters
  one flat config mode for all of them (and `interface Gi0/0.10` stays in `(config-if)#`), so those
  prompts cannot be checked here — a different question, and a much larger one.
* **Version spread.** All the captures above are 12.4T or later IOS XE. A 12.0/12.1 guide was not found
  in full text; if DHCP pool mode ever prompted differently it would be that far back and no public
  capture shows it.
