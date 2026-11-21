# The column the action sits in on a `show access-lists` line

**Question (one, narrow).** On the line under a list's heading, how many columns does the action word
occupy — is `deny` followed by one space like `permit`, or is it padded so the address starts in the same
column on every line of the list?

**Verdict: settled for standard lists, and corrected.** A standard ACE prints with a **seven-column action
field**: `permit` plus one space (`permit `), `deny` plus three (`deny   `). An extended ACE is not padded —
`deny ip`, one space. The console printed one space after either action, so every standard line that denied
anything had its address one column to the left of the permits above and below it.

## What PacketForge did before this change

Measured on this branch's parent with the ASR 1001-X and the four entries below:

```
Standard IP access list 1
    10 permit 10.1.2.3 log
    20 deny 10.1.1.1
    30 deny 192.168.1.0, wildcard bits 0.0.0.255
    40 deny any log
```

The address column reads 11 for the permit and 11 for the denies as well, because every line is `action`,
one space, source. On a box the denies' addresses line up with the permit's address one column further
right, which is what the seven-column field is for.

## Evidence

The decisive sample is a typeset certification chapter that prints a standard list and an extended list on
the same page, so the two spellings cannot be an artefact of one page's HTML or one PDF's font:

| Source | Prints |
| --- | --- |
| [Cisco Press sample chapter, *CCNA/CCNP ACL* material (PDF, Pearson)](https://www.pearsonhighered.com/assets/samplechapter/1/5/8/7/158713201X.pdf) | p. 525: `10 deny   192.168.11.0, wildcard bits 0.0.0.255 log (5 matches)` under `Standard IP access list STND-1`, and p. 597: `10 deny ip 192.168.10.0 0.0.0.255 host 209.165.200.225 (4 matches)` under an extended list. Same book, three spaces in the standard line, one in the extended. |
| [ntc-templates raw capture, `cisco_ios_show_access-list.raw`](https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/cisco_ios/show_access-list/cisco_ios_show_access-list.raw) | A machine-recorded session (read with `cat -A`): `10 permit 10.1.2.3 log`, `20 deny   10.1.1.1`, `30 deny   192.168.1.0, wildcard bits 0.0.0.255`, `40 deny   any log` — and, in the same file, `20 deny ip any any` for an extended list. The file itself draws the line between the two kinds, which rules out "the paste lost its spaces". |
| [ntc-templates `cisco_ios_show_ip_access-lists.raw`](https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/cisco_ios/show_ip_access-lists/cisco_ios_show_ip_access-lists.raw) | `Standard IP access list 99` / `20 deny   any log`, the same field width on the alias command. |
| [NetAcad CCNAv6 ACL deck (PDF), Brno FIT mirror](https://netacad.fit.vutbr.cz/wp-content/uploads/ccna/ccna4/ppt/CNv6_4_ACL.pdf) | Slide `10 deny   10.1.1.0, wildcard bits 0.0.0.255` — three spaces in the extracted text layer. |
| [VTSU CIS 3210 ACL handout (PDF)](https://www.pchapin.org/VTSU/cis-3210/Slides/ACLs.pdf) | `10 deny   192.168.11.10`, `15 deny   192.168.11.11`, `20 permit 192.168.11.0, wildcard bits 0.0.0.255` — the padded denies over an unpadded permit, on several slides. |
| [Cisco IE 4010/5000 config guide, "Network Security with ACLs" (PDF)](https://cisco.com/c/en/us/td/docs/switches/lan/cisco_ie4010/software/release/15-2_4_EC/configuration/guide/scg-ie4010_5000/swacl.pdf) | The `show access-lists` example prints `10 deny   171.69.198.102` above `20 permit any`. |

The single-space examples are all HTML pages, where a browser collapses a run of spaces before anyone reads
it: Cisco's [Configure IP Access Lists](https://cisco.com/c/en/us/support/docs/security/ios-firewall/23602-confaccesslists.html)
(`25 deny any`) and the ME 3600X configuration chapter (`10 deny 171.69.198.102`). Neither contradicts the
PDF and raw-text sources; they simply cannot show the difference.

## What is inferred

* That the field is **seven columns** rather than "pad to the longest action in this list". Every sample has
  both actions present, so a per-list rule and a fixed rule produce identical output; the fixed field is the
  simpler statement and the one that also explains a list whose entries are all `deny`.
* That the padding is **inside** the field — `deny` then spaces — and not a tab or a second separator before
  the source. `cat -A` shows plain spaces in the raw capture.
* That a **standard** line is a different printer from an **extended** one on the box, which is why one pads
  and the other does not. IOS's standard entries are re-rendered from the stored ACE (the console already
  reproduces that: `host` dropped, `, wildcard bits` added), while extended entries echo the parsed line; a
  fixed-width action field belongs to the re-rendered form.

## What remains unresolved

* **One line in one ntc fixture disagrees.** `cisco_ios_show_ip_access-lists_969.raw`, a later variant of the
  file above, adds `20 deny 10.1.1.2 (1 match)` to `Standard IP access list stdacl` with a single space —
  while the same file's list 99 still reads `20 deny   any log`. Two lines of the same file cannot both be a
  box's output, so one was edited; the file is parser test data, not a pristine capture, and the `_fixed`
  variant beside it shows the family has been hand-corrected. The balance of sources (a typeset book, a
  second raw session, two course PDFs, a vendor guide) pads, so the console pads.
* **Older IOS.** An 11.x-era command reference prints no sequence numbers and no indent at all. This console
  has modelled the modern table since the numbering change (research/show-access-lists-numbering.md), so the
  old form stays out of scope.
* **`match(es)`.** One handout prints `(4 match(es))`, an older plural. The console prints `(1 match)` /
  `(N matches)`; no capture of the exact release that used `match(es)` was found, and it is a separate
  question from this one.

## What evidence would settle the residue

1. One `show access-lists` paste from a box that also prints its IOS version, with a standard entry that
   denies a host and a permit above it — 4 lines decide the width for that release.
2. The same for an IOS XE 17.x box, to say whether the field survived into the current releases; the
   seven-column form is documented here for 12.2/15.x-era material, which is the baseline this console
   already follows for `show vlan brief`.

## What changed

`displayBody()` in `engine/acl.js` now pads the action to `STANDARD_ACTION_WIDTH` (7) before the source, so
`deny` gains three spaces and `permit` keeps one. Extended entries are untouched — `displayBody()` still
returns null for them and the printer keeps the typed line, whose action is followed by one space.
`test/show-access-lists-action-column.test.js` (15 checks) pins the renderer's two widths, the identical
address column, a four-line standard list taken from the Cisco Press page, an extended list that must *not*
pad, the `show ip access-lists` alias, and the running-config still echoing `deny host 10.1.1.1` without the
display padding. Three existing suites had their expected strings widened to match
(`show-access-lists-standard-address-form`, `standard-ace-host-order`, `acl-data`).
