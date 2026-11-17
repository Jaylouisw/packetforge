# Plan: the `show` dispatcher is one 1,152-line method, and every view fix lands in it

Status: forward plan, no code. Measured on `68fd4b98`, 2026-11-17. Closes no open issue - the queue is
seven device requests (#743, #742, #130, #803, #807, #808, #810), all about the catalogue, none about the
console. Steps 1-5 change no output. Steps 6-7 add a knob or a measurement and are labelled
**needs Jay's approval**.

The console is the product, and its whole read surface is one method. `CliSession._show()` runs from
`engine/cli.js:4433` to `:5584` - **1,152 lines of a 5,753-line file**, one fifth of the module in a single
function, with 49 distinct words compared by `===` inside it and a maximum indentation of 16 spaces
(`:4995`). Twenty suites are named `show-*.test.js` and 134 files under `test/` name a `show` command, so
the behaviour is pinned far more tightly than the code is partitioned. Every output fix therefore edits the
same 1,152 lines: **23 of the last 60 commits that touch `engine/cli.js` are one view's layout or wording**
(#1547, #1583, #1591, #1606, #1609, #1616, #1619, #1625, #1632, #1638, #1641, #1698, #1708, #1717, #1737,
#1791 ...), and `docs/CLI.md` - the page those fixes rewrite - was touched in 17 of the last 60 commits on
`main` against 10 for `cli.js` itself.

## What exists today

Six views already have their own method. The chain still has to route to each one, but the body is
separable today, which is what makes step 2 mechanical rather than a rewrite:

| view | method | lines |
|---|---|---|
| `show ip dhcp ...` | `_showDhcp()` `:3580-3759` | 179 |
| `show ip ospf ...` | `_showOspf()` `:3780-3945` | 165 |
| `show power inline` | `_showPowerInline()` `:4281-4395` | 114 |
| `show ipv6 nd` | `_showIpv6Nd()` `:5585-5668` | 83 |
| `show ip bgp ...` | `_showBgp()` `:3945-4027` | 82 |
| `show ip dns` | `_showDns()` `:3483-3559` | 76 |

That is 699 lines the chain never reads for its own logic, sitting below it. The same is true of the table
helpers: `pad()` is defined at `cli.js:26` **and again at `engine/nat.js:766`** - the same rule, two copies,
which is the drift this repo has been bitten by before (`cli.js:13-15`, #1247). `_show()` itself calls
`pad()` 19 times and lazily `require()`s seven engine modules mid-body (`:4484`, `:4899`, `:5344`, `:5488`).

The word tables are the one thing that is already declarative: `SHOW_VIEW_WORDS` (`cli.js:75-90`, 14 doors)
and `SHOW_VIEW_TAILS` (`:449`). Both carry comments explaining that the table *is* the dispatcher's
vocabulary - "a word in it that the dispatcher did not handle would be a door the console promised and
refused" (`:93-95`). Nothing tests that sentence: `test/help-completeness.test.js:14` says in as many words
that its lists are "hand-written on purpose", so a view added to the table and forgotten in the chain is
caught only if someone remembers to add it to the test too.

## What is missing or weak, ranked

1. **No seam.** One method, 49 branches, 20 pinned suites. Every show PR pays for the whole file in review
   and conflict risk; the two hottest files on `main` are this method and the doc page that transcribes it.
2. **No door census.** 14 declared doors, 49 compared words, and no automated assertion that each declared
   door opens something. `show ?` is answered from the table (`:4450`), so the table can advertise a door
   nothing implements and the console will not notice.
3. **Helper duplication.** `pad()` twice; per-view padding inlined 19 times inside `_show()`; a view that
   wants a column width has no shared place to ask.
4. **Three "not modelled" answers live in this method**, each one field away from an answer the engine
   already computes: `Pri` in `show ip ospf neighbor` is hardcoded to 1 because `ip ospf priority` is not
   modelled (`cli.js:3889`, `docs/CLI.md:1151-1167`), the PoE budget is reported as "not modelled"
   (`cli.js:4317`), and `spanning-tree portfast` is refused as unmodelled (`cli.js:917`, `:1054`,
   `docs/CLI.md:2236`).

## Ordered steps

1. **A door census, no engine change (S).** New `test/show-doors.test.js`: for every `SHOW_VIEW_WORDS`
   entry and every `show ip <view>` spelling the redirect accepts, assert the answer is a table or a
   refusal that names the view - never `% Invalid show command` - on a device that has the capability. Same
   file asserts `docs/CLI.md`'s command table has a row per door. This is the contract steps 2-5 must keep.
2. **Extract the six method-backed views (S).** `engine/views/{dhcp,ospf,power,bgp,dns,ipv6-nd}.js`, each
   exporting one function that takes the session and the tokens. Move the bodies verbatim - no reflow, no
   renamed cells - and leave the chain one line per door. `engine/views/index.js` is the only new surface.
3. **One table helper (S).** `engine/console-table.js` holding `pad`, `briefLine`, `vlanLine`, `vlanRows`,
   `vlanRule`, `probeCells`, `roundTripClause` (`cli.js:26-341`, `:562-600`), required by `cli.js` and the
   views; delete `nat.js:766`'s copy and require the shared one. Deleting the duplicate is the point, not a
   side effect.
4. **Split the `show ip` family (M, two views per PR).** route, arp, dhcp, dns, ospf, bgp, nat, interface
   each to their own module; the chain keeps `_showIpRedirect()` (`:4420`) as the only router.
5. **`show vlan` and `show interfaces` last (M).** They are the hottest views (#1791, #1638, #1698, #1547)
   and therefore the ones whose suites give the most coverage per moved line.
6. **`ip ospf priority` (S-M) - needs Jay's approval.** A config knob plus the Hello field, so the `Pri`
   column carries the neighbour's value instead of the default and DR/BDR is elected rather than derived from
   router ID. File the issue first; `research/show-ospf-neighbor-state.md` already has the sources.
7. **Power budget and STP portfast (M) - needs Jay's approval.** Both are new measurements or knobs, not
   refactors, and both should be scheduled only after the seam exists so each lands in a small file.

## Risks and tests

- **A verbatim move that is not verbatim.** The real risk is a silent column shift on a view nobody has a
  fixture for. Rule: each extraction PR captures `show ...` output for three devices (a router, a switch, a
  POE switch) before and after and diffs it byte-for-byte; only the new door suite may be added, never
  edited, in a move PR.
- **State on `this`.** `_show()` writes one field, `_showAliasFrom` (`:4444`, read in the etherchannel
  branch), so views must receive the session rather than a copied context, or the alias name is lost.
- **Exports must not move.** `cli.js:5753` exports `CliSession, runCommands, resolvePortName, portKey`;
  every suite imports through those, so the modules must be reached through `CliSession`.
- **Net:** the 20 `show-*` suites plus `docs-cli-transcript.test.js`, `show-view-phrase.test.js` and
  `help-completeness.test.js`, then `node scripts/run-tests.js` for the repo-wide answer.

## Issues this would close

None open. It does not compete with `docs/plans/stated-configurations.md`, which owns the seven device
requests, and it makes step 6's documented gap (`docs/CLI.md:1151`) cheap to close once Jay approves it.
