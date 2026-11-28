# Triage labels

The skills speak in five canonical triage roles. This file maps them to the label strings
this repo actually uses.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

## This repo's own labels

Two labels carry meaning the roles cannot express, and both belong on hardware requests:

| Label              | Meaning                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `device-request`   | A `[Device]:` issue: someone wants a manufacturer or model added to the catalogue.                                              |
| `blocked-on-build` | The vendor publishes the *type* of the field (slots, port kinds, capacities) but not its *value*. An honest close is impossible. |

`blocked-on-build` is the label that stops the same request being re-walked: the thread has
already recorded which document would settle it, so the next pass reads the comment instead
of repeating the search.

`device-request` is a convenience, not the definition. The label is applied by a workflow *after*
filing, so a real request can exist without it: #2521 did, carrying only `device`, and every reader
that asked the tracker for `labels=device-request` answered "queue is empty" while the app's
`/api/requests` listed it. The title is what the rest of the repository already reads -
`server/requests.js`, `scripts/sweep-device-requests.js` and `scripts/close-merged-issues.js` all
match the `[Device]:` / `[hardware]` prefix - and since #2524 `scripts/request-queue.js` and
`scripts/missing-devices.js` select on label *or* title too. The queue prints such an issue as
"in by title, not by label", naming its labels, so the missing one can be applied.

## Applying

```sh
gh issue edit <N> --add-label device-request --add-label blocked-on-build
gh issue list --label device-request --state open     # what is in the queue
```

The labels live on the tracker, not in the repository. `.github/labels.yml` records the 13 labels the
repository was born with — name, colour, description — but nothing reads it and nothing syncs it any
more: its own header named `.github/workflows/labels.yml`, and that workflow went out on 2026-11-08 with
the other GitHub-legacy workflows (`dd8b024a`, six files), so a name added to the file is created by
nobody. The tracker carries 25 labels; the 12 the file does not list include four of the five triage
roles above (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`) and
`blocked-on-build`, which is the label this page leans on hardest. So `gh label list` is the definition
of what exists and the file is a catalogue of what was intended — one that has fallen behind in the
other direction too, since `from-github` still describes itself as *"Opened on the GitHub mirror"*,
which the move on 2026-11-27 made untrue. `gh label create <name> --description "..." --color <hex>` is
what makes a label exist, and `gh issue edit <N> --add-label` can only apply one that does.
