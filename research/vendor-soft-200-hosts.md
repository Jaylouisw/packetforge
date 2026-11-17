# A 200 is not a document: the host that answers every path with the same page

Measured 2026-11-17 while probing Ubiquiti for #130 (Dream Wall Pro). It is recorded separately
because it is a **method** failure, not a device fact, and it can manufacture a spec field out of
nothing: if a datasheet path answers `200`, the tempting next step is to treat the response as a
vendor document and read ports out of it.

## The measurement

One crawler user-agent, `-L`, `--max-time 30`, fresh output file per URL, read back with
`%{http_code} %{size_download} %{content_type}`:

| URL | status | bytes | content-type |
|--|--|--|--|
| `https://dl.ui.com/ds/udw-pro_ds.pdf` | 200 | 609,911 | `text/html; charset=utf-8` |
| `https://dl.ui.com/qig/udwpro/` | 200 | 609,911 | `text/html; charset=utf-8` |
| `https://store.ui.com/us/en/products/udw-pro` | 404 | 204,279 | `text/html; charset=utf-8` |
| `https://ui.com/cloud-gateways/dream-wall-pro` | 200 | 446,725 | `text/html` |
| `https://help.ui.com/hc/en-us/search?query=Dream+Wall+Pro` | 200 | 45,271 | `text/html; charset=utf-8` |

`dl.ui.com` serves its storefront shell at **any** path, including a nonsense one (`qig/udwpro/`), and
never serves a PDF: both bodies are the same 609,911-byte document and both begin `<!DOCTYPE html>`.
`store.ui.com` returns `404` for the Pro SKU with a 204,279-byte shell. So neither the status code nor
a `200` on a `.pdf` path is evidence that a file exists - only the `content-type` and the leading
bytes distinguish a document from the router's catch-all page.

Nothing in this table shows that a Dream Wall Pro datasheet or quick-start guide exists. It shows that
the earlier `200` / `404` readings against these hosts carry no information on their own.

## The measurement error this note exists to prevent

A first pass of the same probe reused **one** output file for every URL and recorded `204,279 B` for
nine different paths across four hosts - a number that looked like a shared error page and was in fact
the size of whichever download last succeeded. One file per request, and print
`%{size_download}`/`%{content_type}` from curl rather than `wc -c` on a path you did not just write:
a stale file turns a failed fetch into a confident table.

## The rule

Before a body becomes a source: check that it is the *type* the path implies (a PDF starts with
`%PDF-` and says `application/pdf`), that its size and content-type differ from the host's known
catch-all, and that its text layer contains the model number being modelled. A 609,911-byte HTML shell
at a `.pdf` path fails all three. Recorded so the next pass on #130 spends its fetches on the FCC grant
index and the regional store grids - which are real documents - rather than on path guessing.
