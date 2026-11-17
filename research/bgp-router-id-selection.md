# Which address a box elects as its BGP router ID, and the port-order guess it replaces

**Question (one, narrow).** With `bgp router-id` *not* configured, which address does a real IOS-style router
report as its BGP router identifier in `show ip bgp` (`BGP router identifier x.x.x.x, local AS number N`)?

**Verdict: settled, and corrected.** A loopback's address if one is configured — the highest, when several are —
otherwise the highest IPv4 address on a physical interface. Not "the first address the interface table yields",
which is what this engine elected, so the identifier it printed was a fact about catalogue order: a router
holding `10.0.0.1` on Gi0/0 and `192.168.1.1` on Gi0/1 reported `10.0.0.1` where a real box reports
`192.168.1.1`.

## What the vendor publishes

| Source | Says |
| --- | --- |
| [Cisco IOS IP Routing: BGP Command Reference, `bgp router-id`](http://cisco.com/c/en/us/td/docs/ios/iproute_bgp/command/reference/irg_book/irg_bgp1.html) | Command Default, verbatim: "If a loopback interface is configured, the router ID is set to the IP address of the loopback interface. If multiple loopback interfaces are configured, the router ID is set to the IP address of the loopback interface with the highest IP address. If no loopback interface is configured, the router ID is set to the highest IP address on a physical interface." Also: "Peering sessions are automatically reset when the router ID is changed." |
| [Cisco IOS IP Routing: BGP Command Reference, `show ip bgp`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_bgp/command/irg-cr-book/bgp-s1.html) | The same rule in one line, as the field description of the line this repo prints: "BGP router identifier — In order of precedence and availability, the router identifier specified by the bgp router-id command, a loopback address, or the highest IP address." |
| [BGP 4, Cisco IOS XE 16.7 configuration guide](https://cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_bgp/configuration/xe-16-7/irg-xe-16-7-book/bgp-4.pdf) | "By default, the Cisco software sets the router ID to the IPv4 address of a loopback interface on the router. If no loopback interface is configured on the device, the software chooses the highest IPv4 address configured on a physical interface of the device to represent the BGP router ID." |
| [BGP Case Studies (Cisco support doc 26634)](https://cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/26634-bgp-toc.html) | "The remote router ID: This number is the highest IP address on the router or the highest loopback interface, if existent." Read in `show ip bgp neighbors` as the peer's identifier. |
| [Select BGP Best-path Algorithm (13753)](https://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/13753-25.html) | Step 11: "Prefer the route that comes from the BGP router with the lowest router ID. If not configured manually, the router ID is selected as the highest IP address on a loopback interface. If no loopback interfaces exist, it is selected as the highest IP address on an active physical interface." |

Two properties matter for a simulator and both are in those rows: the choice is a **maximum over a set**
(`10.0.0.10` beats `10.0.0.9`, and a string comparison gets that backwards), and the set is chosen by **kind
first**, so a numerically smaller loopback still wins over a bigger port address.

## What the engine did

`engine/simulator.js`, `computeBgp()`, elected `cfg.routerId || (addrs[0] && addrs[0].ip) || configured[0].ip`
— the *first* address in `dev.interfaces` iteration order, which is the order the catalogue lists ports in.
`engine/cli.js` then printed `dev.bgpRouterId || cfg.routerId || '0.0.0.0'` in `show ip bgp`.

So on a two-port router the printed ID was Gi0/0's address whatever Gi0/1 held, and a hand-written or imported
lab whose interfaces were listed in a different order could print a different ID for the same box. A loopback,
if a lab ever had one, was never consulted.

## What changed

* `engine/bgp.js` gains `deriveRouterId(ifaces)` — the published rule as a pure function: bucket by kind
  (loopback vs everything else), take the numerically greatest address in the loopback bucket if any, else the
  greatest in the other. A loopback is recognised by `type === 'loopback'` or, for a fixture that only has the
  name, by the folded name (`Loopback0` → `loopback0`). Returns `null` when the box holds no IPv4 address.
* `engine/simulator.js` calls it for the speaker's identifier, keeping `bgp router-id` first and the old
  first-address fallback last (so a lab with an unparseable or empty table still behaves as before).
* `engine/cli.js` uses the same function when no pass has computed `dev.bgpRouterId` yet, instead of printing
  `0.0.0.0` about a box that holds addresses.
* `test/bgp-router-id.test.js` pins the rule (highest-not-first, order independence, numeric comparison,
  loopback preference, highest-of-several loopbacks, name-only loopback, empty/unparseable input) and the
  end-to-end `show ip bgp` header for a two-port router and for one with `bgp router-id 1.1.1.1` typed.

## What is inferred, not published

* **Interface state.** The command reference says "the highest IP address on a physical interface", the
  best-path note says "on an **active** physical interface", and the IOS XR guide says the ID is invalidated
  "because the interface goes down". They disagree. This engine ignores `enabled`: the identifier is a fact
  about the addresses configured, so a cable pull does not silently renumber the box (IOS, unlike XR, does not
  re-elect until the BGP process is restarted). Evidence that would settle it: a bench transcript of
  `show ip bgp summary` on a router whose highest address is on a shutdown port.
* **Loopbacks are unreachable from the CLI.** No device in `devices/` has a loopback port and there is no
  `interface loopback <n>` command, so the loopback tier can only be exercised by a catalogue entry, an
  imported lab, or the unit test. The rule is implemented anyway because it is the *first* tier of the
  published rule and guessing "no loopbacks exist" would be inventing a deviation.
* **A box with no address.** Real IOS prints `0.0.0.0` (XR/XR-style docs say BGP then cannot peer at all).
  `computeBgp()` skips a speaker with no configured address entirely, which is a separate, older decision left
  alone here.

## What remains unresolved

* **The ID is now used by the best-path decision** (fixed since this note was written). Step 11 of the
  algorithm - lowest router ID wins on a tie after steps 1-10 - was not implemented: candidate paths in
  `computeBgp()` carried no `routerId`, so `bgpLib.comparePaths()` never saw one and every tie fell through
  to insertion order. `computeBgp()` now stamps the advertising speaker's identifier and the peer address on
  each candidate, and the comparison ends on them; `research/bgp-bestpath-tiebreak.md` has the sources and
  the test. Electing the right ID was necessary for that fix and was already in place.
* **"Elect once, then keep it."** IOS keeps the ID it chose until BGP restarts; this engine recomputes on every
  pass, so adding a loopback would renumber the router instantly. Modelling stickiness needs a per-device
  "chosen at" record the simulator does not have, and an answer to what happens when the elected address is
  removed (a new election *and* a session reset, per the command reference).
* **NX-OS and IOS XR differ from IOS**: NX-OS prefers `loopback0` by name and, for a VRF with no loopback,
  "uses the first interface in the configuration file"; XR prefers the highest loopback only if the router
  booted with it saved. The engine is vendor-agnostic and now follows the IOS rule, which is the one the
  Cisco CLI this console imitates answers with. A per-family table would need a catalogue field for it.
