# The E9600 board datasheet has a name, a document ID and a vendor link — and the viewer will not serve it

Follow-up to `research/optixtrans-board-census.md`. That note ended on a board matrix that only a
partner mirror carried, and on a second blocker it called an engine gap. This pass read the E9605,
E9612 and E9624 product pages with a crawler user-agent, which turns the first blocker into a
*named, linkable, vendor-hosted document* — and closes the second one out of the catalogue's own
precedent rather than out of a new engine type.

## 1. The vendor names the document that holds the matrix

`https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e9605-pid-250732995`
(read 2026-11-17, HTTP 200, 436,367 bytes, crawler user-agent) lists, under **Datasheet**:

> OptiXtrans E9600 Board Datasheet
> → `/enterprise/en/doc/EDOC1100163901?idPath=24030884|9856748|9858640|250707904|250732995`

The same entry appears on the E9612 (`optixtrans-e9612-pid-250733000`) and E9624
(`optixtrans-e9624-pid-250733004`) pages, with the same document ID and only the trailing `idPath`
product ID changed. So the board→subrack matrix is not "unpublished": Huawei publishes a datasheet
for it and links it from every frame's support page. What follows is about reaching it.

## 2. Every anonymous route to EDOC1100163901 answers 404

All probes below used the crawler user-agent that is known to get full server-rendered documentation
from this host, on 2026-11-17:

| URL | Result |
|--|--|
| `https://support.huawei.com/enterprise/en/doc/EDOC1100163901?idPath=24030884%7C9856748%7C9858640%7C250707904%7C250732995` | 302 → `https://support.huawei.com/view/notFound`, **404**, 452,479 bytes |
| `https://support.huawei.com/enterprise/ru/doc/EDOC1100163901?idPath=…` (same idPath) | **404** → `view/notFound`, 452,479 bytes |
| `https://support.huawei.com/enterprise/en/datasheet/optixtrans-e9600-board-datasheet-pid-250732995` | **200**, 436,427 bytes — but the body is the *product page* again, `<title>Huawei OptiXtrans E9605 Support Guide…`; the slug is ignored, so this is not a datasheet landing |
| `https://support.huawei.com/hedex/hdx.do?docid=EDOC1100163901&lang=en` | **200**, 3,728 bytes, `<title></title>` — the single-page-app shell; adding `&format=json` returns the identical 3,728-byte HTML, so there is no anonymous content API |

**Control, so that these 404s are not read as "the crawler route is broken":**
`https://support.huawei.com/enterprise/en/doc/EDOC1100318733/4f560405/cabinet-layout-and-connection-planning`
returns **200, 517,177 bytes**, `<title>Cabinet Layout and Connection Planning - OceanProtect X3000
1.3.0 Installation Guide (with Data Backup Feature) - Huawei`, with full document chrome. The host
serves section URLs of the shape `/enterprise/en/doc/<EDOC>/<8-hex-section>/<slug>` to this agent;
it does not serve a bare `/enterprise/en/doc/<EDOC>` even with its `idPath`.

## 3. The current-generation documents fail the same way

The E9605 page's document set also lists, for the newest release:

| Document | ID | Landing result |
|--|--|--|
| OptiXtrans E9600 V100R026C00 Hardware Description | `EDOC1100625542` | **404** → `view/notFound` |
| OptiXtrans E9600 V100R026C00 Product Description | `EDOC1100622610` | **404** → `view/notFound` |
| OptiXtrans E9600 V100R026C00 Feature Description | `EDOC1100622612` | **404** → `view/notFound` |

So the "Boards" chapter of the *current* hardware description is as unreachable as the datasheet —
but only through these shapes: a section URL needs the 8-hex slug, and nothing in the product page,
the search engines, or `hedex/hdx.do` will hand one out for these document IDs. The earlier X3000
success only happened because a search engine had indexed one of that document's sections.

What *is* citable from the frame side is unchanged and vendor-hosted:

- `https://e.huawei.com/en/products/optical-transmission/optixtrans-e9600` — spec table, `Number of
  Service Slots: 12/24 | 13 | 5`.
- `https://e.huawei.com/marketingcloud/pep/asset/20000001/Material/0f9e00e3f2ca431693884a01667d7ec6/M3T1A669N1188254857740624027/OptiXtrans%20E9600%20Family%20-.pdf`
  — 277,705 bytes, `Max. number of service board slots … 13 … 5`, no board list.

## 4. Correction: the second blocker is not an engine gap

`research/optixtrans-board-census.md` §2 concluded that the family is additionally blocked because
`engine/media.js` has no `otn` / `wdm` port type, so a `TNG1N210`'s SFP+ line ports could only be
filed as Ethernet. That conclusion does not survive the catalogue. Four merged specs already file a
WDM or OTN line side as an Ethernet cage, and say so in the description rather than in a new type:

| spec | line-side ports | how it is declared |
|--|--|--|
| `devices/ciena/6500-s14.json` | `line1`–`line4`, 200G coherent | `type: ethernet, connector: qsfp28`; description: *"4 line ports at 200G (modelled at this engine's 100G ceiling)"* |
| `devices/adva/fsp-3000.json` | 16 coherent line ports | `ethernet/qsfp28`; *"modelled at this engine's 100G ceiling"* |
| `devices/nokia/1830-pss-24x.json` | `line1`–`line8`, coherent, 200G–400G | `ethernet/qsfp28`; same caveat |
| `devices/packetlight/pl-2000m.json` | single 200G coherent uplink | `ethernet/qsfp28`; same caveat |

So an E9605 built as `5 x TNG1N210` would not need a new port type; its line ports would be
`ethernet` / `sfp+` with the same prose caveat the four devices above carry. **The only thing still
missing is the board→subrack matrix, i.e. the contents of EDOC1100163901.** The stated configuration
that would be written the moment that table is readable is `E9605 (5 x TNG1N210)` = 50 x 10G SFP+
line ports, 100G-free, no PoE, category `switch`/OTN node.

## 5. What would unblock #807, #808 and #810

One of:

1. A Huawei partner or support login that can open **OptiXtrans E9600 Board Datasheet
   (EDOC1100163901)** and paste the "boards supported per subrack" table — three columns, `Y` / `NA`
   per board family, exactly as the partner mirror reprints it.
2. Any indexed section URL of `EDOC1100625542` (V100R026C00 Hardware Description) whose slug starts
   with `board`.
3. A Huawei-hosted PDF of the board datasheet on `e.huawei.com` — the family brochure is there and
   carries no board list, so this may simply not exist.

No spec is added by this file: the frame arithmetic is public, the card arithmetic is public in the
product documentation Huawei withholds, and a `Y`/`NA` matrix from a partner mirror is a lead, not a
source.
