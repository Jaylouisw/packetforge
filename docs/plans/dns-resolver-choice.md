# Plan: the resolver asks whoever it meets first, and the picker that would choose is dead code

Status: forward plan, no code. Measured on `2eeb3051`, 2026-11-19, with three labs built directly on
`Topology`/`Simulator` + `runCommands` (probes below are reproducible as written). Closes **no** open issue — the
queue is two entries: #2146 (a `show` refusal's advice, with #2147/#2151 in flight) and #130 (a device request).
Step 6 is new command surface and **needs Jay's approval**; steps 3–5 change a verdict that `docs/SIMULATION.md`
currently labels *Approximate*, not a feature.

## What exists today

- `engine/dns.js` is a complete authority-side model: zones, CNAME chains, NXDOMAIN vs empty-NOERROR
  (`dns.js:342`), a **step-driven answer cache** (`createCache`/`cachePut`/`cacheLookup`, `dns.js:446-492`) and a
  **deterministic server picker** (`planQuery`, `dns.js:532-557`, documented "prefer a server that is
  authoritative for the queried name, then take the lowest IP"). All three are exported (`dns.js:626-629`).
- `Simulator.resolveName()` (`engine/simulator.js:292-370`) is the only resolver the product runs. It builds
  `candidates` by scanning `this.topo.devices.values()` and keeping every device that hosts **any** zone, filtered
  by `wanted.indexOf(ip) !== -1` — a membership test, so the order of `ip name-server` is discarded (`:294-305`).
  It then walks each candidate's `config.dnsZones` **in config order** and returns the first A it finds (`:307-330`),
  hard-coding `'A'` at both `:309` and `:339`.
- Callers: `ping` and `traceroute` (`engine/cli.js:4256`, `:4591`), and `openFlow()` (`engine/simulator.js:637`).
  `show ip dns` prints zones only — `_showDns()` accepts `zone`/`zones`, anything else falls through to a usage
  line (`engine/cli.js:4639-4712`).
- `test/dns.test.js:470-512` and `:523-545` are the **only** callers of the cache and `planQuery`. No engine or
  console path reaches either one.

## Measured

1. **`ip name-server` order is ignored.** Client `pc1` (10.9.0.50) configures `10.9.0.2` then `10.9.0.5`; both
   routers host zone `lab`. `resolveName` returned `10.9.0.5` and `serverIp: 10.9.0.5` — the *second* listed server,
   because `r1` (10.9.0.5) is earlier in the topology. `_domainServersFor()` (`cli.js:4299`) then prints only
   `(10.9.0.5)`, though its own comment says the addresses are printed "in the order the box would query them".
2. **A server with no path answers.** A router on an isolated 192.168.9.0/24 segment, with no link and no route
   from the client, still returned `{ok: true, address: '192.168.9.9'}`. Nothing in `resolveName` consults the
   route table.
3. **The wrong zone answers.** One box holds apex `lab` with `www.sub.lab A 10.0.0.30` and apex `sub.lab` with
   `www A 10.0.0.31`. `resolveName(pc, 'www.sub.lab')` returned **10.0.0.30**: `lab` is earlier in `dnsZones`, so
   it answers for a name its child zone is authoritative for. `show ip dns` prints both rows under the same name.
4. **Docs describe a datagram the engine never sends.** `docs/CLI.md:1331` says a device with no `ip name-server`
   "sends the lookup to `255.255.255.255`"; the engine asks any zone-hosting device in the lab
   (`simulator.js:294-305`), and `_domainServersFor` prints the broadcast address anyway (`cli.js:4303-4305`).

The stale-proof is separate but sits in the same rows: `docs/SIMULATION.md:420` cites `simulator.js:137` and
`:228-260`, and `:421` cites `:137-156`; `resolveName` is at `:292-370`, so all three pointers land in unrelated code.

## Ranked gaps

1. **Zone selection is config order, not longest matching apex** — silently answers from the wrong authority (#3).
2. **Server selection is topology order** — a configured primary is never preferred (#1); documented as
   "Approximate" (`SIMULATION.md:421`).
3. **No reachability** — a lookup succeeds against a server the client cannot reach (#2), which then fails at the
   packet path with a misleading "translation OK".
4. **`planQuery` and the answer cache are dead code** — the same shape as NAT's `expireTranslations()`, which
   existed and nothing called until it was wired (`SIMULATION.md:331`). Two exported, tested, unreachable modules.
5. **No cache view** — `show ip dns` cannot say what has been cached or when it ages out; TTLs are printed on
   zone rows but never elapse anywhere an operator can see.
6. **Docs**: three stale pointers, and the broadcast-address sentence above.

## Ordered steps (one PR each)

1. **S — docs: the §5.7 pointers and the broadcast claim.** Re-point `docs/SIMULATION.md:420-421` at
   `simulator.js:292-370`; add a row stating that the cache and picker exist but no path reads them; correct
   `docs/CLI.md:1331` to "asks any device in the lab that hosts a matching zone" until step 3 lands.
2. **S — `dns.js`: `bestZone(zones, qname)`.** Longest-suffix apex wins, ties broken by input order; `planQuery`
   uses it so a `{ip, zone}` descriptor set prefers the most specific zone. Unit tests only; no engine change.
3. **M — `simulator.js`: use both.** Ask the server `planQuery` chose (descriptors carrying the configured index so
   the configured order breaks ties before lowest-IP), resolve through `bestZone`, and report the chosen server and
   the `reason`. Turns #3 and #1 into one test each; leaves reachability alone.
4. **M — reachability.** A candidate is only asked if the client has a route to it (`topo` route lookup, the same
   one `ping` uses). Unreachable-and-only option → `SERVFAIL` with a distinct `unreachable-server` status so the
   console's reason line (`cli.js:4323-4337`) can name it. Keep the any-server fallback for clients with no
   `ip name-server` — narrowing that is a separate decision.
5. **M — wire the cache, on the topology.** `topo.dnsCache`, created lazily the way `flowStateFor()` does it
   (`server/index.js:322-329`) so an API request's `new Simulator(topo)` sees the CLI session's entries; `resolveName`
   reads at `this.step`, writes the record's TTL (`answers[0].ttl`), and never caches a TTL of 0. Steps only — no
   wall clock. Test: a lookup, a zone edited in-session, an answer that survives until TTL expiry and then re-resolves.
6. **S — console: `show ip dns cache` and `clear ip dns cache`** (**needs Jay's approval** — two new subcommands),
   plus an unknown subcommand that names `zone` and `cache` instead of only printing usage. Land after #2147/#2151
   merge, and match the refusal style they settle on for #2146.
7. **S — docs: §5.7 to *Modelled*.** The picker's rule (most specific zone, configured order, lowest IP), the cache's
   ageing and its visibility, `docs/CLI.md`'s DNS row (`:38`) and the translation-line paragraph.

## Tests

- New `test/dns-selection.test.js` from the three probes: order (`10.9.0.2` expected), isolated server
  (`SERVFAIL`/`unreachable-server`, no answer), overlapping apex (`10.0.0.31` expected). One assertion per claim;
  each must fail on `2eeb3051`.
- Keep `test/dns.test.js`, `test/dns-wire.test.js`, `test/dns-console.test.js` green — `dns-console:182` asserts the
  usage line for an unknown subcommand, so step 6 moves that assertion deliberately.

## Risks

- Any fixture where the client and the zone host are the same box now resolves through the same rule, but a lab
  with two hosts of one apex can flip its expected address. Grep `dns zone` in `test/` before step 3.
- The cache makes an in-session zone edit take effect at TTL expiry, not immediately. That is the realistic answer,
  and it is surprising enough to need its own test and one sentence in §5.7.
- Determinism: key the cache on `this.step` only, and break `planQuery` ties by input index — never by `Map` order,
  which is what the current code does by accident.
- Steps 3–5 change a documented verdict, so the docs PR must land in the same merge queue as step 3, not after it.

## Size

S, S, M, M, M, S, S — seven PRs, roughly one worker-week end to end; steps 1–2 and 6–7 are independent of each other.
