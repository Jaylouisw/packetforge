# `no ipv6 nd ra lifetime` is the way back to 1800, not a second way to set the value

**Question.** The printed line is `ipv6 nd ra lifetime <s>`. What does its `no` form do - restore the
default, refuse, or set the value again - and does the vendor's no form carry the seconds?

**Verdict.** It restores the default, and the vendor writes the no form with **no seconds in it**:
`no ipv6 nd ra lifetime`. PacketForge read the leading `no` into a `negated` flag and never looked at it on
the `lifetime` branch, so the bare form answered `% Incomplete command` and the long form (`no ipv6 nd ra
lifetime 900`) was *accepted*, answered with the set-receipt and wrote the value again - a `no` that did the
opposite of what it said, on a box that never had one.

## What the vendor says

* Cisco IOS IPv6 Command Reference, *ipv6 nd ra lifetime* (PDF, "IPv6 Commands: ipv6 mo to ipv6 ospf da"):
  > To configure the router lifetime value in IPv6 router advertisements on an interface, use the `ipv6 nd ra
  > lifetime` command in interface configuration mode. To restore the default lifetime, use the no form of
  > this command.
  >
  > `ipv6 nd ra lifetime seconds`
  > `no ipv6 nd ra lifetime`
  >
  > Command Default: The default lifetime value is 1800 seconds.

  https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipv6/command/ipv6-cr-book.pdf
* Cisco Catalyst 1200 and 1300 Switches CLI, *IPv6 Commands*: the same two lines - "To restore the default
  lifetime, use the no form of this command", `ipv6 nd ra lifetime seconds` / `no ipv6 nd ra lifetime` - and
  the same note that a non-zero Router Lifetime "should not be less than" the RA interval.
  https://www.cisco.com/c/en/us/td/docs/switches/campus-lan-switches-access/Catalyst-1200-and-1300-Switches/cli/C1300-cli/ipv6-commands.pdf
* Cisco CBS 250/350 CLI, *IPv6 Commands*: identical wording and syntax, default "3*<Maximum RA Interval>
  seconds" (600 s interval -> 1800 s).
  https://www.cisco.com/c/en/us/td/docs/switches/lan/csbms/CBS_250_350/CLI/cbs-350-cli-/ipv6-commands.pdf
* Aruba AOS-CX 10.16, *ipv6 nd ra lifetime*: the one vendor found that shows the optional value -
  `no ipv6 nd ra lifetime [<TIME>]` - and still defines it as "sets lifetime to the default of 1800 seconds",
  never as "remove the value named".
  https://arubanetworking.hpe.com/techdocs/AOS-CX/10.16/HTML/ip_services_8100-83xx-93xx-100xx/Content/Chp_IPv6_RA/IPv6_RA_cmds/ipv-nd-ra-lif-10.htm

The one thing every source agrees on is the *effect*: the no form is the default (1800 s), and with no other
`ipv6 nd` setting configured the line is simply not in the configuration - which is why the lifetime is
printed only when it differs from `ra.DEFAULTS.routerLifetime`.

## What changed

`_ipv6Nd()` in `engine/cli.js`, the `lifetime` branch:

* the bare `no ipv6 nd ra lifetime` restores 1800 s and answers
  `IPv6 RA router lifetime back to the default 1800s (it was 900s)`; `show running-config` drops the line,
  because the default is not a line the config owns.
* a bare `no` with nothing to remove refuses in the shape `no hostname` uses:
  `% No router lifetime set on R1 (it is the default, 1800s)` - and changes nothing.
* a value on the no line has to name the value in force (the rule `no ip route <dest> <mask> <gw> [<distance>]`
  already follows): `no ipv6 nd ra lifetime 1200` removes a configured 1200, and `no ipv6 nd ra lifetime 900`
  against a configured 1200 answers `% No router lifetime 900s set on R1 (it is 1200s) - nothing was removed`.
  Reading any number as "remove whatever is there" would delete a setting the line never named.
* `0` is a configured value ("do not use me as a default router"), not "nothing": the bare no removes it, and
  `show running-config` owns `ipv6 nd ra lifetime 0` because it differs from the default.
* the seconds field is validated by one shared check, so the no form refuses a word or an out-of-range number
  in the set form's own sentence (`% Invalid router lifetime "soon" ...`, `% Router lifetime out of range:
  70000 (0..65535)`).
* a device without `l3-forward` refuses the no form with the same capability sentence as the set form,
  before any state is touched.

`test/ipv6-nd-ra-lifetime-no-form.test.js` (34 assertions) holds the console to all of it.

## What is inferred, and what would settle it

* **Inferred: the receipt.** IOS accepts a config line silently. This console prints a receipt for every line
  it accepts (the project's standing rule), so `IPv6 RA router lifetime back to the default 1800s (it was
  900s)` is this console's sentence, not a capture. No vendor source shows IOS printing anything here, and a
  `show running-config` on a real box after the no form would only confirm the absence of the line.
* **Unresolved: whether IOS accepts the seconds on the no line.** The documented spelling has none, and IOS's
  `no` prefix generally tolerates the full command with its arguments. A capture of `no ipv6 nd ra lifetime 900`
  typed at a box that holds 1200 - accepted-and-reset, or `% Invalid input` - would settle whether the
  value-must-match rule is stricter than the vendor. Refusing is the safe side of that line: it changes
  nothing and names what is set.
* **Unresolved: the accepted range.** This console keeps the 16-bit field, `0..65535` (RFC 4861 S4.2), which
  is what `show ipv6 nd` advertises. The Catalyst 1200/1300 and CBS 250/350 command lists say the acceptable
  range is "0 or from <Maximum RA Interval> to 9000 seconds", and the IOS 15.x reference gives no range for
  this command at all. A `show version` plus one range probe from an IOS 15.2 switch would say whether the
  ceiling is a platform limit or a documentation habit; nothing in hand justifies changing the field width.
