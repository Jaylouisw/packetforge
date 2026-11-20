# HPE OfficeConnect PoE budgets, read off HPE's own QuickSpecs

Measured 2026-11-20 06:3x UTC for the five `devices/hpe/officeconnect-*-poe-*.json` entries whose
`poe.budgetW` was absent, so `scripts/audit-poe-budget.js` reported each one as "inferred from the
model name". Every number below is printed by an HPE-hosted PDF, fetched today with a desktop
user-agent; none is derived from the SKU suffix.

## What each row prints

| spec | SKU | HPE's row, verbatim | budget |
|---|---|---|---|
| `officeconnect-1420-5g-poe-32w` | JH328A | "This product provides PoE or PoE+ power across 4 of 5 ports, with a total power budget of 32W" | 32 W |
| `officeconnect-1820-8g-poe-65w` | J9982A | "PoE power 65 W PoE+" | 65 W |
| `officeconnect-1820-24g-poe-185w` | J9983A | "PoE power 185 W PoE+" | 185 W |
| `officeconnect-1950-24g-2sfp-plus-2xgt-poe-370w` | JG962A | "PoE power 370 W PoE+" | 370 W |
| `officeconnect-1950-48g-2sfp-plus-2xgt-poe-370w` | JG963A | "PoE power 370 W PoE+" | 370 W |

Sources (all `https://www.hpe.com/psnow/downloadDoc/...`, HTTP 200, text layer):

- 1420 QuickSpecs, v10 26-Aug-2019, `HPE OfficeConnect 1420 Switch Series-c04609036.pdf`
- 1820 QuickSpecs, v7 07-Feb-2022, `HPE OfficeConnect 1820 Switch Series-c04518995.pdf`
- 1950 QuickSpecs, v10 05-Feb-2018, `HPE OfficeConnect 1950 Switch Series-c04545486.pdf`

The full URLs are recorded in each spec's `poe.sourceUrl` and top-level `sourceUrl`. `psnow`
`downloadDoc` links answer to `web_extract` even though plain `curl` to `www.hpe.com` dies on an
HTTP/2 `INTERNAL_ERROR`; that is an instrument note, not a gate.

## Three things worth not re-deriving

1. **The 1820 QuickSpecs contradicts itself on the 24-port.** Its PoE+ availability bullet says
   "Ports 1 - 12 provide PoE+ on the HPE 1820-24G-PoE+ (**180W**) switch", while the model list, the
   configuration section and the J9983A Technical Specifications row all read **185 W**. 185 W is
   modelled (three statements against one); the 180 W bullet is stale text carried from an earlier
   revision.
2. **The 1420's 32 W is not 4 x 8 W.** HPE's own switch guide prints, for the same chassis,
   "Max. PoE power per port 30 W", "Total PoE output 32 W" and "Max. PoE ports at full 30 W output:
   **1**". So the 32 W allocation buys one 30 W device; four devices are served only at phone-class
   draw.
3. **The 1950s have an RJ-45 console the catalogue did not model.** Both JG962A and JG963A print
   "Additional ports and slots: 1 RJ-45 console port to access limited CLI port" - which is why both
   specs already declared `capability: cli` with no console interface. They now carry
   `{"name":"console","type":"console"}`. No connector is declared: `test/hardware-invariants.test.js`
   ("every typed port resolves to a cage of its own type") refuses `type: console` + `connector: rj45`,
   because the engine would then cable it as a data port. The same rule is why
   `devices/allied-telesis/at-x530-28gpxm.json` models its RJ-45 RS-232 console the same way.
4. **RPS figures are not budgets.** 1950 prints 720 W (24-port) and 800 W (48-port) "when supplemented
   with the use of an HPE RPS1600" (JG136A, sold separately); the internal-supply allocation is 370 W
   on both, which is what is modelled. Same call as the ECS-48-PoE 2,250 W row in #2249.

## Series members this tree does not carry (not added here)

Named by the same HPE documents, absent from `devices/hpe/`: 1420 8G PoE+ 64 W (JH330A), 1420 24G
PoE+ 124 W (JH019A), 1820 48G PoE+ 370 W (J9984A), 1950 12XGT 4SFP+ (JH295A), 1950 24G/48G
2SFP+ 2XGT non-PoE (JG960A/JG961A). Each has a full HPE row, so any of them is a spec that can be
written from a source rather than inferred.
