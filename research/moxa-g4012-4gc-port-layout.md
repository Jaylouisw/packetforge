# EDS-G4012-4GC-T: the catalogue models 20 ports on a 12-port switch

`devices/moxa/eds-g4012-4gc-t.json` declares 20 interfaces on a switch the datasheet calls a
12-port box: copper ports `1` to `12`, plus `sfp9` to `sfp12`, with `comboWith` pairs hung off
ports `1` to `4`.

The EDS-G4012 Series datasheet (v1.8) is unambiguous for the `-4GC` models:

> 10/100/1000BaseT(X) Ports (RJ45 connector) | EDS-G4012-4GC-HV/-LV/-T models: 8
> Combo Ports (10/100/1000BaseT(X) or 100/1000BaseSFP) | EDS-G4012-4GC-LV/-HV/-T models: 4

Source: https://moxa.com/getmedia/e08a3f88-7aea-49de-b97a-97c1a5c26580/moxa-eds-g4012-series-datasheet-v1.8.pdf

So the correct layout is eight fixed copper ports (1 to 8) and four combo positions (9 to 12),
each one cage carrying an RJ45 half and an SFP half - 16 interface entries in total, not 20, and
no fixed cage anywhere. The file also carries no `sourceUrl`, so nothing in it can be traced to a
datasheet.

## Why it is still wrong

Neither existing pipeline can repair it:

- `scripts/import-devices.js --upgrade` rewrites an entry only when the one on disk carries **no**
  hardware detail at all (`detailScore() === 0`). This file's combo halves all carry `speedCaps`,
  so its score is well above zero and a richer incoming spec is reported as a duplicate instead.
- `scripts/apply-port-layouts.js` edits `connector` / `cage` / `speed` / `speedCaps` / `notes` on
  ports that already exist and refuses to add one. It has no way to delete `sfp9` to `sfp12` or to
  move the combo pairs from ports 1-4 to 9-12.

A hand edit of the one file is what this needs. It is not done here because the firmware stream is
restricted to the pipelines, and a structural rewrite slipped in beside seven unrelated new specs
would be the kind of change nobody re-reads.

## Related, smaller

`devices/moxa/eds-4008-2gt-2gs-lv-t.json` lists a `{ "name": "console", "type": "console" }`
interface, while `docs/DEVICE_SCHEMA.md` says a serial console belongs in `notes`, not in
`interfaces` ("a console port is a fact about the box, not a link it can carry traffic on"). It is
harmless in the simulator - nothing cables to a console - but it is the shape the schema forbids,
and the seven EDS-4000 specs added alongside this note keep the console in `notes`.
