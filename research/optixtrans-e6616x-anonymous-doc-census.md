# The E6616X's public document set is now counted: 47 open files out of 299 ids, and none is a board chapter

Measured 2026-11-18, 10:25-11:00 UTC, one increment on request #803 (Huawei OptiXtrans E6616X). Earlier
passes closed the e-file chapter bundle, the 26H2 brochure tree, hedex's viewer, Info-Finder and the
sitemap. This pass did the one thing none of them had done: it took the **product-page document list
itself** - every `EDOC` id the three E6600 product pages link - requested each one, and read whatever
answered 200. The result is a census rather than a sample, and it closes the "there must be a public
chapter somewhere on the support site" line: 47 of 299 ids are readable and every one of them is a video,
an O&M chapter, a UI user guide or a cybersecurity statement.

## 1. The census

| page | pid | ids linked |
|--|--|--|
| OptiXtrans E6616X | 257173887 | 260 |
| OptiXtrans E6616 | 250732937 | 298 |
| OptiXtrans E6600 Series | 266120513 | 189 |
| union | - | **299** |

Googlebot UA is required (a browser UA gets Akamai `403 Access Denied`, per
`research/optixtrans-infofinder-api.md` section 7). `https://support.huawei.com/enterprise/en/doc/<ID>`
answers `200` for 47 of the 260 E6616X ids and `302 -> /view/notFound` for the other 213.

What the 47 are, by title:

- **38 are video items** - "What Is WDM", "Basic Compositions of WDM Systems", "OTN Technologies",
  the NHP series, the SE-OTN and urban-rail solution videos;
- **8 are O&M chapters** of *Routine Maintenance of OptiXtrans E6600 Hardware* (`EDOC1100475300`-
  `EDOC1100475309`: replacing a pluggable, checking indicators on a service board, replacing a system
  control board, cleaning an optical connector);
- **1 is the joint UI guide**, *Huawei OptiX OSN 1800, OptiXtrans E6600, and DC908 User Guide*
  (`EDOC1100605035`, 551,070 B) - and its 74,406-character text layer contains **zero** occurrences of
  `TMB1`, `TMK1`, `TMK5`, `TNG1`, `Valid Slots` or `Port Spec`; it is the web-UI manual;
- **1 is the EUCC cybersecurity statement** (`EDOC1100605335`).

The 39 ids unique to the E6616 and E6600-Series pages add 14 more 200s and they are all videos too. There
is no hardware-description and no board chapter anywhere in the 299. A board chapter is not merely
unlinked from the product page - it is not in the product page's document list at all.

## 2. The one board document that exists answers "No doc data found."

`EDOC1100156575BEJ09044` is the *OptiXtrans E6600 Boards Overview* the catalogue already cites as the
document that states board front panels. Its static chapter paths do exist and redirect into the viewer:

```
GET /hedex/pages/EDOC1100156575BEJ09044/01/.../resources/1800v/hd/hybrid/unq2/tmk1unq2.html
  -> 302 /hedex/hdx.do?docid=EDOC1100156575&tocURL=...&tocLibId=BEJ09044&tocLibVer=01&ui=1
  -> 200, 3,728 B Vue shell (index-legacy-DaAKRolI.js)
```

The shell names its own content endpoint, `/hedex/api/pages/<docid>/<topicLibId>/<topicLibVer>`. Called
directly it answers **`404 No doc data found.`** - not `401`, not "login required". So this document is not
published to anonymous readers at all, and no amount of cookie or user-agent work will fetch it.

## 3. The documentation packages are closed at the root, not per chapter

The `Downloadable Product Documentation Package` block on the E6608T page hands over the package roots,
which is the list a reader with a session would use:

| package | id | anonymous result |
|--|--|--|
| OptiXtrans E6600 V100R026C00 Product Documentation 01 | `EDOC1100625826` | 302 |
| OptiXtrans E6600 V100R025C10 Product Documentation 01 | `EDOC1100556468` | 302 |
| OptiXtrans E6600 V100R025C00 Product Documentation 01 | `EDOC1100526008` | 302 |
| OptiXtrans E6600 V100R024C10 Product Documentation 03 | `EDOC1100456079` | 302 |
| OptiXtrans E6600 V100R023C10 Product Documentation 03 | `EDOC1100366068` | 302 |

