# Import report — security/energy and rack-power/KVM batches

Two research files were imported into `devices/` on 2025-11-08 with
`scripts/import-devices.js --apply`, one file per run, each from its own
`PF_INCOMING` scratch directory (never bare from `research/incoming/`).

| Source file | Specs | Imported | Skipped (duplicate) | Rejected | Corrected before import |
|---|---|---|---|---|---|
| `devices-security-energy.json` | 12 | 12 | 0 | 0 | 5 (wireless connector) |
| `devices-rack-power-kvm.json` | 12 | 12 | 0 | 0 | 2 (1 capability, 1 description) |
| **Total** | **24** | **24** | **0** | **0** | **7** |

Catalogue after import: **905 models across 199 vendors** (was 881 / 188), +24
models and 11 vendors not previously represented (2n, akuvox, eaton,
tripp-lite, avocent, hms, mercury, hid, alfen, wallbox, fronius).

## Deduplication

Nothing was skipped: no incoming `vendor|model` pair (case-insensitive) exists
in `devices/`. The near-miss checks that were run explicitly, because these are
the variants most likely to already be covered:

| Incoming | Nearest existing entry | Verdict |
|---|---|---|
| `apc/AP8965` | `apc/AP8959` (switched PDU) | different model — imported |
| `apc/NetBotz NBRK0750` | `apc/NetBotz NBRK0250A` | different model — imported (the 250A note already says the 750-series is the Gigabit variant) |
| `raritan/KX4-101` | `raritan/Dominion KX III KX3-864` | different model — imported |
| `aten/SN0116CO` | `aten/KN2124VA` | different model (serial console server, not KVM) — imported |
| `lantronix/SLS200USB0-01` | `lantronix/SLC8000`, `lantronix/UDS1100` | different model — imported |
| `hikvision/DS-KV8113-WME1(C)` | existing hikvision set is cameras/NVR only | no door station present — imported |
| `shelly/Pro 3EM` | `shelly/Plus 1`, `Plus 1PM`, `Pro 4PM` | different model — imported |

## Specs that needed correcting

The importer's schema gate rejected none of the 24, so every correction below was
a fidelity fix found by review, not a validator failure. Each fix is supported by
the spec's own cited datasheet/manual text.

1. **`connector: "internal"` on 5 wireless ports** (hikvision DS-KV8113-WME1(C),
   dahua VTO2211G-WP, alfen Eve Single Pro-line, wallbox Commander 2, shelly
   Pro 3EM). `internal` is not a cage the engine models, so the port fell back to
   RJ45 copper — the audit flagged it HIGH as "a wireless radio must present an
   antenna … it renders as a wired socket and can be cabled to copper", and the
   cable matrix failed. The radio is real; only the connector token was wrong.
   Changed to `antenna`, which is what the 89 existing wireless ports use. This
   is the one correction that changed an already-written file, so the batch was
   re-verified after it.
2. **`hms/AB7505-F` — dropped `cli`.** The record's own source (HMS specification
   tab) documents configuration only by web page and Anybus Configuration
   Manager; an X-gateway has no command line. `host`, `http-server`,
   `dhcp-client` kept. Capabilities are what the simulator branches on, so
   claiming a shell the box does not have is the exact error class the closed
   set exists to prevent.
3. **`raritan/KX4-101` — description wording.** It said "fibre-channel-style
   digital video and USB stay on the server side", which describes no real
   interface. Replaced with "the server-side HDMI video and USB keyboard/mouse
   links are not network ports", which is what the datasheet panel actually
   shows ('HDMI to Server', 'USB-B to Server').

Left deliberately alone: the 100 console ports on the new serial devices carry
`speed: "100M"`, matching the 100 existing console ports already in the catalogue
(digi, etc.). `media.js` ignores the figure for the console cage (it always
presents `console-rs232` at 115200 bps), so it is cosmetic — but it is not the
convention-breaking change it looks like.

## Imported models

Ports are counted per interface as written in the file. "Rejected"/"skipped"
columns are absent because no record in either file was dropped.

### `devices-security-energy.json` — IP door stations, access controllers, EV chargers, energy meters/inverters

