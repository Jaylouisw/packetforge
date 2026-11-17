# The OceanProtect port census is not behind a login wall — it is behind an unindexed section slug

Three open device requests ask for an OceanProtect node and its ports: #741 (X8000/X9000), #742 (E8000)
and #743 (X8100/X9100). All three were parked on the same sentence — Huawei publishes front-end port
*types* and a controller count, never a port *count*, and the configuration-specific tables live on
`support.huawei.com`, which an earlier pass recorded as a login wall. The wall part is wrong, and this
note records what is actually in the way.

## What the public spec table really says (read 2026-11-17)

`https://e.huawei.com/en/products/storage/oceanprotect/x100-series`, X8100/X9100 columns:

> Number of Controllers | **2** (X8100) | **2** (X8100) | **4** (X9100) | **4** (X9100)
>
> Maximum Number of Controllers | **4** | **4** | **8** | **8**
>
> Front-End Port Types | 16/32/64 Gbit/s Fibre Channel; 10/25/40/100GE

`https://e.huawei.com/marketingcloud/pep/asset/20000001/Material/9f5f91eed2a44fef9ffc21f94fe26982/M3T1A590N1101096260646756423/Huawei%20OceanProtect%20X8000%20Backup%20Storage%20-%20Data%20Sheet.pdf`
(Huawei OceanProtect X8000 Data Sheet) and the all-series data sheet carry the same shape for
X3000/X6000/X8000/X9000: `Front-End Port Types | 8/16/32/64 Gb FC, 1/10/25/40/100 GbE`. There is no
port-count row in any of them, and nothing that says how many interface modules a node holds.

## The access finding: a crawler user-agent gets the whole page

The 2026-11-09 comment on #743 ("plain fetch returns HTTP 422; a real browser returns an empty page")
is superseded. A crawler user-agent gets HTTP 200 with the full server-rendered text, verified this
pass on sibling documents:

- `https://support.huawei.com/enterprise/en/doc/EDOC1100318730/ce945100/cabinet-layout-and-connection-planning`
  — *OceanProtect X6000, X8000 1.3.0 Installation Guide (with Data Backup Feature)*, HTTP 200,
  567,916 bytes, complete document chrome and body.
- `https://support.huawei.com/enterprise/en/doc/EDOC1100318733/4f560405/cabinet-layout-and-connection-planning`
  — *OceanProtect X3000 1.3.0 Installation Guide (with Data Backup Feature)*, HTTP 200, 517,177 bytes.

So the login wall is not a wall. The real obstacle is URL shape: the viewer only serves
`/enterprise/en/doc/<EDOC>/<8-hex-section>/<slug>`, and the bare `/enterprise/en/doc/<EDOC>` answers
HTTP 404 via `https://support.huawei.com/view/notFound`.

## The documents that do carry the census, and why they are not readable yet

The X8100 product page (`https://support.huawei.com/enterprise/en/data-protection/oceanprotect-x8100-pid-268353477`,
HTTP 200) lists the document set. The ones that would answer this are:

| Document | ID | Status 2026-11-17 |
|---|---|---|
| OceanProtect X6000, X8000, X8100 1.6.0-1.7.0 & V200R001 Product Description | EDOC1100368229 | doc root 404 |
| OceanProtect X9000, X9100 1.6.0-1.7.0 & V200R001 Product Description | EDOC1100368230 | doc root 404 |
| OceanProtect E8000 V200R001 Product Description | EDOC1100486186 | doc root 404 |
| OceanProtect X6000, X8000, X8100 1.x & V200R001 Hardware Installation Guide | EDOC1100305240 | doc root 404 |
| OceanProtect X9000, X9100 1.x & V200R001 Hardware Installation Guide | EDOC1100305243 | doc root 404 |
| OceanProtect E8000 V200R001 Hardware Installation Guide | EDOC1100486185 | doc root 404 |

The document IDs are published; their internal section slugs are what the viewer needs, and no search
engine has indexed a section of this set (the X6000/X8000 1.3.0 and X3000 1.3.0 sections above were
found indexed, which is how they were read). One indexed section from this family is all it takes.

## The trap: the module table that looks like the answer belongs to another product

A search for "interface module" + "100GE" surfaces
`https://support.huawei.com/enterprise/en/doc/EDOC1100484689/bb36e2c/connection-planning-between-the-storage-system-and-application-server`,
whose Table 6-1 is exactly the shape wanted — GE 4 ports, 10GE 4, 40GE 2, 100GE 2, 16/32/64 Gb FC 4,
10/25GE 4 — and whose Table 6-2 gives the back-end modules (12 Gb SAS 4, 100 Gb RDMA 2). Its real
title, read off the page, is **OceanStor Dorado 8000 and Dorado 18000 V700R001 Site Planning Guide**.
It is not an OceanProtect document, and importing its module list into a backup array would be the
family-sibling error this project has corrected repeatedly. Recorded here so the next pass does not
make it.

Same hazard, closer to home: the X3000 installation guide above states "each of controllers A and B
provides two interface module slots" and "2 x 10GE onboard optical ports". That is the **X3000**, a
1U-class node, not the X8100. It does not transfer.

## What a converted fix looks like

The catalogue can express a flat port list, so each of these needs one stated configuration:

