# `show ip nat translations`: where the columns sit, how wide each one is, and whether there is a sixth

**Question (one, narrow).** In the plain `show ip nat translations` table, how wide is each field — the
protocol, the inside global, the inside local, the outside local — at which column does each heading start,
and does the vendor print anything after `Outside global`?

**Verdict: the column count is settled (five, no sixth field); the column widths are unresolved.**
Two Cisco documents disagree on where the address columns start — 4/20/35/50 in one and 4/23/42/61 in
another, and a third header on the same page at 4/25/44/63 — and neither geometry matches this console, which
sits at 5/28/51/74 and appends a sixth word. Nothing in `engine/` was changed: choosing either geometry would
be a coin flip, and dropping the sixth field is a change to a shape that three test assertions and one doc
line currently describe, so it is recorded here as a decision with its evidence rather than taken this run.

## What PacketForge prints today

Measured by running the engine (three PAT translations: udp, tcp, icmp):

```
Pro  Inside global          Inside local           Outside local          Outside global
udp  203.0.113.5:1024       192.168.1.10:52000     198.51.100.9:53        198.51.100.9:53        pat
tcp  203.0.113.5:1025       192.168.1.11:52000     198.51.100.9:53        198.51.100.9:53        pat
icmp 203.0.113.5:1026       192.168.1.12:0         198.51.100.9:0         198.51.100.9:0         pat
```

| field | starts at column | width incl. separator |
| --- | --- | --- |
| Pro | 0 | 5 |
| Inside global | 5 | 23 |
| Inside local | 28 | 23 |
| Outside local | 51 | 23 |
| Outside global | 74 | to end of line |
| *the translation type* | 97 | no vendor sample has this column at all |

The widths are `pad(e.protocol || 'any', 5)` plus three `pad(..., 23)` calls in `formatTable`
(`engine/nat.js:774`), and `TABLE_HEADER` (`engine/nat.js:752`) is a hand-written literal that happens to
agree with them. Two by-products of the same code are visible above and are not this run's question: `icmp`
carries a port no sample prints, and a field with no port is printed as `:0` where the vendor prints the bare
address.

## Evidence

| Source | Shows | Column starts |
| --- | --- | --- |
| [Catalyst 9600 17.18 Command Reference, `show ip nat translations` (PDF, p.156)](https://cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/17-18/command_reference/b_1718_9600_cr/ip_addressing_services_commands.pdf) | `Pro Inside global   Inside local   Outside local  Outside global` over `tcp 10.8.8.50:1024  10.5.5.1:1024  10.2.2.3:1024  10.2.2.3:1024` and `--- 10.8.8.50       10.5.5.1       ---            ---` — header and both row shapes agree, so the geometry reads two ways | **4 / 20 / 35 / 50** (widths 16, 15, 15) |
| [IOS 12.4T config guide, Monitoring and Maintaining NAT (archived)](https://web.archive.org/web/20220809111728/https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_nat/configuration/12-4t/nat-12-4t-book/iadnat-monmain.html) | `Pro Inside global      Inside local       Outside local      Outside global` over `--- 192.168.2.1 … 192.168.2.12 … ---                ---` | **4 / 23 / 42 / 61** (widths 19, 19, 19) |
| Same page, the `show ip nat translations verbose` sample | `Pro Inside global        Inside local       Outside local      Outside global` — a different header, eight spaces after `Inside global` | **4 / 25 / 44 / 63** (widths 21, 19, 19) |
| [IOS 15.2S config guide, same section (archived)](https://web.archive.org/web/20260617171414/https://www.cisco.com/en/US/docs/ios-xml/ios/ipaddr_nat/configuration/15-2s/iadnat-monmain.html) | The same document text and the same two headers, five years later | as above |
| [IOS XE 17.x Monitoring and Maintaining NAT (PDF)](https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/ip-addressing/b-ip-addressing/m_iadnat-monmain-xe.pdf) | Lists the five translation fields in prose — protocol, inside global, inside local, outside local, outside global — and no sixth; the sample leading whitespace is lost in extraction | unusable |

Three things are not in doubt, because every sample agrees on them:

1. The heading text is `Pro Inside global … Inside local … Outside local … Outside global`.
2. The protocol field ends where the inside-global field begins, at **column 4** — `Pro`, `tcp`, `udp` and
   `---` are all three characters, so the second column starts at 4 in every sample. This console starts it
   at 5.
3. There is **no sixth field**. Every vendor sample ends at `Outside global`; the translation type appears
   only under `verbose`, as `flags: extended` / `flags: static` on a continuation line. This console appends
   `pat` / `static`, which no sample contains, and `docs/CLI.md:1144` describes the table as
   "proto, inside global, inside local, outside local/global" — five columns, so the doc and the code
   already disagree with each other.

## Why the widths cannot be adopted from this evidence

* **The two intact geometries are 16/15/15 and 19/19/19.** The first is corroborated by its own rows: a
  9-character cell followed by 7 spaces and a 14-character cell followed by 2 both land on the next column,
  which is what a fixed `%-16s` does. The second is header-only — in the 12.4T/15.2S `<pre>` blocks the
  alignment runs were replaced by literal tab characters, so the row spacing there is not what the router
  printed, and no rule can be recovered from it.
* **The vendor page carries two different headers for one command.** Plain sample: six spaces after
  `Inside global`. Verbose sample: eight. That is either two platforms pasted into one page, or a formatter
  whose first column widens with the longest cell. The data supports the second reading only weakly: the
  verbose sample widest inside-global cell is 18 characters and its column is 21 wide (+3), while the plain
  sample widest is 12 and its column is 19 (+7), and inside-local is 19 wide in both despite carrying an
  18-character cell in the verbose sample. No single rule reproduces all three headers.
* **The protocol field is either 4 wide or the value plus one space, and the evidence cannot separate them**,
  because every intact sample uses a three-character protocol. `icmp` is four characters and never appears in
  an intact sample, so the two rules differ exactly where the evidence is silent: padding to 4 would abut the
  next column for `icmp`, value-plus-space would shift every later column one right.

## What would settle it

* A raw capture of `show ip nat translations` — not a web page — from one named platform and release, pasted
  so the spaces survive: `show tech-support`, a session transcript, or a terminal log on a forum post. Two
  captures, one from a 12.4/15.x box and one from an IOS XE 16.x/17.x box, would say whether the 19-wide
  geometry belongs to an era rather than to a platform.
* One capture containing an **icmp** translation, which settles the protocol field.
* Failing either, the platform formatter is not public and the honest state stays: two geometries,
  platform-undetermined.

## What was not changed, and the follow-up it leaves

* **Widths**: unchanged. `pad(..., 5)` and `pad(..., 23)` stay until a geometry can be attributed to a
  platform this simulator models.
* **The sixth field**: this is the one settled fact that would change output, and it was still not taken,
  because it is a shape change rather than a one-column shift — `test/nat.test.js:357`, `:361` and
  `test/protocol-regression.test.js:1048` all assert the trailing word, and `docs/CLI.md:1144` already
  describes the five-column table. A follow-up that drops it must move all four together and check the
  static/PAT distinction is still reachable (`show ip nat rules` names the rule; `verbose` is where the
  vendor puts its flags).
