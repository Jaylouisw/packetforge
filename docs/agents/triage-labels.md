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
curl -sS -X POST -H "Authorization: token $TOK" -H 'Content-Type: application/json' \
  -d '{"labels":["device-request","blocked-on-build"]}' \
  http://odin:3000/api/v1/repos/jaylouisw/packetforge/issues/<N>/labels
```
