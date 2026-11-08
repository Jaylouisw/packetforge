# Triage: hardware requests

Most of this repository's open issues are device requests — around 800 at the time of writing — and
a steady fraction of them ask for hardware that is already modelled. Each one costs a human reading
it. `scripts/sweep-device-requests.js` answers, mechanically, the only question that matters before
anyone reads the body: **is this already in the catalogue?**

```
node scripts/sweep-device-requests.js                  # report only
node scripts/sweep-device-requests.js --limit 900      # scan the whole backlog
node scripts/sweep-device-requests.js --close 10       # comment and close 10 verified matches
```

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

Stripping punctuation made `WiFi Mesh 3+` and `WiFi Mesh 3` the same key, and they are different
products. `+` becomes the word `plus` and everything else becomes a separator, so `RB5009UPr+S+IN`
and `RB5009UPr+S+OUT` stay distinct — which matters, because the catalogue has both.

## What a close says

Each close posts a comment naming the vendor, the model, the file and the category, and invites the
reporter to disagree about the ports:

> This device is in the catalogue: **TP-Link TL-SG105E** (`devices/tp-link/tl-sg105e.json`).
> Filed under `switch`. If the port count, cage or rate is wrong for your hardware, say so and it
> gets fixed — a spec that disagrees with the box is a bug here, not a preference.

That last sentence is the point of the project, and it is also the honest position: a request being
"satisfied" means a spec exists, not that the spec is right.

## What it does not do

- It does not read the request body. A title asking for a 48-port model may be matched to a 24-port
  one with the same name root — check before closing in bulk.
- It does not find *near* misses. A request for a model one revision newer than the catalogue entry
  stays open, which is correct: that is a different device.
- It does not close anything without `--close N`. The default is a report.
