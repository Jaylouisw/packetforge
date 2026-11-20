# The E6616X product page is a shell in every locale, and the archive kept the shell

Measured 2026-11-20 19:2x-19:3x UTC, one increment on request #803 (Huawei OptiXtrans E6616X). The
issue's missing field has not changed - the service-board census valid in an X subrack - and this pass
adds no field. What it does is close two surfaces the thread had open by implication rather than
measurement: **the non-English editions of the product page**, of which only `/cn/` had been probed, and
**the Wayback Machine's copies of the support-portal product page**, which predate the login wall and
were therefore worth opening.

## 1. The locale editions are the same shell as the bogus slug

`https://e.huawei.com/<locale>/products/optical-transmission/optixtrans-e6616x` was fetched with the
crawler user-agent already used for this vendor (Googlebot), with a **control request for a slug that
cannot exist** (`optixtrans-e6699`) in the same locale:

| locale | `-e6616x` | `-e6699` (control) | bytes | md5 (both) | `E6616X` occurrences |
|--|--|--|--|--|--|
| `es` | 200 | 200 | 325,313 | `4c576b15c75c…` | 0 |
| `de` | 200 | 200 | 323,642 | `49e839dc130a…` | 0 |
| `tr` | 200 | 200 | 328,556 | `83de63b1e320…` | 0 |
| `fr` | 200 | 200 | 328,984 | `67ee1e2575f8…` | 0 |
| `ru` | 301 | 301 | 165 | `fae1ee88425a…` | 0 |
| `ja` | 301 | 301 | 165 | `fae1ee88425a…` | 0 |

Every locale answers the real slug and the impossible one **byte-identically**, and none of the twelve
bodies contains the string `E6616X`. `/ru/` and `/ja/` do not serve the path at all (301, 165 B - the
same redirect body for both slugs). This is the `/cn/` result (`research/optixtrans-e6616x-...`, and the
2026-11-20 04:3x comment on #803: 348,308 B, md5 `c366504bee8a`, identical to `/optixtrans-e6699`)
generalised: **the soft-200 is site-wide across locales, not a Chinese-edition quirk**, so a 200 on any
`e.huawei.com` product path is not evidence that a page exists and only a body diff against a bogus slug
tells the two apart.

## 2. The archived support page is the same shell

`web.archive.org` has three captures of the E6616X support-portal product page
(`support.huawei.com/enterprise/en/optical-transmission/optixtrans-e6616x-pid-257173887`), two of them
from before the current gate:

| capture | bytes on disk (`id_` raw) | `TMB` / `TM65` / `TMK` / `B1L` / `EDOC` / `Slot` / `100G` |
|--|--|--|
| 2024-03-02 00:10:01 | 356,312 | 0 / 0 / 0 / 0 / 0 / 0 / 0 |
| 2024-12-13 18:19:17 | 641,154 | 0 / 0 / 0 / 0 / 0 / 0 / 0 |

Both are JavaScript shells: the document list is fetched client-side, so the archive kept the frame and
none of the payload. The 2025-05-20 capture is 8,301 B on the wire (an error page) and was not opened.

The same query family for the document pages themselves returns **nothing archived**:

| URL | CDX result |
|--|--|
| `support.huawei.com/enterprise/en/doc/EDOC1100456166` (R024C10 HD, the newest offered for the X) | `[]` |
| `support.huawei.com/enterprise/en/doc/EDOC1100625826` (V100R026C00 package) | `[]` |
| `support.huawei.com/enterprise/en/doc/EDOC1100558549` (R025C10 HD) | `[]` |

So the archive holds neither the portal payload nor any chapter of the hardware description: the
"read an older edition" route is not merely gated today, it was never captured.

## 3. Where #803 stands after this

Unchanged, and both halves are now measured rather than assumed:

1. **A build.** No vendor document that is reachable anonymously states the service boards valid in an
   E6616X subrack or their front-panel census. Reachable-and-empty now includes every locale of the
   product page (§1), both pre-gate archive captures (§2), the full 27-part `(N)-` `e-file` bundle
   (`research/optixtrans-e-file-numbered-bundle.md`), the 273-page MIB guide
   (`research/optixtrans-e6616x-public-corpus-inventory.md`), the Common Criteria security target, and
   the 26H2 brochures. The only census (32x E1/T1 on the `B2DMS` + 2x `B2PD1` assembly) exists on
   reseller reprints and re-uploaded Huawei decks, which `docs/MAINTAINING.md` does not let a field rest
   on.
2. **A port type.** `engine/media.js` has no E1/T1 (G.703) family: a 2.048 Mbit/s BNC or 120-ohm twisted
   pair port would classify as `serial` and draw as a V.35 socket, which `scripts/audit-port-types.js`
   polices. That is an engine change and out of scope for this stream
   (`research/optixtrans-e6616x-port-type-gap.md`).

The two things that would close it are therefore a maintainer decision each - an E1/T1 media family, and
a stated build of the shape `E6616X DC (n x TMB2TPS)` - not another probe. This note exists so the next
pass does not spend a fire on locales or the Wayback Machine.
