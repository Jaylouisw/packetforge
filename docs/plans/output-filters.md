# Plan: the pipe is read as a word, so `| include` is refused by nineteen handlers and `show interfaces | exclude down` invents a port

Status: forward plan, no code. Measured on `d1ad8f93`, 2026-11-21. Closes **no** open issue: the queue holds one
blocked device request (#130) and nothing about filtering. Scope: `engine/cli.js` (`run()`, `_show()`'s tail
refusals, `showViewUsage()`, `_help()`), a new suite under `test/`, and `docs/CLI.md`. Additive: with no pipe in the
line, every command answers exactly as it does today.

IOS XE's own syntax line is `show command | {append | begin | exclude | include | redirect | section | tee}
regular-expression`, and it says the expression is **case sensitive** (Cisco, *Using Cisco IOS XE Software*,
"Filtering Output from the show and more Commands"). Three of those verbs are line filters and need no file system:
`begin`, `exclude`, `include`. `section` needs the block shape the running-config printer already owns. This console
has none of them.

Related but not duplicated: `show-help-key.md` builds the position-keyed help tables `?` needs - this plan reuses
them at a new position rather than building a second index. `show-view-seams.md` splits `_show()`; the filter must
sit in `run()`, above that split, so the two plans do not collide. `traceroute-options.md` owns the trace's
arguments; a filter applies to the trace's output for free.

## What exists today

| fact | evidence |
|---|---|
| the pipe is just another word in the tail | `run()` `engine/cli.js:1101` splits the whole line on whitespace (`:1108`) and hands `show` every token after the command word (`:1147`) |
| nineteen handlers therefore answer a pipe with "does not take" | `showNoTail()` `:776`, called from 19 sites (`:5729`, `:5733`, `:6363`, `:6393-6399`, `:6472`, `:6533`, `:6700`, `:6735-6738`, `:6812`, `:6874-6884`, `:7003`, `:7175`, `:7292`, `:7625`) |
| `show interfaces` turns the pipe into a port name | `wanted = tokens.slice(1).join(' ')` `:7488`; the missing-port sentence `:7543` |
| a pipe before the view word blames the view | `_show()` `:6325`, view word resolved at `:6343`; `% Invalid show command: <tokens>` `:7958` |
| no two commands agree on what a pipe means | `show`: 19 refusals (above). `show interfaces`: a port name (above). `ping`: `% Unrecognized "|"` (`:1149`). `traceroute`: the pipe and its words are **dropped in silence** and the full trace prints - `_traceroute()` reads `tokens[0]` only (`:5029`). `links`: reads no argument at all (`_links()` `:4996` has no parameter). `converge`: `% Invalid instant: \|` (`:4869`) |
| `?` after a pipe is not a position | `showViewUsage()` `:888` lists `show` words only; nothing consults a table at the pipe |
| a pipe inside config text is data and already survives | `description uplink \| core` is accepted and printed; the config branch is `:7620` |
| the docs call a pipe a bad argument | `docs/CLI.md:129` "a word they cannot use is refused"; no filter syntax in the file |
| no test has ever typed one | `grep -rn '| include' test/` is empty |
| the API shares the door | `server/index.js:1094` calls `session.run(cmd)`, so console, web and HTTP all get the fix at once |

Measured on `generic-router` with a hostname, an address and one static route:

```
Router# show running-config | include hostname
% show running-config does not take "| include hostname": the whole configuration is printed - the file is the plain `show running-config`

Router# show interfaces | exclude down
% No interface | exclude down on R1

Router# show | include hostname
% Invalid show command: | include hostname

Router# ping 10.0.0.2 | include 64
% Unrecognized "|" (ping <address|name> [<count 1-50>] [at <ms>])

Router# traceroute 10.0.0.2 | include 1
Type escape sequence to abort.
Tracing the route to 10.0.0.2
  1  *  *  *  (no ARP reply from 10.0.0.2)          <- the pipe is gone, the trace is not filtered

Router# converge | include x
% Invalid instant: |

