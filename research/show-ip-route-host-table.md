# `show ip route` on a box that does not route: what it prints

**Question (one, narrow).** On a real IOS switch with `ip routing` off — a Catalyst 2960, or a 3560 that has
not been given `ip routing` — what does `show ip route` print? Does it print a routing table at all?

**Verdict: it prints no routing table.** The answer is three lines — the default gateway, a host/redirect
header, and `ICMP redirect cache is empty` — with no codes legend and no route rows. The engine printed the
router's shape for every device (the legend, then the `S*` row standing for `ip default-gateway`), which is a
shape no non-routing box produces. Changed here.

## Evidence

| Source | What it prints |
| --- | --- |
| [Catalyst 4500 Software Configuration Guide 12.2(18)EW, "Configuring the Switch for the First Time"](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/18ew/configuration/guide/config/supcfg.html) | after `ip default-gateway 172.20.52.35`: `Default gateway is 172.20.52.35` / `Host Gateway Last Use Total Uses Interface` / `ICMP redirect cache is empty` |
| [Catalyst 4500 Software Configuration Guide, IOS XE 3.4.xSG](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/15-1-2/XE_340/configuration/guide/config/supcfg.html) | the same three lines, same wording, in the same task |
| [Cisco community, "ip route 0 0 versus ip default-gateway"](https://community.cisco.com/t5/switching/ip-route-0-0-versus-ip-default-gateway/td-p/812905) | a 3560 with `ip routing` off: `sh ip route` → `Default gateway is not set` / `Host Gateway Last Use Total Uses Interface` / `ICMP redirect cache is empty` |
| [Cisco community, "Switch reaching outside network"](https://community.cisco.com/t5/switching/not-sure-what-i-m-missing-switch-reaching-outside-network/td-p/3702977) | a 2960: `sh ip route` → the same three lines, negative form |
| [Cisco IOS IP Application Services Command Reference, `show ip redirects`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp/command/iap-cr-book/iap-s1.html) | the same table, `<pre>`-preserved: header `Host               Gateway           Last Use    Total Uses  Interface`, then `172.16.1.111      172.16.80.240         0:00             9  Ethernet0` |
| [networklessons.com, "Cisco Router as Host or Server"](https://networklessons.com/ip-services/cisco-router-as-host-or-server) | a router after `no ip routing`: negative form; after `ip default-gateway 192.168.1.254`: positive form |

## What is known

1. The shape is three lines whatever the state: `Default gateway is <addr>` when `ip default-gateway` is
   configured, `Default gateway is not set` when it is not, then the header, then the redirect-cache line.
2. The address on the first line is the **configured** gateway, printed back verbatim. Nothing in any capture
   suggests the line is conditioned on the gateway being reachable.
3. There is no codes legend and no route row. A static default configured with `ip route 0.0.0.0 0.0.0.0 …` on
   such a box is not shown at all — the 3560 transcript above has exactly that configuration and prints the
   empty form, which is the point of the thread: the static route was not being used because routing was off.
4. The header's spacing is pinned by the `show ip redirects` command reference, which prints this same table:
   `Host` + 15 spaces, `Gateway` + 11, `Last Use` + 4, `Total Uses` + 2. Values sit under it: host at column 19
   (the row sample starts at 18), gateway 19–31, `Last Use` right-aligned to 45, `Total Uses` to 59, interface
   from 61.

## What is inferred

1. **No blank line** between the gateway line and the header. Every capture above has them adjacent; the
   command-reference `<pre>` block settles it for `show ip redirects` and the guide samples match.
2. **The rule is "does this box route", not the command's spelling or the model.** The console has no
   `ip routing` command and decides routing by the device capability (`isL3()` / `l3-forward`), so that
   capability is the stand-in. A box that routes keeps the legend and the `Gateway of last resort` line.
3. `ip default-gateway` is still configured, saved and used for the box's own management traffic; only the
   `show ip route` shape changes. The engine's `routeTo()` already reads `config.defaultGateway`.

## What remains unresolved

1. **The host cache is printed empty.** A real box fills the table under the header with destinations reached
   through the gateway and with ICMP-redirect targets (`172.16.1.111 172.16.80.240 0:00 9 Ethernet0`). This
   engine models neither an ICMP redirect nor a per-destination host cache, so it prints the wording a box with
   nothing cached prints. What would settle it: a transcript of a non-routing switch after traffic to a
   non-local subnet, showing which of the two mechanisms creates a row and when it expires.
2. **Non-IOS L2 switches are not covered.** HP/Aruba ProVision, Arista EOS and friends have their own
   `show ip route` (or none). The console speaks IOS for every model, as it already does for the codes legend,
   so this note pins IOS only. What would settle it: one capture per vendor family.
3. **An L3 switch's default.** A 3560/9300 ships with `ip routing` off, but this simulator treats an `l3-forward`
   device as routing from boot, because there is no `ip routing` command to turn it on. That is a larger
   question than this note (it changes forwarding, not just one printer), and it is not modelled here.
