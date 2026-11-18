# The E6616X's two vendor brochures disagree with each other, and one of them does name a board

Measured 2026-11-18, 13:25-13:50 UTC, one increment on request #803 (Huawei OptiXtrans E6616X).
`research/optixtrans-e6616x-anonymous-doc-census.md` section 4 ends with two claims, both made about the
pair of brochure assets it re-read that morning:

> Both print the same specification table - 14/12 service slots, 680G OTN / 680G OSU / 160G+20G SDH /
> 800G packet cross-connect, 100G grey per channel - and neither names a board.

Both halves are wrong, and wrong in opposite directions: the two documents do **not** print the same
table, and the newer one **does** name a board. Re-extracting the same two asset URLs - no new source, no
new route - gives the following. This file is the correction; it writes no spec and closes nothing.

## 1. What each asset actually says

| | PDF `M1T1A669N837008945971838990` | DOCX `M3T1A590N1227914753962237967` |
|--|--|--|
| file | `.../6fffa7f348f9475081b17eb1fc591b10/M1T1A669N837008945971838990/OptiXtrans E6616X Product Brochure.pdf` | `.../91ebb26076e6453ab0c72480cd6e5464/M3T1A590N1227914753962237967/OptiXtrans E6616X V100R025C10 Product Brochure.docx` |
| result | HTTP 200, `application/pdf`, **216,145 B**, 4 pp | HTTP 200, Word 2007+, **1,628,703 B** |
| text layer | `pdftotext -layout` -> **8,708** chars | `word/document.xml` stripped -> **5,961** chars, 1 table |
| edition string | none printed | **V100R025C10**, in the filename and on page 1 |
| highlights line | "Up to **620G OTN**, 160G SDH higher-order, and 20G SDH lower-order capacities and **820G Packet** per subrack." | "Up to **780G OTN**, **620G OSU**, 160G SDH higher-order, and 20G SDH lower-order capacities and **820G Packet** per subrack." |
| OTN cross-connect, table | **680 Gbit/s** | **780 Gbit/s**, footnoted: "The **TM65UXCL** board supports a maximum of 780 Gbit/s OTN cross-connect capacity only when a license is used." |
| OSU cross-connect, table | **680 Gbit/s** | **620 Gbit/s** - "Cross-connects 620 Gbit/s OSUflex signals and passes through 420 Gbit/s OSUflex line signals (for a maximum of 2000 services)." |
| SDH cross-connect | 160 Gbit/s VC-4, 20 Gbit/s VC-3/VC-12 | identical |
| packet switching, table | **800 Gbit/s** | **820 Gbit/s** |
| service slots | DC 14 / AC 12 | DC 14 / AC 12 |
| `TM*` board part numbers | **zero** - `grep -o 'TM[0-9][A-Z0-9]*'` returns nothing | **one: `TM65UXCL`**, in the licence footnote |

The census compared a document with itself: the docx and the PDF are two editions of one brochure, and
three of its four switching figures differ between them (OTN 780 vs 680, OSU 620 vs 680, packet 820 vs
800). Only slot count, dimensions, weight, power ranges and SDH capacity are common to both.

## 2. The PDF also disagrees with itself, inside four pages

Its highlights say 620G OTN and 820G packet; its own table on page 2 says 680G OTN/OSU and 800G packet.
The highlights line is a summary written to survive the next capacity bump, not a specification - which is
why reading it as one is the trap here. The docx is consistent with itself (780 / 620 / 820 in both
places), and its 780G is explicitly conditional on a licence.

## 3. Why this lands on #803's own text

The request body reads "Cross-connect: OTN 620G / PKT 820G / SDH 160G". 620G is the **PDF highlights**
figure, contradicted by that same PDF's table (680G) and by the newer edition (780G); 820G is the
highlights figure in both documents while the older table says 800G. A spec built from that line would
carry a capacity no vendor table states. The registry row for #803 quotes 780G OTN and 620G OSU from the
docx, which is the defensible pair - it is the newest edition and its numbers match its own table.

## 4. The board namespace is `TM65`, not `TMK5` / `TMB1`

