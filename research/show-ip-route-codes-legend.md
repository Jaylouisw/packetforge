# `show ip route`'s `Codes:` legend: nine printed lines, or one line of the codes in use?

**Question (one, narrow).** The console printed the legend above `show ip route` as a single line naming only
the codes its own table can emit. A box prints something much wider. How many lines is that block, where does it
break, at which column do the continuations start, and does it name codes the table is not using?

**Verdict: known, and adopted.** The legend is **the image's fixed text**, wrapped over nine lines at IOS 15.2E,
with every continuation starting at column 7 so each code lines up under the `L`. It names RIP, EIGRP, IS-IS,
NHRP, ODR, LISP and PfR whether or not a route in the table uses them — the same rule the repo already applies
to `show etherchannel summary`'s flags ("a box prints every flag it can use, not only the ones this table happens
to set"). `engine/cli.js` now prints the block as `IP_ROUTE_CODES_LEGEND`, and
`test/show-ip-route-codes-legend.test.js` pins the nine lines, the column and the gateway sentence's place.

## The captures

| Platform / release | Prints | What it settles |
|---|---|---|
| ntc-templates, `cisco_ios_show_ip_route.raw` (IOS 12.4-era router, raw text with the leading spaces intact) | 6 lines, continuations starting with **7 spaces**, break after `B - BGP`, then `D - EIGRP…`, `N1…`, `E1…`, `i - IS-IS…`, `ia - IS-IS inter area, * - candidate default, U - per-user static route`, `o - ODR, P - …` | the **indent**: 7 spaces, i.e. alignment under the first code, because `Codes: ` is seven characters. This is the only source in hand whose whitespace survived publication. <https://github.com/networktocode/ntc-templates/blob/master/tests/cisco_ios/show_ip_route/cisco_ios_show_ip_route.raw> |
| Catalyst 2960-L, IOS 15.2(5)E, *Configuring IP Unicast Routing* (`show ip route` sample) | 9 lines: `Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP` / `D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area` / `N1 … N2 …` / `E1 … E2 …` / `i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2` / `ia - IS-IS inter area, * - candidate default, U - per-user static route` / `o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP` / `a - application route` / `+ - replicated route, % - next hop override, p - overrides from PfR` | the **15.2E switch block**, which is what this console now prints: the catalogue's access switches are 2960-X/2960-L class. <https://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960l/software/15-2_5_e/config-guide/b_1525e_consolidated_2960l_cg/b_1525e_consolidated_2960l_cg_chapter_0111101.html> |
| Cisco technote 116264, IOS 15.0(1)S router | 8 lines; `H - NHRP` ends the `o - ODR` line and the last line stops at `% - next hop override` | a **second 15.x variant**: no `l - LISP`, no `p - overrides from PfR`. The block is per-release, not universal. <https://www.cisco.com/c/en/us/support/docs/ip/ip-routing/116264-technote-ios-00.html> |
| Catalyst 3850, IOS XE 16.12.7 (Cisco doc 41260) | **11 lines**: `E1 … E2 - OSPF external type 2, m - OMP` / `n - NAT, Ni - NAT inside, No - NAT outside, Nd - NAT DIA` / `H - NHRP, G - NHRP registered, g - NHRP registration summary` interleaved | IOS XE **inserts codes into the same block**; the wrap points move with them. <https://www.cisco.com/c/en/us/support/docs/lan-switching/inter-vlan-routing/41260-189.html> |
| Cisco SD-WAN Routing Configuration Guide, IOS XE 17.x | longer again (`& - replicated local route overrides by connected` after the `+ - replicated route` line) | the block keeps growing; there is no "one true legend" across releases. <http://cisco.com/c/en/us/td/docs/routers/sdwan/configuration/routing/ios-xe-17/routing-configuration-guide-17-x/routing-information-protocol-ref/verification-commands-for-ripv2-configuration.html> |

The wrap points are **not** a reflow at a column: the 15.2E lines measure 73, 69, 69, 59, 76, 78, 72, 28 and 74
characters, so a printer that wrapped at `len > 72` would produce a different block from the captured one. It is
a string literal in the image, which is why the release, not the terminal width, decides the shape.

## What this console printed, and what it prints now

One line, 85 characters counting the label, naming six codes:

```
Codes: L - local, C - connected, S - static, B - BGP, O - OSPF, * - candidate default
```

The line was assembled over several fixes — `L` first and `*` last are the box's order
(`research/local-route-in-show-ip-route.md`, `research/show-ip-route-candidate-default.md`) — and the comment
above it said out loud that "the subset is this console's own". That was the right call for the *set* and the
wrong one for the *shape*: a reader comparing a capture against this console saw nine lines where there was one,
and a code list four times longer than the one in front of them. The set and the shape are one object on the
box, so they are one object here now.

## Known, inferred, unresolved

**Known.** The indent (7), the 15.2E block's nine lines and their exact break points, that IOS XE 16/17 inserts
`m - OMP`, four NAT codes and three NHRP codes into the same block, and that the legend is printed even when no
route uses any of the codes.

**Inferred.** That the modelled 2960-X (15.2E, the platform whose block this console prints) carries the same
nine lines as the 2960-L page — same release train, same guide family, and the 2960-X's own PDF sample did not
survive text extraction. If the two differ, the difference would be on the last line (`p - overrides from PfR`).

**Unresolved.** Which variant a 9200/9300 at 17.x prints on a *fixed-config Catalyst* rather than an SD-WAN
router: the 3850 at 16.12.7 capture is a Catalyst and settles 16.x, but the catalogue's 9000-series entries carry
no software release, so a per-device legend is not expressible today (the same gap `research/stp-mode-default.md`
records for the default STP mode). One block for the whole catalogue is the honest simplification, and
`docs/CLI.md` says which one.

**What would settle it.** A `show ip route` capture from a factory-default Catalyst 9200 at 17.x, pasted with its
whitespace intact, and one from a `show ip route ospf` on the same box (the legend is reprinted per protocol
view, so the two should be byte-identical — unverified here).
