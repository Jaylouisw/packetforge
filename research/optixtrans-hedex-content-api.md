# The hedex content API is identified — and both hosts that ever served it are closed to anonymous readers

Follow-up to `research/optixtrans-e9600-board-datasheet.md` (which closed every *document* route to
`EDOC1100163901` and ended on the hedex single-page shell) and to `research/optixtrans-client-board-chapters.md`
(which closed the search route). Those notes treated `support.huawei.com/hedex` as an opaque wall: a 3,728-byte
shell, or a 403 to a browser user-agent. This pass took the shell apart and found the content API underneath it,
the two identifiers every earlier probe was missing, and — once the API could be called — the reason it still
refuses this particular document.

Nothing here closes #803, #807, #808 or #810. It removes the last "maybe the viewer route works" and replaces it
with a named API that answers, and answers `No doc data found` for the E9600 series.

## 1. The endpoint, and the ids earlier passes did not have

`https://support.huawei.com/hedex/hdx.do?docid=EDOC1100126589&tocURL=resources%2Fhelp%2Fwdm%2F9800%2Fhd%2Fline%2Fn210%2Fn210.html&tocLibId=BEJ09047&tocLibVer=03&ui=1`
(HTTP 200, 3,728 B, crawler user-agent) is still the shell. It loads exactly one script:

- `/hedex/lst/js/index-legacy-DaAKRolI.js` — HTTP 200, 361,996 B, minified.

That bundle carries the content endpoints and the path template they take:

| string in the bundle | meaning |
|---|---|
| `/hedex/api/pages/` | the page-content call |
| `/hedex/api/pages/[^/]+/([^/]+)/([^/]+)/([^#?]+)` | a `RegExp` in the bundle: **docId / topicLibId / topicLibVer / topicUrl** |
| `/hedex/api/navi/`, `/hedex/api/navi/${e}/first-level-tree`, `/hedex/api/navi/${e}/topic/navi-tree` | table of contents |
| `/hedex/api/search/`, `/hedex/api/search/${e}/count/big-…` | search |

built as `` `/hedex/api/pages/${e}/${t.topicLibId}/${t.topicLibVer}` `` plus `topicUrl`.

**The two ids are the new part.** Earlier passes had the document id only. The `302` from any
`/hedex/pages/…` URL hands back the pair in its `Location` header — for the OSN 9800 hardware description
(`EDOC1100126589`, the document set that contains the `n210` line-board chapter):

```
Location: /hedex/hdx.do?docid=EDOC1100126589&tocURL=resources%2Fhelp%2Fwdm%2F9800%2Fhd%2Fline%2Fn210%2Fn210.html&tocLibId=BEJ09047&tocLibVer=03&ui=1
```

so `topicLibId=BEJ09047`, `topicLibVer=03`. A content URL is therefore constructible for **any** chapter whose
`/hedex/pages/…` URL is known.

## 2. What the API answers (all read 2026-11-17, crawler user-agent)

| URL | result |
|---|---|
| `https://support.huawei.com/hedex/api/pages/EDOC1100126589/BEJ09047/03/resources/help/wdm/9800/hd/line/n210/n210.html` | **404**, 18 B, body `No doc data found.` |
| same URL without the `.html` suffix | **404**, 18 B, `No doc data found.` |
| `https://support.huawei.com/hedex/api/navi/EDOC1100126589/first-level-tree` | **404**, `{"status":404,"message":"No doc data found.","data":null}` |
| `https://support.huawei.cn/hedex/api/pages/EDOC1100126589/BEJ09047/03/resources/help/wdm/9800/hd/line/n210/n210.html` | **404**, 18 B, `No doc data found.` |
| `https://support.huawei.cn/hedex/api/pages/EDOC1100625542/BEJ09047/03/resources/help` | **401**, 10 B, `NOT LOGIN!` |
| `https://support.huawei.cn/enterprise/en/doc/EDOC1100163901` | 302 -> `https://support.huawei.cn/view/notFound`, 404, 452,479 B |

Two facts follow, both useful:

1. The live API is **not** a uniform wall. It distinguishes *"this document is not served to you"*
   (`404 No doc data found`) from *"you must log in"* (`401 NOT LOGIN`), so its 404 is a statement about the
   document, not only about the caller. Read literally, the OSN 9800 chapter and the `E9600 Hardware Description`
   parent (`EDOC1100625542`) are not anonymously served even with a lib/ver pair.
2. `support.huawei.cn` is a byte-for-byte mirror of the same walls — same 452,479-byte `view/notFound` body,
   same `NOT LOGIN`. A regional host is not a way around the account.

