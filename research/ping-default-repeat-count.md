# How many echoes a bare `ping <address>` sends, and who was counting four

**Question (one, narrow).** When nobody types a count, how many ICMP echoes does a real box send, and what does its
own header line say it sent?

**Verdict: settled, and the engine was wrong.** The default repeat count is **five**. This console sent four and
printed `Sending 4, 100-byte ICMP Echos to ...` over `Success rate is 100 percent (4/4)`, so the most-used command in
the lab disagreed with every real transcript by one echo. Fixed in one constant, plus the two copies of the number
that had drifted away from it.

## What the vendor publishes

| Source | Says |
| --- | --- |
| [`ping` (privileged), Cisco IOS command reference](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/ping.htm) | The prompt transcript opens `Repeat count [5]:`, then `Sending 5, 100-byte ICMP Echos to 192.168.7.27, timeout is 2 seconds:` / `!!!!!` / `Success rate is 100 percent, round-trip min/avg/max = 1/2/4 ms`; the field table reads "**Repeat count [5]:** Number of ping packets that will be sent to the destination address. **Default: 5.**" - and "Datagram size [100] ... Default: 100 bytes", "Timeout in seconds [2] ... Default: 2". |
| [Understand the Ping and Traceroute Commands](https://www.cisco.com/c/en/us/support/docs/ios-nx-os-software/ios-software-releases-121-mainline/12778-ping-traceroute.html) | Says the rule in words beside a transcript: "By default, the repeat count is five times, so there will be five echo requests, and five echo replies." Every sample on the page is `Sending 5`, and the failure case is `Success rate is 0 percent (0/5)`. |
| [Understand the Extended Ping and Extended Traceroute Commands](http://cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/13730-ext-ping-trace.html) | The same field table a second time: "Repeat count [5]: Number of ping packets that are sent to the destination address. The default is 5." |
| [Verify and Troubleshoot Basic NAT Connectivity](https://www.cisco.com/c/en/us/support/docs/ip/network-address-translation-nat/221481-8605-13.html) | A partial-loss run, which is how the four-of-five shape is confirmed from the other side: `Sending 5, ...` / `.!!!!` / `Success rate is 80 percent (4/5), round-trip min/avg/max = 1/1/2 ms`. The denominator is five because five were sent. |
| [IOS XR network diagnostic services (Cisco 8000)](https://www.cisco.com/c/en/us/td/docs/iosxr/cisco8000/ipaddresses-and-services/configuration-guide/ip-addresses-and-services-config-cisco8000/host-services-and-applications/network-diagnostic-services.html) | The same default survives the OS rewrite: `Sending 5, 100-byte ICMP Echos to 192.0.2.1, timeout is 2 seconds:` / `!!!!!` / `Success rate is 100 percent (5/5)`. |

Two numbers settle it: the prompt's own default is `[5]`, and no sample in any of these references prints
`Sending 4` for a ping that was not given a count.

## What the engine did

The nine-character defect, in three places:

* `engine/simulator.js` - `PING_COUNT_DEFAULT = 4`, the constant `ping()` falls back to when `opts.count` is absent.
* `engine/cli.js` - `let count = 4;` in `_ping()`, the console's own copy. The console always passes its count down
  explicitly, so this copy, not the engine constant, is what a typed `ping <address>` used.
* `engine/simulator.js` `ping6()` - a third copy, `opts.count || 4`, for the IPv6 echo.
* `web/app.js` - three copies in one function: the dialog's `<input id="ping-count" ... value="4">`, the
  `countField === '' ? '4'` handed to the validator, and the `Number(countField === '' ? 4 : countField)` actually
  sent. The browser always sends an explicit `count`, so it would have stayed at four even after the engine was fixed.

`docs/CLI.md` and `docs/ARCHITECTURE.md` then printed `Sending 4` / `(4/4)` as worked examples, which is how a wrong
default becomes documentation of a wrong default.

## What changed

One rule, one number, four call sites:

* `PING_COUNT_DEFAULT = 5` in `engine/simulator.js`, with the vendor citation in the comment; `ping6()` now reads that
  constant instead of its own `|| 4`.
* `engine/cli.js` `_ping()` takes its default from `PING_COUNT_DEFAULT` rather than a literal, so the console cannot
  drift from the engine again.
* `web/app.js`: all three copies in the dialog are 5 - the field's value, the empty-field value handed to the
  validator, and the number sent.
* `docs/CLI.md` / `docs/ARCHITECTURE.md`: the worked examples now read `Sending 5` / `!!!!!` / `(5/5)` with five reply
  lines, and the ping section states the default and cites it.
* `test/ping-default-count.test.js` (new, 18 checks): the constant, a bare `sim.ping()` and `sim.ping6()` (five replies,
  all answered, `requestedCount` still `null`), the console header/marks/rate/reply-line count, an explicit count still
  winning, the browser field and its empty fallback, and that no doc example still says four.
* `test/ping-count.test.js` and `test/ping-ipv6.test.js`: the assertions that had pinned the four-echo default now pin
  five - including the IPv6 timeout case, which loses five now, so `seq 4` is checked too.

## What is inferred rather than read

* **One default for the whole catalogue.** Every source above is Cisco. The catalogue is not, and the console keeps a
  single `ping` for all of it, so a non-IOS box here also answers five. That is the same simplification this console
  already makes for `show vlan`, `show etherchannel` and the rest of an IOS-shaped CLI; it is named here because a
  Junos or EOS operator might expect otherwise, and this note is the place to find that out.
* **`timeout is 2 seconds` and `100-byte`** are the vendor defaults too and were already right; they are quoted above
  only because the header line carries all three numbers and a reader checking one will check the others.

## What remains unresolved

* **The count ceiling.** This console refuses 51 and above (1-50) and cites no vendor for the ceiling; a real box takes
  a repeat count up to 2,147,483,647 and simply sends for a long time. Fifty is a *console answer size* rule here, not
  a device rule, and the refusal says so - but no source was read that states an IOS-side limit, so no number is
  claimed as one.
* **`Success rate` on a partially lost five.** The rate is computed, so it is right by construction; what was not
  checked against a transcript is the marks line's ordering when a reply is lost mid-run (`.!!!!` vs `!.!.!!`), which
  belongs to a different question about the marks line.
