# A standard access list is not printed — or tested — in the order it was entered

**Question (one, narrow).** `show access-lists` prints a list's entries in sequence order here. Does a Cisco
box do the same for a **standard** list, or does it rewrite the order — and if it rewrites it, what happens to
the sequence numbers of the lines it moves?

**Verdict: settled, and adopted.** IOS moves every standard entry that pins one address (`host 10.1.1.1`, or
`10.1.1.1 0.0.0.0`) above the entries that match a range, keeps each moved line's own sequence number, and
writes the configuration file in that same order. The column therefore reads 30, 40, 10, 20, … on a real box.
This console printed and *evaluated* standard lists in sequence order, so a list whose host entry carried the
higher number was read upside down: the range line permitted the address the box denies.

## What a box does: the rewrite is documented

Every Catalyst software-configuration guide in the 12.2(2x)SE and 15.2(x)E trains carries the same paragraph,
in the **Numbered Standard IPv4 ACLs** section:

> "The switch always rewrites the order of standard access lists so that entries with **host** matches and
> entries with matches having a *don't care* mask of 0.0.0.0 are moved to the top of the list, above any
> entries with non-zero *don't care* masks. Therefore, in **show** command output and in the configuration
> file, the ACEs do not necessarily appear in the order in which they were entered."

| Guide | Where the paragraph appears |
| --- | --- |
| [Catalyst 2960-X, IOS 15.2(6)E, *Configuring IPv4 Access Control Lists*](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/configuration_guide/b_1526e_consolidated_2960x_cg/m_sec_acls_cg_cauvery.html) | `Numbered Standard IPv4 ACLs`, above the standard-ACL example |
| [Catalyst 2960-X, IOS 15.2(5)E](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_5_e/configuration_guide/b_1525e_consolidated_2960x_cg/b_1525e_consolidated_2960x_cg_chapter_0110011.html) | same section |
| [Catalyst 2960-XR, IOS 15.2(7)E](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15_2_7_e/configuration_guide/b_1527e_consolidated_2960xr_cg/m_sec_acls_cg_cauvery.html) | same section |
| [Catalyst 2960, IOS 15.2(2)E](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-2_2_e/configuration/guide/b_1522e_2960_2960c_2960s_2960sf_2960p_cg/b_1522e_2960_2960c_2960s_2960sf_2960p_cg_chapter_0101011.html) and [15.2(4)E (PDF)](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-2_4_e/configurationguide/b_1524e_consolidated_2960p_2960c_cg/m_1522e_sec_acls_2960_cg.pdf) | same section |
| [Catalyst 2960, 12.2(37)SE](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_37_se/configuration/guide/scg/swacl.html), [12.2(40)SE](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_40_se/configuration/guide/scg/swacl.html), [12.2(52)SE](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_52_se/configuration/guide/2960scg/swacl.html), [12.2(25)FX](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_25_fx/configuration/guide/2960scg/swacl.html) | `Creating a Numbered Standard ACL` |
| [Catalyst 3560CX/2960CX, IOS 15.2(6)E (PDF)](https://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960cx_3650cx/software/release/15-2_6_e/configuration_guide/b_1526e_consolidated_3560cx_2960cx_cg/m_sec_acls_cg.pdf) | same section |
| [Catalyst 1000, IOS 15.2(7)Ex](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst1000/software/releases/15_2_7_e/configuration_guides/sec/b_1527e_security_c1000_cg/configuring_ipv4_acls.html) | same section, beside `Sequence Numbering Behavior` |
| [IE 4010/5000, IOS 15.2(4)EC (PDF)](https://cisco.com/c/en/us/td/docs/switches/lan/cisco_ie4010/software/release/15-2_4_EC/configuration/guide/scg-ie4010_5000/swacl.pdf) | `Configuring IPv4 ACLs` |

The paragraph is written for *numbered* standard lists. A router capture shows a **named** standard list
rewritten the same way, and a reply on that thread calls it long-standing behaviour on every IOS router:

```
IP access-list standard VTY                      Standard IP access list VTY
 permit 169.254.0.0, wildcard bits 0.0.0.255       30 permit 172.20.225.124
 permit 169.254.1.0, wildcard bits 0.0.0.255       40 permit 172.20.225.225
 permit 172.20.225.124                             10 permit 169.254.0.0, wildcard bits 0.0.0.255
 permit 172.20.225.225                             20 permit 169.254.1.0, wildcard bits 0.0.0.255 (2 matches)
 permit 172.20.226.0, wildcard bits 0.0.0.255      50 permit 172.20.226.0, wildcard bits 0.0.0.255
 permit 172.24.226.0, wildcard bits 0.0.0.255      60 permit 172.24.226.0, wildcard bits 0.0.0.255
 permit 192.168.1.0, wildcard bits 0.0.0.255       70 permit 192.168.1.0, wildcard bits 0.0.0.255 (2 matches)
 deny any log                                      80 deny any log
```

* Cisco Community, "Reordered named access-list", 2007 — <https://community.cisco.com/t5/switching/reordered-named-access-list/td-p/844044>
  (the post carries both the typed list and the printed one; the reply: *"I have worked with IOS routers since
  the early days of release 9. It has consistently been the behavior (though not clearly documented) for
  standard access lists that IOS reorders the lines of the access list so that any host specific entries are
  put before any other entries"*).

That capture answers the question the guides leave open — **the numbers stay with their entries**: the two
host lines keep 30 and 40 and are printed above 10 and 20, so the column is no longer monotonic. It also
shows the match counts staying on their own lines (`20 … (2 matches)`, `70 … (2 matches)`), so the counters
move with the entry, not with the position.

## What changed

* `engine/acl.js` — `isHostEntry()` recognises the shape (`kind: 'standard'`, a source spec that is not `any`
  and whose wildcard is all zeroes, however it was spelled), and `numberedEntries()` now sorts a standard
  list's host entries ahead of everything else, sequence-then-typed order within each group. The display and
  `evaluate()` already shared that one helper, so the printed order and the tested order move together.
* `engine/acl.js` — `evaluate()` returns `matchedEntry` beside `matchedIndex`. The index counts the *ordered*
  list while the stored array is in another order now, so `_countAclHit()` (engine/simulator.js) keys the
  counter by the entry itself and the matches stay on the line that matched.
* `engine/cli.js` — `show running-config` writes the `access-list` lines through the same helper, because the
  guides say the configuration file is rewritten too.
* `test/standard-ace-host-order.test.js` (15 checks) — the host deny printed first with its 20; the range
  permit after it with its 10; the same order in `show running-config`; the ping denied and the matches
  counted on the host line; `x 0.0.0.0` treated as a host; `any` and an extended list left alone; and the
  helper itself (`[20, 10, 30]`, verdict naming the entry).
* Two existing tests asserted position rather than content and encoded the old order — their *subject*
  (numbering, rendering) is unchanged, so their row lookups are now by content:
  `test/show-access-lists-standard-address-form.test.js` (the two standard-list blocks) and `test/acl.test.js`
  (`normalizeAcl` now numbers by typed position 10/20 and orders the host entry first, which is the pair the
  test now asserts).
* `docs/CLI.md`, under *Reading `show access-lists`*, says a standard list is the one list that is not printed
  in sequence order, and why.

## Inferred, not known

* **That the printed order is the tested order.** The guides say only that the ACEs are not in entered order;
  first-match-wins makes the order they *are* in the order that decides. No capture pairs a `show access-lists`
  table with a packet that the moved line decided, so this is inference from the model of the command, not a
  transcript.
* **Order within each group.** The capture's hosts are 30, 40 and its ranges 10, 20, 50, 60, 70 — ascending in
  both readings, so it cannot separate sequence order from any other. The console keeps sequence-then-typed
  order in each group, which is the reading that changes the least.
* **That `any` counts as a range, not a host.** Its wildcard is all ones, and the guides' sentence names only
  all-zero masks; the capture's `deny any log` stays last. No capture shows a box moving `any` to the top.

## Unresolved, and what would settle it

* **Are the non-host entries sorted further, by mask length?** The guides claim only that all-zero-mask
  entries go above the rest. The capture's ranges are /16, /16, /24, /24, /24 in ascending order — which is
  also their entered order — so "everything else keeps its order" and "the rest is sorted by specificity"
  both fit it. **What would settle it:** a capture of a standard list typed with a /24 *before* a /16, i.e.
  `access-list 10 permit 10.1.2.0 0.0.0.255` then `access-list 10 permit 10.1.0.0 0.0.255.255`, and the
  printed table.
* **Do the 17.x/NX-OS-class platforms still rewrite?** The paragraph was found in the 12.2SE and 15.2E books
  in hand; no Catalyst 9200/9300 (17.x) book was read for this note, and the 2960-X is an E-train image. The
  console applies the rule to every standard list it holds, which is correct for the images that document it
  and no worse than the old behaviour for any that do not.
* **A host entered with an explicit low sequence.** The capture's hosts were typed last and took the highest
  numbers, so it shows the rewrite overriding the numbering. It does not show whether an explicit `5 permit
  host 10.1.1.1` would also move above a `1 permit 10.0.0.0 0.0.255.255`; the console moves it, on the
  reading that the rewrite is about the mask and not the number.
* **`ip access-list resequence`** is not a command this console has; if it is ever added, it has to run before
  this ordering, and its own ordering effect is a separate question.
