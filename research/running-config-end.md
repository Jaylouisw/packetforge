# What closes a configuration file: the last line of `show running-config`

**Question (one, narrow).** A Cisco configuration file ends with a line this console's printer never wrote:
the bare word `end`. What exactly is that line, is it part of the file or something the terminal prints, and
what does it do when the file is pasted back into a session?

**Verdict: known, and adopted.** `end` is the last line of the file. Two vendor samples a decade apart both
end with it; they disagree only on how many bare `!` lines sit above it, so only `end` was adopted. It is
printed now, and `end` typed at privileged EXEC — where a paste is usually started — is accepted in silence
instead of answering `% Unrecognized command: end`, which is what this console did to the one line whose job
is to close the file.

## The evidence

The Cisco TAC command reference for `show running-config` (IOS 11.2) prints a partial sample whose last line
is `end`, with a single `!` above it:

```
Router2# show running-config
Building configuration...
Current configuration:
!
version 11.2
no service udp-small-servers
no service tcp-small-servers
!
hostname Router2
!
...
!
end
```
<https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_running-config.htm>

The Cisco 4000 Series ISRs Software Configuration Guide (IOS XE 15.3) prints a full default configuration,
and it too ends with `end` — here under **two** `!` lines:

```
Router# show running-config
Building configuration...
Current configuration : 977 bytes
!
version 15.3
...
line con 0
stopbits 1
line vty 0 4
login
!
!
end
```
<http://www.cisco.com/c/en/us/td/docs/routers/access/4400/software/configuration/guide/isr4400swcfg/bm_isr_4400_sw_config_guide_chapter_0110.html>

So: the line is `end`, not `exit`, not a blank line, and not `!`. `exit` appears in neither sample as a block
terminator — a real box separates blocks with `!` and closes the file with `end`.

What `end` means is stated twice by Cisco, in the CLI chapter that ships with several IOS releases:

> Pressing Ctrl-Z or entering the **end** command will always take you back to EXEC mode regardless of which
> configuration mode or configuration submode you are in.

> The **end** command is the recommended way to indicate to the system that you are done with the current
> configuration session.

<https://www.cisco.com/c/en/us/td/docs/ios/fundamentals/configuration/guide/12_2sr/cf_12_2sr_book/cf_cli-basics.html>

That is the reason the line is in the file at all: a config pasted into global configuration mode *closes
itself* at the end, instead of leaving the operator at `(config)#` wondering whether the paste finished. NX-OS
states the same rule from the other side — its `end` command reference lists the command mode as "Any command
mode" and says it "returns you to EXEC mode regardless of which configuration mode you are in"
(<https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus5600/sw/command/reference/fund/7x/n5600-fund-cr/n5600-fund_cmds_e.html>).

## What PacketForge printed

Measured in this worktree on an ASR 1001-X, one session, a router configured with a hostname, an address, a
shutdown port and a static route:

```
EDGE-1#show running-config
! PacketForge running-config
hostname EDGE-1
...
interface Te0/0/1
exit
ip route 0.0.0.0 0.0.0.0 10.1.2.1
```

The file stopped at the last configured value. Pasting it back reproduced the configuration (the invariant
`test/config-roundtrip.test.js` holds), but the session was left at `EDGE-1(config)#`: the paste had ended and
nothing in the text said so. And because the terminator was missing, a script that closed its paste with
`end` — the existing round-trip test does exactly that — was answered with `% Unrecognized command: end`,
since this console's EXEC branch knew `end` as a word but had no handler for it.

## What changed

* `show running-config` now ends with `end`, after the last configured line (`engine/cli.js`, the
  `running-config` branch). It is not state and not printed twice: the file is byte-identical when printed
  again, and `config-completeness`/round-trip still hold.
* `end` at privileged EXEC is accepted and prints nothing (`engine/cli.js`, the EXEC branch), so a file pasted
  over an already-enabled session — and the trailing `end` a script appends after one — no longer produce an
  error on the closing line.
* `test/running-config-end.test.js` (14 assertions): the last line on a configured and an unconfigured box,
  exactly one `end`, `end` after the last configured line and directly under the `!` that closes the last
  interface block, an unpasted file is stable, a full paste ends at `EDGE-1#` with no rejected line and a
  byte-identical configuration, and `end` at `#` is silent.

## What is inference, and what is still unresolved

* **`end` at privileged EXEC is inference, not a captured transcript.** Cisco's IOS reference describes `end`
  from configuration modes ("use the `end` command in global configuration mode"), and the mode table lists
  `end` under each config mode's exit methods — never under EXEC. The CLI guide's "regardless of which
  configuration mode" sentence does not cover EXEC itself. NX-OS's "Any command mode" does, but that is a
  different OS. What settles it needs one thing: a capture of `Router#end` on IOS, accepted silently or
  refused. If it is refused, the handler in `engine/cli.js` should go, and a script that appends `end` after a
  pasted file will get an error from a real box too.
* **The number of `!` lines above `end` is not adopted.** The 11.2 sample shows one `!` then `end`, the ISR
  4400 sample shows `!`, `!`, then `end`. With two samples that differ, printing a fixed count would be
  inventing a platform. PacketForge separates blocks with `exit` (documented, load-bearing for the paste-back invariant)
  and prints no `!` separators at all; whether to add them is a separate question this run did not open.
* **`Building configuration...` and `Current configuration : N bytes` are outside the file.** Both samples
  print them before the first `!`, but they are the box's narration to the terminal — the second is a byte
  count of its own config file, which no second device could reproduce for the same input. Neither is printed
  here, and the byte count is unresolved in the deeper sense: nothing found says whether it counts the
  trailing `end`, the `!` lines, or line endings, so a number printed by this console would be a guess dressed
  as a measurement.

## What would settle the rest

A capture of `show running-config` followed by one of `show startup-config` from the same box would show
whether the byte count differs between the two views (it should not, if it counts the file), and a `Router#end`
capture would turn the EXEC acceptance from inference into fact.
