# How `show access-lists` spells a standard entry's address

**Question (one, narrow).** On a standard IPv4 access list, how does a box print the source address on a
`show access-lists` line — the address and wildcard as they were typed (`permit 10.0.0.0 0.0.0.255`), a
comma with the words `wildcard bits`, or the `host`/`any` keywords — and does the extended form spell it
the same way?

**Verdict: settled, and corrected for the standard form.** A standard entry prints `<address>, wildcard
bits <wildcard>`, a single-host entry prints the bare address with **no** `host` keyword, and `any` prints
as `any`. The console echoed the typed line instead, so a rule read `permit 192.168.1.0 0.0.0.255` and
`deny host 10.0.1.10` where a box prints `permit 192.168.1.0, wildcard bits 0.0.0.255` and
`deny 10.0.1.10`. The extended form is different and was left alone; see below.

## What a box does

| Source | Says |
| --- | --- |
| [Cisco, *Configure IP Access Lists* (Doc 23602)](https://www.cisco.com/c/en/us/support/docs/security/ios-firewall/23602-confaccesslists.html) | `25 deny any`, `30 permit 172.16.1.11` (a host, bare), and — twice — `15 permit 10.10.10.0, wildcard bits 0.0.0.255`. |
| [Catalyst 2960 12.2(44)SE Command Reference, `show access-lists`](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_44_se/command/reference/cr/cli2.pdf) | `Standard IP access list 1` / `10 permit 1.1.1.1` / `20 permit 2.2.2.2` / `30 permit any` — hosts as bare addresses, `any` as `any`. |
| [Catalyst 2960-L 15.2(5)E, *Configuring IPv4 ACLs*](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960l/software/15-2_5_e/config-guide/b_1525e_consolidated_2960l_cg/b_1525e_consolidated_2960l_cg_chapter_0110010.pdf) | `100 permit 10.4.4.0, wildcard bits 0.0.0.255`, `15 permit 10.5.5.0, wildcard bits 0.0.0.255` (`show ip access-lists kmd1`). |
| [Catalyst 9300 17.16, *IPv4 ACLs*](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-16/configuration_guide/sec/b_1716_sec_9300_cg/configuring_ipv4_acls.pdf) | `Standard IP access list 6` / `10 permit 172.20.128.64, wildcard bits 0.0.0.31` — the form survives into IOS XE 17.x. |
| ntc-templates real captures, [`show_access-list.raw`](https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/cisco_ios/show_access-list/cisco_ios_show_access-list.raw) | `Standard IP access list 1`: `10 permit 10.1.2.3 log`, `30 deny   192.168.1.0, wildcard bits 0.0.0.255`, `40 deny   any log`. |
| ntc-templates [`show_ip_access-lists.raw`](https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/cisco_ios/show_ip_access-lists/cisco_ios_show_ip-access-lists.raw) | `10 permit 172.16.191.199`, `20 deny   any log`, `30 permit 10.0.10.0, wildcard bits 0.255.0.255 (20 matches)`. |

The counter is the one piece already modelled: it still sits after the body, as the last capture shows.

## The extended form is not this form

The same captures print extended entries as `<protocol> <source> <destination>` with `host` kept and the
wildcard written beside the address with **no** comma or words:

```
Extended IP access list 101
    10 permit tcp any host 10.1.1.1 eq www
    20 permit tcp any host 10.1.1.1 eq 443 log
    90 permit ip 54.48.253.0 0.0.0.31 any
```

(`show_ip_access-lists.raw`, `show_access-list3.raw`.) Since this console accepts only the forms the user
types, an extended line was already printed in that spelling, so nothing there changed.

## What was changed

`engine/acl.js` grew `displayBody(entry)`: the body of a **standard** entry as a box writes it — `any` for
an `any` spec, the bare address when the wildcard is `0.0.0.0` (whether `host` was typed or not), otherwise
`<address>, wildcard bits <wildcard>`, with ` log` when the entry carries it. It returns `null` for a line
it does not speak for (an extended entry, or one with no parsed source), and `engine/cli.js` then keeps
printing the typed text exactly as before. The sequence number, its four-column indent, the counter keyed
by the typed line and `show running-config` (which still echoes `access-list 10 permit 192.168.1.0
0.0.0.255`) are untouched. `test/show-access-lists-standard-address-form.test.js` (17 checks) pins the
comma form, the dropped `host`, `any`, `log`, an all-zero wildcard, a hand-typed sequence, the counter on
the printed line, the `show ip access-lists` alias, the unchanged running-config, the untouched extended
line and the renderer's refusal. `test/acl-data.test.js` asserted the old typed form (`deny host ...`) and
now asserts the vendor's.

## What is inferred

* That a wildcard of `0.0.0.0` is printed as the bare address even when it was typed as `<addr> 0.0.0.0`.
  Every capture with a host was most likely typed with `host`, and they all print the bare address; the
  two are the same object to IOS, and this model's parser already treats them as the same match.
* That the counter is appended after `log` rather than before it. Two captures show a count on a line with
  no `log` (`show_access-list3.raw`, `show_ip_access-lists.raw`) but none pairs the two.

## What remains unresolved

* **Whether `permit`/`deny` is padded on a standard line.** The captures disagree (`20 deny   any log` with
  three spaces, `30 deny   192.168.1.0, ...` with three, `10 deny 171.69.198.102` with one); this was
  already recorded in [show-access-lists-numbering.md](show-access-lists-numbering.md) and is unchanged.
* ~~**Whether `0.0.0.0 255.255.255.255` typed on a standard line prints as `any`.**~~ **Settled:** it does, and
  the renderer now folds it — [show-access-lists-any-wildcard.md](show-access-lists-any-wildcard.md).
* **Whether an extended line normalises a host typed as `<addr> 0.0.0.0` to `host <addr>`.** No capture in
  hand was typed that way, so extended lines keep the typed text.
* **`log-input`, `time-range`, `established`, port ranges and named ACLs.** This console has none of them;
  a box's rendering of those tails is not needed until the commands exist.
