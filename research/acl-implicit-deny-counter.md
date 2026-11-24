# The implicit deny's match count — is there a line to print it on?

**Question (one, narrow).** Every IOS access list ends with an unwritten `deny any`. When traffic falls off
the end of a list and is dropped by that rule, does `show access-lists` (or `show ip access-lists`) print
anything for it — a line, a count, or a footnote — beside the written entries whose counts it does print?

**Verdict: no, and this console printed one.** A box counts the packets that match *written* lines. The
implicit deny is not a line in the table, so it has no counter and nothing is printed for it — not when it
has dropped nothing, and not when it has dropped everything. Cisco says so in one sentence, repeated in
every ACL book that carries the "Helpful Hints" list, and two machine-recorded sessions show the table with
no such line. PacketForge printed

```
Extended IP access list 101
    10 permit icmp host 10.0.0.77 any
  (implicit deny all: 2 matches)
    applied IN on Gi0
```

and the code beside it claimed "Real gear prints it once it has fired." That claim is false, and the line is
gone. The drops themselves are still reported, one command over: `show interfaces` and `ping` both carry
`ACL 101 denied (in) x2`.

## The evidence

Cisco, *IP Access List Overview* (IOS XE 16), "Helpful Hints for Creating IP Access Lists":

> Although all access lists end with an implicit **deny** statement, we recommend use of an explicit **deny**
> statement (for example, `deny ip any any`). On most platforms, you can display the count of packets denied
> by issuing the **show access-list** command, thus finding out more information about who your access list is
> disallowing. **Only packets denied by explicit `deny` statements are counted**, which is why the explicit
> `deny` statement will yield more complete data for you.

* <https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_data_acl/configuration/xe-16/sec-data-acl-xe-16-book/sec-access-list-ov.html>
* the same paragraph, same words, in the 16.9 PDF
  <http://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_data_acl/configuration/xe-16-9/sec-data-acl-xe-16-9-book/sec-access-list-ov.pdf>,
  in *IP Named Access Control Lists* for XE 16.12
  <https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_data_acl/configuration/xe-16-12/sec-data-acl-xe-16-12-book/sec-acl-named.html>
  and for 3S
  <https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_data_acl/configuration/xe-3s/sec-data-acl-xe-3s-book/sec-acl-named.html>,
  in *IP Access List Entry Sequence Numbering*
  <http://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_data_acl/configuration/xe-16-9/sec-data-acl-xe-16-9-book/sec-acl-seq-num.pdf>,
  and in the Catalyst 2960-XR 15.2(7)E *Access Control List Overview*
  <http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15_2_7_e/configuration_guide/b_1527e_consolidated_2960xr_cg/m_sec_acl_overview_cauvery.pdf>.
  Six documents, one sentence: the count exists for explicit denies only.

Two raw console captures, recorded from real devices rather than retyped by hand:

| Capture | Prints |
| --- | --- |
| ntc-templates `cisco_ios_show_access-list.raw` <https://github.com/networktocode/ntc-templates/tree/master/tests/cisco_ios/show_access-list> | `Standard IP access list 10` / `10 permit 192.168.1.0, wildcard bits 0.0.0.255 (5177 matches)` / `16 deny udp host …` — 5,177 matches on one line, and **no implicit line** under the list, though a list that permits 192.168.1.0/24 as its only permit has certainly dropped something |
| ntc-templates `cisco_ios_show_ip_access-lists.raw` <https://github.com/networktocode/ntc-templates/tree/master/tests/cisco_ios/show_ip_access-lists> | `Standard IP access list 99` … `(20 matches)` on its third line; `Extended IP access list test` with a heading and **nothing under it** — an empty list prints an empty body, not a note about the rule that ends it |

The second capture is the sharp one for this table's shape: a list with no entries prints its heading and
stops. There is no place in that output for a rule nobody typed.

## What is inferred rather than witnessed

* **"No counter" means "no line", not "a line with no number".** The sentences above are about counting, and
  the captures are about printing; together they say the box has nothing to print. Neither alone would prove
  the absence — a silent zero is indistinguishable from a missing line in a document that only discusses
  counters — which is why both kinds of source are cited here.
* **The drop is still real, and still visible.** `show interfaces` on the ingress port carries
  `2 drops ("ACL 101 denied (in)" x2)` and a lost echo carries `Echoes lost: …`; both come from the engine's
  drop path, not from an ACL counter. Removing the invented line takes away no way to find the packets.
* **The tally behind the line stays.** `_countAclHit()` still increments `tally.implicit`, because it is the
  truth about what happened and the field distinguishes "dropped by the implicit rule" from "never tested".
  No view prints it now. `total`, `permitted` and `denied` in the same tally have never been printed either.

## What is unresolved

* **"On most platforms" is the vendor hedging.** The sentence is written for the family, not for one image,
  and IOS XE's *hardware* ACL detail views do print an implicit entry: `show access-lists ipv4 objv4acl
  hardware ingress detail location 0/0/CPU0` on IOS XR prints a block whose `Sequence Number:` is
  `IMPLICIT DENY`, with `Hit Packet Count: 0 Byte Count: 0`
  (<https://www.cisco.com/c/en/us/td/docs/iosxr/ncs5000/ip-addresses/79x/b-ip-addresses-cg-ncs5000-79x/implementing-access-lists-and-prefix-lists.html>).
  That is a different command, a different address family spelling and a different OS — XR, not IOS — so it
  is not evidence about `show access-lists` here, but it is the reason this note does not claim the count is
  *unavailable* anywhere on Cisco gear. **What would settle it:** a platform whose plain
  `show ip access-lists` prints an implicit-deny count; if one exists, this console owes it a
  platform-specific line, not a default one.
* **ASA and NX-OS.** The ASA's `show access-list` prints `hitcnt=` per ACE and no implicit rule; NX-OS's
  `show access-lists` likewise. Both are different CLIs and are out of scope for this console's door, noted
  so a later reader does not average them into the IOS answer.

## What the model does now

* `engine/cli.js`, `show access-lists`: the `(implicit deny all: N matches)` line is removed, with the
  citation in a comment where it used to be printed. The table is the heading, the written entries with their
  own counts (absent when zero), the console's `counters:` note when nothing has been tested at all, and the
  `applied IN/OUT on <iface>` lines the console prints in its own voice.
* `engine/simulator.js`, `_countAclHit()`: unchanged — the implicit deny is still counted internally.
* `docs/CLI.md` and `docs/SIMULATION.md` updated to say what is printed and why nothing is.
* `test/show-access-lists.test.js`, 25 checks (was 23): the same two pings are dropped, the table carries no
  implicit line, it reads as a heading over one written rule with no count, and `show interfaces` still
  attributes both drops to `ACL 101 denied (in)`.