Router# show running-config | ?
% show running-config does not take "| ?": the whole configuration is printed - the file is the plain `show running-config`
```

## What is missing, ranked

1. **There is no one answer to "what is a pipe".** Six handlers give six answers: nineteen views refuse it as an
   argument, `show interfaces` names a port after it, `ping` calls it unrecognised, `traceroute` silently drops it
   and answers the unfiltered question, `links` cannot see it, and `converge` reads it as an instant. The first of
   those also teaches the wrong lesson - `show run | include hostname` is how a technician reads a config, and the
   console says the *file* "does not take" a filter, which is false about every IOS box and true only about this
   parser.
2. **`show interfaces` fabricates a port** (`:7543`). `% No interface | exclude down on R1` names an object that
   cannot exist. This is the exact failure class #1403 set out to remove: a wrong answer that looks like an answer.
3. **`?` dies at the pipe** (`:888`). `show ?` is a table; `show run | ?` is a refusal. The one key a technician
   presses to learn a position is silent in the position that most needs it.
4. **No `begin` and no `section`.** `show run | begin interface` is the paste-adjacent habit, and `section` is the
   only filter that respects the file's block structure - a structure the printer already defines and documents
   (`:7629-7640`, one space per submode level).
5. **No chaining.** `show run | include interface | exclude Gi0/1` is refused as one long string today, because every
   segment after the first is one more word in the same tail.

## Ordered steps

**1. One seam in `run()`: split, dispatch, filter (S).** Move the dispatch body at `:1113-1181` into
`_runLine(tokens)` unchanged - which is also what makes `traceroute`, `links` and `converge` stop disagreeing,
because the pipe no longer reaches any of them; `run()` becomes comment check -> `splitFilters(line)` -> `_runLine(cmd)` ->
`applyFilters(reply, filters)`. `splitFilters` is gated on the **head word** resolving in `EXEC_WORDS` (`:55`), so a
`description uplink | core` line (head `description`) is never touched - that line is measured working today and a
test must keep it that way. A segment whose first word is not `include | exclude | begin | section` (unique prefixes
accepted, as everywhere else: `i`, `in`, `inc`, `ex`, `b`, `sec`) is refused: `% Invalid filter "foo" after |: this
console filters with include, exclude, begin and section`. With no pipe the reply is byte-identical.

**2. `include` and `exclude` (S).** The pattern is the raw text after the filter word, trimmed - not re-joined
tokens, so an intentional double space survives. Compile once with `new RegExp(pattern)` (no flags: the reference says
case sensitive); a bad pattern answers `% Invalid regular expression: <pattern>` in the console's own voice, and is
not itself filtered. The filter runs on the reply's line array after dispatch, so every view and `ping`,
`traceroute` and `links` gain it at once. No match prints nothing, as a box does. **A reply that is exactly one line
beginning `% ` is a refusal and is never filtered** - the console's own sentence must not be hideable by the
operator's pattern, so `show version flurbish | include Cisco` keeps its refusal instead of printing nothing. That is
a deliberate divergence from a box (which fails the parse before the pipe runs); it is the safer direction and it is
documented in step 5.

**3. `begin`, and the `?` position (S/M).** `begin` prints from the first matching line to the end of the reply; no
match prints nothing. `show run | ?` lists the four filters with a one-line meaning each, in `showViewUsage()`'s
shape (`:888`); `show run | include ?` answers `LINE  Regular expression to match`; a bare `|` and a bare filter word
are `% Incomplete command: ... | include <pattern>`. This is the step that makes the nineteen `showNoTail` messages
unreachable *for a pipe* - none of those call sites should be edited, because a real argument still needs every one
of them.

**4. `section`, scoped to the file that has sections (M).** For `show running-config`, a section is the block whose
header is the nearest preceding line with no leading space (or one space, for a child of a first-level stanza);
print the block containing a match, header first. The printer already owns that shape and its one-space-per-level
rule (`:7629-7640`). On every other view, refuse with a pointer rather than approximate - a table has no sections,
and a guess would print a block the box would not: `% | section reads show running-config here; ...`.

**5. Docs and the index (S).** Add `### Filtering output with |` under `docs/CLI.md:129`, correcting the sentence
that calls a pipe "a word the command cannot use"; add one line to `_help()` (`:8078`); state the `%`-refusal rule,
the case sensitivity, and that patterns are JavaScript regexes matched per printed line - so a continuation line of
a wrapped table can match on its own, exactly as on a box.

## Risks and test strategy

- **Config text containing `|`** (measured) is the whole risk. The head-word gate is the only defence; a regression
  test must configure `description uplink | core` and `vlan 10 name a|b`, then read both back through
  `show running-config`.
- **Regex dialect.** JS accepts more than IOS (`(?:`, lookarounds). Do not translate; document the subset the
  examples use and let the pattern fail loudly rather than silently match nothing.
- **Wrapped output.** Filters see the lines the view already emits, wrapped at 80 columns (`VLAN_TERMINAL_COLS`
  `:444`). A match on a continuation line prints a fragment; that is what a box does, and it must not be "fixed" by
  filtering before wrapping.
- **Ordering with the `show` split** (`show-view-seams.md`): the filter lives in `run()`. If it were put inside
  `_show()`, every future view would have to remember it, and `ping` would never get it.
- **Tests:** new `test/cli-output-filters.test.js` on `generic-router` plus a switch, covering each verb, prefixes,
  chaining, no-match silence, invalid regex, refusal pass-through, the config-line case, and the disappearance of
  `% No interface | exclude down`; then `node scripts/run-tests.js`, and `test/docs-cli-transcript.test.js` for the
  docs edit.

Not in this plan: `append`, `redirect` and `tee` (there is no file system to write to), `count` (present in some XE
platform guides and absent from others, so it is a per-platform claim this console cannot make), `more`, and
`terminal length` / `--More--` pagination - pagination is the other half of reading a long table and deserves its
own plan.

## What this closes

No open issue. It retires the last observable case of the #1403 class - an answer that names something that does
not exist - and it removes nineteen refusals that currently tell a reader the wrong thing about IOS.