| Vendor | Model | Category | Ports | Action |
|---|---|---|---|---|
| 2n | IP Style | camera | 1× 100M RJ45 | imported |
| akuvox | E16C | camera | 1× 100M RJ45 | imported |
| hikvision | DS-KV8113-WME1(C) | camera | 1× 100M RJ45 + 1× 2.4 GHz radio | imported |
| axis | A8207-VE | camera | 1× 100M RJ45 | imported |
| dahua | VTO2211G-WP | camera | 1× 100M RJ45 + 1× 2.4 GHz radio | imported |
| axis | A1001 | iot | 1× 100M RJ45 | imported |
| mercury | MP1502 | iot | 1× 100M RJ45 | imported |
| hid | Aero X1100 | iot | 1× 100M RJ45 | imported |
| alfen | Eve Single Pro-line | iot | 1× 100M RJ45 + 1× 2.4 GHz radio | imported |
| wallbox | Commander 2 | iot | 1× 100M RJ45 + 1× 2.4 GHz radio | imported |
| fronius | Symo GEN24 10.0 Plus | iot | 2× 100M RJ45 + 1× radio | imported |
| shelly | Pro 3EM | iot | 1× 100M RJ45 + 1× 2.4 GHz radio | imported |

Door stations are filed as `camera` (they are ONVIF/RTSP video devices and the
catalogue has no intercom category); access controllers, chargers, inverters and
meters as `iot`. Both are in the importer's accepted vocabulary.

### `devices-rack-power-kvm.json` — switched PDUs, IP KVM, console servers, sensors, industrial gateways

| Vendor | Model | Category | Ports | Action |
|---|---|---|---|---|
| apc | AP8965 | host | 1× 100M RJ45 | imported |
| raritan | PX3-5190R | host | 1× 1G + 1× 100M RJ45 | imported |
| eaton | EMA333-10 | host | 1× 100M RJ45 | imported |
| tripp-lite | PDUMH30NET | host | 1× 100M RJ45 | imported |
| raritan | KX4-101 | host | 1× 1G RJ45 + 1× console | imported |
| avocent | MPU2016DAC | host | 2× 1G RJ45 + 1× console | imported |
| aten | SN0116CO | host | 2× 1G RJ45 + 16× console | imported |
| lantronix | SLS200USB0-01 | host | 1× 1G RJ45 + 1× console | imported |
| apc | NetBotz NBRK0750 | host | 2× 1G RJ45 | imported |
| raritan | EMX2-888 | host | 1× 100M RJ45 + 1× console | imported |
| moxa | MGate MB3660-8-2AC | host | 2× 100M RJ45 + 8× console | imported |
| hms | AB7505-F | host | 4× 100M RJ45 | imported |

PDUs, KVM switches and environmental appliances are filed as `host`, matching the
existing `apc/AP8959`, `apc/NetBotz NBRK0250A` and `aten/KN2124VA` entries. None
of them claims `l2-forward` or `l3-forward`: a PDU's management port is a host
interface, and where a record describes a PDU-to-PDU or proprietary sensor bus
(APC Network Port Sharing, Eaton daisy-chain, Raritan cascade, NetBotz A-Link,
Raritan RJ-45 feature/RS-485 ports) that bus is documented in `notes` instead of
being modelled as an Ethernet port. The two exceptions carry real NICs and say so:
`raritan/PX3-5190R` (primary + redundant NIC) and `apc/NetBotz NBRK0750` (public
LAN + PoE+ private LAN, recorded as a second host port, not as a switch).

## Gate results

Run after each batch; the numbers below are the final state, after both imports.

```
$ node test/hardware-invariants.test.js
✓ the catalogue is still populated (905 models)
19 passed, 0 failed
```

```
$ node scripts/audit-port-types.js
  models:  905 across 199 vendors
  ports:   11202
  offending devices: 0
  offending ports:   0  (high 0, medium 0, low 0)
No port contradicts its declared type.
```

```
$ node test/cable-matrix.test.js
  unused cages         : lc-apc, usb
OK: every pair matches the specification.
```

`lc-apc` and `usb` were already unused before this import and are unchanged by
it — nothing here adds or removes a cage.
