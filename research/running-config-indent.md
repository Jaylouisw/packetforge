# How deep is a line indented inside a configuration submode in `show running-config`?

**Question (one, narrow).** When the printer writes a line that belongs to a submode - the body of an
`interface` stanza, of `ip dhcp pool`, of `dns zone`, or the `bgp router-id` / `neighbor` lines under
`router bgp` - how many spaces go in front of it?

**Verdict: one space per submode level, and it is written down by the vendor.** Cisco publishes the
rule as a numbered list, in the same words, in the prerequisites of four configuration guides, and says
that the list is how the software itself builds the file. This console printed **two** spaces for a
first-level line - the depth the rule reserves for a *second*-level submode - and printed the two
children of `router bgp` with **no** indentation at all, so they read as global commands.

## What the vendor publishes

The paragraph, verbatim (Catalyst 9300 17.1, "Prerequisites for Configuration Replace and Configuration
Rollback"):

> The format of the configuration files used as input by the Configuration Replace and Configuration
> Rollback feature must comply with standard Cisco software configuration file indentation rules as
> follows:
>
> * Start all commands on a new line with no indentation, unless the command is within a configuration
>   submode.
> * Indent commands within a first-level configuration submode one space.
> * Indent commands within a second-level configuration submode two spaces.
> * Indent commands within subsequent submodes accordingly.
>
> These indentation rules describe how the software creates configuration files for such commands as
> `show running-config` or `copy running-config` *destination-url*. Any configuration file generated on
> a Cisco device complies with these rules.

| Source | Says |
| --- | --- |
| [Catalyst 9300 17.1, Configuration Replace and Configuration Rollback](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-1/configuration_guide/sys_mgmt/b_171_sys_mgmt_9300_cg/configuration_replace_and_configuration_rollback.html) | The four bullets above, then "Any configuration file generated on a Cisco device complies with these rules." |
| [Catalyst 9200 26.x, same chapter (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/26-x/configuration_guide/sys_mgmt/b_26x_sys_mgmt_9200_cg/configuration_replace_and_configuration_rollback.pdf) | The same list word for word, on a later release of a different platform family. |
| [Configuration Replace, Catalyst 9000 / IOS XE 17](https://www.cisco.com/c/en/us/td/docs/switches/lan/c9000/mgmt/config-replace/configuration-replace.html) | The same list; "The software creates configuration files based on these indentation rules for commands like `show running-config`." |
| [Managing Configuration Files, IOS XE 17 - Contextual Configuration Diff Utility](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/config-mgmt/configuration/xe-17/config-mgmt-xe-17-book/cm-config-diff.html) | The same list again, reached from a different feature (the diff utility), which is what shows the rule is about the file format rather than one feature. |

Two raw device captures, read with the whitespace intact (`cat -A`), show the first rung on real
hardware:

| Capture | Shows |
| --- | --- |
| [ntc-templates, `cisco_ios_show_running-config_interface.raw`](https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/cisco_ios/show_running-config_interface/cisco_ios_show_running-config_interface.raw) | `interface GigabitEthernet2/0/4.223415` then, each with exactly one leading space and a `$` right after the last character: ` description DISTRIBUTION`, ` bandwidth 2048`, ` encapsulation dot1Q 2234 second-dot1q 15`, ` ip address 10.30.33.161 255.255.255.252`, and a bare `!` between stanzas. |
| [ntc-templates, `cisco_ios_show_running-config_partition_route-map.raw`](https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/cisco_ios/show_running-config_partition_route-map/cisco_ios_show_running-config_partition_route-map.raw) | `route-map RIP_TO_BGP permit 100` then ` match metric 4` and ` set community 11167:5002`, one space each; a second stanza confirms the same shape. |

The raw files are the useful kind of evidence for this question: a published HTML page collapses runs
of spaces, so any sample read through a browser cannot settle an indentation count - these two are the
box's bytes as captured by a parser test suite.

## What this console printed

```
router bgp 65001
bgp router-id 1.1.1.1                     <- column 1: reads as a global command
neighbor 10.0.0.2 remote-as 65002         <- column 1 too
interface GigabitEthernet0/0
  description uplink                      <- two spaces: the depth of a second-level submode
  ip address 10.0.0.1 255.255.255.0
!
```

Consequences, in the order they bite an operator:

1. A backup taken out of this console and diffed against the same box's own file showed **every** line
   of every stanza as changed - the indent is part of the line, and it moved by one character. The
   whole point of the file is that it can be compared with a box's.
2. The `router bgp` children sat at the left margin, where the vendor's rule says a *global* command
   lives. Read as text (in a ticket, in a wiki table, by a script that looks at column 1) they claimed
   to be global configuration.
3. It was internally inconsistent: two spaces is a real, different depth in the rule, so the file said
   every interface line was two levels deep and its own stanza one level.

## What changed

* `engine/cli.js`, `show running-config`: one `IN_SUBMODE` constant, documented with the quoted rule,
  used for every first-level line - the `interface` stanza body, the `ip dhcp pool` body, the `dns zone`
  records, and the two `router bgp` children (which gain the space they were missing).
* `test/running-config-indent.test.js` (32 checks): no line is indented two or more spaces; global
  commands (`hostname`, `vlan`, `router bgp`, `ip dhcp pool`, `dns zone`, `end`) start in column 1; every
  line of an `interface`, pool and zone stanza begins with exactly one space; the BGP children follow
  their header at one space and are not printed at the margin; the printed file replays byte for byte on
  a fresh device; and a config typed in the box's own shape (one space, `!` separators) lands its
  addresses and its administrative-off line on the right ports.
* `docs/CLI.md`: the "config you can paste back" section gains the indentation property, and the VRRP
  syntax block is re-indented to match. `docs/BGP-POLICY.md`: the printed-form block loses the
  left-margin shape it specified for `bgp`/`neighbor`/`set` lines.

## Known, inferred, unresolved

* **Known.** The rule and its two rungs, verbatim, from four Cisco pages; the first rung observed on two
  real captures; that the file is meant to be read back as input (the rule's own subject is the format
  `configure replace` accepts).
* **Inferred.** That a `router bgp` block follows the same rung. No capture in hand contains one - the
  route-map capture is the nearest neighbour, and the rule is written once for every submode, so applying
  it is what the document says rather than an analogy. A `show running-config` from a box with a BGP
  process would make it observed rather than inferred.
* **Unresolved - the second rung.** Nothing here nests two deep, so the "two spaces for a second-level
  submode" half of the rule is quoted but unexercised: no capture in hand shows a two-space line, and
  this console has no configuration command whose body contains another body. If one is added
  (`ip dhcp pool` → `host`, `route-map` → `set`, class-map/policy-map chains are candidates), the second
  rung needs its own capture before it is printed.
* **Unresolved - is the indent load-bearing on input?** The vendor states the rule for files fed to
  `configure replace`; whether a *paste* at `(config)#` depends on the leading space is not stated in any
  page read here. This console accepts both (the parser trims, which the replay test above exercises),
  so nothing here rests on the answer. A transcript of a deliberately mis-indented paste into a real box,
  and the resulting config, would settle it - it is also the open question in
  `research/running-config-stanza-separator.md` about what a `!` inside a submode does.
* **Not touched.** `show access-lists` keeps its four-space indent for an entry's sequence number
  (different view, documented separately in `research/show-access-lists-numbering.md`), and `show
  route-map` keeps its two-space `Match clauses:` heading; the vendor indents those views differently
  from a configuration file.
