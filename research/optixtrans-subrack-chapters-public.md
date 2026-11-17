# The E9600 *subrack* chapters are public too — the frame half of the census is now vendor-sourced

Follow-up to `research/optixtrans-client-board-chapters.md` (PR #1819, #807) and
`research/optixtrans-board-chapters-public.md` (PR #1816). Those notes found that
`e-file.huawei.com` serves *OptiXtrans E9600 Product Documentation* as one PDF per chapter, anonymously,
and ended on one missing file: a chapter for a **client-port** board. This pass went back to the same
document set through the **material page** route and found the chapter type nobody had fetched yet — the
**subrack** chapter, one per frame. That settles the frame census from the vendor, and it corrects the
service-slot number printed on every one of these requests.

Nothing here closes #807/#808/#810: the subrack chapter describes *where boards go*, not what comes out of
their front panels.

## 1. The route (already scripted, not used for this chapter type before)

`scripts/huawei-material-fetch.js` resolves a 32-hex material hash to the real asset path, because
`https://e.huawei.com/en/documents/others/<32-hex>` is server-rendered and carries the
`pep/asset/20000001/Material/...` path inline. The TNG2DAP chapter page lists its siblings in a
"related materials" carousel; two of those are subrack chapters:

| chapter | URL | bytes | pages |
|--|--|--|--|
| OptiXtrans E9612 | `https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/1df5f09736174bdcaed9ea4e9276bf8b/M3T1A669N1188254859888107676/OptiXtrans%20E9612%20-.pdf` | 333,351 | 6 |
| OptiXtrans E9605 | `https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/cc7356212e6146b58f38b74dd1102e08/M3T1A669N1188254859704168616/OptiXtrans%20E9605%20-.pdf` | 117,447 | 2 |

Both are `HTTP 200`, `application/pdf`, no login. Material pages:
`https://e.huawei.com/en/documents/others/1df5f09736174bdcaed9ea4e9276bf8b` and
`https://e.huawei.com/en/documents/others/cc7356212e6146b58f38b74dd1102e08`.

## 2. E9612: the service-slot count is configuration-dependent (10 / 11 / 12 / 13)

Chapter *E9612 Subrack, Descriptions of the areas and slots*, read end to end:

| configuration | service board slots | slots |
|--|--|--|
| DC-powered, **master** subrack | **12** | IU1-IU12 |
| AC- or HVDC-powered, master subrack | **10** | IU3-IU12 |
| DC-powered, **slave** subrack | **13** | IU1-IU13 |
| AC- or HVDC-powered, slave subrack | **11** | IU3-IU13 |

and, in the same book, the E3CTU variant: "DC-powered subrack working as a master *or slave* subrack:
**13** service board slots, IU1-IU13; AC-powered or HVDC-powered **11**, IU3-IU13", with the footnote
that one APIU occupies physical slots IU1 *and* IU2 while occupying logical slot IU1 — which is exactly
where the two missing slots go.

Other areas, same table: PIU `IU100-IU101`; fan tray `IU90`; `TMF1EFI` at `IU13`/logical `IU72`;
`TME1EFI` at `IU71-IU72`; `TME3CTU` (master) or `AUX` (slave) at `IU73-IU74`. Mechanical: 347.2 x 442 x
295 mm, 12.2 kg — which matches the brochure and the marketing page, so the chapter is talking about the
same box those tables describe.

**The correction.** The request (#808) quotes "13 service slots", the marketplace spec table prints
`Number of Service Slots 13`, and the brochure prints 13. All three are the **maximum**: 13 is reached only
by a DC-powered slave (or E3CTU) subrack. A DC master has 12, an AC/HVDC master has 10. This is the same
shape as the E9624's "12/24 in 1:1 vs 10/20 in 1:3" — a service-slot count is not a property of the frame
alone, and the label must carry the configuration.

## 3. E9605: five service boards, and a second service range the board tables do not mention

Chapter *E9605 Subrack, Descriptions of the areas and slots*, verbatim in substance:

| area | composition | slot |
|--|--|--|
| Power and interface | two PIU/APIU boards, two EFI boards | PIU/APIU `IU100-IU101`; EFI `IU71-IU72` |
| Fan | one fan tray assembly | `IU90` |
| Service board | **5 service boards** | `IU1-IU5`, `IU73-IU74` |
| System control and cross-connect | two CTU boards (1+1) | - |

Mechanical: **177 x 442 x 260 mm, 7.6 kg**. The brochure and the marketing page both print depth
**295 mm** for the E9605 (and 295 mm for the E9612, which this chapter confirms). The 35 mm difference is
recorded here rather than resolved: it is plausibly cable-management depth versus chassis depth, but the
vendor does not say which, so neither number is safe to publish as "D" without the caveat.

**One open question, not a guess.** The service-board row names **two** ranges, `IU1-IU5` and
`IU73-IU74`, while every board chapter read so far (TNG2DAP, TNG2SRAPXF, TNG3SRAPXF) allows a service
board in `IU1-IU5` only. What is allowed to sit in `IU73-IU74` of an E9605 is therefore *not* settled by
this chapter — it needs a board whose Valid Slots row names those slots. Do not fill it in from the
E9612, where `IU73-IU74` belong to the CTU/AUX boards.

## 4. A correction to our own earlier note

`research/optixtrans-client-board-chapters.md` treated the sibling list on a material page as the
document set, and used it to argue that the set contains no client-board chapter. That inference does not
hold: the carousel is a **recommender**, not an index. An E9605 material page recommends *OceanStor 5310
and 5510 Capacity Flash Storage*, *CloudEngine S6881H*, *CloudEngine 16800* and three OceanStor
documents — unrelated products, in a different line of business. Membership in the carousel is evidence
that a document exists; absence from it is not evidence that it does not.

What still stands, unchanged: a search for the client boards by part number (`TNG1N206`, `TNG1N210`,
`TNG1N401`, `TNG1T401`, `TNG1M210D`, `TNV1T210U`) reaches the family brochure, the ActForNet mirror, an
HCIP training deck and reseller pages — never an `e-file.huawei.com` chapter. The three board chapters
that *are* published are all optical-layer (`TNG2DAP`, `TNG2SRAPXF`, `TNG3SRAPXF`), plus transceiver
chapters (`eSFP-1310nm-1.25Gb/s`, `eSFP,125M to 2.67Gbps`, `SFP 2.5Gb/s`).

## 5. What is still missing, exactly

For #807, #808 and #810 alike: the **front-panel port census of a client-port board that fits the frame** —
one chapter carrying a `TNG1N*` / `TNG1T*` / `TNG1M*` / `TNV*` board's Front Panel *and* Port
Specifications. The frame half is now settled from vendor material for E9605 and E9612 (sections 2 and 3),
and for E9624 the brochure's 1:1 / 1:3 arithmetic plus the TNG2DAP Valid Slots footnote already agree.

No spec is written from what is public today. The engine also has no way to hold the frame itself:
`devices/*.json` carries `interfaces` and `portTemplate`, and no `slots` / `modules` concept exists in
`scripts/catalogue-shapes.js` or the importer, so "model the empty shelf and its 5 service slots" is an
engine feature, not a spec file.

**What closes it in one step:** any `e-file.huawei.com` chapter for a client board of this frame, or one
stated configuration ("E9605, DC master, 5 x TNG1N210") from a Huawei document. The label then becomes
`OptiXtrans E9605 (5x TNG1N210)` — the shape `docs/RESOLUTIONS.md` already sets — with 50 x 10G line ports
read off that board's own Port Specifications.

## 6. Sources checked this pass (2026-11-17)

| URL | result |
|--|--|
| `.../Material/1df5f09736174bdcaed9ea4e9276bf8b/.../OptiXtrans%20E9612%20-.pdf` | 200, 333,351 B, 6 pp — slot arithmetic in section 2 |
| `.../Material/cc7356212e6146b58f38b74dd1102e08/.../OptiXtrans%20E9605%20-.pdf` | 200, 117,447 B, 2 pp — slot table in section 3 |
| `https://e.huawei.com/en/documents/others/1df5f09736174bdcaed9ea4e9276bf8b` | 200, 337,523 B — material page, asset path inline |
| `https://e.huawei.com/en/documents/others/cc7356212e6146b58f38b74dd1102e08` | 200 — material page; carousel is unrelated products (section 4) |
| `https://e.huawei.com/en/products/optical-transmission/optixtrans-e9600` | 200, 344,531 B — spec table unchanged; the seven 32-hex strings on it are image assets, not document links |
| `https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/0f9e00e3f2ca431693884a01667d7ec6/M3T1A669N1188254857740624027/OptiXtrans%20E9600%20Family%20-.pdf` | 200 — brochure; "Max. number of service board slots ... 13" is the maximum, see section 2 |
