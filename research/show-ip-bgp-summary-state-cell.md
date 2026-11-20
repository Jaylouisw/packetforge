# `show ip bgp summary`: what the last cell holds, and whether "Established" is ever printed

**Question (one, narrow).** In an IOS-style `show ip bgp summary`, what goes in the final
`State/PfxRcd` cell — for a session that is up, and for one that is not — and does the word
`Established` ever appear in that table?

**Verdict: settled for both halves, and this console printed the one word the box cannot.** The cell holds a
**number** — the prefixes received from that neighbour — while the session is Established, and the **FSM state
word** (`Idle`, `Connect`, `Active`, `OpenSent`, `OpenConfirm`, with suffixed forms such as `Idle (Admin)`)
while it is not. The string `Established` is not a value of this column on any IOS image whose output is
published; it appears in `show ip bgp neighbors` (`BGP state = Established`) and in the state tables that
describe the FSM, not in this cell.

This note backs one small change (`engine/cli.js`, `engine/simulator.js`, a new
`test/bgp-summary-state-cell.test.js`), not a redesign of the table: see *What was adopted* below.

## What the device prints

Cisco's own troubleshooting document, *Understand Basic BGP Troubleshoot*, prints the table and annotates the
column:

> `Neighbor V AS MsgRcvd MsgSent TblVer InQ OutQ Up/Down State/PfxRcd`
> `10.1.1.1 4 64512 346 334 67 0 0 05:25:12 8` -> BGP peer IP address, remote ASN, Time session has been
> established or down, amount of prefixes received.
> **State/PfxRcd** section displays the BGP state the session is currently on. It shows the number of
> prefixes learned from its peer when the state is established.

<https://cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/220604-understand-basic-bgp-troubleshoot.html>

Noction's state guide states the negative half explicitly:

> Note that you won't see the word "Established" in the output of the *show … summary* command: rather,
> you'll see the number of prefixes received from the neighbor in question.

