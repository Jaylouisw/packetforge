# UniFi cloud gateways — Port Layout census

Read from Ubiquiti's own rendered tech-spec tables on 2026-11-19, one page per
product card on `https://techspecs.ui.com/unifi/cloud-gateways` (HTTP 200,
610,412 B, sixteen cards: `ef-core efg ucg-fiber ucg-industrial ucg-max
ucg-ultra udm-beast udm-pro udm-pro-max udm-se udr udr-5g-max udr7 udw ux ux7`).

Every page below answered 200 **at its own URL** (no redirect to
`https://techspecs.ui.com/`), so none of them is the 609,911 B fallback page that
this host serves for a slug it does not have.

| product | Port Layout, verbatim | page bytes |
|---|---|---|
| ef-core | 1 GbE RJ45 = 2 (1G/100M/10M); 10 GbE RJ45 = 8 (10G/5G/2.5G/1G/100M); 25G SFP28 = 4 (25G/10G/1G); 100G QSFP28 = 4 (100G/40G); **MGMT = 1 (1G/100M/10M)**; **Console = 1** | 674,322 |
| efg | 2.5 GbE RJ45 = 2 (2.5G/1G/100M/10M); 10G SFP+ = 2 (10G/1G); 25G SFP28 = 2 (25G/10G/1G) | 678,934 |
| ucg-fiber | 2.5 GbE RJ45 = 4 (2.5G/1G/100M/10M); 10 GbE RJ45 = 1 (10G/2.5G/1G); 10G SFP+ = 2 (10G/1G) | 667,242 |
| ucg-industrial | 2.5 GbE RJ45 = 4 (2 PoE+++, 2 PoE+) (2.5G/1G/100M); 10 GbE RJ45 = 1 (PoE+++) (10G/5G/2.5G/1G/100M); 10G SFP+ = 1 (10G/1G) | 699,443 |
| ucg-max | 2.5 GbE RJ45 = 5 (2.5G/1G/100M/10M) | 668,564 |
| ucg-ultra | 1 GbE RJ45 = 4 (1G/100M/10M); 2.5 GbE RJ45 = 1 (2.5G/1G/100M/10M) | 657,109 |
| udm-beast | 1 GbE RJ45 = 2 (1G/100M/10M); 10 GbE RJ45 = 8 (10G/5G/2.5G/1G/100M); 10G SFP+ = 2 (10G/1G); 25G SFP28 = 2 (25G/10G/1G); **Console = 1** | 679,909 |
| udm-pro | 1 GbE RJ45 = 9 (1G/100M/10M); 10G SFP+ = 2 (10G/1G) | 676,527 |
| udm-pro-max | 1 GbE RJ45 = 8 (1G/100M/10M); 2.5 GbE RJ45 = 1 (2.5G/1G/100M/10M); 10G SFP+ = 2 (10G/1G) | 677,375 |
| udm-se | 1 GbE RJ45 = 8 (1G/100M/10M); 2.5 GbE RJ45 = 1 (2.5G/1G/100M/10M); 10G SFP+ = 2 (10G/1G) | 682,320 |
| udr | 1 GbE RJ45 = 5 (2 PoE) (1G/100M/10M) | 685,837 |
| udr-5g-max | 2.5 GbE RJ45 = 4 (1 PoE) (2.5G/1G/100M); 10G SFP+ = 1 (10G/1G) | 876,426 |
| udr7 | 2.5 GbE RJ45 = 4 (1 PoE) (2.5G/1G/100M/10M); 10G SFP+ = 1 (10G/1G) | 694,590 |
| udw | 1 GbE RJ45 = 17 (4 PoE++; 4 PoE+; 4 PoE) (1G/100M/10M); 2.5 GbE RJ45 = 1 (2.5G/1G/100M); 10G SFP+ = 2 (10G/1G) | 704,702 |
| ux | 1 GbE RJ45 = 2 (1G/100M/10M) | 670,206 |
| ux7 | 2.5 GbE RJ45 = 1 (2.5G/1G/100M/10M); 10 GbE RJ45 = 1 (10G/5G/2.5G/1G/100M) | 688,360 |

## What the census changed

`devices/ubiquiti/ef-core.json` was the only row whose modelled socket count
contradicted its own page: 18 jacks modelled against the vendor's 20, missing the
separate **MGMT** RJ45 and the **Console** port, and missing the 10M rung on the
two 1 GbE data ports. Corrected in this pass.

## Still open from the same census

`udm-beast` prints **Console = 1** and the spec at `devices/ubiquiti/udm-beast.json`
does not carry it. Not fixed in this pass: one device per increment. It is the
next row in this family to correct, and the evidence is the row above.
