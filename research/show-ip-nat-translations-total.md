# `show ip nat translations`: does the table end with a total, what does it count, and what is printed when it is empty

**Question (one, narrow).** After the last row of `show ip nat translations`, does a real IOS-like box print
anything — and if it prints a count, what does that count count, and what does the view answer when there are
no translations at all?

**Verdict: settled, and adopted.** A box closes the table with `Total number of translations: N`, and a box
with nothing in the table answers with that sentence **alone** — no column headings over an empty table. The
`N` is the number of translations active at the instant asked, which on this model is exactly the number of
rows the view just printed. PacketForge printed the headings and the rows and stopped, so every reader had to
count the rows to know how many there were, and an empty table was a header over nothing.

This is the same piece of furniture the MAC address table (`research/mac-table-surround.md`) and the
EtherChannel summary (`research/etherchannel-summary-layout.md`) each carried before their own audits; the NAT
table was the one table still missing its closing sentence. It is also the follow-up that
`research/show-ip-nat-translations-columns.md` explicitly left open ("does the vendor print anything after
`Outside global`?" — asked there about a sixth *column*, answered here about a trailing *line*).

## What the box prints

Six Cisco pages, one shape. The plain sample in every one of them ends the table with the sentence:

| Source | Sample (last lines) |
| --- | --- |
| [IOS XE 17.x, Monitoring and Maintaining NAT](http://cisco.com/c/en/us/td/docs/routers/ios/config/17-x/ip-addressing/b-ip-addressing/m_iadnat-monmain-xe.html) | `tcp 192.168.1.1:512 192.168.2.4:53 192.168.2.22:256 192.168.2.22:256` / `Total number of translations: 3` |
| [IOS 15M&T, same module](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_nat/configuration/15-mt/nat-15-mt-book/iadnat-monmain.html) | the same three rows, the same closing sentence |
| [IOS 15S, same module](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_nat/configuration/15-s/nat-15-s-book/iadnat-monmain.html) | same |
| [IOS XE Release 3S, same module](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_nat/configuration/xe-3s/nat-xe-3s-book/iadnat-monmain.html) | same |
| [IOS XE 16.10, Carrier Grade NAT](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_nat/configuration/xe-16-10/nat-xe-16-10-book/iadnat-cgn.html) | three `udp` rows / `Total number of translations: 3` |
| [Catalyst SD-WAN NAT guide 17.16+, Site-Local Failover for NAT DIA](http://www.cisco.com/c/en/us/td/docs/routers/sdwan/configuration/nat/nat-book-xe-sdwan/site-local-failover.html) | `tcp …` / `icmp …` / `Total number of translations: 2`, then, after the breakout goes down, `#show ip nat translations` / `Total number of translations: 0` — **no headings at all** (in the same page's longer captures the sentence follows `<snip>`, so it is one line at the end, not per row) |

The 17.x guide's "Statistical Information" section defines the counter the sentence is printing: "The total
number of translations active in the system. This number is incremented each time a translation is created and
is decremented each time a translation is cleared or times out." So it is a count of **live entries**, not of
rules, not of packets, and not a lifetime total.

Two consequences follow, and both are visible above:

1. **Headings belong to a non-empty table.** With zero translations the view is one line — `Total number of
   translations: 0`. The SD-WAN page prints exactly that after the failover, in the same page where the
   two-row table above it has headings.
2. **The sentence is the last line**, after the rows, and is not repeated per row or per rule.

One document in hand does **not** print it: the archived 12.4T module's plain sample ends at the
`--- 192.168.2.1 … ---` row (`https://web.archive.org/web/20220809111728/https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_nat/configuration/12-4t/nat-12-4t-book/iadnat-monmain.html`).
That is why the sentence is adopted as the *modern* shape rather than as a universal one — every sample from
15M&T onwards has it, the 12.4 page does not, and this console's own models are IOS-XE-era boxes.

## What PacketForge did, and what it does now

Before, on a router with one PAT translation (`show ip nat translations`, run in this worktree):

```
Pro  Inside global          Inside local           Outside local          Outside global
icmp 203.0.113.1:1024       192.168.10.50          203.0.113.9            203.0.113.9            pat
```

and with the table aged out, the headings were still printed, alone. Now:

* rows present → headings, one line per translation, then `Total number of translations: N`;
* table exists but is empty → `Total number of translations: 0`, **no headings**;
* no table at all (nothing has needed translating) → the console's own sentence `No translations: no packet
  needing NAT has crossed this device` is kept, and the box's count closes it at `0`. The sentence is this
  model's affordance (`docs/CLI.md`, "a device that has carried no NAT traffic says nothing has crossed") and
  deleting it to print one bare line would delete the answer to *why* the table is empty; the vendor's closing
  line still appears, so a reader looking for the box's sentence finds it.

`N` is `natLib.formatTable(table).length` — the rows just printed. The model's table holds only live
translations (expired ones are dropped when the view is asked, `engine/nat.js` `expireTranslations`), so this
is also the number the `Active translations:` line of `show ip nat statistics` reports, and the new test
asserts the two views agree.

Changed: `engine/cli.js` (the `translations` branch of the NAT door), `docs/CLI.md` (the paragraph under the
three NAT views), and `test/nat-translations-total.test.js` (13 assertions: the sentence is last, counts the
rows, appears exactly once, headings present only with rows, the empty table is the sentence alone, the
never-translated case keeps its sentence and ends at zero, and the two views agree).

## What is inferred, and what remains

* **"Active" = the rows printed** is inferred from the vendor's own definition plus the fact that this model's
  table has no dormant entries. On a box that supports a filtered view (`show ip nat translations inside
  <address>` exists on IOS XE 17.x) the sentence may count the *printed subset* or the whole table; no sample
  with a filter and a total was found, so no filter is offered here and the question does not arise yet.
* **Unused static rules do not appear in this model's table.** Configure `ip nat inside source static A B` and
  ask for the table before any packet crosses: this console answers `Total number of translations: 0`. A real
  box is widely reported to list a static mapping as soon as it is configured (`--- inside-local inside-global
  --- ---`), and the 12.4T sample's non-overloaded rows have that shape. That is a *separate* question — does
  a static rule occupy a row before it carries traffic — and it would change this count, so it is recorded here
  rather than guessed at. What would settle it: a capture of `show ip nat translations` on a box with one
  static rule configured and no traffic since boot, plus the same command after one packet.
* **The `verbose` view also ends with the sentence** in the 16.x/17.x samples (`Total number of translations:
  3` after the `create/use/flags` lines). This console keeps no verbose form (it refuses the word), so there is
  nothing to close there.
* **Adjacent, not changed:** `show ip nat statistics` in this model opens with `Ports: inside … - outside …`,
  which no box prints; the vendor's first line is `Total active translations: N (N static, N dynamic; N
  extended)` followed by `Outside interfaces:` / `Inside interfaces:` sections (all six pages above agree). The
  `extended` field's exact rule is not established from these samples, so that shape was left alone this run.
