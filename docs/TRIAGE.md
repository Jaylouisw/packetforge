# Triage: hardware requests

Every open issue in this repository is a device request — **24 of 24** when this was last measured,
each carrying both the `device` and `device-request` labels — and a steady fraction ask for hardware
that is already modelled. Each one costs a human reading it.

The count is the part that moves, and it has moved a lot: this page has quoted 127, 126 and 121 at
different times, and the queue is now 24, because closing them is the point. So measure rather than
remember — two anonymous requests, no token needed for either:

```bash
curl -s "https://git.jayw.uk/api/v1/repos/jaylouisw/packetforge/issues?state=open&limit=1" \
  -D - -o /dev/null | grep -i '^x-total-count'          # x-total-count: 24
curl -s "https://git.jayw.uk/api/v1/repos/jaylouisw/packetforge/issues?state=open&limit=50" \
  | grep -o '"title":"\[[^]]*\]' | sort | uniq -c      # 24 "title":"[Device] - one line, nothing else
curl -s "https://git.jayw.uk/api/v1/repos/jaylouisw/packetforge/issues?state=open&type=issues&limit=50" \
  | grep -o '"name":"device[a-z-]*"' | sort | uniq -c   # 24 "name":"device" then 24 "name":"device-request"
```

The third line is the one that measures the label half of the sentence above, which the first two cannot:
a count of 24 and 24 `[Device]` titles say nothing about labels, and "each carrying both" is a claim
about all 24 device requests at once. Measured with it: **24** open, **24 of 24** with `device`, **24 of 24** with
`device-request`, **24 of 24** titles beginning `[Device]`. The `type=issues` is not decoration: the
issues endpoint serves pull requests too, from the same number space, so without it an open PR's labels
land in the same tally.

**And how much of it is work.** Re-measured on 2026-11-12 by fetching the same 24 issues anonymously and
parsing the three fields the form guarantees — vendor, exact model, datasheet URL — then matching
vendor and model against `loadCatalog()` (normalised, then a loose prefix pass in both directions):
**24 open, 24 ready, 0 waiting on a requester, 0 already in the catalogue.** Every open request names a
manufacturer, an exact model and a URL, and not one of them — not even as a near-miss on a name root —
is a device the catalogue already models. So the queue is not padded: those 24 are all implementable
work, which is the number worth knowing before anyone claims the backlog is full of duplicates.

`scripts/sweep-device-requests.js` answers, mechanically, the only question that matters before anyone
reads the body: **is this already in the catalogue?**

The exception this page used to name — because a page that says "every" invites a reader to stop
checking — was **#1335** ("The console over HTTP has its own counters…"), which carried **no labels at
all** and was not a device request. It is closed now, and the current queue holds no unlabelled issue,
so the exception is history rather than a live example. Keep the rule it taught: the sweep below finds a
device request by its **title prefix**, never by its labels, which is why an unlabelled one would still
be found. The script does not care either way, and that is the more useful fact —
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
and exits **1** before parsing anything — the public API answers anonymous reads, but a write does not.
Measured, and worth knowing before you wire it into a script that reads exit codes: the failure is an
uncaught `Error:` with a stack trace rather than a tidy message, so the difference between "not
configured" and "found nothing" is the non-zero code and the word `Error:`, nothing else.

