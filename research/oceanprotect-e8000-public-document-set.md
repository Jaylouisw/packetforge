# The E8000's public document set is two data sheets — and the one vendor book that names E8000 is retired

Follow-up to `research/oceanprotect-e8000-enumeration-gates.md`. That note closed the document *tree* and
Spare Parts Query. This pass did the thing three earlier passes had only sampled: it **counted the vendor's
public document set** for this product, read both surviving data sheets in full, and measured the one
transfer that would otherwise look tempting — importing `OceanProtect X6000/X8000`'s six interface-module
slots into the E8000 spec.

Nothing here closes #742. The front-end census is still unpublished; what changes is that the two cheapest
remaining routes are now **counted** dead ends rather than search results that came up empty.

## 1. The vendor file host carries exactly two E8000 documents, and both are data sheets

`https://e.huawei.com/robots.txt` lists 32 sitemaps. `sitemap-ebg-x-default.xml` is **1,803,417 B**, carries
**11,855** `<loc>` entries, of which **5,522** are `/documents/...` pages and **224** are under
`/en/documents/products/storage/`. All 224 were fetched and titled on 2026-11-18 (one request each,
crawler user-agent, HTTP 200): **17** are OceanProtect documents and exactly **two** are E8000 documents.

| E8000 document | page | asset |
|---|---|---|
| *V200R001C20 – Data Sheet* | `https://e.huawei.com/en/documents/products/storage/597eb7d1363f4b5da0d4ad663da1f7b6` | `.pptx`, 2,407,538 B, 4 slides |
| *– Data Sheet 26H2* | `https://e.huawei.com/en/documents/products/storage/b2c7e3c34bcb4798812106bdd494fe91` | `.pdf`, 658,756 B, 3 pp |

There is **no** E8000 Product Description, Installation Guide or Quick Installation Guide on the file host.
The 224-page set contains data sheets, white papers and solution briefs only — the numbered hardware books
exist only behind `support.huawei.com`.

## 2. Both data sheets were read in full, not sampled

Both were downloaded anonymously from `e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/…`
(the asset path is printed inline in each server-rendered page) and text-extracted — `pdftotext -layout`
for 26H2, `ppt/slides/slideN.xml` `<a:t>` runs for the pptx.

Both print the same four rows and stop there:

```
Number of Controllers per Node        2
Front-End Port Types                  16/32/64 Gbit/s Fibre Channel; 10/25/40/100GE
Front-End Storage Protocols           NFS, SMB/CIFS, FC, iSCSI, S3, FTP/SFTP, NDMP
Data Disk Types                       7.68/15.36/30.72/61.44 TB NVMe SSD / 8/10/16/20/24 TB NL-SAS
```

and neither contains the words the census needs: `interface module` **0**, `slot` **0**, `IOM` **0** in both
text extractions. Even the "36-slot" phrasing is the product page's, not the data sheet's. A data sheet that
never says *slot* cannot be the source of a slot count.

## 3. hedex: the package link resolves, the API does not

The only `Downloadable Product Documentation Package` on the family page
(`https://support.huawei.com/enterprise/en/data-protection/oceanprotect-storage-x-series-pid-262802350`,
HTTP 200, 472,163 B, crawler UA) is *OceanProtect X6000, X8000, X8100, X9000, X9100, E8000 Backup Storage
1.6.0-1.7.0 & V200R001 Product Documentation*, linked as
`https://support.huawei.com/hedex/hdx.do?docid=EDOC1100368651&lang=en`. That URL is the same 3,728 B Vite
shell `research/optixtrans-hedex-content-api.md` dissected, and the content API behind it refuses this book
family exactly as it refused the optical one:

| request | answer |
|---|---|
| `/hedex/api/navi/EDOC1100368651/first-level-tree` | **401** `{"status":401,"message":"NOT LOGIN!"}` |
| `/hedex/api/navi/EDOC1100486185/first-level-tree` | **401**, same body |
| `/hedex/api/navi/EDOC1100486186/first-level-tree` | **401**, same body |
| `/hedex/api/navi/<id>/topic/navi-tree` | **400**, `error!` |
| `/enterprise/en/doc/EDOC1100486185?idPath=…` | **302 → `/view/notFound`** |
| `/enterprise/en/doc/EDOC1100486186?idPath=…` | **302 → `/view/notFound`** |

The last two are the bare-document URLs **in the exact form the product page itself emits** (with the
`idPath=7919749|251366268|261607408|251366267|262802350` navigation context), not hand-built guesses. Bare
documents do not render for this family.

## 4. The book whose title names E8000 is retired

*OceanProtect Backup Storage 1.x and V200R001 Parts Replacement* (`EDOC1100305200`) is the one vendor book
whose chapter titles name the E8000 alongside the X6000/X8000. Two of its sections are still in search
indexes and were re-requested today:

| URL | 2026-11-18 |
|---|---|
| `…/EDOC1100305200/6cc495b9/replacing-a-controller-oceanprotect-x6000-x8000-e8000` | **302 → `/view/notFound`** |
| `…/EDOC1100305200/50297f09/how-to-distinguish-crus-and-frus` | **302 → `/view/notFound`** |

So the sections a search hit still shows are no longer served — the "one indexed section is all it takes"
route that opened the X3000 book has nothing to open here.

## 5. The trap, measured: the six-slot figure belongs to the X6000/X8000, and its document never says E8000

The one installation guide in this family that *is* readable is
`https://support.huawei.com/enterprise/en/doc/EDOC1100318730/ce945100/cabinet-layout-and-connection-planning`
— *OceanProtect X6000, X8000 1.3.0 Installation Guide (with Data Backup Feature)*, HTTP 200, 121,711 B. Its
rendered text (473,037 characters) states:

> Each of controllers A and B provides **six interface module slots**. … 12 Gbit/s SAS interface modules can
> be installed in the following slots: IOM 5 > IOM 4 > IOM 3. … Interface modules for the front-end network
> connection can be installed only in slots IOM 0, IOM 1, and IOM 4.

That sentence is why `devices/huawei/oceanprotect-x8000.json` exists. It is **not** E8000 material: the string
`E8000` occurs **zero** times in those 473,037 characters, and the book's own title scopes it to X6000/X8000.
The E8000 is a 36-slot NVMe node with 2 controllers per node; the X6000/X8000 enclosure the guide describes is
a 25-slot SAS unit. Importing six slots into an E8000 spec would be the family-sibling error this project has
corrected before (the Dorado 8000 module table, the UDW/UDW Pro pair).

## 6. Also closed: the Common Criteria Security Target

`https://www.commoncriteriaportal.org/files/epfiles/st_huawei_oceanprotect160_v1.10.pdf` (HTTP 200,
951,881 B, *CC Huawei OceanProtect Software 1.6.0 Security Target*, Issue 1.10, 2025-12-09) names the E8000
in its evaluated set — `E Series: E1000, E6000, E8000` — and carries **no hardware port census**: the only
hardware sentence is that the Storage subsystem manages "controllers, interface modules, omtask, and storage
connectivity". A role table is not a port table.

## Status of #742 after this pass

| field needed | still missing because |
|---|---|
| interface-module slots per E8000 controller | no public E8000 document contains the word `slot`; the book that names E8000 is retired |
| ports per module type | module tables live in the same gated Product Description |

Unblocking evidence is unchanged: one rendered section of `EDOC1100486186` / `EDOC1100486185` /
`EDOC1100485347`, or a stated configuration ("E8000 node, 2 controllers, 2 x 4-port 25GE IOM per controller").
What a later pass should not do is read six slots out of the X6000/X8000 guide and call it E8000.