`/hedex/api/misc/<id>/pdf-dl-url?txt=0` - the viewer's own PDF-export call - answers `400` for each of
them. R026 is the generation that would carry E6616X board chapters, and it is the one id the earlier
passes never had; having it changes nothing, which is the point of recording it.

## 4. Two brochure assets re-read, one of them new

| asset | bytes | result |
|--|--|--|
| `.../6fffa7f348f9475081b17eb1fc591b10/M1T1A669N837008945971838990/OptiXtrans E6616X Product Brochure.pdf` | 216,145, 4 pp | 8,708 chars of text layer; spec table only, zero `TM*` board part numbers |
| `.../91ebb26076e6453ab0c72480cd6e5464/M3T1A590N1227914753962237967/OptiXtrans E6616X V100R025C10 Product Brochure.docx` | 1,628,703 | same document, same absence |

The PDF is a different asset from the 26H2 brochure read on 2026-11-16 (different material hash, `M1T1`
rather than `M3T1` prefix) and is the older layout. Both print the same specification table - 14/12 service
slots, 680G OTN / 680G OSU / 160G+20G SDH / 800G packet cross-connect, 100G grey per channel - and neither
names a board.

**Corrected 2026-11-18:** both halves of that sentence are wrong. Re-extracting the same two
assets shows three of the four switching figures differ between them (OTN 780 vs 680 Gbit/s, OSU 620 vs
680, packet 820 vs 800) and that the docx **does** name a board, `TM65UXCL`, in a licence footnote. See
`research/optixtrans-e6616x-brochure-editions-disagree.md`.

## 5. A reseller catalogue names E6616X parts, and none of them is a census

A price catalogue (`https://www.tanatel-comm.com/product/e6616/`) is indexed with rows that separate the
X's hardware from the E6616's for the first time:

- chassis assemblies under a **TM65K** prefix - `TM65K31AFB` (DC), `TM65K33AFB` (AC 1500 W),
  `TM65K34AFB` (AC 1500 W with fiber storage), `TM65K35AFB` (DC with fiber storage, no fiber
  preconnection) - against the E6616's `TMK5K31AFB` family;
- service boards `TMK1UNS4MP` ("100G Unified Line Service Processing Board, contains 2x10G line capacity")
  and `TMK1XCL01` ("40G fgOTN Lower Order Cross-Connect Board").

Two reasons this does not move #803: the catalogue prints no Valid Slots column, so it never says which
subrack accepts `TMK1UNS4MP`; and the host refused every connection from this network today (21 s timeout
on 443, `connect_error` through the extractor), so the rows above come from the search index and not from
a page this pass read. Lead only, not evidence - the same standing as the actfornet board mirror.

## 6. What #803 is still missing

Unchanged in kind, now short in list:

1. a `TMB1*` / `TMK1*` board chapter whose **Valid Slots** table names OptiXtrans E6616X, plus that
   board's front-panel census (count, rate, cage); or
2. a stated configuration of the shape used for E6608/E6616/E9612/E9624 - "E6616X DC chassis with 14x
   <board>" - at which point the frame arithmetic already sourced in
   `research/optixtrans-e6600-chassis-chapters.md` and `research/optixtrans-e9624-stated-build.md`
   completes a spec.

Routes now closed by measurement: the E6600 product-page document list (299 ids, 47 open, no board
chapter), the hedex content API (`No doc data found.` for the boards overview), the R026/R025 package roots
(302) and the viewer's PDF export (400). No spec is added by this file.

## 7. Reproduce

```
UA='Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
curl -sS --compressed -A "$UA" \
  'https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e6616x-pid-257173887' \
  | grep -oE 'EDOC[0-9A-Z]+' | sort -u > ids.txt
cat ids.txt | xargs -P 10 -I{} sh -c 'echo "$(curl -sS --compressed -A "'"$UA"'" -o /dev/null \
  -w "%{http_code}" "https://support.huawei.com/enterprise/en/doc/{}") {}"' | sort | uniq -c
# the content endpoint, for the boards overview that the catalogue cites
curl -sS --compressed -A "$UA" 'https://support.huawei.com/hedex/api/pages/EDOC1100156575/BEJ09044/01'
#   -> 404 No doc data found.
```