A **bad** token is a third case, and it fails with a non-zero code but no parseable reason.
`PF_TOKEN=bogus` (or a real variable with a revoked token) first prints the two setup lines —
`catalogue: 1661 models, 1659 distinct normalised model names` and `scanning up to N open issues`, so it
announces a scan it never completes — and then
`error: 401 {"message":"user does not exist [uid: 0, name: ]", …}`, exiting **1**. An earlier reading of
this page recorded a Node assertion instead (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`)
and exit **127**; four runs on this host today produced neither, so treat the *shape* as the stable fact
— non-zero exit, `error: 401` on stderr, nothing scanned — and the exact code as host- and
timing-dependent. Either way do not read a 127 or a 401 as an empty queue. Point `PF_API` at another
instance if you are sweeping one.

The script's own header still says the repository "has ~830 open issues"; it has **24** (measured
against the tracker: `x-total-count` on the `limit=1` request above, which is the number this page
should be re-measured rather than re-quoted — it has fallen from 127 to 24 while this page sat here).
Nothing reads that comment, and `--limit 200` still covers the whole queue, as the default does — but do
not quote the header as if it were a count.

**Which script the last three paragraphs are about.** All of them are `scripts/sweep-device-requests.js`.
Its neighbour `scripts/request-queue.js` — the queue described in
[`REQUESTING-HARDWARE.md`](REQUESTING-HARDWARE.md) — fails differently, and confusing the two is easy
because both read the same tracker through the same module: it prints `Could not read issues from
jaylouisw/packetforge.` and one reason line (`FORGEJO_TOKEN is not set - the tracker is not readable
without it (this is not the same as "no open requests")`, or `not authorised to read jaylouisw/packetforge
(HTTP 401) - check FORGEJO_TOKEN`), then exits **2**, deliberately — the comment above the call reads
*"Exit 2, not 0: 'could not look' must never be reported as 'nothing to do'".* No setup lines and no stack
trace in either branch. Measured: both failure modes exit 2, with `bogus` and with no variable at all.

Two flags exist and no others. `--limit` caps how many open issues are fetched and **defaults to
200** — the queue has not been near that since this page was written, so the flag is only needed
once it grows past it (`--limit 900` scans a large backlog in one pass). Note that the API caps
a page at **50** regardless: the script paginates, so `--limit 200` is *at most* four requests, not one,
and the `limit=1` count above is the only request whose size you can predict. Read that "at most"
literally: with today's 24 open issues the first page comes back short of 50, the loop breaks on it
(`scripts/sweep-device-requests.js:119`, `if (batch.length < LIMIT_PER_PAGE) break;`) and the scan is
**one** request however large `--limit` is. The four-request case is what a backlog of 200+ would cost,
not what this queue costs today. That is why `LIMIT_PER_PAGE`
is 50 and not 200: the loop stops when a page comes back short (`batch.length < LIMIT_PER_PAGE`), so a
page size *above* the server's cap would end the scan after one page and report a quiet fraction of
the queue. The cap and the constant have to agree, and today they agree *exactly* — measured:
`limit=51` returns **50** items, `limit=50` returns 50 — so `LIMIT_PER_PAGE = 50` sits on the cap with
no headroom. The open queue cannot show this any more, because 24 issues fit inside every candidate cap;
measure it against the archive instead, which does not:

```console
$ curl -s -D - -o /dev/null 'http://odin:3000/api/v1/repos/jaylouisw/packetforge/issues?state=all&type=issues&limit=51&page=1' \
    | grep -iE '^(x-total-count|link):'    # X-Total-Count: 960, Link: …limit=51&page=2… rel="next"
$ curl -s 'http://odin:3000/api/v1/repos/jaylouisw/packetforge/issues?state=all&type=issues&limit=51&page=1' \
    | grep -o '"number":' | wc -l         # 50
```

Two things about that response are worth copying down, because both mislead a first reading. The
`Link` header **echoes the limit you asked for** — `limit=51&page=2`, and `page=20` for `rel="last"` — while
the body is capped at 50, so the header is not the place to learn the cap; the count in the body is. And
every URL in `Link` is rewritten to the server's **canonical host**, `https://git.jayw.uk/…`, even though
the request went to `odin:3000`, so a client that follows a `rel="next"` link stops talking to the host it
started with. Re-measured on 2026-11-12 against `odin:3000`. On `state=open` each of `limit=50`, `51` and
`200` returns 24 — the queue is smaller than any cap this page could test, which is why the reading above
needed the 960-odd archived issues to exist at all. If the server's cap ever drops below 50, the sweep keeps working and quietly scans one
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
which matters, because the catalogue has both. It is not a theoretical worry: **104 of the 1,661
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
