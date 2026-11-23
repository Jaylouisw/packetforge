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

## Applying

```sh
curl -sS -X POST -H "Authorization: token $TOK" -H 'Content-Type: application/json' \
  -d '{"labels":["device-request","blocked-on-build"]}' \
  http://odin:3000/api/v1/repos/jaylouisw/packetforge/issues/<N>/labels
```
