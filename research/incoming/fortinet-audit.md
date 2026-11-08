# Fortinet audit — every spec in `devices/fortinet/`

Audit opened for issue **#59** ("FortiGate 200G models no copper ports"), widened to the
whole vendor directory because the issue suspected the same omission elsewhere.

Method: each spec was compared, port by port, against the vendor's own port table —
the FortiGate *Hardware Acceleration* "fast path architecture" page where one exists
(it lists front-panel interfaces verbatim, and its `diagnose npu np7lite port-list`
output gives the FortiOS interface *names*), otherwise the model's data sheet. Only
differences the source states outright were fixed. Nothing was added to make a count
come out right, and nothing was removed that a source does not disprove.

- Specs audited: **12** (`fortiadc-1000f`, `fortiauthenticator-300f`, `fortigate-40f`,
  `fortigate-60f`, `fortigate-80f`, `fortigate-90g`, `fortigate-100f`, `fortigate-200f`,
  `fortigate-200g`, `fortigate-600e`, `fortigate-1800f`, `fortigate-3000f`)
- Datasheets that could not be opened: **none**
- Verdicts: **5 wrong** (all fixed here), **6 right**, and **1 right on ports but with a
  copper rate list corrected**

## The 200G port table (the #59 fix)

FortiGate 200G / 201G fast path architecture, FortiOS 8.0.2:

> Two 10/100/1000BASE-T RJ45 (HA, MGMT) that are not connected to the NP7Lite.
> Eight 10/100/1000BASE-T RJ45 (1 to 8).
> Eight 5GigE/2.5GigE/1GigE/100M BASE-T RJ45 interfaces (9 to 16).
> Eight 10/1 GigE SFP+/SFP (X1 to X8). X1 and X2 are FortiLink interfaces.
> Four 1GigE SFP (17 to 20).

FG-200G-DAT-R12 agrees and adds the management pair and the USB/console ports:

| FortiOS name | Count | Connector | Rates | Notes |
|---|---|---|---|---|
| `mgmt` | 1 | RJ45 | 10/100/1000 | not on the NP7Lite |
| `ha` | 1 | RJ45 | 10/100/1000 | not on the NP7Lite |
| `port1`–`port8` | 8 | **RJ45** | **10/100/1000** | the eight GE switch ports — the ones #59 was about |
| `port9`–`port16` | 8 | RJ45 | 100 / 1G / 2.5G / 5G | 5GBASE-T, no 10BASE-T |
| `x1`–`x8` | 8 | SFP+ / SFP | 10G / 1G | X1 and X2 are FortiLink by default |
| `port17`–`port20` | 4 | SFP | 1G | |
| USB, console | 1 + 1 | — | — | not modelled, consistent with the rest of the catalogue |

30 interfaces after the fix (28 data ports + MGMT + HA).

What was actually wrong: `port1`–`port8` were produced by a `portTemplate`, and every
audit in the repo (`scripts/audit-port-types.js`, the description-vs-port check in
`test/hardware-invariants.test.js`) reads `spec.interfaces` only. So the eight copper
ports existed at runtime but were invisible to review, and they carried no `connector`
and no rate list. They are now eight explicit interfaces with `connector: "rj45"` and
`speedCaps: [10, 100, 1000]`, and `port9`–`port16` — which were bare `speed: "5G"` —
carry their documented ladder `[100, 1000, 2500, 5000]` instead of the engine's
10M–5G default. The fibre ports are untouched.

## Verdicts