- **X8100 / X9100 (#743)** — interface modules per controller and which slots take front-end modules,
  plus whatever onboard front-end ports the node has. Either a base ordering configuration ("X8100
  node, 2 controllers, 2 x 4-port 25GE IOM per controller") or the Product Description's interface
  module table plus its per-controller slot count.
- **X8000 / X9000 (#741)** — the same two numbers for a 2-controller and a 4-controller node.
- **E8000 (#742)** — no interface table on the page and none in the datasheet (both read below), so
  its Product Description (EDOC1100486186) is still the only route.

Until then these stay open. This note converts none of them; it removes the "login wall" explanation
that has been standing in for a real diagnosis three times, and names the exact document a reader has
to open.

## E8000: the primary datasheet was readable, and it stops at port *types* too (2026-11-17)

The E8000 request has one source the other two do not: a downloadable datasheet. It was fetched and
transcribed this pass, and it settles the E8000 half of the question without unblocking it.

Product page `https://e.huawei.com/en/products/storage/oceanprotect/oceanprotect-e8000` (HTTP 200,
343,723 bytes) links a datasheet through `https://e.huawei.com/en/documents/products/storage/597eb7d1363f4b5da0d4ad663da1f7b6`
(HTTP 200, HTML wrapper), whose `attachmentUrl` is a **PowerPoint**, not a PDF:

```
https://e.huawei.com/marketingcloud/pep/asset/20000001/Material/597eb7d1363f4b5da0d4ad663da1f7b6/M3T1A590N1325408746781700176/Huawei%20OceanProtect%20E8000%20Backup%20and%20Archiving%20Converged%20Storage%20V200R001C20%20-%20Data%20Sheet.pptx
```
HTTP 200, 2,407,538 bytes, `application/vnd.openxmlformats-officedocument.presentationml.presentation`.
Slide 3 is the technical specification table. Its port rows, verbatim:

> **Number of Controllers per Node** | 2
> **Front-End Port Types** | 16/32/64 Gbit/s Fibre Channel ; 10/25/40/100GE
> **Front-End Storage Protocols** | NFS, SMB/CIFS, FC, iSCSI, S3, FTP/SFTP, NDMP

No port-count row, no interface-module table, no slot count. The page adds one number that is *not*
a port count and should not be read as one: "2 U 36-slot high-density hardware" — that is the **disk**
slot count of the NVMe node.

Two Huawei documents disagree on this model's bandwidth, and neither is a port census, so both are
recorded rather than resolved: the page gives 53 TB/hour physical / 115 logical / 55 recovery, the
datasheet gives "Up to 55" physical / "Up to 110" logical / "Up to 46 (all-flash), 15 (hybrid flash)"
per node. The datasheet also adds NL-SAS disks (8/10/16/20/24 TB) to the NVMe-only list on the page.
The stale figures in #742 (6.2/19/55 TB/hour, 8 nodes, 16 PB) come from neither: they are the X-series
tier table.

## The doc-navigation API is login-gated, so a section URL remains the only door

`https://support.huawei.com/hedex/api/navi/EDOC1100486186/first-level-tree` answers
`401 {"status":401,"message":"NOT LOGIN!","data":{"loginUrl":...}}`. The viewer is a SPA; its JSON
navigation endpoints are the one part of the site that really is gated (the SSR section pages are not).

The SSR pages do, however, carry the whole document: the section page for
`https://support.huawei.com/enterprise/en/doc/EDOC1100318730/ce945100/cabinet-layout-and-connection-planning`
(HTTP 200, 567,916 bytes) embeds 31 `href` links, one per section of that document. So the earlier
conclusion stands and is now stronger: **one indexed section of the V200R001 E8000 set is enough** to
open the entire set, and no such section is indexed. `EDOC1100486186` and `EDOC1100486185` both still
answer HTTP 404 at the doc root (`/view/notFound`), and the one E8000-relevant section that used to be
indexed - `EDOC1100305200/6cc495b9/replacing-a-controller-oceanprotect-x6000-x8000-e8000` - now answers
HTTP 404 as well; that 1.x document has been superseded.

## The nearby slot rule belongs to X6000/X8000 1.3.0 and does not transfer

The accessible 1.3.0 installation guide does state a census-shaped rule:

> Controllers A and B each provide six interface module slots ... Interface modules for the front-end
> network connection can be installed only in slots IOM 0, IOM 1, and IOM 4.
> — `EDOC1100318730/ce945100`, *OceanProtect X6000, X8000 1.3.0 Installation Guide (with Data Backup Feature)*

Tempting for E8000 (also a 2 U, 2-controller node) and not usable: the document is titled X6000/X8000,
the E8000 is a different enclosure (86.1 x 447 x 820 mm NVMe controller enclosure on the datasheet,
against 488-790 mm enclosures in that guide), and no Huawei document read this pass says the two share
a controller. Importing six IOM slots into the E8000 would be the same family-sibling error as Table 6-1
of the Dorado 8000 guide above.

## Exact missing field for E8000, restated after the datasheet

Front-end ports exist only as interface modules, so the missing field is: **interface modules per
controller, which of the controller's slots accept front-end modules, and the port count of each
module.** Equivalently, one base ordering line - e.g. "E8000 node, 2 controllers, 2 x 4-port 25GE
interface module per controller" - which the catalogue can express as a flat port list today.

**What would unblock it:** any indexed section of `EDOC1100486186` (Product Description) or
`EDOC1100486185` (Installation Guide), both of which are published but unreachable at the doc root; or
a Huawei ordering guide pinning per-model ports; or the interface-module chapter of either document
pasted by a reader with support access. Until then #742 stays open: the datasheet proves the field is
unpublished, not that this pass could not find it.

## X8000: the module sections do state port counts (read 2026-11-17)

Supersedes the sentence three earlier passes repeated - "Huawei publishes port *types* and a controller
count, never a port *count*". That is true of the datasheets and of the marketing spec tables, and false
of the Product Description's interface-module chapters, which are ordinary indexed sections.

| Document section | What it states | URL |
|---|---|---|
| 10GE Electrical Interface Module | "A 10GE electrical interface module provides **four** 10 Gbit/s electrical ports." Table 4-4 types the electrical module as SFP+. | `https://support.huawei.com/enterprise/en/doc/EDOC1100319420/7a0c3635/10ge-electrical-interface-module` |
| 25 Gbit/s RoCE Interface Module | "provides **four** 25 Gbit/s optical ports", and is "used only for data forwarding inside the device" | `https://support.huawei.com/enterprise/en/doc/EDOC1100319420/378e8255/25-gbit-s-roce-interface-module` |
| 25 Gbit/s RDMA Interface Module | "provides **four** 25 Gbit/s optical ports", used "to connect two controller enclosures" | `https://support.huawei.com/enterprise/en/doc/EDOC1100319420/c4d726f4/25-gbit-s-rdma-interface-module` |
| SmartIO Interface Module | **no port count in prose** - five appearance figures and an optical-module table only | `https://support.huawei.com/enterprise/en/doc/EDOC1100319420/7c64209f/smartio-interface-module` |

The SmartIO row is the one to leave alone. Its page says only that a 10GE electrical module "has the same
appearance as a SmartIO interface module that uses a 10 Gbit/s optical module"; an identical faceplate is
not a port census, so the X8000 spec models the electrical module, whose count is stated, and does not
borrow four ports for the SmartIO family.

Slot geometry, from the 1.3.0 Installation Guide (with Data Backup Feature), section *Cabinet Layout and
Connection Planning* - `https://support.huawei.com/enterprise/en/doc/EDOC1100318730/ce945100/cabinet-layout-and-connection-planning`:

> Each of controllers A and B provides six interface module slots.
>
> IOM 3 must house a 25 Gbit/s RoCE interface module, and no cable connection is required.
>
> Interface modules for the front-end network connection can be installed only in slots IOM 0, IOM 1, and IOM 4.
>
> IOM 0 … can house a 10GE electrical interface module or a SmartIO interface module with a 10 Gbit/s or
> 25 Gbit/s optical module for replication and backup data transmission.
>
> IOM 1 can house a container front-end interface module, which can be a 10GE electrical interface module
> or SmartIO interface module with a 10 Gbit/s or 25 Gbit/s optical module … Ports P0 and P1 are used for
> transmitting backup and replication control signaling … Port P2 is used in archive scenarios … Port P3
> is used for the SFTP service.

Two versions of "Rules for Installing Interface Modules" are served on that one page and they disagree: the
earlier block says "12 Gbit/s SAS interface modules can be installed in the following slots: IOM 5 > IOM 4 >
IOM 3", the data-backup block says front-end modules may sit in IOM 4. **IOM 0 and IOM 1 are front-end
slots under both readings**, so the modelled configuration uses exactly those two, and IOM 4 - optional in
every version - is not fitted rather than guessed.

### What was modelled

`devices/huawei/oceanprotect-x8000.json`: one 2 U controller enclosure, two controllers, a 4-port 10GE
electrical module in IOM 0 and another in IOM 1 on each controller - **16 x 10GbE SFP+**, no PoE.
Deliberately absent, with the reason recorded in the spec's `notes`: IOM 4 (optional, and the two document
versions disagree on it), the IOM 2 RDMA and IOM 3 RoCE modules (internal / inter-enclosure links, "no
cable connection is required"), the 12 Gbit/s SAS modules (disk enclosures), and the management port whose
count appears only in a figure.

## X9000: the document that would settle it is not live (2026-11-17)

The X8000 half of #741 is settled; the X9000 half is not, and the blocker is now a dead URL rather than an
unindexed one.

| URL tried | Result |
|---|---|
| `/enterprise/en/doc/EDOC1100337685/8ed1346b/overview` (X9000 1.5.0 PD) | Googlebot UA: 302 -> **404** `/view/notFound`; browser UA: **403** |
| `/enterprise/en/doc/EDOC1100337685/67ea5a63/interface-module` | **404** |
| `/enterprise/en/doc/EDOC1100337685/ad9f2760/component-description` | **404** |
| `info.support.huawei.com/enterprise/en/doc/EDOC1100337685/8ed1346b/overview` | 200 but lands on `/supportindex/` (91,294 B) - not the document |
| `/enterprise/{es,de}/doc/EDOC1100337685/8ed1346b/overview` | **404** (locale variants do not help) |
| `/enterprise/en/doc/EDOC1100368229` (X9000, X9100 1.6.0-1.7.0 & V200R001 PD) | **404** - doc root, and no section slug of this set is indexed |
| `/enterprise/en/doc/EDOC1100305237` (X9000, X9100 1.x Quick Installation Guide) | **404** - doc root, no slug |
| `/enterprise/en/doc/EDOC1100368334` (X9000, X9100 1.x Hardware Installation Guide) | **404** - doc root, no slug |

The search index still serves the 1.5.0 text - 4 U enclosure, IOM H0..H13 / L0..L13 (28 slots), back-end
modules only in H5..H8, front-end slot rules per quadrant - but a cache snippet is not a URL a reader can
open, and this project models from vendor pages, not from search results. It is recorded here as a lead,
not as evidence.

**Exact missing fields for X9000:** for a stated controller count (2 or 4), which of the 28 slots accept
front-end modules, the module mix per quadrant, and the per-module port count for the modules Huawei sells
for this node. The X6000/X8000 counts do **not** transfer silently: the module names are shared, the
controller enclosure and slot numbering are not, and the X9000's own price catalogue lists modules the 2 U
node does not have (2-port 40 GbE, 2-port 100 GbE, 4-port 1 GbE).

**One trap, repeated:** the live page `https://info.support.huawei.com/enterprise/en/doc/EDOC1100484689/bb36e2c/connection-planning-between-the-storage-system-and-application-server`
reads almost exactly like the X9000's cached slot rules - IOM H5..H8 for back-end, quadrant rules for
front-end - and it is titled *OceanStor Dorado 8000 and Dorado 18000 V700R001 Site Planning Guide*. The 4 U
28-slot geometry is shared hardware language between a Dorado array and an OceanProtect X9000; importing it
would put Dorado's census on a backup appliance.

**What would unblock #741's X9000 half:** any live section of `EDOC1100368229` or `EDOC1100368334` (one
slug opens the set, as `ce945100` did for X6000/X8000), or one stated configuration in the shape "X9000
node, 4 controllers, 4-port 25GE module in IOM H0/L0, ...".

#743 (X8100/X9100) and #742 (E8000) are unchanged by this pass: no document read states whether X8100
shares the X6000/X8000 controller enclosure, so its census stays unpublished rather than borrowed. (The
next section identifies the four books that would settle it - and shows the pair are different enclosures.)

## The X8100 and X9100 books, identified by ID (2026-11-17, second pass)

The previous pass stopped at "no document read states whether X8100 shares the X6000/X8000 controller
enclosure". This pass found which books carry the answer and confirmed the two models in #743 are not one
box. Nothing here closes #743; it removes the search step.

### 1. The vendor page names the four books

`https://support.huawei.com/enterprise/en/data-protection/oceanprotect-x8100-pid-268353477` — HTTP 200,
420,838 bytes, crawler UA. Its documentation tree lists, under *Product Description* and *Hardware
Installation Guide*, four documents that split the request down the middle:

| book | document ID | covers |
|---|---|---|
| Product Description | `EDOC1100368229` | **X6000, X8000, X8100** Backup Storage 1.6.0-1.7.0 & V200R001 |
| Product Description | `EDOC1100368230` | **X9000, X9100** Backup Storage 1.6.0-1.7.0 & V200R001 |
| Hardware Installation Guide | `EDOC1100305240` | **X6000, X8000, X8100** Backup Storage 1.x & V200R001 |
| Hardware Installation Guide | `EDOC1100305243` | **X9000, X9100** Backup Storage 1.x & V200R001 |

(Quick Installation Guides are `EDOC1100305237` / `EDOC1100305238`; the downloadable package is
`EDOC1100368651`.) So X8100 is documented *with* X6000/X8000 and X9100 *with* X9000 — the book boundary
is a documentation grouping, not a statement that the subracks are identical: the same X6000/X8000 book
also carries a 4 U SAS disk enclosure.

### 2. The X8100/X9100 data sheet is a PowerPoint, and it still has no port count

`https://e.huawei.com/en/documents/products/storage/78d3796f54df4f30a2f0cbd5d7b938e8` — HTTP 200,
266,909 bytes — leads to `.../Material/78d3796f54df4f30a2f0cbd5d7b938e8/M3T1A590N1306219389672218650/
Huawei OceanProtect X8100 X9100 Backup Storage Data Sheet V200R001C30.pptx`: HTTP 200, 5,265,602 bytes,
`application/vnd.openxmlformats-officedocument.presentationml.presentation`, 5 slides.

Slide 4, *Technical Specifications*, is the whole census, and its rows are: Number of Controllers (2 | 4),
CPU, Memory, Physical/Logical Backup Bandwidth, Recovery Bandwidth, Usable Capacity, Maximum Number of
Controllers, Data Disk Types, **Front-End Port Types** (16/32/64 Gbit/s FC; 10/25/40/100GE), Front-End
Storage Protocols, RAID Levels, Main Software Functions, Data Reduction Ratio, System Management, Power
Supply, Dimensions, Weight, Operating Temperature, Operating Humidity. Across all five slides the string
counts are: `slot` 0, `IOM` 0, `interface module` 0, `port count` 0, `Front-End Port` 1 (the port-types
row). This is the same shape as the E8000 data sheet, and the same lesson: Huawei storage data sheets are
PowerPoint files, so a PDF hunt never finds them - and finding them does not yield a socket count.

### 3. #743 asks for two enclosures, not one model

From that slide:

| field | X8100 | X9100 |
|---|---|---|
| Node (controller enclosure) | 86.1 x 447 x **920** mm, 2 U, <= 45 kg | 175 x 447 x **865** mm, 4 U, <= 89 kg |
| Controllers per node / max | 2 / 4 | 4 / 8 |

Different height, different depth, different controller count and a different book. Whatever census is
found is **per model**; a single `oceanprotect-x8100` record cannot stand for the pair, and X9100 inherits
nothing from X9000 for the same reason the X6000/X8000 slot rules did not transfer to it in the previous
pass.

### 4. What the four books answer to, measured

| probe | result |
|---|---|
| `/enterprise/en/doc/EDOC1100368229` (and `.../305240`) | **302** -> `/view/notFound`, 100 bytes |
| the same IDs on `support.huawei.cn` | **404** -> `/view/notFound` |
| `hedex/hdx.do?docid=EDOC1100305240&lang=en` | **200**, 3,728 bytes - the viewer shell, no content |
| `hedex/api/navi/EDOC1100305240/first-level-tree` | **401** `{"status":401,"message":"NOT LOGIN!"}` |
| `/enterprise/en/doc/EDOC1100368229/5ee6c5f0/overview` and `.../ef1db5f6/product-specifications` | **302** -> `/view/notFound` |
| control: `/enterprise/en/doc/EDOC1100319420/5ee6c5f0/overview` (1.3.0 book) | **200**, 501,601 bytes |

The section hash is per document, so no `EDOC`/`case-hex`/`slug` triple transfers between books - the
1.3.0 control parses while every borrowed hash on the 1.6.0-era ID lands on `/view/notFound`. None of the
four books has an indexed section page, which is why the 1.3.0 generation (and only it) is what
`devices/huawei/oceanprotect-x8000.json` was built from.

### 5. Exact missing field, and what would unblock #743

**Missing field, per model:** the controller-enclosure interface-module slot count, which of those slots
accept *front-end* modules, and the per-module port count for the 10/25/40/100GE and 16/32/64 Gb FC modules
Huawei sells for X8100 (2U, 2 controllers) and for X9100 (4U, 4 controllers).

**What would unblock it:**

- any one live section of `EDOC1100368229`, `EDOC1100305240`, `EDOC1100368230` or `EDOC1100305243` - one
  slug opens the whole set, exactly as `ce945100` did for X6000/X8000;
- or one stated configuration in the shape "X8100 node, 2 controllers, 4-port 25GE module in IOM 0 and
  IOM 1 of each controller";
- or a Huawei ordering guide that pins ports per base model.

Until then #743 stays open with no spec file: the two models are different enclosures, and the only port
statement Huawei publishes for either is a list of port *types*.

## 6. The hedex topic pages are anonymous - and the ones readable today are OceanStor, not OceanProtect

Second probe pass, 2026-11-17. The viewer route in section 4 needs an 8-hex section slug, and
`hedex/hdx.do` answers with a 3,728-byte Vue shell. There is a third shape, and it is plain static HTML:

```
https://info.support.huawei.com/hedex/api/pages/<EDOC>/<viewer>/<issue>/resources/<topic>.html
```

One file per Product Description topic, no login, indexed by search engines - which is how they were found
(`prod_desc_mid_interface_100G.html`, `prod_desc_mid_interface_RoCE_100G.html`,
`prod_desc_mid_interface_12G.html`, `prod_desc_mid_evrmt_para.html`, ...). Read today:

| topic page | sentence, verbatim |
|---|---|
| `prod_desc_mid_interface_100G.html` | "A 100GE interface module provides two 100 Gbit/s optical ports." |
| `prod_desc_mid_interface_GE.html` | "A GE electrical interface module provides four 1 Gbit/s electrical ports." |

That is exactly the per-module port census #743 has been missing - except that neither page belongs to an
OceanProtect book. Both are topics of `EDOC1100233761` (`YEM05121`, issue 11), which is the **OceanStor
5x10/6x10** Product Description: the ENISA EUCC-3096-2026-003 certification report cites that document as
`support.huawei.com/hedex/hdx.do?docid=EDOC1100233761&id=oceanstor_5x10_031`, and its topics carry
HyperMetro, SmartMobility and OceanStor Dorado subject matter. The `prod_desc_mid_*` prefix is the
**OceanStor mid-range** topic family.

**The rule this leaves:** an interface-module page found under `prod_desc_mid_*` is OceanStor's, not
OceanProtect's, and must not be imported into an OceanProtect spec. This is the same family-sibling error
as the Dorado 8000/18000 Table 6-1 recorded under "The trap" above, now with a second and more tempting
source: hedex pages look like the answer, and the sentence itself never names the product.

Access mechanics measured from this host (2026-11-17): plain `curl` with a Googlebot user-agent gets
**403 Access Denied** on `support.huawei.com/hedex/...`, and a silent rewrite to
`support.huawei.com/supportindex/` on `info.support.huawei.com/hedex/...`; `r.jina.ai` is rewritten the same
way. A topic that does not exist falls back to the support index too, so "HTTP 200 + index chrome" means
*no such topic* - which is how the guessed topic names for the OceanProtect books were ruled out.

Still unread, for the same reason as section 4 (no slug): `EDOC1100305240` (X6000/X8000/X8100 1.x &
V200R001 Hardware Installation Guide), `EDOC1100368229` (X6000/X8000/X8100 1.6.0-1.7.0 Product
Description), `EDOC1100368230` / `EDOC1100305243` (X9000/X9100), `EDOC1100486186` (E8000 Product
Description). All four answer `.../doc/<EDOC>?idPath=...` - the query the product page itself uses - with
HTTP 404 on the 452,479-byte `/view/notFound`, so `idPath` does not open them either.

## 7. Vendor fields read this pass, and the one that is still missing

`https://e.huawei.com/en/products/storage/oceanprotect/x100-series` (HTTP 200, crawler UA) prints a
single-node table for X8100/X9100 that is richer than the MKT datasheet: controllers per node 2 / 4, CPU
2 x 2 x 48 or 64 cores at 2.6 GHz, memory 1 TB / 2 TB, physical/logical/recovery bandwidth, NVMe disk
types, front-end port **types** (16/32/64 Gbit/s FC; 10/25/40/100GE), protocols, RAID levels, C13 vs C19
power feed, node dimensions 86.1 x 447 x 920 mm (X8100) and 175 x 447 x 865 mm (X9100), weight <= 45 kg /
<= 89 kg. Not one of those fields is a port count.

`Huawei OceanProtect X Series Backup Appliance Technical White Paper`, Issue 01 (2026-09-29), read as a
16,574,915-byte PDF resolved from the material page
`https://e.huawei.com/en/documents/products/storage/eded1b265ecc4dfba2fbf8669b0b8213`, settles the
enclosure side for X8100 and leaves the module side open: "Each controller enclosure supports up to 12
hot-swappable interface modules" and, for the 2 U controller enclosure, "Controllers A and B separately
provide six interface module slots"; each X8100 controller has only "two GE management/maintenance ports
and one serial port" of its own, so every front-end port on this model comes from an IOM. The white paper
lists IOM kinds (GE electrical, 10GE electrical, 40GE optical, 100GE optical, SmartIO 8/16/32 Gbit/s FC,
10/25 Gbit/s, 4-port 25 Gbit/s RDMA) and never a ports-per-module count.

`Huawei OceanProtect E8000 Backup and Archiving Converged Storage V200R001C20 - Data Sheet`, resolved from
`https://e.huawei.com/en/documents/products/storage/597eb7d1363f4b5da0d4ad663da1f7b6` (2,407,538-byte
pptx, 4 slides), was read end to end: the only port row is `Front-End Port Types 16/32/64 Gbit/s Fibre
Channel; 10/25/40/100GE`. #742's blocker is unchanged, and now has one more vendor source that does not
answer it.

**What is still missing for #743:** the per-module port counts for the 10/25/40/100GE and 16/32/64 Gb FC
modules *from an OceanProtect book*, plus one stated configuration - the shape
`devices/huawei/oceanprotect-x8000.json` was built from ("a 4-port 10GE electrical interface module in
IOM 0 and another in IOM 1 on each controller"). The slot half is now vendor-sourced from the white paper;
the port half is not, and the only sentences that state it belong to another product family.

## 8. The Dorado port table, second instance: `EDOC1100214756` is OceanStor Dorado V6

A search for an OceanProtect module port count answers with
`https://info.support.huawei.com/hedex/api/pages/EDOC1100214756/YEK0928G/12/resources/plan_plan_all.html`
("Connection Planning Between the Storage System and Application Server"), whose Table 1 is exactly the census
these issues ask for: `GE electrical interface module | 1 | 4`, `10GE electrical | 10 | 4`,
`40GE interface module | 40 | 2`, `100GE interface module | 100 | 2`, `25 Gbit/s RoCE | 25 | 4`,
`100 Gbit/s RoCE | 100 | 2`, `8/16/32/64 Gbit/s FC | ... | 4`, `10GE or 25GE | ... | 4`,
`25 Gbit/s NoF | 25 | 4`, `100 Gbit/s NoF | 100 | 2`.

It is not an OceanProtect book. Read off the same EDOC: the sibling topic
`.../YEK0928G/12/resources/disk_encryt_general.html` opens "This document describes the disk encryption feature of
OceanStor Dorado storage systems"; other topics in the set are named `dorado_18000_021.html` (Quick Installation
Guide) and `dorado_18000_091.html` (Container User Guide); and the set's own attachment
`.../YEK0928G/13/resources/en-us_attachment_0000001207425401.pdf` states "OceanStor Dorado V6 series" with
Dorado 3000 V6 through Dorado 18000 V6 as its applicable models. This is the Dorado 8000/18000 Table 6-1 hazard
recorded above, one document set further out - and it is what a module-count search returns first.

Fetching any of those topics, the attachment PDF included, answers HTTP 200 with the 91,294-byte support index
(`https://support.huawei.com/supportindex/`) - the silent rewrite of section 6. Only the search index has the text,
and the text is the wrong product family.

## 9. The E8000 books: an id for the Quick Installation Guide, and a doc root that ignores `?idPath`

`https://support.huawei.com/enterprise/en/data-protection/oceanprotect-storage-x-series-pid-262802350`
(HTTP 200, 472,195 B, crawler UA) lists the E8000 set with links carrying the idPath the page itself uses:

| book | id |
|---|---|
| OceanProtect E8000 V200R001 Product Description | `EDOC1100486186` |
| OceanProtect E8000 V200R001 Quick Installation Guide | `EDOC1100485347` |
| OceanProtect E8000 V200R001 Hardware Installation Guide | `EDOC1100486185` |

The QIG id is new here. All three still answer 302 to `https://support.huawei.com/view/notFound` - a 452,479-byte
shell containing no document links - and so do `EDOC1100486186?lang=en` and the zh-locale doc root. `idPath` is
site-navigation context, not a resolver: a doc root with no section hash yields nothing, so the book still needs
one indexed section to open.

## 10. The 167-page X Series white paper contains no E8000 at all

The book quoted in section 7 was re-counted after the read, because a 167-page hardware chapter is the natural place
for an E8000 rear view: `E8000` occurs **0** times and `E6000` 0, against `X6000` 24, `X8000` 27, `X8100` 11,
`X9000` 29, `X9100` 22. It is X-series only, so it cannot answer #742 under any reading; its
`36 (palm-sized) NVMe disk slots` sentence belongs to the X8100 enclosure, not to the E8000's "2 U 36-slot" body.

What it settles for #743 is unchanged from section 7: X8100 is a 2 U enclosure with two controllers and up to 12
hot-swappable interface modules, each controller contributing two GE management/maintenance ports and one serial
port; X9100 is an independent controller enclosure with 28 interface modules shared by four controllers and two
management modules of three GE ports each. Ports per module remain absent from every OceanProtect document read.

**Still missing, unchanged:** for #742, the E8000's interface-module slots per controller and the port count of each
front-end module type; for #743, the ports per module for the 10/25/40/100GE and 16/32/64 Gbit/s FC modules from an
OceanProtect book. One indexed section of `EDOC1100486186`, `EDOC1100485347` or `EDOC1100486185`, or a stated
ordering configuration, unblocks them; the Dorado tables do not.

## 11. C33 is a PDF now and still has no port row; the V200R001 books are re-issues of the
##     1.3.0 ids; and the host that serves them refuses this network

Three things settled on 2026-11-17 (second pass). None of them close #743.

**(a) The newest X8100/X9100 datasheet was read end to end and does not carry the census.**

`https://e.huawei.com/en/documents/products/storage/7450a63331f44a35a6d85d42bc2b79ed` (HTTP 200, 337 KB) gives
*Huawei OceanProtect X8100 X9100 Appliance Data Sheet V200R001C33 (2026 H2)*, asset
`https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/7450a63331f44a35a6d85d42bc2b79ed/M3T1A590N1319414983213645852/Huawei OceanProtect X8100 X9100 Appliance Data Sheet V200R001C33 _2026 H2_.pdf`
- 743,373 B, PDF 1.6, **11 pages**. A PDF this time, where the C30 revision read earlier
(`.../documents/products/storage/78d3796f54df4f30a2f0cbd5d7b938e8`, 200, 266,908 B) links a 5-slide pptx.

Rows, in full: number of controllers, CPU, memory, physical/logical/recovery bandwidth per node and per system,
usable capacity, data disk types, `Front-End Port Types | 16/32/64 Gbit/s Fibre Channel; 10/25/40/100GE`,
front-end storage protocols, RAID levels, software functions, data reduction ratio, system management, power
supply (C13 / C19), dimensions, weight, operating temperature and humidity. The string `slot` occurs **0** times
and `IOM` **0** times in the file; `Front-End Port Types` occurs 3 times (one per spec-table rendering). Two
datasheet revisions in a row publish port *types* and no port count.

**(b) The book ids already in this thread are the right ones - the set was re-issued, not replaced.**

`https://support.huawei.com/enterprise/en/data-protection/oceanprotect-x8100-pid-268353477` (200, 420,418 B,
crawler UA) lists `OceanProtect X6000, X8000, X8100 Backup Storage 1.6.0-1.7.0 & V200R001 Product Description`
-> `EDOC1100368229`, `OceanProtect X6000, X8000, X8100 Backup Storage 1.x & V200R001 Hardware Installation Guide`
-> `EDOC1100305240`, package -> `EDOC1100368651`. The 1.3.0-era ids now carry "1.x and V200R001" titles over the
same hardware: `EDOC1100305200` is titled *OceanProtect Backup Storage 1.x and V200R001 Parts Replacement*, and
`EDOC1100305241`'s About This Document table reads
`OceanProtect X3000 | 1.3.0 1.5.0 1.6.0 1.7.0 V200R001C10`. So `EDOC1100305240` is a multi-model HIG covering
X8100's IOM rules - the id in the thread is correct and the missing item is one section slug.

**(c) The block is an ALB header rule on `info.support.huawei.com`, not a login wall and not a 404.**

This generation is served on `info.support.huawei.com` only. Measured today from this host, the section URLs the
search index holds -

- `https://info.support.huawei.com/enterprise/en/doc/EDOC1100305200/4bd9b2a1/replacing-an-electrical-module`
- `https://info.support.huawei.com/enterprise/en/doc/EDOC1100305241/48cd803f/safety-precautions-for-operating-equipment`
- `https://info.support.huawei.com/enterprise/en/doc/EDOC1100305241` (bare root, no section)

- answer **HTTP 302, 355 bytes, `Location: https://support.huawei.com/`** with `X-ALB-HIT: req-hd-bl`, under
Chrome 131, Googlebot, Bingbot and `curl/8.4.0` user agents, with and without `Referer`, `Accept`,
`Accept-Language`, `Upgrade-Insecure-Requests` and `Sec-Fetch-*`. `r.jina.ai` sees the same bounce
(`Final URL: https://support.huawei.com/supportindex/`). The same books on `support.huawei.com` answer **403,
442-459 B** with a browser UA and **404 -> `/view/notFound`, 452,479 B** with a crawler UA - including with the
page's own `?idPath=7919749|251366268|261607408|251366267|268353477`. `hedex/hdx.do?docid=` still returns the
identical 3,728-byte SPA shell for `EDOC1100368229`, `EDOC1100305240` and `EDOC1100368651`, so no viewer/issue
code can be recovered from it.

**Lead, deliberately not imported.** `EDOC1100337685` (*OceanProtect X9000 1.5.0 Product Description*), section
`8ed1346b/overview`, gives the 4 U controller enclosure's slot topology: management modules in `SMM 0`/`SMM 1`,
upper interface slots `IOM H0`-`IOM H13`, lower `IOM L0`-`IOM L13`, back-end modules only in `H5/L5`, `H6/L6`,
`H7/L7`, `H8/L8`, plus front-end installation sequences. #743's X9100 is the four-controller 4 U sibling, but
that text names **X9000**, so it is a search shape, not an X9100 census - it is not written into any spec.

**Still missing (#743):** ports per 10/25/40/100GE module and per 16/32/64 Gbit/s FC module from an OceanProtect
book, plus the IOM slots that accept front-end modules on X8100 (2 U) and X9100 (4 U). **What closes it:** one
live section of `EDOC1100305240`, `EDOC1100368229` or `EDOC1100368230` fetched from a network the ALB does not
bounce, or a stated configuration of the shape `X8100 node, 2 controllers, 4-port 10GE electrical module in
IOM 0 and IOM 1`.

## 12. The host does not refuse this network - it renders one document generation and 302s the rest

Measured 2026-11-17 (third pass), one crawler user-agent, one session, minutes apart. The point of the table is
that §11(c)'s "the host that serves them refuses this network" names the wrong cause, and that mis-naming sends
the next pass hunting a proxy instead of the actual gap.

| URL | result |
|---|---|
| `support.huawei.com/enterprise/en/doc/EDOC1100318730/ce945100/cabinet-layout-and-connection-planning` | **200, 567,916 B** |
| `support.huawei.com/enterprise/en/doc/EDOC1100319420/5ee6c5f0/overview` | **200, 501,601 B** |
| `support.huawei.com/enterprise/en/doc/EDOC1100319420/a9dbbf6/interface-module` | **200, 485,245 B** |
| `.../EDOC1100305240/216dcdb5/cabinet-layout-and-connection-planning` | 302 -> `/view/notFound` |
| `.../EDOC1100305242/4dbe1160/replacing-an-interface-module` | 302 -> `/view/notFound` |
| `.../EDOC1100305200/4bd9b2a1/replacing-an-electrical-module` | 302 -> `/view/notFound` |
| `.../EDOC1100368229?idPath=7919749\|251366268\|261607408\|251366267\|268353477` | 302 -> `/view/notFound` |
| `.../EDOC1100368230?idPath=...` (X9000, X9100 Product Description) | 302 -> `/view/notFound` |
| `.../EDOC1100305237?idPath=...` (X6000, X8000, X8100 Quick Installation Guide) | 302 -> `/view/notFound` |

So the discriminator is the **document**, not the host and not the source address: this host renders the whole
`1.3.0 ... (with Data Backup Feature)` set (`EDOC1100318xxx` / `EDOC1100319xxx`) to an anonymous crawler and
refuses every book outside it. Consequence for #743: an ALB bypass or a fetch from another network cannot
produce `EDOC1100305240` / `EDOC1100368229` / `EDOC1100368230`, because the viewer has no renderable version of
those three to bypass *to*. What is needed is a reader with a session, not a different route.

**The readable generation cannot be borrowed for X8100.** `EDOC1100319420/a9dbbf6/interface-module` was re-read
in full this pass: the string `X8100` occurs **0** times and `X9100` **0** times in its 485,245 bytes (the book
is titled *OceanProtect X6000, X8000 1.3.0 Product Description (with Data Backup Features)*). Its Interface
Module chapter links exactly four modules - `10GE Electrical`, `SmartIO`, `25 Gbit/s RoCE`, `25 Gbit/s RDMA` -
i.e. the X8000 census already modelled, and nothing about X8100's IOM population.

**The archive route is dead, and it was dead in a way that also invalidates every indexed hash.** Wayback CDX
(`web.archive.org/cdx/search/cdx?url=support.huawei.com/enterprise/en/doc/<ID>*`) holds exactly one capture
across all three ids: `.../EDOC1100305240/216dcdb5/cabinet-layout-and-connection-planning`, timestamp
`20250906080606`, status 200. That capture is the **6,698-byte SPA shell** - empty `<title>`, no server-rendered
text, only the Wayback banner and a `bundle-playback.js` include. And the hash it carries (`216dcdb5`) answers
302 -> `/view/notFound` live today, which is the general rule this pass confirms: a section hash recovered from
a search index or an archive is **revision-scoped**, so it is not a durable pointer to a readable page even when
the book is later opened.

**`info.support.huawei.com` is not a second door.** It reproduces the same path shape
(`/enterprise/<lang>/doc/<EDOC>/<hash>/<slug>`) and answers **302, 355 bytes, `Location: https://support.huawei.com/`**
for every variant tried under Chrome 131, Bingbot, Googlebot and `curl/8.4.0` - including through `r.jina.ai`,
whose `Final URL` is `https://support.huawei.com/supportindex/`. Confirms §11(c) on that host, with the
correction above on this one.

**Field still missing (#743), restated without the network clause:** the IOM slots that accept front-end
interface modules on X8100 (2 U, 2 controllers) and on X9100 (4 U, 4 controllers), plus the port count of each
10/25/40/100GE and 16/32/64 Gbit/s FC module as fitted to those two models. **What unblocks it:** any section of
`EDOC1100368229`, `EDOC1100368230` or `EDOC1100305240` pasted by a reader with a support session; Huawei's
Spare Parts Query output for the model (the Product Description defers the per-model module list to it); or a
stated configuration of the shape `X8100 node, 2 controllers, 4-port 10GE electrical module in IOM 0 and IOM 1`,
which converts in one step using the slot rules already transcribed above.

## 13. Fourth pass: the books are absent under a UA that renders their siblings, and the vendor names the tool that holds the answer

Measured 2026-11-17. §12 established *which* books render; this pass fixes the **probe method**, because a wrong
probe makes an unavailable book look available and an available one look unavailable.

**The shell trap.** The doc viewer answers every `/doc/...` URL with the same 3,800-byte SPA shell to a default
`curl` user-agent - including a section that is present. One user-agent switch apart:

| URL | default `curl` UA | Googlebot UA |
|---|---|---|
| `.../EDOC1100318730/ce945100/cabinet-layout-and-connection-planning` | 200, **3,800 B**, no text | 200, **567,916 B**, renders |
| `.../EDOC1100318733/4f560405/cabinet-layout-and-connection-planning` | 200, **3,800 B**, no text | 200, **517,177 B**, renders |

So `200 + shell` carries **no** information about whether a section exists. Read a 200 from a non-crawler client
as "not measured", never as "reachable". The discriminator that does work is `404` (with the `/view/notFound`
body, 383,570-452,479 B) against a rendered page.

**The X8100/X9100 books are absent, not bounced.** Same session, same Googlebot UA that renders both books above:

| URL | result |
|---|---|
| `.../EDOC1100368229` (bare root) | **404**, 452,479 B |
| `.../EDOC1100368229/interface-module` (slug, no hash) | **404**, 383,570 B |
| `.../EDOC1100368229/a9dbbf6/interface-module` (X8000's topic hash) | **404**, 452,479 B |
| `.../EDOC1100368230/a9dbbf6/interface-module` (X9000, X9100) | **404**, 452,479 B |
| `.../EDOC1100305240/216dcdb5/cabinet-layout-and-connection-planning` (the Wayback hash) | **404**, 452,479 B |

Topic hashes are revision-scoped and do not carry across books, and no slug-without-hash form resolves, so there
is no enumeration entry point: §12's conclusion holds with the probe now controlled for user-agent.

**The frame census is vendor-sourced and does not need those books.**
`https://e.huawei.com/en/products/storage/oceanprotect/x100-series` (200, rendered spec table) publishes, per
model: **2 controllers** (X8100) and **4** (X9100), max 4 / 8 per system, front-end port **types**
`16/32/64 Gbit/s Fibre Channel; 10/25/40/100GE`, node enclosure `86.1 x 447 x 920 mm` (X8100, 2 U) and
`175 x 447 x 865 mm` (X9100, 4 U), node weight <= 45 / <= 89 kg, `10% to 90% RH`. It publishes no IOM slot
count and no per-module port count - so it confirms the thread's frame figures and still stops at the census.

**The vendor names the one artefact that would finish it.** The Interface Module chapter of the readable
generation (`.../EDOC1100319420/a9dbbf6/interface-module`) says, in its own text: *"For details about the types
of hot-swappable interface modules supported by each product model, see Spare Parts Query"* - linked as
`https://info.support.huawei.com/storage/spareparts/#/home`. That is a public page. It is a JavaScript app
(`main-ZCQDDWQH.js`, 2,605,430 B) whose product/module data loads from an endpoint not present in the shell
bundle, so it needs a browser session rather than a fetch; recorded here as **the** next route, ahead of re-trying
the books.

**Field still missing (#743), unchanged:** the IOM slots that accept front-end interface modules on X8100 (2 U,
2 controllers) and X9100 (4 U, 4 controllers), plus the port count of each 10/25/40/100GE and 16/32/64 Gbit/s FC
module as fitted to those two models. **What unblocks it, in order:** (a) Spare Parts Query for the model, in a
browser - the vendor defers the answer to it by name; (b) any rendered section of `EDOC1100368229`,
`EDOC1100368230` or `EDOC1100305240` pasted by a reader with a support session; (c) a stated configuration of the
shape `X8100 node, 2 controllers, 4-port 10GE electrical module in IOM 0 and IOM 1`, which converts in one step
using §5's slot rules. No spec is written from this file: a 2 U frame with an unpublished IOM population would be
an empty array, not a census.

## 14. The management plane *is* published per model, and that is enough for X8100 and X9100

Measured 2026-11-17. Every earlier section looked for the front-end census and stopped there. The vendor
publishes a second port list on the same array - the management/maintenance plane - per model, in a document
that is not on `support.huawei.com` at all and therefore never hit the ALB: the **Huawei OceanProtect X Series
Backup Appliance Technical White Paper, Issue 01 (2026-09-29)**, 16,574,915 B, material page
`https://e.huawei.com/en/documents/products/storage/eded1b265ecc4dfba2fbf8669b0b8213` (200 with a crawler UA;
a desktop UA gets an Akamai `Access Denied`), asset
`.../Material/eded1b265ecc4dfba2fbf8669b0b8213/M3T1A590N1323345335641751810/Huawei OceanProtect X Series Backup Appliance Technical White Paper.pdf`.
`pdftotext -layout` gives 6,458 lines, and Chapter 3 goes model by model:

| model | what the white paper states (verbatim) |
|---|---|
| X6000 | "Each controller has two GE management/maintenance ports and one serial port"; enclosure supports six hot-swappable I/O modules |
| X8000 | same sentence; "Each controller enclosure supports up to 12 hot-swappable interface modules" |
| X8100 | same sentence; "a 2 U controller enclosure that has two controllers and 36 (palm-sized) NVMe disk slots"; "up to 12 hot-swappable interface modules" |
| X9000 / X9100 | "Each controller enclosure has two management modules. Each management module has three GE ports (management/maintenance network ports), one USB port, and one serial port", and the note "The management module provides one serial port, one maintenance network port, and two management network ports"; "Each controller enclosure supports 28 interface modules ... shared among all controllers" |

So the two models in #743 convert into specs the same way the X8000 did, with a different build: **no interface
modules fitted**. X8100 = 2 controllers x 2 GE = 4 x 1GbE management ports (plus two serial, which
`docs/DEVICE_SCHEMA.md` puts in `notes`); X9100 = 2 management modules x 3 GE = 6 x 1GbE. The frame facts stay
where they were (X8100 2 U 86.1 x 447 x 920 mm <= 45 kg, X9100 4 U 175 x 447 x 865 mm <= 89 kg; 2 / 4
controllers per node, 4 / 8 per system, from `.../x100-series`).

**The front-end is still not published, and the white paper does not close it either.** Section 2.3.2 gives the
six-slots-per-controller layout and a *preference* order for front-end modules - "IOM 0 > IOM 1 > IOM 3 > IOM 4 >
IOM 5 > IOM 2" - where the 1.3.0 X6000/X8000 guide gave a *restriction* ("can be installed only in slots IOM 0, IOM 1, and
IOM 4"). A preference is not a slot rule, and §3.1.5-3.1.6 list the module kinds (8/16/32/64 Gbit/s FC, 10GE,
25GE, 40GE, 100GE, 100 Gbit/s RDMA scale-out, 12 Gbit/s SAS) with no ports-per-module count. So no stated
front-end build can be written from a vendor source even now.

## 15. E8000: the one document that publishes this field for the X series excludes the E8000

Same white paper, same 6,458-line dump: the strings `E8000` and `E6000` occur **zero** times. That is the
decisive negative for #742 - Huawei has published per-model management-port counts for X3000, X6000, X8000,
X8100, X9000 and X9100 and did not publish them for the E series. Its own sources were re-read today:

- **Datasheet** (PowerPoint, 2,407,538 B, all four slides' text extracted, not just slide 3): the port rows are
  `Front-End Port Types | 16/32/64 Gbit/s Fibre Channel; 10/25/40/100GE` and `Number of Controllers per Node | 2`.
  No management row, no port count, no slot count. New detail from the electrical table: it prices two
  enclosures - "NVMe controller enclosure: 86.1 mm x 447 mm x 920 mm" and "Controller enclosure:
  86.1 mm x 447 mm x 820 mm" - and still publishes no port list for either.
- **Product page** `https://e.huawei.com/en/products/storage/oceanprotect/oceanprotect-e8000` (200, 343,723 B):
  port types and protocols only; its only document link is the datasheet above.
- **Its three books** - Product Description `EDOC1100486186`, Hardware Installation Guide `EDOC1100486185`, and
  the Quick Installation Guide `EDOC1100486182` (id newly recorded; all three listed for the model on
  `https://support.huawei.com/enterprise/en/data-protection/oceanprotect-e8000-pid-261860234`) - answer HTTP 302
  with `X-ALB-HIT: req-hd-bl`. `info.support.huawei.com` and `support.huawei.cn` give the same bounce.

**The one route to an E8000 census, recorded and not taken.** The E8000-applicable *OceanProtect Backup Storage
1.x and V200R001 Parts Replacement* (`EDOC1100305200`) groups the hardware explicitly: its CRU/FRU table reads
"Fan module (2 U controller enclosure and smart disk enclosure of OceanProtect X6000/X8000/E8000)" and it carries
a section titled "Replacing a Controller (OceanProtect X6000/X8000/E8000)" that says "The procedures for
replacing controllers of this model are the same". So the E8000's 2 U controller enclosure is the X6000/X8000
one, which would make X8000's six slots per controller and 4-port 10GE electrical module apply to it. That is a
family transfer - the exact move §4 and §5 record as an error - and the book itself is ALB-bounced (302), so
even the grouping above comes from a search-engine snippet rather than a fetched page. It is written down so the
next reader does not have to re-derive the temptation; it is not used as a source.

Status after this pass: X8100 and X9100 are modelled as the management-plane build the white paper states; the
E8000 stays open on the same field, now with the negative measured rather than assumed.
