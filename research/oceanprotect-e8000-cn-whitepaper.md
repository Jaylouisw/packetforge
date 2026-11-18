# The E8000's front-end census is published - in the Chinese white paper, not in the data sheet

Closes the research half of #742. Four earlier passes counted the *English* document set: 224
`/en/documents/products/storage/` pages, exactly two E8000 documents, both data sheets, `slot` and
`interface module` zero times in each. The mistake was the language. Huawei's **Chinese** product page
carries a different resource list, and one of its entries is the product technical white paper - the
book the hedex tree keeps behind a login, published anonymously on `e-file.huawei.com`.

## 1. The route

| step | URL | result |
|---|---|---|
| product page (zh) | `https://e.huawei.com/cn/products/storage/oceanprotect/oceanprotect-e8000` | 200, 360,565 B (crawler UA; a desktop UA gets 403) |
| its "白皮书" link | `https://e.huawei.com/cn/documents/products/storage/4b552a977d394d1e802814db6a8d4a0a` | 200, 332,980 B, title *华为OceanProtect专用备份存储 产品技术白皮书 V200R001C20* |
| the asset, read from that page's hidden `attachmentUrl` field | `https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/4b552a97.../华为OceanProtect专用备份存储产品技术白皮书 V200R001C20.pdf` | 200, `application/pdf`, **19,224,057 B, 141 pp**, doc version 03 (2026-05-06) |

The English product page, read the same way, lists only the data sheet: the white paper is not offered
there, and `sitemap-ebg-x-default.xml` indexes the `/en/` document tree only. That is why four passes
concluded the census was unpublished while it sat on the other TLD path.

## 2. What the white paper states, in its own words

Section **3.1.3 OceanProtect E8000** (white-paper p.14, PDF p.22):

> OceanProtect X8000，采用2U2控的控制框，盘控一体形态，支持36盘位NVME(PALM）。关键模块FRU设计，支持冗余备份，
> 故障时可在线更换。**每控制框支持最多12个可热插拔的接口模块**。通过RDMA实现框内2控制器间镜像，通过Scale-out接口模块
> 实现多个控制框直连；**每控有2个GE管理/维护口，1个串口**。

The first four characters are a copy-paste slip: the sentence opens with the X8000's model name while the
heading, the two figures it introduces (`图3-10/3-11 OceanProtect E8000 NVME 36 盘位型号前视图/后视图`) and the
36-slot two-controller description are all the E8000's - the same paragraph appears, correctly named, in
section 3.1.2 for the X8000 (p.13). Read as a whole the section says: a 2 U, two-controller E8000 frame,
36 Palm NVMe slots (or 25 SAS in the HDD form), **up to 12 hot-swappable interface modules per control
frame**, two GE management/maintenance ports and one serial port per controller. That slip is recorded in
both specs' `notes` rather than papered over, because it is the only vendor statement of the slot count.

The per-model table on white-paper pp.7-9 (PDF pp.15-17), row `接口卡`, read from each column's own
coordinates rather than from the linearised text:

| form | front-end modules | scale-out | back-end |
|---|---|---|---|
| E8000 (HDD) | 4-port 8G/16G/32G/64G FC; 4-port 10GE/25GE ETH; 2-port 40GE/100GE ETH | 4-port 25Gb RDMA (4-controller direct connect) | 4-port 12Gb SAS |
| E8000 (NVMe) | same three | 4-port 25Gb RDMA | 100Gb RDMA, 2 ports per module |

So each module type publishes its per-module port count (4 / 4 / 2), which is exactly the field the issue
said was missing, and the frame publishes how many modules it takes. The front-end port count is a
multiplication, not a guess.

## 3. What was modelled

`devices/huawei/oceanprotect-e8000-hdd.json` and `devices/huawei/oceanprotect-e8000-nvme.json`: the two
forms the vendor's table names, each as one 2 U two-controller node with a stated configuration - one
4-port 10GE/25GE module in IOM 0 and one in IOM 1 per controller, 16 front-end 10/25GbE SFP28 ports in
the node - plus the two 1GbE management/maintenance ports per controller that the same section states.

Not modelled, and named in `notes` so the next reader does not mistake silence for absence: the FC and
40/100GE front-end modules (fitted instead of, not as well as, the 10/25GE pair in this configuration),
the 4-port 25Gb RDMA Scale-Out module (inter-enclosure), the back-end SAS/RDMA modules (disk frames), and
the per-controller serial port.

## 4. What this does not establish

The E8000's *maximum* front-end census, because the frame's 12 modules admit several mixes and no
ordering guide is public. A node with three 100GE modules per controller is a different, equally lawful
configuration; it would be a second spec, not an edit to these two.