| Spec | Verdict | Difference and action |
|---|---|---|
| `fortigate-200g` | **WRONG → fixed** | `port1`–`port8` invisible to audits and untyped; `port9`–`port16` had no rate bounds. See the table above. |
| `fortigate-90g` | **WRONG → fixed** | The eight internal ports were generated as `port1`–`port8`; FortiOS names them **`port1`–`port6`, `a`, `b`** (A and B are the FortiLink pair) — the `port-list` output in the hardware doc spells this out. `wan1`/`wan2` were declared 2.5G although the doc rates the copper half of each shared position at **10GigE/5GigE/2.5GigE/1GigE/100M**; they are now 10G copper with `[100, 1000, 2500, 5000, 10000]`. Shared media with `sfp1`/`sfp2` was already modelled. |
| `fortigate-80f` | **WRONG → fixed** | `sfp1`/`sfp2` had no connector, so they resolved to **RJ45 copper** — an 80F could not take a fibre link, and the description's "2x GE SFP" was unbacked. WAN1/SFP1 and WAN2/SFP2 are one connector each ("2 x GE RJ45/SFP shared media pairs"), and were modelled as four independent ports; both are now combo pairs, like the 100F and 90G. |
| `fortigate-600e` | **WRONG → fixed** | `x1`/`x2` (the two 10 GE SFP+ slots) had no connector; `x1` is not a name the cage inference recognises at 10G, so both fell through to **RJ45 copper**. Now `connector: "sfp+"`, `[10000]`. `sfp1`–`sfp8` were only optical by name inference; their connector is now explicit. |
| `fortigate-1800f` | **WRONG → fixed** | `ha1`/`ha2` are the **10 GE SFP+ / GE SFP HA slots** but resolved to RJ45 copper (same inference gap: `ha` is not an optical name and 10G is not an inferable optical rate). Now `sfp+`, `[1000, 10000]`. The 25G and 100G slots were optical only by rate inference; they now declare `sfp28` / `qsfp28`. The QSFP slots were declared 40G while the datasheet calls them "100 GE QSFP28 / 40 GE QSFP+" — now 100G with 40G in the rate list. The 16 copper ports stay on the `internal1-16` template (count matches). |
| `fortigate-3000f` | **RIGHT**, rates tightened | 16 x 10 GE / 5 GE / 2.5 GE / GE RJ45, 2 x 10GE/GE RJ45 MGMT, 14 x 25 GE SFP28 + 2 x 25 GE HA, 6 x 100 GE QSFP28 — counts and cages match exactly. The only change is the copper template's rate list `[1000, 2500, 5000, 10000]`: the engine default offered 10BASE-T and 100BASE-TX on 10GBASE-T ports, which the datasheet does not list. |
| `fortigate-100f` | **RIGHT** | 22 x GE RJ45 (2 WAN, 1 DMZ, 1 MGMT, 2 HA, 16 switch with 4 SFP shared media), 4 x GE SFP, 2 x 10 GE SFP+ FortiLink — all 32 interfaces, the four combo pairs and the `-sfp` naming already match. No change. |
| `fortigate-200f` | **RIGHT** | 18 x GE RJ45 (1 MGMT, 1 HA, 16 switch), 8 x GE SFP, 4 x 10 GE SFP+ (2 network, 2 FortiLink) — 30 interfaces, all present and correctly caged. No change. |
| `fortigate-40f` | **RIGHT** on hardware | 5 x GE RJ45 = 1 WAN + 3 internal + 1 FortiLink; the spec has `wan1` + `internal1`–`internal4` = 5 copper ports. The FortiLink port is modelled as `internal4` rather than by a FortiLink name; the datasheet gives front-panel labels, not FortiOS names, so the name is not disproved and was left alone. |
| `fortigate-60f` | **RIGHT** on hardware | 10 x GE RJ45 = 2 WAN + 1 DMZ + 5 internal + 2 FortiLink; the spec has `wan1`, `wan2`, `dmz` + `internal1`–`internal7` = 10. Same cosmetic point as the 40F (two of the seven are the FortiLink ports). |
| `fortiadc-1000f` | **RIGHT** | FAD-1000F: "4x 10 GE SFP+ ports, 8x GE SFP ports, 8x GE RJ45 ports, 1x GE RJ45 management port" = 21; the spec has exactly that (`port1`–`port8` SFP, `port9`–`port16` RJ45, `port17`–`port20` SFP+, `mgmt1`). Ports 1–8 also list 100M alongside 1G; an SFP cage that takes a 100BASE-FX module is not something the datasheet rules out, so it was left as is. |
| `fortiauthenticator-300f` | **RIGHT** | Hardware table: 10/100/1000 copper RJ-45 x 4, SFP interfaces 0 for FAC-300F. The spec has `port1`–`port4`. The console port is not modelled, consistent with the rest of the catalogue. |

## Two findings about the tooling, not the hardware

1. **`portTemplate` is invisible to every audit.** Ports generated by a template are
   real in the engine but absent from `spec.interfaces`, so `scripts/audit-port-types.js`
   and the "description promises ports the spec lacks" invariant cannot see them. The
   200G's eight copper ports sat in that blind spot, which is why #59 read as "the
   device has no copper ports at all" while a topology could cable them. Five Fortinet
   specs still rely on a template for their copper ports (`40f`, `60f`, `600e`,
   `1800f`, `3000f`); their counts are right, but teaching the audit to expand
   `portTemplate` would close the blind spot for the whole catalogue. `scripts/` is out
   of scope for this change.
2. **Cage inference only recognises `sfp`/`qsfp`/`xfp`/`cfp` names and 25G/40G/100G
   rates.** A 10G port called `x1` or `ha1` therefore resolves to RJ45 copper — that is
   exactly how the 600E and 1800F lost their fibre. Explicit `connector` on every
   optical port is the durable fix, and is what the files fixed here now do.
