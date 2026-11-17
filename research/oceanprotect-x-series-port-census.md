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
- **E8000 (#742)** — the E8000 page publishes no interface table at all, so its Product Description
  (EDOC1100486186) is the only route.

Until then these stay open. This note converts none of them; it removes the "login wall" explanation
that has been standing in for a real diagnosis three times, and names the exact document a reader has
to open.
