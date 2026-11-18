# UDW-PRO: the document tree is slug-addressed, and it has no Pro slug

Question this note answers: is there a Ubiquiti-hosted datasheet or quick-install guide for the
Dream Wall Pro under a slug spelling nobody has tried? The earlier passes tested
`dl.ui.com/ds/udw-pro_ds.pdf` (302 to the techspecs front page) and stopped there, leaving the
narrower hypothesis open: *maybe the file exists and only the naming convention is wrong.*

## Controls: what a real product's slug looks like

Measured 2026-11-18, plain `curl`, no redirect following, Chrome UA:

| URL | status | bytes | content-type |
|---|---|---|---|
| `https://dl.ui.com/ds/udm-pro.pdf` | 200 | 353,553 | `application/pdf` |
| `https://dl.ui.com/ds/udm-pro_ds.pdf` | 302 | 308 | - |
| `https://dl.ui.com/qig/udw/` | 200 | 6,310 | `text/html` |
| `https://dl.ui.com/qig/udm-pro/` | 200 | 6,185 | `text/html` |

Two facts come out of the controls, and both matter more than the Pro probes themselves:

1. **The `_ds` suffix is not the convention - it is one of two.** `udw_ds.pdf` and `udm_ds.pdf`
   carry it; `udm-pro.pdf` does not, and its `_ds` twin 302s to `https://techspecs.ui.com`. So a 302
   on a `_ds` path is not evidence that the product lacks a datasheet; only the bare-slug path is.
   That weakens every earlier "no datasheet" reading that was taken from a `_ds` URL alone.
2. **The quick-install-guide tree is slug-addressed and server-rendered.** `dl.ui.com/qig/<slug>/`
   answers 200 for every product that has one, in the same spelling as the model's slug.

## Probes: every slug spelling, both trees

| URL | status | bytes |
|---|---|---|
| `https://dl.ui.com/ds/udw-pro.pdf` | 302 | 285 |
| `https://dl.ui.com/ds/udwpro.pdf` | 302 | 304 |
| `https://dl.ui.com/ds/udw_pro.pdf` | 302 | 305 |
| `https://dl.ui.com/ds/udw-pro_ds.pdf` | 302 | 308 |
| `https://dl.ui.com/ds/udw-pro-1.pdf` | 302 | 307 |
| `https://dl.ui.com/qig/udw-pro/` | 302 | 313 |
| `https://dl.ui.com/qig/udwpro/` | 302 | 312 |

All seven answer `302` with a `Location:` of `https://techspecs.ui.com` - the site front page, the
same 609,911-byte page that `udw-pro` URLs have landed on since the 2026-11-17 pass.

## What this closes

The naming-convention route is now measured shut at both ends: the tree that serves real datasheets
under a bare slug (`udm-pro.pdf`) has no `udw-pro` file under any of five spellings, and the tree
that serves real installation guides under a bare slug (`qig/udw/`, `qig/udm-pro/`) has no Pro
entry under two. This is a control-based negative now, not a single absent file: the paths exist and
are populated for real products, and they are empty for this one.

## What it does not change

Issue 130 stays blocked. Nothing here names a port or a PoE wattage for a Dream Wall Pro, and the
catalogue still has no `devices/ubiquiti/` file for it. The fallback the request points at - the
non-Pro UDW - is `devices/ubiquiti/udw.json`, and the row a requester is most likely to settle for,
the UDM-Pro, was corrected in the same pass (`devices/ubiquiti/UDM-Pro.json`): it had been modelled
twice, and the entry carrying the model string could not express its own second 10G cage.
