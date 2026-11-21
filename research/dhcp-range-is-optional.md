# Is `range` required in a DHCP pool, or does `network` alone define what the server hands out?

**Question (one, narrow).** On a Cisco IOS/IOS-XE router, a pool is written `ip dhcp pool <name>` then
`network <subnet> <mask>` then the options. Is a `range <start> <end>` statement **required** before the
pool will serve, or is it an optional narrowing whose absence means "the whole subnet"? And if the range is
derived, which address does the first client get — the subnet's first host address, or the one the router
itself answers on?

**Verdict: `range` is optional, and the pool serves its whole subnet without one. The engine required it, so
the commonest DHCP configuration in the world was refused; it now derives the range, and the allocator no
longer offers the gateway.** Cisco's own worked configuration for a DHCP server is `network`,
`default-router`, `dns-server` and nothing else, and the `show ip dhcp pool` printed beside it reports 77
addresses leased and the row `10.4.5.1 - 10.4.5.254`. Every captured pool that has no `range` still says
`1 subnet is currently in the pool` and prints the subnet's usable range.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco, *Configure and Troubleshoot a DHCP Server on Cisco IOS XE SDWAN Router* (doc 221087)](https://www.cisco.com/c/en/us/support/docs/routers/sd-wan/221087-configure-and-troubleshoot-a-dhcp-server.html) | The whole pool is `ip dhcp pool CISCO` / `vrf 40` / `network 10.4.5.0 255.255.255.0` / `default-router 10.4.5.1` / `dns-server 8.8.8.8` — no `range` — and `show ip dhcp pool CISCO` then prints `Leased addresses : 77`, `Excluded addresses : 86`, and the row `10.4.5.1 10.4.5.1 - 10.4.5.254 77 / 86 / 254`. The server served 77 clients from a pool that never named a range. |
| [Cisco 850/870, *Configuring a LAN with DHCP and VLANs*](http://www.cisco.com/en/US/docs/routers/access/800/850/software/configuration/guide/dhcpvlan.html) | The configuration example is `ip dhcp pool dpool1` / `import all` / `network 10.10.0.0 255.255.255.0` / `default-router 10.10.10.10` / `dns-server 192.168.35.2` / `domain-name cisco.com`; `show ip dhcp pool` answers `Total addresses : 254`, no `Excluded addresses` line, and the row `10.10.0.1 10.10.0.1 - 10.10.0.254 0`. |
| [Cisco IOS IP Addressing Services Command Reference, XE 3SE — `address range`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-xe-3se-3850-cr-book/ipaddr-xe-3se-3850-cr-book_chapter_00.html) | "If the address range command is not configured for a DHCP class in a DHCP server address pool, the default value is the entire subnet of the address pool." The same default rule, stated for the pool-class form of the command. |
| [Cisco IOS 12.2SY, *Configuring the Cisco IOS DHCP Server*](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_dhcp/configuration/12-2sy/dhcp-12-2sy-book/config-dhcp-server.html) | Six worked pools in one configuration block, every one of them `ip dhcp pool N` + `network ...` + options, with no `range` anywhere (`ip dhcp pool 1` / `network 172.16.1.0 /24` / `default-router ...` / `lease 30`). |
| [Cisco IOS 12.4, *Configuring the Cisco IOS DHCP Server* — address conflict logging](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_dhcp/configuration/12-4/dhcp-12-4-book/config-dhcp-server.html) | "By default, the DHCP server pings a pool address twice before assigning a particular address to a requesting client. If the ping is unanswered, the DHCP server assumes ... that the address is not in use and assigns the address." The router's own interface address answers that ping, so it is never the address a client is given. |
| [Cisco Community, `show ip dhcp pool` capture from a live router](https://community.cisco.com/t5/network-management/dhcp-keeps-quot-dropping-out-quot-or-resetting/td-p/4656861) | A pool with no exclusions prints the row `192.168.0.1 - 192.168.0.254` and **no** `Excluded addresses` line, with `Current index 192.168.0.17` — the index is past the low addresses without those addresses being counted as excluded. |

## What the engine did

Measured before the change, a pool typed exactly as the SD-WAN guide types it:

```
r1(config)#ip dhcp pool LAN
r1(dhcp-config)#network 10.4.5.0 255.255.255.0
r1(dhcp-config)#default-router 10.4.5.1
r1(dhcp-config)#exit
% Pool LAN is incomplete - DHCP pool LAN: both rangeStart and rangeEnd are required. (E_DHCP_BAD_RANGE)
```

and `show ip dhcp pool LAN` carried `% this pool is not serving yet: ... both rangeStart and rangeEnd are
required.` A host on that subnet asked, was never offered anything, and the lab read as a broken
configuration rather than a missing statement. The library's own `validatePool()` made the range mandatory
(`E_DHCP_BAD_RANGE`), so the console, the editor and the data path all agreed on a rule the box does not
have.

A second, smaller disagreement sat behind it: `poolCapacity()` excludes the gateway "because it is
deliberately not allocatable", but `nextFreeIp()` and `isAllocatable()` never asked, so a pool whose range
covered its gateway offered the gateway to the first client. With no `range` the gateway *is* the first
address of the derived range, so the two defects would have met in the first packet.

## What changed

* `engine/dhcp.js`
  * `rangeInts()` derives the range from `network` + `mask` when neither end of a range was configured:
    network+1 through broadcast-1, and every address for a /31 or /32 (RFC 3021). A range with **one** end
    typed is still unreadable and still refused.
  * `rangeText()` is the one place a sentence about "the pool range" gets its two addresses, so a refusal or a
    NAK names the derived range rather than printing `-`.
  * `validatePool()` no longer demands a range; it refuses only a half-typed one. The "is anything left to
    hand out?" check now walks the range the allocator will walk, derived or configured.
  * `nextFreeIp()` and `isAllocatable()` skip the gateway, which is the rule `poolCapacity()` already stated.
* `test/dhcp-range-is-optional.test.js` (21 checks): the SD-WAN pool is valid and serves two clients
  (`.2`, `.3`, never `.1`), a configured range still wins, a half range is refused, `show ip dhcp pool`
  prints the subnet row, and `no range` returns the pool to the subnet without an error.
* Tests that used a network-only pool as their example of a *broken* pool now use a pool with no `network`
  (`test/dhcp-in-path.test.js`, `test/dhcp-lease-one-answer.test.js`,
  `test/show-ip-dhcp-pool-layout.test.js`, `test/dhcp-pool-undo.test.js`, `test/dhcp.test.js`).
* `docs/CLI.md` — the DHCP section says `range` is optional and carries the new transcript.

## What is inferred, not published

* **The derived range starts at network+1, not at the first address the box will actually offer.** Every
  capture prints the row from `.1` even when the router holds `.1`, and keeps `Current index` at `.2` or
  later: the *range* is the subnet's, the *index* is what may be offered. The engine now behaves the same way.
* **The gateway is counted in `Excluded addresses`.** The engine derives `excluded = total - capacity`, and
  capacity removes the gateway, so a plain /24 pool with `default-router 10.4.5.1` prints
  `Excluded addresses : 1`. The captures that print no such line either have no exclusions *and* no stated
  default-router (850/870), or come from a release whose header predates the `Leased/Excluded/Total` form.
  None separates the two facts cleanly, so this cell is left as the engine's arithmetic and flagged here
  rather than guessed at.
* **A `range` outside the `network` is still refused** (`E_DHCP_RANGE_OUTSIDE`). That rule predates this
  change and no capture read for it contradicts the vendor's "the range is part of the subnet".

## What remains unresolved, and what would settle it

1. **Whether a box prints `Excluded addresses : 1` for its own interface address.** `show ip dhcp pool` on a
   factory router with `network 192.168.1.0 255.255.255.0` + `default-router 192.168.1.1` and *nothing else*,
   photographed before and after the first lease. Two outcomes are possible and the note will not pick one:
   the gateway is counted as excluded (this engine's arithmetic) or the line is absent (the 12.4-era header
   does not carry it at all).
2. **A `range` narrower than the subnet on a box that also has exclusions** — the two ways of saying "do not
   offer this" are counted separately or together was not captured.
3. **Huawei/HPE pools**, which use a different command (`dhcp server pool` / `dhcp pool` with `network`), are
   outside this question: this console speaks one IOS grammar for every vendor, and that decision is recorded
   in `docs/CLI.md` rather than re-litigated here.
