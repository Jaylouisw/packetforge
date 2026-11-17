# How `show running-config` prints a lease: only the fields it needs

**Question (one, narrow).** A DHCP pool's lease is stored as a duration, and the command that sets it takes three
optional fields — `lease {days [hours [minutes]] | infinite}`. When the box prints the pool back, does it print all
three fields (`lease 0 12 0`), or only the ones the duration needs (`lease 0 12`)?

**Verdict: trailing zero fields are dropped.** A twelve-hour lease reads back as `lease 0 12`, a one-day lease as
`lease 1`, and a one-minute lease as `lease 0 0 1` — the leading zeros stay because a later field cannot be printed
without them, and the trailing ones go because they are optional in the syntax. The console printed
`lease <days> <hours> <minutes>` unconditionally, so a twelve-hour pool was saved as `lease 0 12 0`, a line no box
produces.

## What a box prints

| Source | The line | What it settles |
| --- | --- | --- |
| Cisco Community, *C9500 ip dhcp conflict issue* — the original poster's "all run config" and a pool example (<https://community.cisco.com/t5/cisco-catalyst-center/c9500-ip-dhcp-conflict-issue/td-p/5236626>) | `ip dhcp pool XYZ` / `network 10.10.10.0 255.255.255.0` / `domain-name domain.com` / `default-router 10.10.10.1` / `dns-server 192.168.55` / `lease 0 12` / `ip dhcp conflict resolution interval 5` | A **twelve-hour** lease is printed as two fields. No `0` for minutes. |
| Cisco, *Troubleshoot DHCP in Enterprise Networks* (<https://www.cisco.com/c/en/us/support/docs/ip/dynamic-address-allocation-resolution/27470-100.html>) | `lease 0 0 1` then `!--- Lease time.` in a pasted configuration | A **one-minute** lease keeps both leading zeros: minutes cannot stand alone. |
| Cisco, *IP Addressing: DHCP Configuration Guide 12.4*, Example Verifying DHCP Accounting (<https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_dhcp/configuration/12-4/dhcp-12-4-book/config-dhcp-accounting-security.html>) | `ip dhcp pool name1` / `network 10.0.0.0 255.255.255.0` / `lease 0 0 20` / `update arp` | A **twenty-minute** lease, same shape: three fields, because the last one is non-zero. |
| Cisco, *DHCP Client* configuration guide, Example: Configuring the DHCP Client (<http://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_dhcp/configuration/15-s/dhcp-15-s-book/config-dhcp-client.pdf>) | `ip dhcp pool 1` / `network 10.1.1.0 255.255.255.0` / `lease 1 6` | Days **and hours** with no minutes field: the trailing minutes zero is dropped even when two fields are needed. |
| Cisco IOS IP Addressing Services Command Reference, `lease` (<https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-l1.html>) and the Catalyst 3850 XE 3SE equivalent (<https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-xe-3se-3850-cr-book/ipaddr-xe-3se-3850-cr-book_chapter_01.pdf>) | "The following example shows a 1-day lease: `lease 1` … a 1-hour lease: `lease 0 1` … a 1-minute lease: `lease 0 0 1`" | The three canonical single-unit forms. `lease 0 1` is the hours-only shape the 12-hour capture above generalises. |

Two independent facts fall out of the set: the minutes field is absent when it is zero (`lease 0 12`, `lease 1 6`),
and the hours field is present even when it is zero if the minutes field is not (`lease 0 0 1`, `lease 0 0 20`).
That is exactly "drop trailing zero components, keep the leading ones".

## What is inferred rather than read

* **A one-day lease prints `lease 1`, not `lease 1 0 0`.** No running-config paste in hand shows a days-only lease;
  the evidence is the command reference's own canonical example (`lease 1` for a 1-day lease) plus the trimming rule
  the two captures above establish. The console prints `lease 1` for 86400 s.
* **IOS stores a duration, not the typed text.** The captures are consistent with re-rendering from a duration (the
  same 12-hour pool would print identically whether it was typed as `lease 0 12` or as `lease 0 12 0`), and that is
  how this engine stores it too, so the printer is the only thing that changes.

## What changed

`engine/cli.js`, the running-config DHCP-pool printer: the days/hours/minutes triple is trimmed from the right before
it is printed, so 86400 s → `lease 1`, 43200 s → `lease 0 12`, 1200 s → `lease 0 0 20`. A sub-minute duration — which
no `lease` command can express and only a hand-edited lab file can hold — keeps the old three-field form rather than
printing a bare `lease 0`, which no box accepts and which would not survive a replay. `test/dhcp-lease-config-form.test.js`
pins the three shapes and the round trip; `test/config-roundtrip.test.js` no longer looks for `lease 0 12 0`.

Nothing else moved: the command still accepts all three fields, `lease 0` is still refused as a zero-length lease, and
`show ip dhcp pool` still carries no lease field at all (it is IOS's usage view).

## What remains unresolved

* **Whether hours can be printed without days.** `lease 0 1` shows the zero that holds the minutes' place; whether a
  box would ever print `lease 12` for twelve hours (i.e. treat the first number as hours) is not something any
  reference read here suggests, and this model keeps the position-based reading the syntax states: "A days value must
  be supplied before you can configure an hours value."
* **Platforms with a different printer.** The Cisco Business 250/350/1300 CLI guides document the same three optional
  fields but print only command-entry examples, and NX-OS/ASA keep the lease elsewhere; none of them was checked for
  a running-config form, and none is in the catalogue as an IOS-style DHCP server.
