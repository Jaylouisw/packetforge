# A static route typed twice: one entry, or two?

**Question (one, narrow).** `ip route 10.9.0.0 255.255.0.0 10.0.0.254` typed a second time, unchanged, on the
box that already carries it: does the configuration gain a second line, and does the table gain a second row?
The console did both (#1657), and the second row read `(not installed: the S route for this prefix has distance
1)` - a route that lost to itself.

**Verdict: one entry.** A static route is keyed on the whole statement - prefix, mask, next hop or interface,
and the administrative distance - so the same statement twice is the same entry. Distinct statements stay
distinct entries: another next hop for the same prefix, the same next hop at another distance (the floating
static), and the fully specified form, whose interface is part of the statement.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco Learning Network, "Router Duplicates Routes to same Network Address"](https://learningnetwork.cisco.com/s/question/0D5Kd0000CCsGPeKQN/router-duplicates-routes-to-same-network-address) | A question about a simulator printing one `ip route` line twice; the answer: "the running-config does not store duplicate commands that are identical ... If you type the exact same command again, the IOS accepts it but does nothing because that configuration line already exists. When you display the configuration with `show running-config`, you will only see the line once." A community answer, not a vendor statement - the weakest row here, and the reason the receipt wording below is the console's own. |
| [Cisco IOS IP Routing: Protocol-Independent Command Reference, `ip route`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/iri-cr-book/iri-cr-a1.html) | The statement's fields: `ip route prefix mask { ip-address / interface-type interface-number [ip-address] } [dhcp] [global] [distance] ...`, "distance ... The range is 1 to 255. The default administrative distance for a static route is 1". The `no` form takes the same words back, which is what makes those words the route's identity. |
| [Cisco, Managing Configuration Files, IOS XE 16.6](https://cisco.com/c/en/us/td/docs/ios-xml/ios/config-mgmt/configuration/xe-16-6/config-mgmt-xe-16-6-book.pdf) | `copy <url> running-config` "applies every command in the source file, whether or not the command is already present in the current running configuration", while `configure replace` "only applies the commands that need to be applied - no existing commands in the current running configuration are reapplied". The vendor distinguishes a command that is *already present* from one that needs applying, and the running-config is what answers which. |
| [Cisco ASA, "Information About the Routing Table"](https://www.cisco.com/c/en/us/td/docs/security/asa/asa91/configuration/general/asa_91_general_config/route_overview.html) | A different platform, the same idea at the table: entries with "identical network prefixes and different interfaces cannot coexist"; the RIB is keyed, not appended to. |
| [Cisco IOS XE BGP command reference, `show ip route`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_bgp/command/iproute_bgp-xe-3se-3850-cr-book/iproute_bgp-xe-3se-3850-cr-book_chapter_0100.html) | The row shape the console already prints - one row per prefix, with the code and `[distance/metric]` - and the reason a duplicate shows up as a second identical row rather than a hidden extra. |

## What is known

1. The identity of a static route is its whole statement; the `no` form repeats those words to select one.
2. The running-config is the configuration in effect, not a log of what was typed - which is why
   `test/config-roundtrip.test.js` can assert that `show running-config` pastes back to the same file.
3. A second row for one prefix is legal only when the rows differ (another next hop, another distance); the
   model marks the loser, and a row cannot lose to a copy of itself.

## What is inferred

* **The receipt wording.** A real box prints nothing for an accepted configuration command, so there is no
  vendor sentence to copy. This console prints a receipt for every state change, so the duplicate gets one -
  `Route 10.9.0.0/16 via 10.0.0.254 is already configured: nothing was added` - rather than silence, which in a
  console where every command answers would read as a command that failed. The sentence is the console's, and
  the note says so rather than passing it off as IOS output.
* **Distance identity across the typed and default form.** `... 10.0.0.254` and `... 10.0.0.254 1` are one
  entry: the second types out the default the first already has, and the saved file keeps the form that was
  typed first (the printer never writes a distance that was not entered).

## What changed

`engine/cli.js` (merged as #1659, `afc27808`): `ip route` compares the parsed statement against `config.routes`
before storing it - the network (host bits are not part of a prefix, so `ip route 10.9.5.0 255.255.0.0` is
10.9.0.0/16 and collapses onto the route already there), the mask, the next hop, the interface and the
effective distance (a missing distance is 1) - and answers a match with
`Route 10.9.0.0/16 via 10.0.0.254 is already configured: nothing was added`, naming the prefix as the table
spells it rather than as it was typed. `ipv6 route` does the same on prefix and next hop, with
`IPv6 route 2001:db8:9::/64 via 2001:db8::1 is already configured: nothing was added`.
`test/static-route-duplicate.test.js` pins both directions: the second typing stores nothing and the file keeps
one line, and another next hop, the floating static at another distance, and the removal form behave as before.

## What remains unresolved

* **What the box prints, if anything.** No capture of a repeated `ip route` line at a console was found. The
  quiet acceptance is the reading of a config command that changes no state, not a transcript.
* **Older images and other shapes.** Whether an image accepts a byte-identical line carrying a `name` or `tag`
  the model does not keep is untested; those slots are already refused or ignored here
  (`research/static-route-distance.md`).
* **Duplicates already in a stored state.** The command door collapses them; a state file hand-edited to hold
  two identical rows still prints both, because the table is built from what the state holds. That is the
  reading that a hand-edited file is the operator's statement, not something the console silently rewrites.