**Caveat, stated rather than papered over:** `BEJ09047/03` is the lib/ver pair for the OSN 9800 document set that
the redirect belongs to. `EDOC1100625542` belongs to the 2026 `V100R026C00` set and may have a different one, so
the `401` above is a login wall and the `404`s are "no data for that doc under that pair". What the API does *not*
offer is a way to discover the right pair: `first-level-tree` and `topic` both answer `No doc data found` /
`NOT LOGIN` for a caller with no session, and `hedex/hdx.do` with an appended `format=json` still returns the
3,728-byte shell.

## 3. The older documentation front end is retired, and search engines have not noticed

Search still indexes `info.support.huawei.com` as an openly readable hedex host — for example
`https://info.support.huawei.com/hedex/api/pages/EDOC1000163559/YEI0812D/19/resources/en-us_topic_0000001238552187.html`
(a chapter page whose text the index holds in full) and
`https://info.support.huawei.com/enterprise/br/optical-transmission/optixtrans-e9605-pid-250732995`
(the E9605 document set).

Today every path on that host redirects to the support landing page:

| URL | today |
|---|---|
| `https://info.support.huawei.com/hedex/api/pages/EDOC1000163559/YEI0812D/19/resources/en-us_topic_0000001238552187.html` | 302 -> `https://support.huawei.com/supportindex/`, 200, 91,294 B (*not* the page text) |
| `https://info.support.huawei.com/enterprise/{en,br,fr}/optical-transmission/optixtrans-e9605-pid-250732995` | 302 -> the same landing page, 200, 91,294 B |
| `https://info.support.huawei.com/hedex/api/navi/EDOC1100625542/first-level-tree` | 302 (ALB) |

So the one Huawei-hosted URL shape that used to serve chapter text anonymously is gone. Its indexed form is
stale, which is also why a search hit on an `info.support.huawei.com/hedex/api/pages/…` URL is not evidence that
the page is readable.

## 4. No archived copy to recover

Wayback CDX, prefix queries:

| query | result |
|---|---|
| `url=info.support.huawei.com/hedex/api/pages/EDOC1100625542&matchType=prefix` | HTTP 200, **0 bytes** — no captures |
| `url=info.support.huawei.com/hedex/api/pages/EDOC1100163901&matchType=prefix` | HTTP 200, **0 bytes** — no captures |
| `url=info.support.huawei.com&matchType=domain&limit=5` | 200, captures exist (earliest `20210218151049`) — the host, not the documents |
| `url=info.support.huawei.com/hedex/api/pages/EDOC1000163559&matchType=prefix` | **504** from archive.org's own nginx after 90 s |

The last row is why this section claims no captures for two document ids only: the prefix index answers slowly
enough to time out, so "nothing archived" is asserted where the query returned a clean empty 200, and nowhere
else.

## 5. The chapter PDFs really are crawlable when they exist

Fetched this pass to test the opposite hypothesis — that anonymous `e-file.huawei.com` chapter PDFs are indexed
but unfetchable:

`https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/08ed3c9aa1274b2c84d9a591d467aaba/M3T1A669N1178216511632400475/OptiXtrans%20E9600%20TNG2SRAPXF.pdf`

HTTP 200, `application/pdf`, 1,104,102 B, and `pdftotext -layout` reproduces §1.9 *Valid Slots* with the
E9605/E9612/E9624/E9624X columns (`2` occupied slots, `(IU1, IU2) -> IU2`, and the rest of the pairing table).
This is the same document family, the same server and the same anonymous access as the `TNG1N*` chapter that
#807 needs — and the family chapter is reachable. So the missing client-board chapter is **not** a crawling or
access gap in the ordinary sense: the vendor publishes this material, and search engines index it, when it is
published. It is the client-board chapters specifically that have no published copy anywhere, which is
consistent with, and now narrower than, the earlier note that only optical-layer and transceiver chapters are
indexed.

## 6. Status after this pass

| issue | device | still missing | one thing that closes it |
|--|--|--|--|
| #803 | E6616X | a client-board chapter for the E6600 generation | the E6600 ordering/configuration guide |
| #807 | E9605 | one `TNG1N*` / `TNG1M*` chapter with a Port Specifications table | that PDF, or a stated `E9605 (5x TNG1N210)` |
| #808 | E9612 | same; the per-power-option slot map is already settled | that PDF |
| #810 | E9624 | same, plus the protection mode in the label | that PDF plus `1:1` or `1:3` |

No spec is added, and nothing in this file is a port count, wattage or slot figure of its own: the frame
arithmetic stays where the earlier notes put it, vendor-sourced, and the board census stays empty rather than
guessed.