`TM65UXCL` is the only board part number any Huawei-hosted E6616X document has yielded, and its prefix is
not the prefix of anything the catalogue models for this family: the E6616's system boards are `K5UXCME` /
`K5SXCH` / `K6XCH` (25H1 brochure) and its service boards are `B1LDCD` / `TMB1LDCD`. The X's
cross-connect is in the **`TM65`** order-code family, consistent with the `TM65K3*AFB` chassis assemblies
that only the reseller catalogue prints (`research/optixtrans-e6616x-anonymous-doc-census.md` section 5 -
lead only; that host refuses this network).

**Consequence for the recorded next step.** The registry's "what would unblock it" cell asks for "a
`TMB1*` / `TMK1*` board chapter whose Valid Slots table names OptiXtrans E6616X". The X's own board prefix
is `TM65`, so a pass that searches only `TMB1*`/`TMK1*` chapters is aimed at the sibling's namespace and
would miss the X's boards even if such a chapter were published. The next pass should ask for `TM65*`
chapters - and for a `TM65*` **service** board, because `TM65UXCL` is a cross-connect/system board with no
client ports and cannot supply a front-panel census on its own.

## 5. Routes measured dead this pass

| URL | result |
|--|--|
| `https://info.support.huawei.com/enterprise/en/optical-transmission/optixtrans-e6616x-pid-257173887` | **302**, `Location: https://support.huawei.com/` |
| `https://info.support.huawei.com/enterprise/zh/optical-transmission/optixtrans-e6616x-pid-257173887` | **302** -> same |
| `https://info.support.huawei.com/hedex/api/navi/EDOC1100558549/first-level-tree` | **302** -> same |

`info.support.huawei.com` is indexed by search engines carrying the E6616X page, so it reads like a second
support portal, but it is an **alias**: every path 302s to the `support.huawei.com` root, so the navi
three-state instrument in `research/optixtrans-e6616x-docs-gated-not-unpublished.md` does not apply there
and nothing is gained. Localised product pages are not a source for board numbers either:
`https://e.huawei.com/en/products/optical-transmission/optixtrans-e6600` answers 200 at **45,722 B** and
`.../hu/...` at **53,363 B**, and neither body carries a single `TM[56]..` order code - the table those
pages show in a browser is rendered client-side.

## 6. What #803 is still missing

Unchanged: a `TM65*` service board whose chapter states the frame it is valid in and gives its front panel
(port count, rate, cage), or a stated configuration of the shape the catalogue already uses for the
siblings - "E6616X DC chassis with 14x `<board>`". `TM65UXCL` names the frame's cross-connect, not its
ports; a capacity is not a socket count.

## 7. Reproduce

```
UA='Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'

curl -sSL --compressed -A "$UA" -o x.pdf \
  'https://e.huawei.com/marketingcloud/pep/asset/20000001/Material/6fffa7f348f9475081b17eb1fc591b10/M1T1A669N837008945971838990/OptiXtrans%20E6616X%20Product%20Brochure.pdf'
pdftotext -layout x.pdf x.txt && grep -nE '[0-9]{3} ?G(bit/s)?' x.txt

curl -sSL --compressed -A "$UA" -o b.docx \
  'https://e.huawei.com/marketingcloud/pep/asset/20000001/Material/91ebb26076e6453ab0c72480cd6e5464/M3T1A590N1227914753962237967/OptiXtrans%20E6616X%20V100R025C10%20Product%20Brochure.docx'
unzip -o -q b.docx -d dx
python -c "import re,html;s=open('dx/word/document.xml',encoding='utf-8').read();s=re.sub(r'</w:p>','\n',s);s=re.sub(r'</w:tc>',' | ',s);s=re.sub(r'<[^>]+>','',s);open('dx/doc.txt','w',encoding='utf-8').write(html.unescape(s))"
grep -nE 'TM65|Gbit/s' dx/doc.txt

curl -sS -A "$UA" -D - -o /dev/null \
  'https://info.support.huawei.com/enterprise/en/optical-transmission/optixtrans-e6616x-pid-257173887' | grep -i location
```
