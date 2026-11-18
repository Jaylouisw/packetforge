# How long does a DNS translation live, and what makes a translation "DNS"?

**Question (one, narrow).** `ip nat translation (timeout)` publishes a `dns-timeout` of 60 seconds beside the
UDP 300-second timer and says "Non-DNS UDP translations time out after 5 minutes, and DNS times out in 1 minute".
PacketForge ages every UDP entry at 300 s, so: **what makes one UDP translation a DNS translation, and is the
60-second timer in force by default?**

**Verdict: known enough to adopt, and adopted.** A *DNS translation* is a UDP entry in the port-translation
(overload) table whose destination is the DNS ALG's port, 53. The ALG is on as soon as NAT is configured, so the
60-second timer is the default for a query, not an opt-in. `engine/nat.js` now classifies such an entry and ages
it at 60 s, and `test/nat-dns-translation-timeout.test.js` holds it (31 checks). Three things stay unmodelled and
are named below.

## Evidence

| Source | What it states |
| --- | --- |
| [Cisco IOS IP Addressing Services Command Reference, `ip nat translation (timeout)`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-i4.html) | `dns-timeout` — "applies to connections to the Domain Name System (DNS). The default is 60 seconds." Usage Guidelines: "When port translation is configured, each entry contains more information about the traffic that is using the translation, which gives you finer control over translation entry timeouts. Non-DNS UDP translations time out after 5 minutes, and DNS times out in 1 minute. TCP translations time out in 24 hours, unless a TCP Reset (RST) or a Finish (FIN) bit is seen…" |
| [Cisco IOS XE Catalyst SD-WAN Qualified Command Reference, NAT commands](https://cisco.com/c/en/us/td/docs/routers/sdwan/command/iosxe/qualified-cli-command-reference-guide/m-NAT-commands.html) | Repeats the same two sentences, and defines `ip nat service dns <tcp or udp> [port port-number]`: the ALG runs on a default port and `port port-number` names "the port other than the default". |
| [Cisco Security Advisory cisco-sa-alg-dos-hbBS7SZE (DNS NAT ALG)](https://www.cisco.com/c/en/us/support/docs/csa/cisco-sa-alg-dos-hbBS7SZE.html) | "The DNS ALG feature is enabled as soon as NAT is configured on the device." Disabling it means `no ip nat service dns tcp` **and** `no ip nat service dns udp` in `show running-config`. This is what makes 60 s the default rather than a configuration. |
| [User Guide for Cisco Security Manager, "Configuring NAT"](https://cisco.com/c/en/us/td/docs/security/security_management/cisco_security_manager/security_manager/429/user/csm-user-guide-429/chapter24-configuring-network-address-translation.html) | "non-DNS translations time out by default after five minutes, but DNS translations time out after 1 minute"; the DNS Timeout field is "the timeout value applied to Domain Naming System (DNS) server connections. The default is 60 seconds", and applies only when port translation (overload) is enabled. |
| [Cisco community, "How to configure a NAT translation timeout"](https://community.cisco.com/t5/networking-knowledge-base/how-to-configure-a-nat-translation-timeout/ta/p/3109488) | The same contrast in a technician's words: "Non-DNS UDP translations time out after 5 minutes; DNS times out in 1 minute." |

Two readings were considered and one was rejected:

* **Rejected: "dns-timeout only applies to entries whose payload NAT rewrote."** The ALG's payload job is to fix
  up A/PTR records, and the Security Manager page describes it that way. But the timer is described as a
  *timeout on a translation entry*, and the command reference contrasts it with "Non-DNS UDP translations" -
  i.e. both are UDP translation entries, told apart by whether NAT recognised them as DNS. A payload-only
  reading would also make the timer unreachable on any box that does no payload rewriting, which is not what
  "enabled as soon as NAT is configured" describes.
* **Adopted: the discriminator is the ALG's port.** The ALG is a service on a port (`ip nat service dns udp`,
  default 53, moved by `port port-number`), so a UDP translation whose destination is that port is the one the
  ALG claims.

## What is modelled

```js
const DEFAULT_TIMEOUTS = { icmp: 60, udp: 300, tcp: 86400, dns: 60, default: 86400 };
const DNS_ALG_PORT = 53;
```

`timeoutFor(timeouts, proto, dstPort)` reads `dns` for a UDP entry whose destination is 53, otherwise the
protocol; a configured `dns` wins, a configured `udp` does not move a DNS entry, and the general `default` is
still the last fallback. `expireTranslations()` passes the destination port **only for a port-translated (PAT)
entry** - the entry the vendor's sentence is written about, and the only one whose destination port is part of
its identity. A simple dynamic entry's `dstPort` is just the first flow's port, so it cannot decide how long an
address-sharing entry lives; those keep the protocol timer. `show ip nat statistics` prints `dns 60` from the
same call, so the line cannot drift from the rule.

## What is inferred, not observed

* **That the entry, not the query, carries the classification.** No public `show ip nat translations` transcript
  prints a per-entry timeout, so the model's reading is the vendor's two sentences applied to its own table
  shape. A transcript showing a DNS entry ageing at 60 s while a neighbouring port-54 entry ages at 300 s would
  settle it directly.
* **That "DNS" means destination port 53 for an outbound query.** The model translates inside-to-outside only.
  An inbound query to an inside DNS server would be claimed by the ALG too; this engine has no inbound
  translation of that shape to test against.

## Unresolved, and deliberately not modelled

* **DNS over TCP.** `ip nat service dns tcp` exists, and the 1-minute sentence sits in the reference's UDP
  paragraph, so a TCP entry to port 53 keeps 86400 s here. What would settle it: a transcript of a TCP entry to
  port 53 in `show ip nat translations`, or a vendor sentence that puts DNS ahead of the TCP timer.
* **A non-default ALG port.** `ip nat service dns udp port <n>` moves the ALG, and this console has no
  `ip nat service`, so 53 is the only port that can be in force. Implementing it means the console grows that
  command, which is a new knob rather than a correction.
* **DNS payload rewriting.** This engine translates addresses and ports, never DNS records, so there is no
  A/PTR fixup to model - the ALG's *payload* half is out of scope for the simulator, not merely unverified.
* **`port-timeout`.** The same reference publishes `ip nat translation port-timeout {tcp or udp} <port>
  <seconds>`, a per-port override that would sit between `dns` and the protocol timer. Not modelled; it needs
  the same port-aware lookup this change added, plus a configuration surface.

## What changed in PacketForge

* `engine/nat.js`: `DEFAULT_TIMEOUTS.dns` 60, `DNS_ALG_PORT` 53, `timeoutKind()`/`timeoutFor()` take an optional
  destination port, `expireTranslations()` passes it for PAT entries, with the citations beside the table.
* `engine/cli.js`: `show ip nat statistics` prints `dns` from `timeoutFor(timeouts, 'udp', DNS_ALG_PORT)`.
* `test/nat-dns-translation-timeout.test.js`: new, 31 checks (the classification, the configured-timer
  precedence, the 59/60 s and 299/300 s boundaries, refresh-by-use, the dynamic entry that must not be
  shortened, and the statistics line).
* `test/nat-ageing.test.js`: the pinned `Timeouts (seconds):` line now carries `dns 60`.
* `docs/CLI.md`: the NAT timeout table and the transcript.
* `research/nat-default-timeouts.md`: the DNS bullet in "Unresolved" pointed at evidence already in hand; it now
  points here, where that evidence has been read against the question.
