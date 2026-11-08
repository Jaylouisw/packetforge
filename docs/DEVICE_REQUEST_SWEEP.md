# The device-request sweeper

`sweep-device-requests.js` answers one question per open issue: **is this hardware already in
the catalogue?** It is deliberately conservative. A missing match costs somebody a fresh
request. A wrong match closes their request by pointing at a *different product* and tells them
their hardware is supported when it is not.

Every guard below exists because the sweeper once got that question wrong on real data. The
numbers are from runs against the live tracker, and the titles are verbatim.

```bash
# report only - the default, always safe
node scripts/sweep-device-requests.js --limit 700

# comment and close up to N matches (needs FORGEJO_TOKEN or a token in the git remote)
node scripts/sweep-device-requests.js --limit 700 --close 20
```

---

## Guards, and the incident behind each

### 1. Keep the parenthetical

A title like `HUAWEI 4G Mobile WiFi 3 (E5785)` used to be cut at the first bracket, giving
`HUAWEI 4G Mobile WiFi 3` — which does not match the catalogue's `4G Mobile WiFi 3 (E5785)`.
Both the title as written *and* the bracket-free form are now tried.

> Measured: **0 of 250** requests matched before, **30 of 250** after.

### 2. Fold entities and typographic dashes

Titles were imported from a scraper that left HTML entities in place. `UF&#8209;OLT` is a
*literal string*, not an en dash, so the caps-token scan read it as the two codes `UF` and
`OLT`. `deEntity()` and `deDash()` fold every dash-like character — `U+2010`–`U+2015`, `U+2212`,
`&#8209;` — onto ASCII `-` before anything else looks at the string.

### 3. Index part numbers that live inside the model name

Aruba stores the part number in the model: `2530-48 (J9781A)`. The request says
`Aruba 2530-48 Switch (J9781A)`. No candidate the matcher tried equalled the stored model, so
**30 requests read as gaps while their specs sat in the catalogue.**

The catalogue is indexed by any parenthesised code, and a bracketed code in the title is tried
as a candidate.

### 4. Index model names that *are* codes

Ubiquiti does not bracket anything — the model is the code: `LBE-5AC-Gen2`, `US-8-60W`,
`IS-5AC`, `ES-12F`. `looksLikeModelCode()` requires a digit and a hyphen, which admits those
and rejects `5GHz` and `M4`.

> Measured: **14 → 20** matches, after the three fixes above and the entity fold.

### 5. A code must *look* like a code

The first version of guard 3 indexed every bracketed token, and `M4` indexed every Apple M4
product:

| request | matched | correct |
|---|---|---|
| `NetEngine 8000 M4` | `apple/iPad Pro 13-inch (M4)` | nothing |
| `Ubiquiti NanoStation M3 (NSM3)` | `apple/MacBook Air 13 (M3)` | nothing |
| `MIMO` | `apple/iPad Air 11-inch (M2)` | nothing |

`looksLikePartNumber()` requires **three or more digits** anywhere in the code and at most three
leading letters. That admits `J9781A`, `JL355A`, `R2W96A`, `S1T37A`; it rejects `M4`, `NSM3`,
`MIMO`, `UX`, `GBE`, `5`.

### 6. Read the vendor from the title, not from the candidate

The vendor guard compares the title's vendor with the catalogue entry's vendor, which is what
stops `Ubiquiti UniFi Cloud Gateway Ultra` matching `roku/Ultra` on the shared word *Ultra*.

It used to read the vendor off whichever candidate was being tried — so a bare-token candidate
(`M4`, `MIMO`) had no vendor to compare and skipped the check entirely. The vendor now comes
from the title, once, before any candidate loop.

### 7. Refuse an ambiguous request

Two ASUS requests read:

> `[Device]: ASUS RT-AX89U — the actual router model, catalogue only has RT-AX89X`

Indexing codes made them match `RT-AX89X`, which is exactly backwards: the reporter was saying
the catalogue has the **wrong** model. If the title names a code the catalogue lacks, and that
code is not a prefix of the code that did match, the request stays open.

A prefix is not a contradiction — `US-8-5` is a five-pack of `US-8`, and the caps-token scan of
`LBE-5AC-Gen2` produces the shorter `LBE-5AC`.

### 8. A variant is not the base model

`JL256A` is not `JL262A`; `RUT951-POE` is not `RUT951`; a five-pack is not the single unit.
`variantOfSameCode()` compares numeric segments so a request for one SKU never closes against
its neighbour.

### 9. A model key needs a digit, or two words

Single generic words — `ultra`, `ac`, `pro` — identify product lines, not products. The
exception is a code the reporter typed themselves (`(UX)`, `(GBE)`, `(LAP-GPS)`), which is
explicit enough to trust.

---

## Operating notes

- **`--close` needs the same `--limit` as the report.** The default scan is 250 issues; a
  backlog of 400 will report matches you cannot then close. This bit once: a `--close 20` run
  closed 0 of 0 while the report showed 14.
- **`--close` posts a comment first**, naming the catalogue file, then closes. Never silently.
- **A token is required** for `--close`: `FORGEJO_TOKEN` (or `GITHUB_TOKEN`), which the script
  prefers over parsing the git remote.
- **`already in the catalogue: 0` is the healthy end state** after a closing pass. If it is not
  0, either the fix has not landed or a new naming convention showed up.

## Where the tests are

`test/sweep-requests.test.js` — 79 checks. Every guard above is pinned by at least one case
built from a real title, so a "simplification" that drops a guard fails the suite rather than
quietly reopening (or mis-closing) requests.
