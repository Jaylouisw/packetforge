# `ip default-gateway` on a box that routes

**Question.** With `ip routing` enabled, what does `ip default-gateway <gw>` do? Is it refused, accepted and
ignored, or accepted and installed as a default route? And what does the box then print in `show ip route` and
in `show running-config`?

**Verdict.** Accepted, retained in the running-config, and **inert**: it installs no route, is not the gateway of
last resort, and no packet leaves by it. It becomes the box's default again the moment `no ip routing` is
configured. The command is scoped by the vendor to the non-routing case; it is not a route in disguise.

## What is known (sources)

1. Cisco IOS IP Routing: Protocol-Independent Configuration Guide, 16.11, "Default Routes":
   "You can use the `ip default-gateway` global configuration command to define a default gateway **when IP
   routing is disabled** on a device. For instance, if a device is a host, you can use this command… In boot
   mode, IP routing is not enabled on the device. Unlike the `ip default-gateway` command, the
   `ip default-network` command can be used when IP routing is enabled on a device."
   <https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/configuration/xe-16-11/iri-xe-16-11-book.pdf>

2. Catalyst 3750 software configuration guide (12.2(50)SE), "Configuring IP Routing": the feature table lists
   "IP default gateway — Disabled", and the procedure is "to define a default gateway (router) **when IP routing
   is disabled**". The same chapter's enable procedure is `ip routing`, and its troubleshooting note says a
   default route must be used once routing is on.
   <http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3750/software/release/12-2_50_se/configuration/guide/scg/swiprout.pdf>

3. Cisco Community, "'ip routing' command on a layer 2 switch" — the retention/no-effect rule in one sentence:
   "While the `ip default-gateway` will be retained in the configuration the only time that it will be used is
   when `ip routing` is disabled."
   <https://community.cisco.com/t5/routing/ip-routing-command-on-a-layer-2-switch/td-p/582837>

4. Cisco Community, "Cisco Catalyst 4506: Default Gateway doesn't work" — an operator's own diagnosis of the
   same behaviour: the box with `ip routing` "gives the routing table", and "my error was that I was trying to
   set a default gateway when ip routing was enabled". Also: "To see the `ip default-gateway` information, you
   need to turn off `ip routing`."
   <https://community.cisco.com/t5/switching/cisco-catalyst-4506-default-gateway-doesn-t-work/td-p/1752479>

5. Cisco Learning Network, "Turning on IP routing broke ip default gateway connectivity": the gateway is "only
   used in the case of `no ip routing`", and the setting "is *not* converted automatically to a default route".
   <https://learningnetwork.cisco.com/s/question/0D53i00000Kt5tCCAR/turning-on-ip-routing-broke-ip-default-gateway-connectivity>

6. Cisco support doc, Catalyst 3750 troubleshooting: "If IP routing is not enabled on the device, the command is
   `ip default-gateway`… If IP routing is enabled, use the `ip route` command in order to specify the default
   router for that device."
   <https://www.cisco.com/c/en/us/support/docs/switches/catalyst-3750-series-switches/77805-troubleshoot-3750.pdf>

Two mechanisms are easy to confuse and are modelled apart:

- `ip default-gateway` — a *host* default, typed, shown in the running-config, used only while routing is off.
- a DHCP lease's `default-router` — installed by a box that routes as a default **route** at administrative
  distance 254 (`S* 0.0.0.0/0 [254/0] via <router>`), absent from the running-config because nobody typed it.

## What the engine did, and what it does now

On a device that routes (`isL3()`), `routesTable()` printed
`S*  0.0.0.0/0  [254/0] via <gw>` for `config.defaultGateway`, directly under the line
`Gateway of last resort is not set` — two statements about one gateway that contradicted each other, and a row
no box installs. `routeTo()` also used the gateway as its last resort, so a lab with `ip routing` and only
`ip default-gateway` forwarded traffic the real device would drop. Turning `ip routing` on did not take the
default away, which is exactly the "ip routing broke my gateway" story.

Now:

- `routeTo()` consults `config.defaultGateway` only when `!isL3()`.
- `routesTable()` emits the gateway row only when `!isL3()`, so no `0.0.0.0/0` row and no gateway-of-last-resort
  line appear for it on a routing box.
- The typed line is still stored and still printed by `show running-config` (the box keeps it).
- A DHCP lease's router on a routing box is kept as `Device.dhcpGateway` and printed as
  `S*  0.0.0.0/0  [254/0] via <router>`; on a host or L2 switch the same number stays the host default gateway.

Regression proof: `test/ip-default-gateway-when-routing.test.js`.

## Inferred (stated as inference, not fact)

- That the *row* disappears from `show ip route` rather than being printed as an unusable/greyed row. The
  vendor documentation says the command "has no effect"/is "used only when routing is disabled" and never shows
  such a row; no captured transcript of the transition (gateway configured with routing off, then `ip routing`)
  was found, so the absence of the row is inferred from "installs no route".
- That the running-config line survives `ip routing` on every platform. Source (3) states retention for a
  Catalyst; a router's behaviour is inferred to match (nothing in the guides says the command is stripped).

## Unresolved

- **Is the command ever refused outright?** One secondary, unattributed page claims the command "is not
  available on routers or Layer 3 switches with IP routing enabled". No Cisco guide or captured transcript says
  so, and sources (3)-(5) show operators configuring it with routing on. Treated as wrong; would be settled by a
  console capture from an IOS/IOS-XE L3 box.
- **Exact wording if a platform does refuse.** Nothing found; nothing invented here.
- **`ip default-network`** is explicitly usable *with* routing on (source 1) and is not modelled at all. That is
  a separate question.
- **The success message.** This console answers `ip default-gateway x` with `Default gateway: x`; the IOS
  command reference says no output is displayed on success. That predates this note and is not changed here
  (the message may belong to another vendor's CLI that shares the command). It is the next question worth
  asking of this door.
