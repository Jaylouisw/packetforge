# `ip name-server`: how many addresses does one line carry, and whose order wins?

**Question (one, narrow).** The vendor syntax is `ip name-server server-address1 [server-address2 ...
server-address6]`. When an operator types two or more addresses on one line, does a real IOS-like box store
them all, in the order typed — or only the first? And what happens at the limit?

**Verdict: all of them, in the order typed, up to six on the line and six on the box.** Both are stated in
the vendor's own words, and the order is the preference order: "the first server specified is the primary
server". PacketForge stored `tokens[2]` and nothing else, so the documented two-address form configured the
primary and then **silently discarded the rest of the line** — a configuration command that lost half of
itself without a refusal, the same defect class as `speed 100 full` dropping the word after the value
(#2004). It now appends every address named, in typed order, and refuses a line that would break either six.

## What PacketForge did before this

`ISR 4331`, nothing configured:

```
r1(config)#ip name-server 172.16.1.111 172.16.1.2
Name server 172.16.1.111                 <- receipt reads as if the whole line was taken
r1#show ip dns
Name servers this device asks: 172.16.1.111
```

The second address was gone, and nothing said so. The model already held a list (`config.dnsServers`) and
already walked it in order — `_domainServersFor()` sends the query to the first entry, then the next, and
`show ip dns` prints them in that order — so the list semantics were right and only the command that fills
it was truncating.

## Evidence

| Source | Says |
| --- | --- |
| [IP Addressing Configuration Guide, Cisco IOS XE 17.x — *Configuring DNS*](https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/ip-addressing/b-ip-addressing/m_configuring_dns.html) | Step 5 is `ip name-server server-address1 [server-address2 ... server-address6]`, described as "Specifies one or more hosts (up to six) that can function as a name server to supply name information for DNS", with the worked example `Device(config)# ip name-server 172.16.1.111 172.16.1.2`. The same page's `show running-config` sample prints both addresses on **one** line: `ip name-server 192.168.1.111 192.168.1.2`. |
| [Cisco IOS IP Addressing Services Command Reference — `ip name-server`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-i3.html) | Syntax and the parameter table: `server-address2...server-address6` — "(Optional) IP addresses of additional name servers (**a maximum of six name servers**)". The no-form takes the same address list: "To remove the addresses specified, use the **no** form of this command." |
| [Cisco IOS Software Configuration Guide for Aironet Access Points 15.3(3)JB (PDF)](https://www.cisco.com/c/en/us/td/docs/wireless/access_point/15-3-3-JB/configuration/guide/cg_book.pdf) | The ordering rule in words: "You can specify up to six name servers. Separate each server address with a space. **The first server specified is the primary server.** The wireless device sends DNS queries to the primary server first. If that query fails, the backup servers are queried." |
| [Cisco IOS IPv6 Command Reference — `ip name-server`](http://www.cisco.com/c/en/us/td/docs/ios/ipv6/command/reference/ipv6_book/ipv6_05.html) | The same six-slot syntax in the IPv6 book, so the shape is the command's, not one address family's. |
| [Cisco IOS fundamentals guide, TIPs conversion (PDF)](https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/configuration/guide/TIPs_Conversion/lmsi_15_1s_book.pdf) | A startup-config sample that shows the other rendering: two separate `ip name-server` lines, one address each. Vendor examples disagree on how the *printer* groups the list (see below). |

## What is known

- One `ip name-server` line takes one to six addresses, space separated. Three Cisco documents (IOS XE 17.x
  DNS configuration guide, the IP Addressing Services command reference, the Aironet configuration guide)
  give the same range and say "up to six".
- The order typed is the order asked: the first address is the primary. This is the reason the console's
  receipts are emitted in typed order and the reason the model appends rather than sorts.
- Six is a property of the **box**, not of one line: the parameter table says "a maximum of six name
  servers", not "six per command".
- The whole line is parsed before it executes, as every IOS configuration line is. A line with one bad word
  configures nothing — PacketForge now checks every word before storing any, so `ip name-server 10.0.0.9
  flurbish` leaves the list untouched instead of storing `10.0.0.9`.

## What is inferred

- **A seventh address is refused, not truncated.** The grammar has six slots, so a seventh word is a parse
  error. PacketForge says so in its own sentence ("takes at most six addresses on one line … nothing was
  configured") rather than quoting IOS, because the vendor's exact wording for that case is not in hand.
  Truncating silently would have been the worse choice: it is the same class of lie the old code told.
- **A seventh server across several lines is refused too.** The limit is the box's six, per the parameter
  table. What a live IOS does here — refuse the line, ignore it, or replace the oldest entry — is *not*
  documented in anything read for this note. The console refuses and says how many are already configured,
  which cannot be mistaken for success; see below for what would settle it.
- **Retyping an address already configured is not a second server.** It cannot push the box past six. This
  follows from "six servers", not from any transcript; the receipt ("Name server <ip>") is unchanged, as it
  was before this increment.

## What is unresolved

1. **The wording when a line names more than six addresses.** No transcript. IOS would print `% Invalid
   input detected at '^' marker.` if the seventh word simply fails to parse — plausible, unverified. The
   console's own refusal is honest, not a quote.
2. **Whether a second `ip name-server` line appends or replaces.** IOS proper accumulates: the fundamentals
   guide's startup-config sample shows several one-address lines, and the command reference's no-form takes
   addresses to remove, which only makes sense for a set. But the *Cisco Business* 250/350 CLI guides say
   the opposite in as many words — "Each `ip name-server` command replaces the configuration defined by the
   previous one (if one existed)" — and they allow eight servers, not six. Those are a different platform
   family (small-business switches) from the IOS routers modelled here, so PacketForge keeps IOS's
   accumulate behaviour; the contradiction is recorded rather than hidden.
3. **How `show running-config` groups the list.** One line with up to six addresses (IOS XE DNS guide) or
   one line per address (fundamentals guide's startup-config sample)? An Oracle Exadata procedure on a Cisco
   9300 prints three configured servers on one line — `ip name-server 192.0.2.2 198.51.100.4 203.0.113.2` —
   which is the strongest evidence found so far for the one-line grouping
   (https://docs.oracle.com/en/engineered-systems/exadata-database-machine/dbmmn/change-dns-server-address-cisco-93xx-switch.html),
   but this increment does not touch the printer: it still prints one line per address, which replays correctly
   into the console because a one-address line is always valid.

**One question from an earlier list is settled since this note was written:** whether `no ip name-server
<address>` removes one address or clears the list. The no-form names the addresses it removes — the command
reference's `server-address1 [server-address2...server-address6]` plus "To remove the addresses specified", the
3560-X and IE 3010 guides' singular sentence, and an Oracle procedure on two Cisco switch families that removes
three servers with three separate one-address commands. PacketForge used to clear the whole list; it now removes
exactly the addresses named. `research/no-ip-name-server-removal.md` carries the sources and the implementation.

## What would settle it

- A console capture (or a Packet Tracer / CML transcript) of `ip name-server` with seven addresses on one
  line, and of a seventh `ip name-server` line when six are already configured — two sentences, two answers.
- A `show running-config` from a router with three or more configured servers, to fix the printer's grouping.
- A capture of `no ip name-server 10.0.0.1` on a box holding three servers, then `show ip dns`, to settle
  selective removal (item 4).

## What changed

`engine/cli.js`, the `ip name-server` branch: every address on the line is validated before anything is
stored, all of them are appended in typed order, an address already present is not counted twice, and a
line that would exceed six — on the line or on the box — is refused with nothing configured. Receipts are
one `Name server <ip>` line per address, as before.

`test/ip-name-server-list.test.js`, 23 assertions: the documented two-address line stores both and prints
two receipts in order; `show ip dns` names them in the order they will be asked; a bad word in a good line
configures neither; six fit and seven do not; two lines of three fill the list and a seventh across lines is
refused with the list untouched; retyping an existing address is accepted and changes nothing; the single
address, the bare command and the out-of-range address behave exactly as before; and `show running-config`
carries all three servers in order.
