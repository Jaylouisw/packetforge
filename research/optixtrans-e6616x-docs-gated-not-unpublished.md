# The E6600 hardware description is published and login-gated - the census counted gated documents as absent

Follow-up to `research/optixtrans-e6616x-anonymous-doc-census.md`. That pass counted 299 EDOC ids on
the three English E6600 product pages, found 47 answering 200 at `/enterprise/en/doc/<ID>`, and
concluded that "no hardware description and no board chapter appears anywhere in the 299". This pass
finds that the counting instrument could not tell *absent* from *gated*: one endpoint answers in three
distinct states, and under it the E6616X's hardware description is published - six editions of it.

Nothing here writes a spec and nothing here closes #803. What changes is the blocker: it was recorded
as "Huawei does not publish the field"; it is "Huawei publishes the field behind an account".

## 1. One endpoint, three states

`https://support.huawei.com/hedex/api/navi/<EDOC id>/first-level-tree` (crawler user-agent,
`Accept: application/json`) answers:

| state | body | means |
|--|--|--|
| **200** | `{"status":200,"message":null,"data":[...]}` | public, tree served (empty array for one-page media) |
| **401** | `{"status":401,"message":"NOT LOGIN!","data":{"loginUrl":"https://uniportal.huawei.com/uniportal1/?redirect="}}` | **exists, requires a login** |
| **404** | `{"status":404,"message":"No doc data found.","data":null}` | no such document |

The difference matters because `/enterprise/en/doc/<ID>` (the route the census used) redirects a
*gated* document to `/view/notFound` exactly like a missing one, so a 302 there was read as
"unpublished" when it only means "not anonymously readable".

Controls, read 2026-11-18 with the same user-agent:

| id | navi | reading |
|--|--|--|
| `EDOC9999999999` | **404** | nonexistent id |
| `EDOC0000000000` | **404** | nonexistent id |
| `EDOC1100447312` | **200** | the enterprise optical-network documentation guide, anonymously readable |
| `EDOC1100456166` | **401** | *OptiXtrans E6600 V100R024C10 Hardware Description* - the EN page lists it and the census counted it as missing |
| `EDOC1100163901` | **401** | the E9600 document set an earlier pass declared "no doc data found" |

## 2. The Chinese partition is a second id set, and 86 of its documents are gated

`https://support.huawei.com/enterprise/zh/optical-transmission/optixtrans-e6616x-pid-257173887` -
HTTP 200, 437,872 B, crawler user-agent - links **176 unique EDOC ids**, a largely different set from
the 299 on the English pages. Queried one at a time at the navi endpoint:

| result | count |
|--|--|
| 200 | 90 |
| **401 (login)** | **86** |
| 404 | 0 |

None of the 176 is "no such document": every document this product page links either is anonymously
readable or needs an account. The 86 are, by the page's own titles, the technical set - 产品文档包,
硬件描述, 产品描述, 特性描述, 安装/升级指导书, the patch notices and the release 中文文档 - while the
90 that answer 200 are the (多媒体) videos, the 光博士 infographics and the 产品全家福 wall chart.

## 3. What is behind the gate (titles as printed on the page)

| id | title | navi |
|--|--|--|
| `EDOC1100558549` | OptiXtrans E6600 V100R025C10 硬件描述 01 | 401 |
| `EDOC1100525984` | OptiXtrans E6600 V100R025C00 硬件描述 01 | 401 |
| `EDOC1100456168` | OptiXtrans E6600 V100R024C10 硬件描述 03 | 401 |
| `EDOC1100367203` | OptiXtrans E6600 V100R023C10 硬件描述 03 | 401 |
| `EDOC1100328735` | OptiXtrans E6600 V100R023C00 硬件描述 01 | 401 |
| `EDOC1100303423` | OptiXtrans E6600 V100R022C10 硬件描述 01 | 401 |
| `EDOC1100625827` | OptiXtrans E6600 V100R026C00 产品文档 01 | 401 |
| `EDOC1100556465` | OptiXtrans E6600 V100R025C10 产品文档 01 | 401 |
| `EDOC1100299473` | OptiXtrans E6616X快速安装指南 02 | 401 |
| `EDOC1100376749` | OptiXtrans E6616X V100R022C10SPC100 中文文档 | 401 |
| `EDOC1100376750` | OptiXtrans E6616X V100R023C10SPC100 中文文档 | 401 |
| `EDOC1100376751` | OptiXtrans E6616X V100R023C00SPC100 中文文档 | 401 |
| `EDOC1100163903` | OptiXtrans E6600 彩页&Datasheet | 401 |

The hardware description is the document whose chapter set carries the board chapters - that is how
the E9600 board chapters were reached (`(6)-UXCME`, `(21)-TMB3AUX`, fetched anonymously from
`e-file.huawei.com` because those particular chapters are published as standalone PDFs). The E6600's
HD is not published standalone; it is served by the viewer, which requires the account.

## 4. The E6616X is not merely a subrack in an E6616 manual

The Chinese page is product-scoped to the X: it carries the E6616X quick installation guide and three
E6616X release documents that the English page does not list at all. That is the document family whose
board chapters would answer #803's question, and it is the family the English census never saw - not
because it is unlinked, but because it is in the other partition.

## 5. What this changes for #803, and what it does not

**Changed.** The blocker is no longer "the vendor does not publish the field". It is "an anonymous
crawler cannot authenticate". A free Huawei enterprise account reading
<https://support.huawei.com/enterprise/zh/doc/EDOC1100558549> (E6600 V100R025C10 硬件描述, the newest
edition listed) is the remaining step, and the requester can do it in a browser in a minute.

**Not changed.** No port count, PoE figure, board part number or slot table was read this pass, so no
spec is written and #803 stays open. The frame arithmetic in the registry (DC 14 service slots,
AC 12 at 1500 W / 10 at 2400 W) still comes from the anonymously published chassis chapter, and the
service-board population is still unstated.

**Reusable.** The three-state test is the instrument the next census should use. Anywhere this
repository has written "unpublished" on the strength of a `/doc/<ID>` 302 - including the OceanProtect
rows - the claim may really be "gated", and one navi query per id settles it.
