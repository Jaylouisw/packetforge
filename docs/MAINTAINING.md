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
   naming rules, registry counts in `docs/DEVICE_REGISTRY.md`.
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
| **Huawei Enterprise** (`support.huawei.com`) | Login wall. `web_extract` returns HTTP 422 "content could not be extracted"; a real browser returns an empty page. The public `e.huawei.com` product tables survive, which is how the NetEngine capacities were confirmed - but the *fixed port lists* live on the support site. | One logged-in session, or someone pasting the port table. |
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

The spec vocabulary itself - every field, every accepted value, and the invariant a description has
to survive - is in [DEVICE_SCHEMA.md](DEVICE_SCHEMA.md).
