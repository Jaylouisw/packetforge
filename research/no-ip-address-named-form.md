# `no ip address <address> <mask>`: the form that names the address, and the address it refuses

**Question (one, narrow).** `no ip address` removes the address a port holds. IOS's syntax also lets the line
name the address being removed — `no ip address ip-address mask [secondary]`. Does a real box accept that form,
does it remove only when the named address is the one the port holds, and what does it say when it is not?

**Verdict: the form is documented and used, the address is matched, a mismatch removes nothing — and the
mismatch sentence is only half-witnessed.** The syntax block prints the `no` line with the address; a Cisco
defect record's workaround shows an operator typing it on a live SVI; and an operator whose paste named an
address the interface did not hold was answered `Invalid address` and told, in the same thread, that "you need
to match the current ip of the interface". What no source in hand shows is the full sentence around those two
words, or whether the mask has to match as well as the address. PacketForge now accepts the matched form, refuses
a mismatch and changes nothing, and prints the vendor's two words (`% Invalid address:`) followed by this
console's own explanation of what the port actually holds — the inference is labelled in the source and in
`docs/CLI.md`.

## The evidence

| Source | Says |
| --- | --- |
| [Cisco, `ip address` command reference (TAC command index)](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/ip_address.htm) | Syntax, printed as two lines: `ip address ip-address mask [secondary]` and **`no ip address ip-address mask [secondary]`**. "To remove an IP address or disable IP processing, use the **no** form of this command." "You can disable IP processing on a particular interface by removing its IP address with the **no ip address** command." |
| [Cisco defect CSCvr84846 (SVI device-tracking entry), workaround section](https://www.findbugzero.com/operational-defect-database/vendors/cisco/defects/CSCvr84846) | A live 15.x box, captured verbatim: `(config)#int vl11` / `(config-if)#no ip address 192.168.1.100 255.255.255.0` / `(config-if)#ip address 192.168.1.100 255.255.255.0`. The line is typed at an interface that holds exactly that address, the config before it prints `ip address 192.168.1.100 255.255.255.0`, and the re-add immediately after takes effect — so the named removal succeeded. |
| [Spiceworks, "Removal of an IP from a VLAN in a Cisco switch"](https://community.spiceworks.com/t/removal-of-an-ip-from-a-vlan-in-a-cisco-switch/1057490) | `Admin-***(config-if)#no ip address 10.172.1.143 255.255.255.128` answered **`Invalid address`**. The reply: "'no ip address' will remove all IPs configured. If you want to be specific then you need to match the current ip of the interface so if the interface has IP 10.172.1.143 with mask 255.255.255.128 your command 'no ip address 10.172.1.143 255.255.255.128' should work." Two things at once: the mismatch is refused, and the matching form is the one that works. |
| [Catalyst 1300X CLI guide 4.10, IP addressing commands](https://www.cisco.com/c/en/us/td/docs/switches/campus-lan-switches-access/Catalyst-1300x/CLI_Release_4_10_0_xx/c1300x-cli-guide/ip-addressing-commands.html) | A small-business IOS XE family printing the short form: `no ip address` **`[ip-address]`** — the address is optional, which is the same shape from the other side (name it, or name nothing). |
| [Cisco Nexus 5000 NX-OS unicast routing command reference, `ip address`](https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus5000/sw/command/reference/unicast/n5k-ucast-cr/n5k-l3_cmds_i.html) | Not the same OS, but the same syntax pair — `no ip address ip-address mask [secondary]` — which shows the two-line form is the family habit and not one book's typo. |

## What PacketForge did, and what it does now

Measured on the ASR 1001-X in this tree, a port holding `10.0.0.1/24`:

| Typed | Before | Now |
| --- | --- | --- |
| `no ip address 10.0.0.1 255.255.255.0` | `% no ip address takes no argument: it removes the address this port holds (the word "10.0.0.1 255.255.255.0" was not used, and nothing was removed)` | accepted; `IP address 10.0.0.1/24 removed from Te0/0/0`, the port is unassigned and the `ip address` line leaves the running-config |
| `no ip address 10.0.0.1 24` | the same refusal | accepted — the mask is a prefix length, the spelling `ip address` already takes |
| `no ip address 10.0.0.9 255.255.255.0` | the same refusal | `% Invalid address: Te0/0/0 holds 10.0.0.1/24, not 10.0.0.9/24 - nothing was removed` |
| `no ip address 10.0.0.1 255.255.0.0` | the same refusal | `% Invalid address: … holds 10.0.0.1/24, not 10.0.0.1/16 …` |
| `no ip address 10.0.0.1 255.255.255.0` on an unaddressed port | the same refusal | `% Invalid address: Te0/0/0 holds no address, not 10.0.0.1/24 - nothing was removed` |
| `no ip address 10.0.0.1 255.255.255.0 secondary` | the same refusal | `% no ip address <ip> <mask> secondary removes a secondary address, which this console does not model …` |
| `no ip address 10.0.0.1` (no mask) | the same refusal | `% Incomplete command: no ip address <address> <mask> - a named removal needs both` |
| `no ip address foo` | refused, word quoted, "nothing was removed" | unchanged |
| `no ip address` | removes what the port holds, or says there was none | unchanged |

A DHCP client is a separate case: its address is written by the box at run time and never appears as an
`ip address` line, so the named form is refused there with the reason and the flag stays on; the bare
`no ip address` still removes the client.

## Known, inferred, unresolved

**Known.** The `no` form takes the address and the mask (both syntax blocks above). A box accepts that line and
acts on it (the defect workaround). It answers a mismatch with `Invalid address` (the forum paste) and does not
remove the address — the operator was told to match the current IP.

**Inferred.** That the mask is part of the match, not just the address: no transcript shows a correct address
with a wrong mask, and this model treats the pair as the key because the syntax names both. Also inferred: that
`%` prefixes `Invalid address` — the paste shows the two words without it, and every other IOS refusal in this
repository carries the marker. Also inferred: that a matched removal is silent on a real box; this console
prints its usual receipt, which is a narration of the change rather than a claim about the vendor's output.

**Unresolved, and what would settle it.**

1. **The full mismatch sentence.** One `(config-if)#no ip address <wrong> <mask>` capture from an IOS or IOS XE
   box — the two words plus whatever follows them, and whether `%` leads. That single capture turns the
   sentence after `% Invalid address:` from this console's explanation into a quote.
2. **Whether the mask must match.** A capture of `no ip address <right address> <wrong mask>` on a port holding
   that address: removed, or `Invalid address`? The model currently refuses it (`test/no-ip-address-named-form.test.js`
   §4); if the box removes on the address alone, that check goes.
3. **Whether a matched removal says anything.** A capture of a successful named removal with nothing else on
   the line — silence or a confirmation line.
4. **`no ip address <address> <mask> secondary` on a box holding both kinds of address.** The reference says the
   `no` form takes `secondary`; no transcript in hand shows it removing only the secondary. Not modelled here
   (one address per port), so the refusal is the whole answer for now.