<https://www.noction.com/blog/debugging-bgp-states> — and the companion page prints a six-row table where the
established neighbour is `00:01:18 1` and the down ones are `never Idle`, `never Active`, `Idle (Admin)`,
`Idle (PfxCt)` (<https://www.noction.com/blog/bgp-errors>).

Dell's OS9 command reference gives the field description with the sub-cases, and it is the one document in
hand that names the header `State/Pfx` rather than `State/PfxRcd` (a platform variant, not a different rule):

> If the neighbor is in Established stage, the number of network prefixes received. If a maximum limit was
> configured … (prfxd) appears … If the neighbor is not in Established stage, the current stage is displayed
> (Idle, Connect, Active, OpenSent, OpenConfirm). When the peer is transitioning between states and clearing
> the routes received, the phrase (Purging) may appear … If the neighbor is disabled, the phrase (Admin shut)
> appears.

<https://www.dell.com/support/manuals/en-lt/dell-emc-os-9/s4048t-on-9.14.2.6-cli-pub/show-ip-bgp-summary>

An independent vendor's description of the same column (IP Infusion OcNOS) adds the definition of `Active`
that matters below: *"the local router is trying to establish a TCP connection to the remote peer. You might
see this if the local peer has been configured, but the remote peer is unreachable or has not been
configured."* <https://documentation.ipinfusion.com/ocnos-sp-layer-3-7.0/Content/ocnos-layer-3/bgp-show-commands/show_bgp_summary.htm>

Cisco's *Troubleshoot BGP Basic Issues* shows what "down" looks like for the one cause this model can
produce — no path to the peer — with the cell `Idle`:

> `198.51.100.1 4 65536 0 0 1 0 0 never Idle`
> - No connected route peer or no route at all; run the `show ip route peer_IP_address` command.

<https://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/218027-troubleshoot-border-gateway-protocol-bas.html>

## Which FSM word for which fault

The FSM itself is RFC 4271 §8.2.2 (<https://www.rfc-editor.org/rfc/rfc4271#section-8.2.2>), and the mapping
from fault to the word a technician sees is consistent across the Cisco documents above and the training
material that teaches it:

| fault | cell |
| --- | --- |
| session up | prefix count (a number, `0` if the peer sent none) |
| peer administratively shut (`neighbor x shutdown`) | `Idle`; some platforms `Idle (Admin)` / `(Admin shut)` |
| no route to the peer address, or the local port is down | `Idle` |
| a route exists but the TCP connection does not complete | `Active` |
| OPEN rejected (AS mismatch, missing neighbour statement) after the notification | `Idle`, then `Active` on the retry |
| more prefixes than the configured maximum | `Idle (PfxCt)` |

The `Idle`/`Active` distinction is *why* the session failed, not *whether* it failed: `Active` means the box
has an address it can try and the attempt is not succeeding, `Idle` means it is not trying at all (no route,
administratively down, waiting for a retry timer). Two teaching sources put it as a table — "Idle: no attempt
yet or cannot try: no route, shutdown, waiting to retry; Active: trying TCP, not completing"
(<https://routelearn.net/ccnp/bgp/troubleshooting-neighbors>) — and both of Cisco's support documents above
agree on the two cases they show.

## What was adopted, and what was not

Adopted (this change):

1. The header word is `State/PfxRcd` — the field name every Cisco capture carries.
2. A session that is up prints the **count of prefixes received from that neighbour**, `0` included. The
   count comes from the candidate lists in `computeBgp()` (every path the peer sent that survived the
   AS-loop check), not from the installed table, so a prefix that loses the best-path decision to a peer or
   to a connected route is still counted. That is the difference the console already reports in its
   `N more received, not installed` line, and the two numbers now agree.
3. A session that is down keeps the word `Idle`, because every way this model refuses a session — a link that
   cannot carry a frame, a shut far port, no `neighbor` statement at the far end — leaves the box waiting to
   retry rather than mid-attempt, which is the `Idle` case in the table above.

Not adopted, on purpose:

* The ten-column layout (`MsgRcvd`, `MsgSent`, `TblVer`, `InQ`, `OutQ`, `Up/Down`). The model keeps no
  message counters and no per-session uptime, and printing `0`/`never` for them would be inventing six cells
  of state. This is the same decision `show ip dhcp binding` records for its own columns
  (`research/show-ip-dhcp-binding-title.md`): the vendor header, this model's columns.
* The `Reason` column. It is this console's teaching aid — no box prints it — but it is the only surface that
  says *why* a session is down, and the CLI tests assert on it.
* `Active`. The model has no in-progress TCP attempt to report; a refusal is recorded as a fact with a cause.
  Printing `Active` for an unreachable peer would be defensible (see the table above) but the model cannot
  distinguish "TCP failed while a route exists" from "no route at all", so it prints the case it can prove.

## What is still open

1. **The count's exact boundary.** A box counts the Adj-RIB-In after inbound policy. This model has no
   inbound policy, so `received` = "prefixes the peer sent that were loop-free". A capture of a box with an
   established session whose only prefix is also directly connected would confirm that the count still reads
   `1` rather than `0`; the Dell and Noction wording ("number of prefixes received") says it should, and this
   model now prints `1` in exactly that lab.
2. **Which word this model would owe for an AS-mismatch refusal.** A real box sends a NOTIFICATION and lands
   in `Idle`, then retries into `Active`; this model prints the refusal's `Idle` for both moments. One state
   cannot be wrong, but the sequence cannot be shown without a retry timer, which the model does not have.
3. **The `Up/Down` format.** `never`, `hh:mm:ss`, `1d21h`, `11w2d` (Dell's reference gives the three time
   shapes). Not modelled, so not printed; nothing here decides whether the times are session age or idle age.
4. **Whether every IOS XE image spells the header `State/PfxRcd`.** IOS XE 17 captures and Cisco's own guide
   do; Dell's OS9 reference and the IP Infusion page print `State/Pfx`. The wider header is used because this
   console imitates IOS, and the narrow one is a different vendor's.

## Sources

- Cisco, *Understand Basic BGP Troubleshoot* — table, sample, field definitions:
  <https://cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/220604-understand-basic-bgp-troubleshoot.html>
- Cisco, *Troubleshoot Border Gateway Protocol Basic Issues* — the `never Idle` capture and "no route at all":
  <https://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/218027-troubleshoot-border-gateway-protocol-bas.html>
- Noction, *Debugging BGP states* — "you won't see the word 'Established' in the output of the show … summary
  command": <https://www.noction.com/blog/debugging-bgp-states>
- Noction, *BGP errors, BGP error codes* — six-row table with `Idle`, `Active`, `Idle (Admin)`, `Idle (PfxCt)`:
  <https://www.noction.com/blog/bgp-errors>
- Dell EMC OS9, *show ip bgp summary* — full field description, `State/Pfx` header, `(Purging)`:
  <https://www.dell.com/support/manuals/en-lt/dell-emc-os-9/s4048t-on-9.14.2.6-cli-pub/show-ip-bgp-summary>
- IP Infusion OcNOS, *show bgp summary* — field table, `Active` definition:
  <https://documentation.ipinfusion.com/ocnos-sp-layer-3-7.0/Content/ocnos-layer-3/bgp-show-commands/show_bgp_summary.htm>
- RouteLearn, *Troubleshooting BGP Neighbor Adjacency* — the Idle/Active cause table:
  <https://routelearn.net/ccnp/bgp/troubleshooting-neighbors>
- RFC 4271 §8.2.2, the BGP finite state machine: <https://www.rfc-editor.org/rfc/rfc4271#section-8.2.2>
