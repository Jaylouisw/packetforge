# Maintaining the hardware library

The catalogue is the product. This page is how a vendor gets from "somebody asked for it" to a
reviewed pull request, and what to do when the usual route fails.

## The loop

1. **A request arrives** as an issue titled `[Device]: <Vendor> <Model>`. `GET /api/requests`
   returns the open ones; the simulator's device palette shows the matching subset next to
   catalogue hits.
2. **A spec is written** as `devices/<vendor>/<model>.json`. Only the ports and capabilities the
   engine can act on belong in it - a serial console, a USB port or an FXS line is a note, not an
   interface.
3. **The importer checks it** (`node scripts/import-devices.js --apply`): schema, duplicate
   spellings, unknown interface types, unknown capabilities. It refuses rather than guesses, and
   its refusals are how most bad entries surface.
4. **The suite checks it** (`npm test`): catalogue invariants, spec-versus-description agreement,
   naming rules, registry counts in `docs/DEVICE_REGISTRY.md`. Do not edit those counts by hand —
   run `npm run regen:registry-doc` and let it print the numbers from `loadCatalog()`. Hand-editing
   them is how `main` goes red for everybody: a batch that merges while a second batch updates the
   same sentence leaves the page describing a catalogue that no longer exists, and every open pull
   request is branched from a commit before the drift, so one stale sentence blocks the whole queue.
5. **The request is closed** with a comment naming the file and the facts worth knowing.

## Getting the ports out of a vendor

Datasheets lie in a specific way: not with wrong numbers, but with numbers that belong to a
different part of the family. The order of preference below is about which source makes that
least likely.

| source | reliability | example |
|---|---|---|
| **rendered spec page** (text in the DOM) | highest for current models | Ubiquiti tech specs |
| **datasheet PDF, text layer** | high, and it usually states the port table explicitly | Peplink, Teltonika, DrayTek, NETGEAR |
| **vendor wiki interface tables** | high for interface *counts*, silent on speeds | Teltonika wiki |
| **reseller or distributor listing** | lowest — last resort, and say so in the note | third-party shops |
| **a vendor page that flags its own data** | **none** — do not use it | Garland (2026-11) |

### Scripts that do the boring part

Each takes candidate URLs from a `research/_<vendor>_urls.json` file and prints the lines that
decide a deployment. They never write a spec; they only quote the vendor.

| script | what it pulls |
|---|---|
| `scripts/netgear-rows.py` | port counts, PoE counts, power budgets |
| `scripts/draytek-rows.py` | diagram callouts (`5x 1GbE RJ-45 LAN Ports`) |
| `scripts/teltonika-rows.py` | prose port lines (`1 x WAN port 10/100 Mbps`) |
| `scripts/peplink-rows.py` | `Number of Ethernet WAN port` rows and SpeedFusion throughput |
| `scripts/extract-peplink-pdf.py` | the earlier, simpler Peplink pass |

PDFs are cached in `research/pdf/`, which is **gitignored**: vendor documents do not belong in
this repository, and a 25 MB cache committed by accident is a mistake that stays in the history.
`research/_*.json` is ignored for the same reason - they are working files, not sources of truth.

## Rules that the importer and the suite enforce

- **One spec per physical device.** Punctuation is not identity: `MAX-BR1-PRO-5G` and
  `MAX BR1 Pro 5G` are the same box, and adding the second spelling is refused.
- **Ports are what the engine can forward on.** A serial port, an FXS line, a USB port and an
  RS485 bus are recorded in `notes` with the reason, because they are physically present but not
  interfaces this simulator can model.
- **A capability is a promise.** `poe-pse` says a port can power something; `l3-forward` says the
  box routes. Claiming either without a source makes the simulator confidently wrong.
- **The description and the ports must agree.** `test/spec-vs-description.test.js` fails an entry
  whose prose promises more ports than it has, or that claims to be PoE-powered while handing out
  power it cannot supply.
- **Nothing is invented.** If a datasheet gives a range across a family (`4-28 x SFP+`), the model
  stays out of the catalogue until one number can be attributed to it. An absent device is a gap;
  a guessed port count is a trap.

## Vendors whose sources are currently unusable

A wall is worth recording once, so nobody spends a second iteration on it. Each of these was
attempted from this host with a plain fetch, a PDF download and a real browser before being
written down.

