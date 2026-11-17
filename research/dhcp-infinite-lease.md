# An unlimited DHCP lease: how it is spelled, and what it reads back as

**Question (one, narrow).** When an operator wants a DHCP pool whose leases never expire, what does an IOS-like box
accept at `(dhcp-config)#`, what does the running configuration print back, and what do the pool and binding views
say about a lease that has no end?

**Verdict: known, and this console knew only half the command.** The vendor states the command with two forms and
names the word: `lease {days [hours [minutes]] | infinite}`, "infinite — Specifies that the duration of the lease is
unlimited". The console parsed the three numbers and nothing else, so the word was refused as
`% Incomplete command: lease <days> [hours] [minutes]` — a diagnosis of a missing argument for a command that had
been typed in full. The word is now a value the pool carries, the config gives the word back, and a lease granted
under it never lapses.

## What is known

The syntax and the meaning of the word, in the vendor's own reference:

> **lease {days [hours [minutes]] | infinite}** … `infinite` — Specifies that the duration of the lease is
> unlimited. … **Command Default** 1 day … **Command Modes** DHCP pool configuration
>
> The following example shows an infinite (unlimited) lease: `lease infinite`

* Cisco IOS IP Addressing Services Command Reference, `lease` —
  https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-l1.html

The same statement, as a configuration step, with the same sentence about the keyword:

> **lease** {*days* [*hours*] [*minutes*] | **infinite**} … • The **infinite** keyword specifies that the duration of
> the lease is unlimited.

* Configuring the Cisco IOS DHCP Server (12.4T) —
  http://www.cisco.com/en/US/docs/ios/12_4t/ip_addr/configuration/guide/htdhcpsv.html

The word is what the box stores, not a number standing in for one: every published running-config that sets an
unlimited lease shows the word inside the pool, e.g.

```
ip dhcp pool POOL_PRINTER
 host 10.1.1.100 255.255.255.0
 client-name printer1
 lease infinite
```

* Cisco network-as-code data model for IOS XE DHCP pools (`lease_infinite`, and the `lease infinite` sample) —
  https://netascode.cisco.com/docs/data_models/iosxe/device/dhcp_pool/

And the word is what a binding table prints in its lease-expiration column for such a lease — `Infinite`, not a date
and not a number of seconds:

```
172.16.3.253 02c7.f800.0422 Infinite Automatic
172.16.3.254 02c7.f800.0422 Infinite Static
```

* Cisco Business 250 Series CLI Guide, DHCP Server Commands (`show ip dhcp binding` samples) —
  https://www.cisco.com/c/en/us/td/docs/switches/lan/csbms/CBS_250_350/CLI/cbs-250-cli/dhcp-server-commands.html
* The static-mapping text file the IOS DHCP server reads has a `Lease expiration` column whose unlimited value is
  the word `Infinite` — Configuring the Cisco IOS DHCP Server, "Static Mapping Text File Field Descriptions", same
  URL as above.

The value on the wire is fixed by the protocol, not by the vendor: "The time value of 0xffffffff is reserved to
represent "infinity"." (RFC 2131 §3.3, https://www.rfc-editor.org/rfc/rfc2131).

## What was wrong here, measured

One session on an `ISR 4331`, before the change:

```
r1(config)#ip dhcp pool lan
r1(dhcp-config)#network 192.168.10.0 255.255.255.0
r1(dhcp-config)#range 192.168.10.100 192.168.10.110
r1(dhcp-config)#lease infinite
% Incomplete command: lease <days> [hours] [minutes]
r1(dhcp-config)#exit
r1(config)#end
r1#show running-config | begin dhcp pool
ip dhcp pool lan
  network 192.168.10.0 255.255.255.0
  range 192.168.10.100 192.168.10.110
exit
r1#show ip dhcp pool lan
  Lease:          86400s
```

Three separate wrong answers from one typed word: the word was refused as an *incomplete* command (it was not
incomplete — it was unknown), the pool silently kept the 1-day default, and the pool view reported `86400s` as if
that were the configured value. An operator who wanted a printer's address pinned for good got a lease that expires
and a message telling them to add a number.

## What was changed

* `engine/dhcp.js` — `leaseSec` may now be the word `infinite`, carried through `normalizePool()` and accepted by
  `validatePool()`; `leaseSeconds()` returns `0xffffffff` for it (RFC 2131 §3.3); `recordLease()` gives such a lease
  `expiresStep = Infinity`, which no run reaches and `expireLeases()` therefore never collects; `leaseTable()`
  reports `remainingSec = Infinity` and the state `active`; a saved document writes the word, because JSON has no
  `Infinity`, and reads it back as `Infinity`.
* `engine/cli.js` — `lease infinite` is accepted in the pool sub-mode (and `lease infinite <n>` is refused, naming
  both forms); the incomplete-command line now advertises the word; `show running-config` prints `lease infinite`;
  `show ip dhcp pool` prints `Lease: Infinite (never expires)`; `show ip dhcp binding` prints `Infinite` in the
  `Expires in` column.
* `engine/simulator.js` — the lease a client is granted is read through `leaseSeconds()`, so the ACK carries
  `0xffffffff` instead of `NaN` (which is what `Number('infinite')` had made of it).
* `test/dhcp-infinite-lease.test.js` pins the acceptance, the read-back, the never-lapsing binding, the one-minute
  control in the same lab, the save/restore round trip and the two refusals.

## What is inferred, not stated

* **The binding-table word at a pool that is not infinite.** The samples that print `Infinite` in the lease-expiration
  column come from static/manual bindings and from a Business-series switch's own table; applying the word to an
  automatically granted lease out of an `infinite` pool follows from the pool's lease policy, not from a transcript of
  that exact combination. The console prints the word for any binding with no end, which is the truthful rendering of
  the fact it holds — it does not claim the row is a manual binding.
* **`show ip dhcp pool`'s wording.** `show ip dhcp pool` on IOS prints utilisation and subnet counters, not a lease
  line; this console's pool view is its own shape, so `Infinite (never expires)` is this console's sentence about a
  vendor fact, not a copy of a vendor cell.

## Unresolved

* **Keyword abbreviation in a sub-mode.** IOS accepts an unambiguous prefix of a keyword (`lease inf`), but this
  console abbreviates *command words* only, at the two positions where it holds a complete table of what may stand
  there (research/command-word-abbreviation.md). `lease infinite` is therefore accepted in full only. Making `lease
  inf` work means deciding the general rule for sub-mode keywords, which is a larger question than this run.
* **`lease 0`, `lease 0 0 0`.** The reference gives `lease 0 1` (one hour) and `lease 0 0 1` (one minute) as examples
  and never says what an all-zero duration means; this console refuses it as "a lease must be longer than zero" and
  keeps doing so. Whether a real box treats all-zeros as infinite (some platforms document a zero lease as infinite;
  none of the IOS references read here says it) is not settled by the sources above.
* **Running-config canonicalisation of the numeric form.** This console prints a 12-hour lease as `lease 0 12 0`. A
  real box commonly shows `lease 0 12` with the trailing zero minutes omitted; the screenshots read for this run do
  not settle which cells it always pads. Left as it was — it is a different question from this one.
