# The board census is behind one gate, so measure the gate instead of re-arguing it

`#803` (OptiXtrans E6616X) has been re-checked twenty times. Eighteen of those passes ended with the
same sentence in slightly different words: *the service-board chapters are published, but anonymously
they answer "not logged in"*. Each pass proved it again by hand, and two of the passes first proved it
**wrongly** - one read `302 -> /view/notFound` as "unpublished", the next showed that a gated document
redirects to the same place, so "213 of 299 documents missing" was really "213 not anonymously
readable".

That is a measurement problem with one correct instrument, and this pass makes it mechanical:

- `research/huawei-gated-docs.json` - the id list, grouped (`e6600`, `osn1800v`, `control`), each with
  the state it had at the baseline.
- `scripts/huawei-doc-gate-probe.js` - probes `GET /hedex/api/navi/<id>/first-level-tree` once per id
  and exits **1** when any id no longer matches the baseline.

Neither is a source and neither writes a spec. What they replace is the prose.

## 1. The instrument, and why it is this endpoint

`https://support.huawei.com/hedex/api/navi/<id>/first-level-tree`, crawler UA, answers in three
mutually exclusive states:

| response | state | meaning |
|---|---|---|
| `200 {"status":200,"data":[]}` | `public` | anonymously readable - go and read the chapter |
| `401 {"status":401,"message":"NOT LOGIN!"}` | `gated` | the document **exists**, behind the free Huawei account wall |
| `404 {"status":404,"message":"No doc data found."}` | `absent` | no such document |

The `/enterprise/<lang>/doc/<id>` page cannot separate the last two - it answers `302` to
`/view/notFound` for both, which is the trap two earlier passes fell into. `scripts/huawei-doc-gate-probe.js`
sends the crawler UA because this host refuses a browser UA (Akamai `403`) and answers a missing UA with
a `302` to the SPA shell.

## 2. Baseline, measured 2026-11-18 21:5x UTC

30 ids: **27 `gated`, 2 `public`, 1 `absent`**, with the controls sitting in the right holes.

| group | ids | state |
|---|---|---|
| E6600 documentation packages, R026C00 -> R022C10 | `EDOC1100625826` (R026C00 Product Documentation 01), `EDOC1100556468`, `EDOC1100526008`, `EDOC1100456079`, `EDOC1100366068`, `EDOC1100331258`, `EDOC1100300582` | all `gated` |
| E6600 hardware descriptions | `EDOC1100558547` (R025C10), `EDOC1100525982`, `EDOC1100456166` (R024C10), `EDOC1100303425` | all `gated` |
| E6600 feature / product descriptions | `EDOC1100625831`, `EDOC1100558553`, `EDOC1100558558`, `EDOC1100163902`, `EDOC1100621358` | all `gated` |
| E6616X Quick Installation Guide (EN + ZH twin) | `EDOC1100299472`, `EDOC1100299473` | both `gated` - the Quick Start class is not a bypass |
| E6616X release documents | `EDOC1100625921` (V100R026C00SPC100), `EDOC1100625925` | both `gated` |
| OSN 1800 V Pro hardware descriptions (substitution route) | `EDOC1100558550`, `EDOC1100525975`, `EDOC1100456158`, `EDOC1100303420`, `EDOC1100249290`, `EDOC1100192279`, `EDOC1100558552` | all `gated` |
| controls | `EDOC1100605035` (joint OSN 1800 / E6600 / DC908 web-UI guide), `EDOC1100447312` | `public` |
| control | `EDOC9999999999` | `absent` |

One fact is new to the thread even though it changes nothing: the **26H2 documentation set is now on
the portal** as `EDOC1100625826` (*OptiXtrans E6600 V100R026C00 Product Documentation 01*), alongside
`EDOC1100625831` (Feature Description), `EDOC1100625925` (Upgrade Guide) and `EDOC1100625921` (the
E6616X SPC100 release document). The R026 brochures were read on 2026-11-17/18; this is the
documentation set that goes with them, and it is gated exactly like R025C10 and R024C10. So the newest
edition does not move the needle - it only shortens the unblock step, because `EDOC1100625826` is now
the first id to read if an account becomes available.

## 3. What a flip means, and what to do

`node scripts/huawei-doc-gate-probe.js` prints one line per id, prefixed `!` where the state has
drifted, then exits non-zero. The two flips that matter:

- **`EDOC1100625826` or `EDOC1100558547` `gated` -> `public`** - the hardware description is readable
  anonymously. Walk its chapters for a service-board chapter with a `配套设备` table naming `E6616X`
  (this family prints 配套设备, **not** `Valid Slots`), take the front-panel census, write
  `devices/huawei/optixtrans-e6616x.json`, close `#803`. Same shape for `#807`/`#808`/`#810` against
  the E9600 ids already named in `docs/DEVICE_REGISTRY.md`.
- **anything `public` -> `gated`** - a document that a spec cites has been withdrawn. That is a
  sourcing problem for the existing entry, not for the open request, and it is why the check runs
  over the whole list rather than only the blocked ids.

`--update` rewrites the baseline after a flip has been acted on. `--group e6600` and `--id <EDOC...>`
narrow a run. `--json` prints the same data for a script.

## 4. What this pass did not do

No `devices/` file changed. The blocker on `#803` is unchanged and exact: per E6616X-valid service
board, (a) part number, (b) validity in the X subrack, (c) front-panel port census - and every vendor
document that would answer it answers `401 NOT LOGIN!` to an anonymous client. The difference is that
the next pass no longer has to establish that; it runs one command, reads `nothing changed`, and
spends the hour on something else.