| vendor | what blocks it | what would unblock it |
|---|---|---|
| **FS.com** | CloudFront refuses the host outright: plain fetch returns 0 bytes, the browser gets `ERROR: The request could not be satisfied`, and per-model datasheets 404 at every pattern except `ap-n505` / `ap-t567`. | A copy of the datasheets, or a network that FS will serve. |
| **Huawei Enterprise** (`support.huawei.com`) | Login wall: `web_extract` returns HTTP 422, a browser returns an empty page. **But `e.huawei.com` is not walled** - the marketing datasheet PDFs download and read cleanly, port tables included. That is how `netengine-8000-m1d-b.json` was built. | Nothing for the fixed 1U boxes. The modular chassis still need a card complement or a SKU. |
| **Garland Technology** | Their own pages carry a banner: *"Internal review build. Anything shown in amber is data we could not confirm from the source spreadsheets … Cards with unconfirmed specs also carry an amber 'Needs Info' pill."* Most cards name no model at all. | The published datasheets, once the site leaves review. |
| **Hikvision** (partial) | One datasheet (`DS-3E1309P-EI`) returns 403 while its siblings download fine; one request ("Web managed 8P PoE Switch") names no model to look up. | A mirror of that one PDF; a part number for the other. |

The rule that follows from all four: **an unbuildable request stays open with the reason attached**.
Closing it hides a real gap; inventing a spec to close it poisons the catalogue. The comments on
those issues name the exact URL and the exact failure, so the next attempt starts where this one
stopped instead of at the beginning.

## When a vendor is hard

- **Image-only PDFs** — the text layer is empty. Go to the vendor's wiki interface table or the
  product page, and record in the note which source the count came from.
- **Specs behind a JS app** — the DOM renders them; a browser session can read `innerText`.
- **Family-wide datasheets** — the numbers are ranges across several SKUs. Do not average them.
- **Duplicate model stems** — `USW-Pro-Max-16` and `-16-PoE` differ by a suffix and by whether
  they supply power at all. Check the suffix.
- **A vendor site mid-migration.** Garland's fiber and copper TAP pages currently carry the banner
  *"Internal review build. Anything shown in amber is data we could not confirm from the source
  spreadsheets"*, and most cards show no model number at all while marked *"Needs Info"*. Those
  thirteen TAP requests stay **open and unbuilt**: the vendor is telling us the numbers are not yet
  trustworthy, and copying them into the catalogue would launder an unconfirmed spec into an
  authoritative-looking one. Wait for the datasheets, or find the models on a page that is not
  flagged.

### Port tables that are really four tables

A carrier datasheet often quotes maxima: *"up to 16×10GE, 2×25GE, 2×50GE"*, *"maximum number of
physical ports on the entire device: 280"*. That is not a port list, and a spec built from it
advertises ports the box does not have until someone configures it or buys a licence.

Ask these three questions before writing a single interface. The NetEngine 8000 line needs all
three, which is why one of its boxes is in the catalogue and the rest are not yet:

1. **Is there a default mode?** The M1D-B datasheet names one - `eth-2x50ge-2x25ge-2x10gf-14xgf-mode` -
   and that default is what `netengine-8000-m1d-b.json` models, with the other three modes and their
   maxima recorded in the note. A stated default is a fact; picking between the modes yourself is
   not.
2. **Is the chassis modular?** M4/M6/M8/M14 are slot machines: the port count is whatever cards are
   in them. The catalogue's precedent for this is `devices/arista/7504r.json`, labelled
   *"7504R (4x 36CQ)"* - the card complement goes in the label, because the model number alone does
   not describe the hardware.
3. **Is the port count licensed or SKU-specific?** On the NetEngine 8000 F1A, ports 48-55 are 100GE
   only with a licence RTU; without it they are 40GE/50GE or four-way split. The SKU matters
   (`F1A-8H20Q` is not `F1A`), and a spec that ignores the licence overstates the box by 800G.

If none of the three can be answered from an open source, the request stays open with the reason
attached. None of these three is a reason to close a request: see [RESOLUTIONS.md](RESOLUTIONS.md). That is the same decision as a walled vendor, arrived at differently.

The spec vocabulary itself - every field, every accepted value, and the invariant a description has
to survive - is in [DEVICE_SCHEMA.md](DEVICE_SCHEMA.md).
