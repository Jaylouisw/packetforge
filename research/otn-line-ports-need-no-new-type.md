# An OTN line port does not need a new port type — the catalogue already files them as Ethernet cages

Correction to `research/optixtrans-board-census.md` section 2.

That section ends by saying the OptiXtrans E9600 requests (#807 E9605, #808 E9612, #810 E9624) are
blocked on **two** fields, the second being "a port type that can represent an OTN line port", and
that adding one is an engine change. The first half of that is a real and useful observation — the
engine has no `otn` type, so a spec that files a WDM-side wavelength as `type: "ethernet"` is making
a protocol claim it cannot support. The second half is wrong, and it is the half that matters,
because it puts a maintainer in front of a task that is not actually required.

**The catalogue has been filing OTN and WDM line ports as Ethernet cages since it had any optical
transport in it at all.** Four specs, two vendors, one of them Huawei and one of them the *sibling of
the very frames in the queue*. Measured on `origin/main` at `efb40710`:

| spec | line ports | filed as | the sentence that carries the compromise |
|--|--|--|--|
| `devices/huawei/optixtrans-e6616.json` | 28 `line*` | `type: ethernet`, `connector: cfp2`, `speed: 200G` | label: "14x B1LDCD (56x 100GE client, **28x 200G line**)"; notes: "client ports carry OTU4/100GE into OTN containers, and there is no L2/L3 forwarding" |
| `devices/ciena/waveserver-ai.json` | 6 `line*` | `ethernet` / `qsfp28` / 100G | "6 line ports (2 per module) each carrying a single-carrier 200G/300G/400G wavelength, modelled at this engine's 100G ceiling" |
| `devices/adva/fsp-3000.json` | 16 `line*` | `ethernet` / `qsfp28` / 100G | "16 coherent line ports (two 200G wavelengths per card, modelled at this engine's 100G ceiling)" |
| `devices/packetlight/pl-2000m.json` | 1 `line*` | `ethernet` / `qsfp28` / 100G | "aggregated onto one coherent 200G CFP2 uplink ... OTU2/OTU2e/OTU3/OTU4" |

None of those ports carries Ethernet. A coherent 200G wavelength on an FSP 3000 line card is an OTUk
signal and nothing else, exactly as a `TNG1N210` WDM-side port is OTU2/OTU2e. `scripts/audit-port-types.js`
passes on all four, and `test/hardware-invariants.test.js` passes on all four, so this is not a quirk
the gates tolerate — it is the house convention, and `devices/huawei/optixtrans-e6616.json` is the
worked example inside this same vendor and document family.

## 1. What the convention is, stated once

An optical line port is modelled as **the physical cage it really is** (`cfp2`, `qsfp28`, `sfp+`) with
`type: "ethernet"` as the engine's only vocabulary for "carries a framed signal at this rate", and the
protocol mismatch is **written down**:

- the label names the build and the line count (`OptiXtrans E6616 OTN platform, 14x B1LDCD (56x 100GE client, 28x 200G line)`);
- `notes` says what the line side really carries, and that the rate may be a ceiling (`modelled at this
  engine's 100G ceiling`);
- for a cross-connect, `fabric.kind` names the real switching discipline (`OTN cross-connect`) and
  `fabric.excludes: ["line*"]` keeps the line ports out of the offered capacity, because each is the far
  end of a client connection the fabric already carries once;
- `aliases` carries the board part number, so a search for `B1LDCD` finds the frame it fits.

That is the shape a settled E9600 spec takes. Nothing in it requires `engine/media.js` to grow a type.

## 2. What a real `otn` type would buy, and why it is not a gate

An `otn` type would let the link validator refuse to join a WDM line port to a 10GBASE-LR peer, which
today it will do — `CAGE_MEDIA['sfp+']` offers 10G Ethernet and the link layer accepts the join. That is
a genuine improvement in the model, and it is an engine change (`engine/media.js` type table plus the
faceplate renderer), which this stream is not allowed to make. It is **an improvement waiting for an
engine PR, not a prerequisite for these three specs**: the catalogue has shipped four optical-transport
models with the same limitation and states it in `notes` each time. Blocking the queue on it would mean
the four sibling specs should never have been written either.

If the type lands later, the migration is mechanical: `type: "ethernet" → "otn"` on the ports whose
names match `line*`, with the cage unchanged and `speedCaps` untouched.

## 3. So the E9600 family is blocked on one field, not two

Restating the blocker as it now stands, for #807 / #808 / #810:

1. **the board census** — one `TNG1N*` / `TNG1M*` / `TNG1T*` chapter with a Front Panel and Port
   Specifications table, *and* a vendor statement of which subrack accepts that board. Not available
   anonymously; the routes are enumerated in `research/optixtrans-subrack-chapters-public.md` section 5,
   `research/optixtrans-dap-slots-are-dap-only.md` and `research/open-device-requests.json`.
2. ~~a port type that can represent an OTN line port~~ — **not a blocker**, see above.

The label the census will produce is already determined by the frame chapters and is not in doubt:
`OptiXtrans E9605 (5x TNG1N210)` = 50 x 10G line ports, `OptiXtrans E9612 (12x TNG1N210)` for a DC
master (10 under AC/HVDC, 13 for a DC slave), `OptiXtrans E9624 (24x TNG1N210, 1:1)` — the counts come
from the board names and are what `research/optixtrans-board-census.md` section 1 already sets out; the
*validity* of the pairing is the part no vendor document this project can read states.
