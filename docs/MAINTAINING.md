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

## When a vendor is hard

- **Image-only PDFs** — the text layer is empty. Go to the vendor's wiki interface table or the
  product page, and record in the note which source the count came from.
- **Specs behind a JS app** — the DOM renders them; a browser session can read `innerText`.
- **Family-wide datasheets** — the numbers are ranges across several SKUs. Do not average them.
- **Duplicate model stems** — `USW-Pro-Max-16` and `-16-PoE` differ by a suffix and by whether
  they supply power at all. Check the suffix.
