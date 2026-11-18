# The default idle timeout of a dynamic NAT translation, by protocol

**Question (one, narrow).** When a Cisco IOS router makes a dynamic NAT translation and the flow goes
quiet, how long does the entry stay in force — per protocol — before any timeout is configured?

**Verdict: known, and adopted.** Cisco publishes four values that matter here: ICMP flows 60 seconds,
UDP flows 300 seconds, established TCP flows 86400 seconds (24 hours), and the general dynamic-translation
timeout 86400 seconds. PacketForge held TCP for **3600** seconds and every protocol it did not name for
**300** seconds — neither value appears in the vendor's documentation. The constants and the two places
that quote them are corrected; the behaviour (idle time, refreshed by use) was already right.

## Evidence

| Source | What it states |
| --- | --- |
| [Cisco IOS IP Addressing Services Command Reference, `ip nat translation (timeout)`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-i4.html) | `icmp-timeout` default 60 seconds; `udp-timeout` default 300 seconds (5 minutes); `tcp-timeout` default 86,400 seconds (24 hours); `timeout` (dynamic translations, except overload) default 86,400 seconds. Also `finrst-timeout` 60 s, `syn-timeout` 60 s, `dns-timeout` 60 s, `pptp-timeout` 86400 s. |
| [Cisco Catalyst IE9300 IP Addressing Services Configuration Guide, "Configure NAT timeouts"](https://www.cisco.com/c/en/us/td/docs/switches/lan/cisco_ie9300/software/17_7/ip-addressing-config-ie93xx/g-ie93xx-l3-nat/t-config-address-translation-timeouts.html) | "Established TCP sessions: 24 hours; UDP flow: 5 minutes; ICMP flow: 1 minute." The same page gives `ip nat translation 300` as an example and repeats: "The default timeout is 24 hours, and it applies to the aging time for half-entries." |
| [Cisco NAT troubleshooting FAQ 218012](http://www.cisco.com/c/en/us/support/docs/ip/network-address-translation-nat/218012-troubleshoot-network-address-translation.html) | "When the three-way handshake is completed, NAT uses a 24-hour timer for a NAT entry by default. If an end host sends a RESET, NAT changes the default timer from 24 hours to 60 seconds. In the case of FIN, NAT changes the default timer from 24 hours to 60 seconds when it receives FIN and FIN-ACK." |
| [IP Addressing: NAT Configuration Guide, Cisco IOS Release 15M&T (PDF)](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_nat/configuration/15-mt/nat-15-mt-book.pdf) | "When overloading is not configured, simple translation entries time out after 24 hours." A configured general timeout "overrides the default TCP and UDP timeout values, unless you explicitly configure the TCP timeout value ... or the UDP timeout value". |
| [IP Addressing: NAT Configuration Guide, Cisco IOS XE Release 3S (PDF)](http://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_nat/configuration/xe-3s/nat-xe-3s-book.pdf) | The same 24-hour rule, and the precedence of a configured general timeout over the per-protocol defaults. |

The command reference is the primary source for the numbers; the configuration guides corroborate them in
prose and settle the precedence question, which this model does not need because `config.nat.timeouts` is a
plain per-protocol override rather than a general value that has to lose to an explicit one.

## What is modelled

`engine/nat.js` `DEFAULT_TIMEOUTS` now reads:

```js
{ icmp: 60, udp: 300, tcp: 86400, default: 86400 }
```

`timeoutFor(timeouts, proto)` prefers a configured value for that protocol, then a configured `default`,
then this table. `expireTranslations()` removes a dynamic or PAT entry once it has been idle for the limit;
static translations never expire. An entry that is used restarts the clock — idle time, not a lifetime — and
`show ip nat statistics` prints the values in force on one line (`Timeouts (seconds): ...`).

`test/nat-default-timeouts.test.js` pins the four constants, the per-protocol boundaries (59/60 s,
299/300 s, 3600/86399/86400 s), the general default for a protocol with no entry (`gre`), a configured
override, and a TCP entry refreshed after an hour surviving another 24 hours of silence.

## What is inferred, not observed

* **The general timeout covers "other" protocols.** The command reference's `timeout` is described as
  applying to dynamic translations generally, with `tcp-timeout`/`udp-timeout`/`icmp-timeout` as the
  specific overrides. The model therefore gives GRE, ESP and anything unnamed the 86400-second value. No
  public transcript was found that shows a GRE translation ageing, so this is the documented general rule
  applied to the model's protocol list rather than a captured expiry.
* **A translation is one entry per inside local, refreshed by any protocol.** IOS keeps per-flow entries
  when overload is configured; this model keeps one entry with a protocol stamp. The timeout is applied to
  that stamp, which is the closest honest reading of the vendor's per-protocol table for this table shape.

## Unresolved, and deliberately not modelled here

These are published defaults that this run did **not** change, because each needs state the model does not
carry or would be a second rule rather than a correction of this one:

* **FIN/RST shortening.** A TCP entry that sees FIN/FIN-ACK or RST drops from 24 hours to 60 seconds
  (`finrst-timeout`). The model records no TCP flags on a translation, so it cannot apply this. What would
  settle the implementation: a table entry that carries the last-seen flags and a test built from the FAQ's
  FIN/RST sequence.
* **SYN without a completed handshake.** `syn-timeout` is 60 seconds. The model has no half-open state.
* **DNS.** *Settled later, in `research/nat-dns-translation-timeout.md`.* `dns-timeout` is 60 seconds, and it
  is not a protocol: the command reference contrasts "Non-DNS UDP translations" (5 minutes) with "DNS"
  (1 minute), and the DNS ALG is on as soon as NAT is configured, on port 53. `timeoutFor()` now takes the
  destination port, and a UDP entry in the port-translation table whose destination is 53 ages at 60 s. The
  TCP side of the ALG, a non-default ALG port and `port-timeout` remain open there.
* **PPTP** has its own 86400-second timer, and ARP-ping and per-port timers exist; none of those flows are
  modelled.

## What changed in PacketForge

* `engine/nat.js`: `DEFAULT_TIMEOUTS.tcp` 3600 → 86400; `DEFAULT_TIMEOUTS.default` 300 → 86400, with the
  vendor citation beside the table.
* `test/nat-ageing.test.js`: the two assertions that quoted the old values, and one example config.
* `test/nat-default-timeouts.test.js`: new, 19 checks.
* `docs/CLI.md`: the timeout table and the `show ip nat statistics` transcript now print 86400.
