# `show ip route`: one space after the prefix, or two?

**Question (one, narrow).** In a `show ip route` row, how many spaces sit between the destination
prefix and the rest of the row (`is directly connected, …` or `[distance/metric] via …`)?
PacketForge printed two; no capture in hand prints two.

**Verdict: known, and adopted — one space.** Twenty-two byte-preserving captures (IOS 12.4, IOS 15,
IOS-XE) hold 64 `is directly connected` rows and 113 `[d/m] via` rows; every one of them puts exactly
one space after the prefix. The only two-space runs in those tables are the *leading* indent of a
continuation row that carries no prefix of its own — a multi-next-hop row or a subnetted row, where the
bracket starts the line. `engine/cli.js` now prints one space in both shapes; the two spaces this console
keeps before its own `(down: …)` / `(not installed: …)` annotations are its own sentence and stay.

## The captures

Two independent corpora, both stored as raw text (not re-flowed by a web page, so the whitespace survives).

1. **ntc-templates**, `cisco_ios_show_ip_route.raw` and `cisco_ios_show_ip_route1.raw`:
   * https://github.com/networktocode/ntc-templates/blob/master/tests/cisco_ios/show_ip_route/cisco_ios_show_ip_route.raw
   * https://github.com/networktocode/ntc-templates/blob/master/tests/cisco_ios/show_ip_route/cisco_ios_show_ip_route1.raw
2. **Genie parser**, IOS-XE `ShowIpRoute` golden outputs 1–13 (live-device captures, `.txt` fixtures):
   * https://github.com/CiscoTestAutomation/genieparser/tree/master/src/genie/libs/parser/iosxe/tests/ShowIpRoute/cli/equal

Measured with `cat -A` (line ends visible) and with a regex for *any* run of two or more spaces between a
non-space character and `is directly connected` / `[d/m]`:

| corpus | `is directly connected` rows | `[d/m] via` rows | rows with 2+ spaces after the prefix |
| --- | --- | --- | --- |
| ntc-templates (IOS 12.4, IOS 15) | — | — | 0 |
| Genie IOS-XE goldens 1–13 | — | — | 0 |
| **total, 22 files** | **64** | **113** | **0** |

Sample rows, copied verbatim:

```
C        192.168.1.0/24 is directly connected, vasileft1
L        192.168.1.1/32 is directly connected, vasileft1
S*    0.0.0.0/0 [1/0] via 10.50.15.1
S        10.16.2.2 [1/0] via 10.186.2.2, GigabitEthernet0/1
                 [1/0] via 10.1.2.2, GigabitEthernet0/0
```

The last line is the continuation row: no prefix, so the bracket starts after the indent, and its two
spaces are indentation, not a separator. 39 such lines exist across the corpus.

Cisco's own documentation pages print the same shape, though an HTML page cannot settle whitespace by
itself — they agree with the raw captures rather than adding to them:
`C 10.44.192.0/24 is directly connected, GigabitEthernet0/0` and `S* 0.0.0.0/0 [1/0] via 10.108.99.2`
(https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/16448-default.html).

## What is known

1. The separator after the prefix is one space, in both row shapes (`is directly connected` and the
   bracket), on every code (`C`, `L`, `S`, `S*`, `O`, `B`, `D`, `i`).
2. The *code field* to the left of the prefix varies by build — `C ` on one, eight or nine characters of
   padding on another — and that variance is not a separator question. It was left alone; see below.
3. The interface after a next hop is introduced by `, ` and belongs to the sentence
   (`research/show-ip-route-interface-spelling.md`).
4. PacketForge's own trailing annotations are not IOS text. They are set off by two spaces, which now
   reads as a deliberate marker: the row itself has one space everywhere.

## What was inferred

* The two-space separator was house style, not a copied shape: `research/show-ip-route-prefix-field.md`
  (its "What remains unresolved") already recorded that IOS uses one space and that the question was
  left for a later increment. This is that increment.
* Because both surfaces read `routesTable()`, no inspector change was needed: the web Routes panel never
  held the CLI's whitespace.

## What changed

* `engine/cli.js`: both row builders print one space between `dest` and the sentence
  (`… + ' is directly connected, '`, `… + ' [' + distance + '/' + metric + '] via '`). The annotation
  gap (`'  ' + r.note`, `'  ' + r.shadow`) is untouched.
* `test/show-ip-route-field-separator.test.js` (new, 14 assertions): every printed row of a table holding
  connected, local, static-via-next-hop, static-via-interface, candidate default, OSPF, BGP and a losing
  (annotated) row matches `code, prefix, ONE space, sentence`; no row has two spaces after a prefix; the
  annotated row keeps one space before its bracket and two before the note.
* Tests that had pinned the two-space house style now pin the device shape:
  `local-route-row`, `ospf-route-metric`, `route-selection`, `show-ip-route-interface-spelling`,
  `show-ip-route-prefix-one-field`, `show-ip-route-static-via-interface`, `ip-route-fully-specified`
  (plus comment samples in `bgp-session-link-state`, `ospf-adjacency-link-state`,
  `route-next-hop-unreachable`, `show-argument-refusal`).
* `docs/CLI.md` (samples and the "Reading `show ip route`" section) and `docs/ARCHITECTURE.md` samples.

## What remains unresolved

* **The code field's width** is still this console's own: four characters, where one capture prints one
  space after `C` and another pads to nine. It is a build detail across releases, and matching one build
  would be a separate decision.
* **A continuation row's indent** (a static with two next hops, or a subnetted row's bracket) is not
  printed at all, because this table never emits two next hops for one prefix and never prints the
  `is subnetted` heading. The indent those rows use is therefore still unmodelled.
* **The `note`/`shadow` separator** is house style by choice. A reader diffing against hardware will see
  a two-space gap that no box writes; it is kept because the sentence after it is one no box writes
  either.
