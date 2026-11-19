# The line between two `interface` stanzas in `show running-config`

**Question (one, narrow).** A printed configuration has several `interface` blocks in a row. What line
separates them — and does the printer need to write `exit` for the file to be replayable?

**Verdict: known, and adopted.** A bare `!`. Every published running-config separates two `interface`
stanzas with one, including the Cisco 4000 Series ISR's own default configuration, and `exit` is not a
line a box writes in this file at all — it is a command an operator types to leave a mode. This console
printed `exit` after every interface block (one per port, empty or not), a line kept for a mechanical
reason that no longer holds. It now prints `!`, and the paste still lands every address and `shutdown` on
the port it belongs to.

## What the vendor prints

| Source | Shows |
| --- | --- |
| [Cisco 4000 Series ISRs Software Configuration Guide, Basic Router Configuration — Default Configuration](http://www.cisco.com/c/en/us/td/docs/routers/access/4400/software/configuration/guide/isr4400swcfg/bm_isr_4400_sw_config_guide_chapter_0110.html) | A full default `show running-config`: `interface GigabitEthernet0/0/0` / `no ip address` / `negotiation auto` / `!` / `interface GigabitEthernet0/0/1` / `no ip address` / `negotiation auto` / `!` / … / `interface GigabitEthernet0` / `vrf forwarding Mgmt-intf` / … / `!` / `ip forward-protocol nd` / … |
| Same page | The file contains no `exit` line anywhere. The only "exit" token is `exit-address-family` inside the `vrf definition` stanza — a keyword, not a stanza terminator. |
| [Cisco TAC, `show running-config` command reference (IOS 11.2)](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_running-config.htm) | `Router2# show running-config` / `Building configuration...` / `Current configuration:` / `!` / `version 11.2` / … / `hostname Router2` / `!` / … / `!` / `end` — the `!` is the separator between stanzas, and the file closes with `end` |
| [Cisco, Dynamically Configuring DHCP Server Options](https://www.cisco.com/c/en/us/support/docs/ip/dynamic-address-allocation-resolution/22920-dhcp-ser.html) | `ip dhcp pool Central` / `network 10.0.0.0 255.255.255.0` / `domain-name Central` / `dns-server 10.0.0.2` / `netbios-name-server 10.0.0.2` / `!` / `interface FastEthernet0/0` / `ip address 10.0.0.1 255.255.255.0` / `duplex auto` / `speed auto` / `!` / `end`. A `ip dhcp pool` stanza is closed by `!` too, and the `interface` stanza after it by `!` before `end` |
| [Managing Configuration Files, Cisco IOS 15M&T](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/config-mgmt/configuration/15mt/config-mgmt-15-mt-book/cm-config-files.html) | "Precede a comment with an exclamation point (!). Because comments are *not* stored in NVRAM or in the active copy of the configuration file, comments do not appear when you list the active configuration with the `show running-config` … command. Comments are stripped out of the configuration file when it is loaded onto the router." The `!` lines in a printed file are separators the OS inserts, not stored configuration |
| [Cisco IOS Configuration Fundamentals Command Reference, `exit` (global)](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/command/Cisco_IOS_Configuration_Fundamentals_Command_Reference/D_through_E.html) | `exit` is a command: "Use the `exit` command in interface, line, or router configuration mode to return to global configuration mode." It is something typed at a prompt; no sample prints it in running-config |
| [Interface and Hardware Components Configuration Guide, Catalyst 9600 17.12.x](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/17-12/configuration_guide/int_hw/b_1712_int_and_hw_9600_cg.pdf) | "An exclamation point (!) or a pound sign (#) at the beginning of a line of code indicates a comment line." On a switch platform, read as a *configuration* document — the separators are comments |

## What this console printed, and why

`show running-config` closed every interface block with `exit`. On a 24-port 2960-X that is 24 `exit`
lines in a row, interleaved with 24 stanzas:

```
hostname Catalyst 2960X-24TS-L-sw1
interface Gi1/0/1
exit
interface Gi1/0/2
exit
...
end
```

The line was added by #1230 for a real defect: the printer originally wrote the blocks back to back, the
parser stayed inside interface mode, and a pasted config applied an address meant for `Gi0/0/0` and a
`shutdown` meant for `Gi0/0/1` both to the first port in the file. `exit` was the fix at the time. It is
no longer load-bearing: the parser takes a new `interface` line inside interface mode as a mode switch,
and applies a global command typed at an interface prompt in global config — the leniency #1230 recorded
and `test/missing-argument-is-not-a-value.test.js` pins. So the terminator can be the character a box
prints without moving a single line of a paste.

## What changed

* `engine/cli.js`: the interface loop pushes `!` instead of `exit`. The DHCP pool loop still pushes
  `exit` (see below).
* `test/running-config-stanza-separator.test.js` (17 checks): one `!` per interface stanza on a fresh
  router, an unconfigured port printed as its header plus the separator, the separator directly above
  `end` for the last block, no `exit` line anywhere, the file replaying byte-identically, and a
  vendor-shaped paste (`!` between blocks, no `exit`) read back onto the right ports.
* `test/config-roundtrip.test.js`, `test/running-config-end.test.js`,
  `test/running-config-switchport-order.test.js`: the readers that treated `exit` as the end of a block
  now treat `!` as one too (the old-shape test strips both, since a config written before #1230 had
  neither).
* `docs/CLI.md`: the property stated as "every interface block closes with `exit`" is now the separator
  a box prints, with the reason the paste still works.

## Unresolved

1. **Does a bare `!` at a submode prompt end the mode?** The vendor documents say `!` is a comment, and
   separately that `exit` is the command that leaves a mode. Neither says what a `!` typed at
   `(config-if)#` does — yet a printed config, which contains no `exit`, pastes cleanly, so *something*
   returns the reader to global config. Indentation is the other candidate: the Managing Configuration
   Files guide instructs "Indent commands within a first-level configuration submode one space", i.e. a
   file is read with indentation carrying the mode. A transcript of pasting an `ip dhcp pool` stanza
   closed by `!` into `conf t`, followed by a global command, would settle it.
2. **The DHCP pool terminator.** The samples close a pool with `!`, but this printer still writes `exit`
   after `ip dhcp pool`, because `!` is ignored rather than acted on here: without a line that returns to
   global config, the stanza after a pool would be read in pool mode. Changing it needs answer 1 first.
3. **Separators between the other stanzas.** A real file has `!` after `hostname`, around the VLAN table,
   between ACL lines and route lines. This run changed only the interface stanza; whether this console
   should print a `!` between every top-level stanza is a separate question with a much wider blast radius
   (every running-config expectation in the suite).
4. **How many `!` sit above `end`.** One in the ISR default configuration, two in the 11.2 sample; the
   count varies by release and this console prints the one its stanza rule produces, not a copy of either.
