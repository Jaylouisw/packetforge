# Plan: `show ?` — the key a technician presses, and the table the dispatcher already keeps

Status: forward plan, no code. Closes #1673. Scope: `engine/cli.js` (the two word tables, `_show()`,
`_showIpRedirect()`, `showIpUsage()`), a new suite under `test/`, and the `?` section of `docs/CLI.md`.
Nothing here changes what any command *does*; only what `?` answers where the console already holds a
complete list of what may stand there.

## What exists today

Two tables are declared as the positions where this console has a *complete* list of the words that may
stand there — the comment block at `engine/cli.js:31-54` says so in those terms (`:40-41`): `EXEC_WORDS` (`:55`, 12
entries) for the first word of an EXEC line, `SHOW_VIEW_WORDS` (`:73`, 14 entries) for the view word after
`show`. `resolveCommandWord()` (`:94`) is the single matcher: exact spelling wins, one prefix match is the
answer, more than one is returned as `rivals` for the caller to refuse in its own words.

`?` is handled, but only as a *whole line*: `head === 'help' || head === '?'` pushes `_help()`
(`:4943`) at `:414`, `:550`, `:1094`, `:2448`. Nothing consults a table, and no handler looks at the
position of the `?` inside the line. `_show()` (`:3809`) resolves its view word at `:3822` and dispatches;
anything it does not recognise reaches `:4846` — `% Invalid show command: <tokens>`.

Measured on `f77e4c44`, `generic-router`:

```
Router# show ?          -> % Invalid show command: ?
Router# show ip ?       -> % `show ip` needs a view. This console has: route, interface brief, ...
Router# show ipv6 ?     -> % Invalid show command: ipv6 ?
Router# configure ?     -> % Invalid input: configure ?
```

`show ip ?` works because `_showIpRedirect()` (`:3796`) answers it from `showIpUsage()` (`:279`), which is
built from `SHOW_IP_ALIASES` / `SHOW_IP_BARE_ALIASES` / `SHOW_IP_POINTERS` (`:264-276`) — a table, in
other words, one level deeper than the level that fails.

**The table is a word list, not a door list.** Three of the 14 entries in `SHOW_VIEW_WORDS` cannot stand
alone: `ipv6` needs `nd` (`:4041`), `mac` needs `address-table` (`:4419`), `power` needs `inline` (`:4043`).
Measured across `generic-router`, `generic-pc` and `generic-switch`: `show mac`, `show power` and
`show ipv6` all answer `% Invalid show command` on all three. So printing `SHOW_VIEW_WORDS` verbatim as
"what may follow `show`" would advertise three words the dispatcher refuses — the same defect, inverted.

Tests that touch this ground: `test/help-key-works-in-every-prompt.test.js` pins `?` at the five prompts
and never after a word; `test/show-view-phrase.test.js` pins the `port-channel`/`run`/`interface` aliases;
`test/docs-show-commands.test.js` types every `show …` code span in `docs/CLI.md`. `docs/CLI.md:2089`
documents `?` per prompt only.

## What is missing or weak, ranked

1. **`show ?` (#1673).** The operator unsure of the *second* word gets a list; the one unsure of the
   *first* is told the key is a typo. This is the issue, and it is the largest single win.
2. **The door list does not exist.** Step 1 of the fix has to come first, or `show ?` ships with three
   lies in it.
3. **`show ipv6 ?`** — the direct sibling of the one that works, refused (`:4041` requires `nd`).
4. **`configure ?`** — `terminal` is the only keyword there; the table is complete by construction.
5. **`showIpUsage()`'s first line is prose** (`:282`) listing `route, interface brief, ospf, bgp, nat,
   dhcp, dns` by hand; only the aliases come from a table. A new `show ip` door can be added and never
   appear, which is the drift this whole plan is about.
6. **`?` in the tail position answers three different ways** — usage (`show interfaces ?`, `show ip dns ?`),
   silently ignored (`show ipv6 nd ?` prints the table), or `does not take "?"` (`show vlan ?`). Real, but
   it is a different question (see "Deliberately left out").

## Ordered steps

| # | Step | Size | Closes |
|---|------|------|--------|
| 1 | Split doors from words: each `SHOW_VIEW_WORDS` entry gains the second word it requires (`mac` → `address-table`, `power` → `inline`, `ipv6` → `nd`), and a `showDoorWords()` helper returns complete forms with their aliases. No dispatch change — `_show()` keeps matching on the first word. Guard test: for every returned door, typing it must not answer `% Invalid show command`, on router, PC and switch. | S | — |
| 2 | `show ?` prints that list: one line per door, aliases named (`port-channel`, `run`, `interface`), plus a pointer to `show ip ?` for the views one word deeper (`:3796`). Ambiguity and unknown-word answers untouched. | S | #1673 |
| 3 | A bare word that needs a second one answers `% Incomplete command: show mac address-table` instead of accusing the word (`:4846`), same for `power`/`ipv6`. Makes the list in step 2 true for every word it names. | S | — |
| 4 | `show ipv6 ?` answers with its own usage line (`nd`), from the same helper, not a second copy. | S | — |
| 5 | `configure ?` answers `terminal` — one keyword, so no guessing is involved (`:385-395`). | S | — |
| 6 | Move `showIpUsage()`'s hardcoded door names into `SHOW_IP_DOORS` so `:282` is generated, closing the drift in rank 5. | M | — |
| 7 | `docs/CLI.md` §`?` gains `show ?` and the incomplete-command answer; one suite enumerates every door × `?`. | S | #1673 |

## Risks and test strategy

* **Advertising a view that refuses** is the failure mode, and it is silent — the list looks right. The
  per-model sweep in step 1 is the mitigation, not a spot check: run it over all three `generic-*` specs
  and at least one vendor device (a PC has no PoE, so the door must answer `% No PoE on …`, not `Invalid`).
* **New verbs read against `head`** must be named in `_help()`, or `test/help-completeness.test.js` fails —
  it extracts every token compared against `head` (`docs/CLI.md:1902`). Steps 3-6 add no new verbs; step 1
  must keep the `head ===` comparisons it already has.
* **`?` must not become a wildcard.** `show`, `show zz`, `show p` (ambiguous → `port-channel | power`) must
  answer exactly as they do now; pin all three verbatim before touching `_show()`.
* **Docs are executable here.** Any `show …` in a code span is typed by `test/docs-show-commands.test.js`,
  so step 7's wording is also a test.
* Existing suites that must stay green untouched: `help-key-works-in-every-prompt`, `show-view-phrase`,
  `command-word-abbreviation`, `configure-abbreviation`.

## Deliberately left out

* **`?` in the tail/argument position.** Three behaviours, one question: does `?` after a complete view mean
  "list what may follow" (usage), "nothing, ignore it" (`show ipv6 nd ?`), or "that is not an argument"
  (`showNoTail`, `:226`)? Deciding that touches every show door's argument rules and deserves its own plan.
* **`?` after a config-mode word** (`ip ?`, `vlan ?`). No complete table exists there and `:43-46` says the
  console does not guess; the index from bare `?` is the answer.
* **`show` with no word** — `% Invalid show command: (empty)`. #1673 explicitly keeps today's answer.
* Token-by-token partial help, tab completion, and the web UI's command box.

## Closes

#1673 (steps 1, 2, 7). Steps 3-6 are smaller defects found while grounding it and each is its own PR.
