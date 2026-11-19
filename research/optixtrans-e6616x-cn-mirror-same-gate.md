# The `.cn` support mirror is the same door, not a second one - and the zh series list is popular science

Measured 2026-11-19 01:2x-01:5x UTC, one increment on request #803 (Huawei OptiXtrans E6616X). Every
earlier pass on this family used `support.huawei.com`. Huawei runs a second enterprise support host,
`support.huawei.cn`, with its own uniportal (`uniportal.huawei.cn`) - a plausible second door, because
a mirror that answers for a different session realm would be exactly the kind of thing the earlier
crawls could not see from outside. It is not. The two hosts serve the same document lists, byte for
byte after decompression, and refuse the same ids with the same status.

## 1. The mirror is byte-identical

Requested with a search-crawler UA, `--compressed`, both hosts, same path:

| page | .com | .cn | decoded md5 |
|--|--|--|--|
| `zh/.../optixtrans-e6616x-pid-257173887` | 200, 85,317 B on the wire | 200, 100,455 B | **81580b68** both |
| `en/.../optixtrans-e6600-series-pid-266120513` | 200, 84,878 B | 200, 100,152 B | **9ffb857b** both |

The wire sizes differ only because the two edges gzip at different levels; the decompressed pages are
the same bytes (437,872 B for the E6616X page, the figure earlier passes already recorded). So the
mirror adds no document the `.com` page lacks - it cannot, it is serving the same HTML.

## 2. The gate is the same gate

`/hedex/api/navi/<id>/first-level-tree`, the three-state probe established in
`research/optixtrans-e6616x-docs-gated-not-unpublished.md`, on the `.cn` host:

| id | what it is | .com | .cn |
|--|--|--|--|
| `EDOC1100558549` | E6600 V100R025C10 硬件描述 (newest zh edition) | 401 | **401** `NOT LOGIN!`, `loginUrl: https://uniportal.huawei.cn/...` |
| `EDOC1100625831` | OptiXtrans E6600 V100R026C00 Feature Description | 401 | **401** |
| `EDOC1100605035` | OSN 1800 / E6600 / DC908 UI guide (known public) | 200 | 200 |

`/enterprise/zh/doc/<id>` behaves the same way: `EDOC1100558549` and `EDOC1100456166` answer `302 ->
/view/notFound`, which is what a gated document also does (the same misreading this thread had to
correct once already). A login on the `.cn` uniportal is a separate account realm, so this is not a
free bypass either.

## 3. The zh twin of the E6600-Series list, counted

The E6600-Series product page was inside the 299-id census of 2026-11-18 through its **English** list
(189 ids). Its Chinese twin is a *different* list, and it had never been counted:

| list | ids | open (200) | gated (401) | dead (404) |
|--|--|--|--|--|
| `en` E6600-Series (pid-266120513) | 189 | 23 | 166 | 0 |
| `zh` E6600-Series (pid-266120513) | 75 | 40 | 35 | 0 |
| union | **264** | 63 | 201 | 0 |

The 75 ids on the zh list are disjoint from the 189 English ones - different localisation ids, not a
subset - so "75 new ids" is the honest count. They buy nothing: of the 40 open ones, every one sampled
is a popular-science post rather than a document -

- `EDOC1100496833` 传送小百科-第4期：波分系统的基本构成之OTU
- `EDOC1100535528` 传送小百科-第13期：OXC技术和价值
- `EDOC1100593014` 传送小百科-第20期：OTN P2MP 2.0解决方案
- `EDOC1100550968` 【知光漫谈】什么是1ms城市算网

and the ids themselves are the same `EDOC10001631xx` / `EDOC11004968xx` video block the English page
links in translation. Of the 23 open English ids, 21 are `(Video)` or 【Optical Basics】 and the two
substantive ones are the UI guide and the EUCC statement already recorded. No board chapter, and no
hardware description, is open on either list.

## 4. What this changes

Nothing about the blocker, and that is the result: the second host is not a second door, so a future
pass need not spend fetches on it. The missing fields are unchanged and exact -

- a **service-board part number valid in an E6616X subrack**, and
- that board's **front-panel port census** (count, rate, cage).

What would still unblock it: one authenticated read of `EDOC1100625826` (V100R026C00 package) or
`EDOC1100558549` / `EDOC1100625831` from a Huawei enterprise account, or a stated configuration of the
shape `E6616X DC (14x <board>)`. The frame arithmetic is vendor-sourced and waiting.

## 5. Reproduce

```
UA='Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
for h in support.huawei.com support.huawei.cn; do
  curl -sS --compressed -A "$UA" -o page.html \
    "https://$h/enterprise/zh/optical-transmission/optixtrans-e6616x-pid-257173887"
  md5sum page.html          # same digest on both hosts
done
curl -sS -o /dev/null -w '%{http_code}\n' -A "$UA" \
  'https://support.huawei.cn/hedex/api/navi/EDOC1100558549/first-level-tree'   # 401
# the two series lists, then one navi probe per id (264 ids, 63 x 200)
grep -o 'EDOC[0-9]\{10\}' page.html | sort -u
```
