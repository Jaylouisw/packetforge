# `ip address` — the word after the mask, and what a box does with it

**Question (one, narrow).** `ip address <ip> <mask>` is the line that gives a port its address. Does a real
device accept a word *after* the mask, which words, and what happens to the address already on the port when
the word is not one of them?

**Verdict: known, and adopted for the refusal.** The syntax is `ip address ip-address mask [secondary]` — one
optional word, `secondary`, and nothing else. `secondary` adds a second address to the same interface and
leaves the primary where it was; any other word is a parse error. This console used to drop the word and apply
the address anyway, which made `... secondary` a *replacement* of the primary reported as `IP address set`.
It now refuses `secondary` by name (one address per port is all this model has) and refuses every other word
with the word quoted, changing nothing in either case.

## The evidence

Cisco's `ip address` command reference gives the syntax and the meaning of the keyword:

> `ip address ip-address mask [secondary]`
> `secondary` — (Optional) Specifies that the configured address is a secondary IP address. If this keyword is
> omitted, the configured address is the primary IP address. … An interface can have one primary IP address and
> multiple secondary IP addresses.
>
> — https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/ip_address.htm

The same page's worked example is the part that decides the behaviour this console got wrong: the primary stays
on the interface when `secondary` lines are added beside it.

```
interface ethernet 0
ip address 131.108.1.27 255.255.255.0
ip address 192.31.7.17 255.255.255.0 secondary
ip address 192.31.8.17 255.255.255.0 secondary
```

"…131.108.1.27 is the primary address and 192.31.7.17 and 192.31.8.17 are secondary addresses for Ethernet
interface 0". Two addresses on one port, the first still primary — so a console that replaced the primary on a
`secondary` line made a change a box does not make, and reported success.

The parse error for a word the command does not take is the CLI's generic one, defined in Cisco's CLI chapter's
table of messages: `% Invalid input detected at '^' marker.` — "You entered the command incorrectly. The caret
(^) marks the point of the error", with the caret printed under the token (§ *Using the Command-Line Interface*,
https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/configuration/xe-16-6/fundamentals-xe-16-6-book/cf-cli-basics.pdf).
`primary` is not a keyword: the syntax has `secondary` or nothing.

## What this model does, and why

| Typed | Before | Now |
|---|---|---|
| `ip address 10.0.0.2 255.255.255.0 secondary` (10.0.0.1/24 already on the port) | replaces the primary with 10.0.0.2/24, says `IP address set` | `% ip address <ip> <mask> secondary adds a second address to this port, which this console does not model: one address per port, and the address was not changed` |
| `ip address 10.0.0.9 255.255.255.0 nonsense` | sets 10.0.0.9/24, says nothing about `nonsense` | `% ip address takes an address and a mask, and then only "secondary": the word "nonsense" was not used, and the address was not changed` |
| `ip address 10.0.0.9 255.255.255.0 primary` | sets the address, swallows `primary` | the same refusal, quoting `primary` |
| `ip address dhcp 5` | becomes a DHCP client, swallows `5` | `% ip address dhcp takes no argument: …` |
| `no ip address foo` | removes the address, swallows `foo` | `% no ip address takes no argument: it removes the address this port holds (the word "foo" was not used, and nothing was removed)` |

The port holds one address here: the front panel, `show ip interface brief` and `show running-config` all print
that single address, and the routing and ARP code reads `iface.ip` / `iface.mask`, not a list. Honouring
`secondary` would mean a second address on the interface, a second connected route, a source-address choice per
packet, and a `secondary` keyword in the config round-trip — a feature, not a fidelity fix, and not one this
change is allowed to smuggle in. Refusing the keyword by name is the honest answer: it tells the reader the
console does not do it, and it says the address they already had is still there.

## What is inferred rather than witnessed

- **The caret line is not modelled.** A box prints `% Invalid input detected at '^' marker.` *and* a line above
  it with the `^` under the offending token; this console prints one sentence that quotes the word instead.
  Every other refusal here is one sentence for the same reason (`research/parse-error-caret.md`), and quoting the
  word does the job the caret does: it names the token the parser could not read.
- **Whether a box accepts a 4th word after `secondary`** (`… secondary vrf RED`, the VRF form in the Catalyst
  9300 reference) is not modelled: VRF is not modelled, so there is no answer to give. That form is refused as an
  unknown word today; if VRF ever arrives, this is the line that changes with it.
- **Whether `no ip address <address> <mask> secondary` removes only that secondary** is stated by the command
  reference's `no` form but not shown in any transcript in hand. It cannot be exercised here while the model holds
  one address per port, so it is left alone rather than guessed.

## What would settle the rest

A capture from a box with a primary and one secondary address, showing (a) `show running-config` printing both
lines with `secondary` on the second, and (b) `show ip interface` listing both addresses under the interface's
own block. That would also be the specification for secondary addressing as a feature, if it is ever built —
this note is the evidence that the refusal above is correct in the meantime.
