# `no ip name-server <address>`: does it remove that server, or clear the list?

**Question (one, narrow).** `ip name-server` prints up to six addresses on one line. When the operator types
`no ip name-server 8.8.8.8` on a box holding `1.1.1.1` and `8.8.8.8`, does a real IOS-like device remove the one
address named and keep the other — or does the no-form clear the whole resolver list? And which did PacketForge
do?

**Verdict: the no-form names the addresses it removes, and PacketForge cleared every resolver instead.** Three
Cisco documents give the no-form an address argument and describe removal per address; an Oracle procedure on a
Cisco 4948 removes three configured servers with three separate one-address lines and says so in as many words.
PacketForge's branch read none of the words: `no ip name-server 8.8.8.8` dropped `1.1.1.1` too, and a word that
was not an address did the same. The engine now removes exactly the addresses named, refuses a line that names an
address the box does not hold, and keeps the bare form as a whole-list clear.

The defect was already written down in `docs/CLI.md` ("A per-address removal is the fix, and until it lands this
page records what the console does rather than what its index says"), so this increment closes a recorded hole,
not a new feature.

## What PacketForge did (before)

`ISR 4331`, nothing configured:

```
r1(config)#ip name-server 1.1.1.1
Name server 1.1.1.1
r1(config)#ip name-server 8.8.8.8
Name server 8.8.8.8
r1(config)#no ip name-server 8.8.8.8
Name servers cleared
r1(config)#do show running-config
! PacketForge running-config
hostname r1
...
```

The `1.1.1.1` line a backup had carried was gone, and the receipt said the list had been cleared — which was
true, and was the bug. The console's own help index already described the form as `no ip name-server <address>`
"removes a name server", so the index and the branch disagreed.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco IOS IP Addressing Services Command Reference — `ip name-server`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-i3.html) | Both forms take the addresses: `ip name-server [vrf vrf-name] server-address1 [server-address2...server-address6]` and `no ip name-server [vrf vrf-name] server-address1 [server-address2...server-address6]`, and the prose is "**To remove the addresses specified, use the no form of this command**". A no-form that took no addresses would not need to say which ones. |
| [Catalyst 3750-X and 3560-X Switch Software Configuration Guide, 15.0(2)SE — Administering the Switch](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3750x_3560x/software/release/15-0_2_se/configuration/guide/3750x_cg/swadmin.html) | Singular, one address: "To remove a name server address, use the **no ip name-server** *server-address* global configuration command." |
| [Software Configuration Guide, Cisco IOS Release 15.2(2)E (IE 3010) — Administering the Switch](https://www.cisco.com/c/en/us/td/docs/switches/lan/cisco_ie3010/software/release/15-2_2_e/configuration/guide/SwCfg/swadmin.html) | The same sentence on a second switch family: "To remove a name server address, use the **no ip name-server** *server-address* global configuration command." |
| [Oracle Exadata — Change the DNS Server Address on the Cisco 9300 Series Management Network Switch](https://docs.oracle.com/en/engineered-systems/exadata-database-machine/dbmmn/change-dns-server-address-cisco-93xx-switch.html) | `show running-config` prints three servers on **one** line (`ip name-server 192.0.2.2 198.51.100.4 203.0.113.2`); the procedure then issues three separate one-address `no ip name-server <address>` commands and notes "**Each current DNS IP address to be changed needs to be erased.**" Removing one address leaves the other two in place. |
| [Oracle Exadata — Change the DNS Server Address on the Cisco 4948 Ethernet Switch](https://docs.oracle.com/en/engineered-systems/exadata-database-machine/dbmmn/change-dns-server-address-cisco-4948-ethernet-switch.html) | Same shape on a 4948, same note; the three removals are three commands, not one. |
| [Cisco Business 250/350 Series CLI Guide — DNS Client Commands](http://www.cisco.com/c/en/us/td/docs/switches/lan/csbms/CBS_250_350/CLI/cbs-250-cli/dns-client-commands.html) | A different platform family, recorded because it disagrees where it always does: `no ip name-server [server-address1...server-address8]` — the brackets make the bare clear legal — and "Each ip name-server command replaces the configuration defined by the previous one". Eight servers, not six. Its parentheses are the basis for keeping this console's bare form, not for the per-address form every IOS document above describes. |

## What is known

- The no-form takes one to six addresses, the same grammar as the positive form, and its documented purpose is
  "to remove the addresses specified". Two switch configuration guides state the removal in the singular, one
  address per command.
- A deployment procedure on two Cisco switch families removes three configured servers with three separate
  one-address commands and keeps the survivors — which is what per-address removal means in practice.
- The same procedure prints the three remaining servers on one `show running-config` line, so the printer's
  grouping (one line, space-separated) is corroborated by a capture-shaped example. This increment does not
  change the printer: an earlier note left the grouping open, and it is a different question
  (`research/ip-name-server-list.md`, item 3).

## What is inferred

- **The bare `no ip name-server` clears the list.** The IOS no-form's syntax has `server-address1` as required,
  so a bare line might be `% Incomplete command.` on IOS proper; the small-business guides make the address
  optional in brackets and this console has always accepted the bare clear. Keeping it is a house decision,
  recorded rather than quoted, and it now only claims to clear when a list exists.
- **An address that is not on the list refuses the line and changes nothing.** No vendor sentence covers this.
  Removing the addresses it could find and silently ignoring the rest would make the result depend on which words
  the parser reached, and a half-applied `no` line is the defect class this console keeps closing. The sentence
  (`% Not a name server: <addresses> - nothing was removed`) is this console's own.
- **An address removed individually prints a receipt.** IOS configuration commands are silent; this console
  prints a line for each change, and the positive form already prints `Name server <address>` per address, so the
  no-form prints `Name server <address> removed` in the same order.
- **A repeated address on one line is removed once.** Deduplicating is the only reading of "the addresses
  specified" that does not print two receipts for one change.

## What is unresolved

1. **The exact vendor text for an address that is not configured.** No transcript. A live IOS would probably
   accept the line and print nothing (the address is simply not there), which is the opposite of this console's
   refusal — but "probably" is not evidence, and silence about a removal that did not happen is the failure mode
   the refusal exists to prevent.
2. **Whether IOS proper accepts a bare `no ip name-server`.** The IOS command reference shows the address as
   required; the small-business books show it optional. No capture of the bare form on an IOS router or Catalyst
   was found.

## What would settle it

- A console capture of `no ip name-server 4.4.4.4` on a box holding `1.1.1.1` and `8.8.8.8`: the `%` line (if
  any) and the following `show running-config` settle both the refusal wording and whether IOS is atomic.
- A capture of a bare `no ip name-server` on an IOS router, to decide whether the whole-list clear this console
  keeps is a form the platform has at all.

## What changed

`engine/cli.js`, the `no ip name-server` branch: an address argument is validated with `net.isIp`; every named
address must be on the list or the line refuses whole; matching addresses are removed in place (the survivors
keep their order); one `Name server <address> removed` receipt per address in typed order; and the bare form
clears the list only when there is a list — an empty box now answers `% No name servers configured` instead of
claiming a clear. The help index already said `no ip name-server <address>`; it is now true.

`test/no-ip-name-server-removal.test.js` (24 assertions): one address removed leaves the others in order and in
place; the primary's removal promotes the next server in `show ip dns`; a repeat removal refuses and changes
nothing; a line naming one absent address refuses whole; a non-address word is a parse error, not a wipe; several
addresses on one line remove several (with one receipt for a repeat); the bare form clears a populated list and
refuses an empty one; `show running-config` carries exactly the survivors; add-remove round-trips byte for byte.

`docs/CLI.md` now states the per-address behaviour and shows the new receipt where it used to record the hole.
