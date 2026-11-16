# The numbers down the left of `show access-lists`: sequence, not index

**Question (one, narrow).** What number does IOS print beside each line of `show access-lists`, and how far
is the line indented — is it the line's *sequence number* (10, 20, 30) or its position (1, 2, 3), and four
columns under the header or two?

**Verdict: settled for the number and the indent, corrected.** A box prints the entry's sequence number,
four columns in. The console printed `  1`, `  2`, `  3` — an array index, two spaces in — so a reader
comparing the simulator with a real box found a column of numbers no box can produce and could not name the
line to change. Both now come from the same helper the first-match evaluation uses.

## What a box does

| Source | Says |
| --- | --- |
| [Cisco IOS XE, *IP Access List Entry Sequence Numbering*](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_data_acl/configuration/xe-16-11/sec-data-acl-xe-16-11-book/sec-acl-seq-num.pdf) | "For backward compatibility with previous releases, if entries with no sequence numbers are applied, the first entry is assigned a sequence number of 10, and successive entries are incremented by 10." The default step is ten; an entry typed later without a number gets "a sequence number of 10 more than the last entry". |
| [Cisco, *Configure IP Access Lists* (Doc 23602)](https://www.cisco.com/c/en/us/support/docs/security/ios-firewall/23602-confaccesslists.html) | `access-list 101 permit tcp any any` … typed with no numbers, displayed as `    10 permit tcp any any` / `    20 permit udp any any` / `    30 permit icmp any any`. Four columns of indent, tens. |
| [Catalyst 3560 Software Configuration Guide 12.2(25)SEA, ch. 31](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3560/software/release/12-2_25_sea/configuration/guide/3560scg/swacl.pdf) | `Standard IP access list 2`, then `10 deny 171.69.198.102` and `20 permit any` — a numbered list typed with legacy `access-list` lines still displays sequence numbers. |
| [Catalyst 9200 IOS XE 17.2, *IPv4 ACLs*](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-2/configuration_guide/sec/b_172_sec_9200_cg/configuring_ipv4_acls.html) | `Extended IP access list 106` / `10 permit ip any 172.20.128.64 0.0.0.31` — modern XE still prints tens. |
| Real captures committed as test fixtures, [ntc-templates `show_access-list.raw`](https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/cisco_ios/show_access-list/cisco_ios_show_access-list.raw) | `    10 permit 10.1.2.3 log`, `    20 deny   10.1.1.1`, `    16 deny udp …`, `    17 deny tcp …` — four spaces, tens by default, and sequences typed by hand (16, 17) kept as they are. |
| [ntc-templates `show_access-list3.raw`](https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/cisco_ios/show_access-list/cisco_ios_show_access-list3.raw) | `    9999 permit ip any any (10878 matches)` — a four-digit sequence still starts at column 5, so the number is left-aligned after the indent, not right-aligned in a field. |
| [ntc-templates `show_ip_access-lists.raw`](https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/cisco_ios/show_ip_access-lists/cisco_ios_show_ip_access-lists.raw) | The same four-space indent on `show ip access-lists`, which Cisco documents as "output identical to the show access-lists command". |

## What was changed

`engine/acl.js` grew `numberedEntries(acl)` — the lines in evaluation order, each paired with the sequence a
box would show (its own, else 10/20/30… by the position it was *typed* at) — and `sortAcl()` is now that
helper with the numbers dropped, so display order and match order cannot drift apart. `engine/cli.js` prints
`'    ' + seq + ' ' + body`, strips a leading sequence from the body when one was typed inside the line
(`10 permit ip any any` must not print its 10 twice), and still keys the match counter by the text as typed.
`test/show-access-lists-numbering.test.js` (16 checks) pins the tens, the four columns, a hand-typed
`9999`, the absence of a doubled body, that a line numbered 5 is printed *and tested* before one numbered
10, and that counters still land on the line that matched.

## What is inferred

* That the number is left-aligned after the indent rather than right-aligned in a fixed field. Two captures
  with 9999 and 100 speak to it; a capture with a one-digit sequence beside a four-digit one in the same
  list would make it certain.
* That the default sequence is taken from the position the entry was typed at, not from where it lands after
  sorting. IOS assigns the number when the line is entered; this model has no separate "line as typed"
  record, so `permit` then `5 deny` yields 10 and 5 — which is what a box does too, since the number is
  assigned at entry.

## What remains unresolved

* **Whether `deny` is padded to line the address up with `permit`.** The captures disagree, and so do the
  documents: the real `show_ip_access-lists.raw` capture prints `    20 deny   any log` in a **standard**
  list (three spaces, aligning with `permit `), while the same capture's **extended** lists print
  `    30 deny ip …` with a single space; the 3560 guide's standard list shows `10 deny 171.69.198.102`
  with one space; and one fixture ([`show_access-list2.raw`](https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/cisco_ios/show_access-list/cisco_ios_show_access-list2.raw))
  has no indent and no padding at all, which looks like a stripped paste rather than a box's output. Since
  the answer the evidence supports is "standard lists pad, extended lists do not, except when they don't",
  nothing was changed here — the console prints one space, as it did, and the question is recorded instead
  of guessed.
* **Old IOS.** The 11.x-era command reference
  ([E-Learning `show_access-lists.htm`](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_access-lists.htm))
  prints no sequence numbers and no indent at all. This console models the modern table, as the rest of it
  already does (`show vlan brief` follows the 2960 15.x output), so the old form is noted rather than
  supported.

## What would settle the rest

One `show access-lists` (or `show ip access-lists`) capture from a box running IOS XE 17.x that has both a
standard and an extended list whose entries were typed without sequence numbers, pasted verbatim rather than
reflowed by a web page: that single paste answers the padding question for both list kinds, since the column
positions survive in a terminal paste and nowhere else.
