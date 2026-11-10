# Triage: hardware requests

Nearly every open issue in this repository is a device request — **126 of 127** when this was measured,
each carrying both the `device` and `device-request` labels — and a steady fraction ask for hardware
that is already modelled. Each one costs a human reading it.
`scripts/sweep-device-requests.js` answers, mechanically, the only question that matters before anyone
reads the body: **is this already in the catalogue?**

The exception is worth knowing by name, because a page that says "every" invites a reader to stop
checking: **#1335** ("The console over HTTP has its own counters…") carries **no labels at all** and is
not a device request. The script does not care either way, and that is the more useful fact —
it counts a device request by the **title prefix** (`[device]` / `[hardware]`, case-insensitive),
never by label. So an unlabelled `[device]` request is found like any other, and #1335 is scanned only
as a body to match against the catalogue — which is why the sweep is safe to run over the whole queue
rather than a filtered one.

The count moves, so re-measure rather than trusting this page. The API is readable without a token:

```bash
curl -s -D - -o /dev/null \
  'https://git.jayw.uk/api/v1/repos/jaylouisw/packetforge/issues?state=open&type=issues&limit=1' \
  | grep -i x-total-count
```

```
node scripts/sweep-device-requests.js                  # report only
node scripts/sweep-device-requests.js --limit 900      # scan the whole backlog
node scripts/sweep-device-requests.js --close 10       # comment and close 10 verified matches
```

**Before the flags, the network.** This paragraph used to say the script was pinned to a LAN address
and scraped its token from a git remote, which was true of an older version and is now wrong in both
halves. Measured against `scripts/forgejo-api.js`, which the sweep imports:

| What | Where it comes from today |
|---|---|
| Base URL | `const API = (process.env.PF_API \|\| canonical.WEB) + '/api/v1'` — the **public** host, not a LAN address; `PF_API` overrides it |
| Token | `process.env.FORGEJO_TOKEN \|\| process.env.PF_TOKEN` — the environment only, nothing is read out of `git remote` |

So the read-only sweep works from anywhere, and so does closing: set the token and go. Without one the
script says *"the tracker is not readable without it (this is not the same as \"no open requests\")"*
and exits **2** before parsing anything — the public API answers anonymous reads, but a write does not.
Point `PF_API` at another instance if you are sweeping one.

The script's own header still says the repository "has ~830 open issues"; it has **121** (measured
against the tracker: `x-total-count` on the `limit=1` request above, which is the number this page
should be re-measured rather than re-quoted — it moved from 127 in an afternoon). Nothing reads that
comment, and `--limit 200` still covers the whole queue, as the default does — but do not quote the
header as if it were a count.

Two flags exist and no others. `--limit` caps how many open issues are fetched and **defaults to
200** — with the backlog at 127 that default already covers everything, so the flag is only needed
once the queue grows past it (`--limit 900` scans a large backlog in one pass). Note that the API caps
a page at **50** regardless: the script paginates, so `--limit 200` is four requests, not one, and the
`limit=1` count above is the only request whose size you can predict. That is why `LIMIT_PER_PAGE`
is 50 and not 200: the loop stops when a page comes back short (`batch.length < LIMIT_PER_PAGE`), so a
page size *above* the server's cap would end the scan after one page and report a quiet fraction of
the queue. The cap and the constant have to agree, and today they agree *exactly* — measured:
`limit=51` returns **50** items, `limit=50` returns 50 — so `LIMIT_PER_PAGE = 50` sits on the cap with
no headroom. If the server's cap ever drops below 50, the sweep keeps working and quietly scans one
page; if it rises, nothing changes. That asymmetry is the reason this paragraph exists. `--close` is a
budget, not a switch: `--close 0` (the default) reports, and the report itself prints at most 40
matches before saying "... and N more".

## How the lookup works

One pass, three attempts per title, each attempt subject to the same guards below:

1. the whole remaining title, normalised, looked up as **vendor + model**, then as **model**;
2. failing that, a **trailing run of tokens**, longest first, so `MikroTik Cloud Core Router
   CCR2004-16G-2S+` finds `CCR2004-16G-2S+` without the script having to know that "Cloud Core
   Router" is filler;
3. failing that, nothing — the request stays open.

Every hit is exact after normalisation. There is no edit distance and no similarity score anywhere
in the file.

## What counts as a match

The script parses the subject out of the title and looks it up by normalised model name, then by
vendor + model. Nothing fuzzy: no edit distance, no similarity score, no "probably the same box".

Two guards exist because the first version closed requests wrongly, and that is worse than leaving
them open: telling someone their hardware is modelled when it is not wastes their time twice.

### The vendor must agree

`[Device]: Ubiquiti UniFi Cloud Gateway Ultra` matched `roku/Ultra` on the shared word **Ultra**.
Three Ubiquiti requests were one keystroke from being closed pointing at a streaming stick. A match
is now rejected unless the vendor in the title, where the title names a known vendor, matches the
catalogue entry's vendor.

### A model key needs a digit, or two words

Single generic words identify product *lines*, not products. `Ultra` is not a model; `Wave-Pro` is;
`AX3` is. The guard is crude and deliberately so — it costs a few missed matches and buys the
absence of confidently wrong ones.

### Normalisation keeps `+`

Stripping punctuation made `WiFi Mesh 3+` and `WiFi Mesh 3` the same key — and a request for the
`+` variant was matching the box that is not the `+` variant. `+` becomes the word `plus` and
everything else becomes a separator, so `RB5009UPr+S+IN` and `RB5009UPr+S+OUT` stay distinct —
which matters, because the catalogue has both. It is not a theoretical worry: **104 of the 1,650
models carry a `+`** (145 if you count display labels, which the slug never sees). `++` is folded to `plusplus` ahead of the single-`+` rule; no current model
uses one, so that branch is defensive rather than exercised.

## What a close says

Each close posts a comment naming the vendor, the model, the file and the category, and invites the
reporter to disagree about the ports:

> This device is in the catalogue: **TP-Link TL-SG105E** (`devices/tp-link/tl-sg105e.json`).
>
> Filed under `switch`. If the port count, cage or rate is wrong for your hardware, say so and it
> gets fixed - a spec that disagrees with the box is a bug here, not a preference.
>
> Closed as already modelled.

That last sentence is the point of the project, and it is also the honest position: a request being
"satisfied" means a spec exists, not that the spec is right.

## What it does not do

- It does not read the request body. A title asking for a 48-port model may be matched to a 24-port
  one with the same name root — check before closing in bulk.
- It does not find *near* misses. A request for a model one revision newer than the catalogue entry
  stays open, which is correct: that is a different device.
- It does not close anything without `--close N`. The default is a report.
