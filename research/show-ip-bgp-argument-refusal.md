# `show ip bgp` and a word it cannot use: refused, or printed as if nothing was asked?

Question (one, narrow): when a word follows `show ip bgp` or `show ip bgp summary` that the view cannot use, what
does a box do — and what should this console do — given that the tail was being dropped entirely before this
iteration?

## What is known

1. **The tail was dropped.** `_showBgp(args)` is handed `tokens.slice(2)` by the dispatcher and its body read
   `args` nowhere, so `show ip bgp`, `show ip bgp summary`, `show ip bgp neighbors`, `show ip bgp neighbors
   10.0.0.2`, `show ip bgp 10.0.0.0/24`, `show ip bgp regexp ^65002` and `show ip bgp bogus` printed identical
   bytes on a populated lab (measured, `docs/plans/bgp-show-views.md`). A typo answered with a table is the same
   wrong answer `show ip route <prefix>` gave before #1403.

2. **A word the view cannot use is refused by the parser, not ignored.** An IOS XE switch transcript in a Cisco
   Community thread shows the caret error on a word after a real BGP view:

   ```
   X02YCA11UH001-KF001-SW#sh ip bgp neighbors br
   % Invalid input detected at '^' marker.
   X02YCA11UH001-KF001-SW#sh ip bgp neighbors
   BGP neighbor is 10.169.24.177, remote AS 65200, external link
   ```
   https://community.cisco.com/t5/routing/bgp-using-layer-3-switches/td-p/5075192

   The same thread's transcript is on a box with an **active** session, so this capture says nothing about the
   process-less ordering (below).

3. **Neither spelling has a free positional word.** The command reference's syntax lines:
   - `show ip bgp [ip-address [mask [longer-prefixes [injected] | shorter-prefixes [length] | bestpath |
     multipaths | subnets] | bestpath | multipaths] | all | oer-paths | prefix-list name | pending-prefixes |
     route-map name]`
   - `show ip bgp [ipv4 {multicast | unicast} | vpnv4 all | vpnv6 unicast all | topology {* | <name>}]
     [update-group] summary [slow]`

   Cisco IOS IP Routing: BGP Command Reference, "show ip bgp" and "show ip bgp summary",
   https://cisco.com/c/en/us/td/docs/ios/iproute_bgp/command/reference/irg_book/irg_bgp5.html

4. **`show ip bgp` is not argument-free on a box.** Its first optional word is an `ip-address` used as a filter
   (`show ip bgp 10.92.0.0 255.255.0.0 longer-prefixes` is one of the reference's own examples). So on a real box
   a word after `show ip bgp` is often *meaningful*; the console's refusal must therefore be phrased as this
   console's own limit, not as a claim about IOS.

5. **With no process, the five words are the answer to every spelling.** `sh ip bgp` → `% BGP not active`,
   `sh ip bgp summary` → `% BGP not active` (https://www.pinglabz.com/mpls-l3vpn-configuration-step-by-step/),
   and `sh ip bgp regexp ^abc` → `% BGP not active`
   (https://community.cisco.com/t5/wireless/automatically-apply-tag-policy-tag-rf-tag-site-on-cisco-9800-wlc/td-p/4906039).
   `regexp ^abc` is *valid syntax*, so these captures show execution being reached. Collected in
   `research/bgp-not-active-refusal.md`, pinned by `test/bgp-not-active.test.js`.

## What is inferred

* The refusal belongs **below** the `% BGP not active` check. With no process there is no table for a word to be
  dropped from, so the state answer is the whole answer whatever was typed; the fabricated answer this iteration
  removes exists only where a table would have been printed. This is also the order the plan asked for
  (`docs/plans/bgp-show-views.md`, step 2: "Guard order is unchanged").

* `show ip bgp neighbors` is a **different** gap from a stray word. A box has that view; this console has no detail
  block (hold time, capabilities, message counters — `dev.bgpNeighbors` carries none of them). Saying "does not
  take" would deny a command a box has, so it is answered the way `show ip nat translations verbose` is:
  `has no detail view here`, naming the table that does carry the neighbour facts.

## What is unresolved

1. **Parse order on a process-less box.** IOS parses a command line before it executes it, so
   `show ip bgp <junk>` on a box with no BGP process is most likely the caret error rather than
   `% BGP not active`. No capture either way has been found. This console answers `% BGP not active` there,
   because that is the captured behaviour for every *valid* spelling and it holds whatever was typed. Settling
   this needs: a transcript, on a box with no `router bgp`, of `show ip bgp bogus` (expect
   `% Invalid input detected at '^' marker.` if the parser runs first) — and the same test with a prefix
   (`show ip bgp 10.0.0.0/24`), which is the case where both orders are plausible.

2. **What a box does with `show ip bgp summary slow`** (`[slow]` is in the syntax line, and this console takes no
   `slow`). Untested here; the console refuses it with the summary's own sentence, which is true of this console
   and silent about whether a box accepts it.

3. **`show ip bgp <prefix>` semantics** — which of `longer-prefixes`, `subnets`, `bestpath` a filtered row would
   print — belong to `docs/plans/bgp-show-views.md` step 6, not to this refusal.
