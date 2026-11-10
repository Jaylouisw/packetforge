'use strict';
// media.js -- physical media, transceiver and port-hardware model.
//
// A port is modelled as a *cage* (the physical connector/cage on the box) plus
// the set of media (optics / copper / DAC) it can carry. Cabling two ports is
// only valid when the cages mate, at least one medium is shared by both ports,
// and a common speed can be negotiated.
//
// Everything here is pure data + pure functions: no dependency on Device or
// Topology, so it is safe to require from the engine, the server or tests.

// ---------------------------------------------------------------------------
// speed helpers
// ---------------------------------------------------------------------------

// Parse the terse speed strings used in device specs ("1G", "10G", "2.5G",
// "100M", "867M", "100G") into Mbps. A bare number is treated as Mbps.
function parseSpeedMbps(s) {
  if (s === null || s === undefined || s === '') return null;
  if (typeof s === 'number') return s;
  const m = String(s).trim().match(/^([0-9]*\.?[0-9]+)\s*([KMGT]?)\s*(?:b(?:it)?s?)?(?:\/s)?$/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (isNaN(v)) return null;
  switch (m[2].toUpperCase()) {
    case '': return v;
    case 'K': return v / 1000;
    case 'M': return v;
    case 'G': return v * 1000;
    case 'T': return v * 1000000;
    default: return null;
  }
}

// Render Mbps back to the short form used in the specs/UI.
function formatSpeedMbps(mbps) {
  if (mbps === null || mbps === undefined) return null;
  if (mbps >= 1000000) return (mbps / 1000000) + 'T';
  if (mbps >= 1000) return (mbps / 1000) + 'G';
  return Math.round(mbps) + 'M';
}

// ---------------------------------------------------------------------------
// media catalogue (one entry per cable/optic type)
// ---------------------------------------------------------------------------
// family: 'copper' | 'fiber' | 'dac' | 'console' | 'wireless'
// connector: physical connector the medium presents ('rj45' | 'lc' | 'mpo' | 'sfp' | 'qsfp' | 'usb' | 'console')
// speedMbps: line rate
// maxRangeM: practical maximum reach in metres (null = unbounded / n/a)
// cable: minimum copper cable category (copper only)
// fiber: 'mmf' | 'smf' | 'both'
// poe: true if the medium can carry PoE (copper only)

const MEDIA = {
  // ---- copper ----
  '10base-t': { name: '10BASE-T', family: 'copper', connector: 'rj45', speedMbps: 10, maxRangeM: 100, cable: 'cat3', poe: true },
  '100base-tx': { name: '100BASE-TX', family: 'copper', connector: 'rj45', speedMbps: 100, maxRangeM: 100, cable: 'cat5', poe: true },
  '1000base-t': { name: '1000BASE-T', family: 'copper', connector: 'rj45', speedMbps: 1000, maxRangeM: 100, cable: 'cat5e', poe: true },
  '2.5gbase-t': { name: '2.5GBASE-T', family: 'copper', connector: 'rj45', speedMbps: 2500, maxRangeM: 100, cable: 'cat5e', poe: true },
  '5gbase-t': { name: '5GBASE-T', family: 'copper', connector: 'rj45', speedMbps: 5000, maxRangeM: 100, cable: 'cat6', poe: true },
  '10gbase-t': { name: '10GBASE-T', family: 'copper', connector: 'rj45', speedMbps: 10000, maxRangeM: 100, cable: 'cat6a', poe: false },

  // 50G in SFP form: 50GBASE-SR/LR ride an SFP56 module, which is an SFP28 socket width with
  // two 25G lanes. Modelling them as 25G (the nearest SFP28 rate) understates the port, and
  // modelling them as QSFP would give the wrong connector.
  '50gbase-sr': { name: '50GBASE-SR', family: 'fiber', connector: 'lc', speedMbps: 50000, maxRangeM: 100,  fiber: 'mmf', wavelengthNm: 850 },
  '50gbase-lr': { name: '50GBASE-LR', family: 'fiber', connector: 'lc', speedMbps: 50000, maxRangeM: 10000, fiber: 'smf', wavelengthNm: 1310 },

  // ---- Fibre Channel ----
  // The "G" in an FC part name is not the line rate. 2GFC runs at 2.125 Gbit/s, 4G at 4.25,
  // 8G at 8.5, 16G at 14.025, 32G at 28.05 and 64G at 57.8, because FC wraps its payload in
  // 8b/10b (up to 8G) or 64b/66b framing. Modelling a "64G" port as 64000 Mbps would let it
  // negotiate with a 100G Ethernet port it has nothing in common with.
  '10gfc-sw': { name: '10GFC-SW', family: 'fibre-channel', connector: 'lc', speedMbps: 10519, maxRangeM: 300, fiber: 'mmf', wavelengthNm: 850, fcRate: 10 },
  '10gfc-lw': { name: '10GFC-LW', family: 'fibre-channel', connector: 'lc', speedMbps: 10519, maxRangeM: 10000, fiber: 'smf', wavelengthNm: 1310, fcRate: 10 },
  '2gfc-sw':  { name: '2GFC-SW',  family: 'fibre-channel', connector: 'lc', speedMbps: 2125,  maxRangeM: 300,  fiber: 'mmf',  wavelengthNm: 850,  fcRate: 2 },
  '2gfc-lw':  { name: '2GFC-LW',  family: 'fibre-channel', connector: 'lc', speedMbps: 2125,  maxRangeM: 10000, fiber: 'smf', wavelengthNm: 1310, fcRate: 2 },
  '4gfc-sw':  { name: '4GFC-SW',  family: 'fibre-channel', connector: 'lc', speedMbps: 4250,  maxRangeM: 150,  fiber: 'mmf',  wavelengthNm: 850,  fcRate: 4 },
  '4gfc-lw':  { name: '4GFC-LW',  family: 'fibre-channel', connector: 'lc', speedMbps: 4250,  maxRangeM: 10000, fiber: 'smf', wavelengthNm: 1310, fcRate: 4 },
  '8gfc-sw':  { name: '8GFC-SW',  family: 'fibre-channel', connector: 'lc', speedMbps: 8500,  maxRangeM: 150,  fiber: 'mmf',  wavelengthNm: 850,  fcRate: 8 },
  '8gfc-lw':  { name: '8GFC-LW',  family: 'fibre-channel', connector: 'lc', speedMbps: 8500,  maxRangeM: 10000, fiber: 'smf', wavelengthNm: 1310, fcRate: 8 },
  '16gfc-sw': { name: '16GFC-SW', family: 'fibre-channel', connector: 'lc', speedMbps: 14025, maxRangeM: 100,  fiber: 'mmf',  wavelengthNm: 850,  fcRate: 16 },
  '16gfc-lw': { name: '16GFC-LW', family: 'fibre-channel', connector: 'lc', speedMbps: 14025, maxRangeM: 10000, fiber: 'smf', wavelengthNm: 1310, fcRate: 16 },
  '32gfc-sw': { name: '32GFC-SW', family: 'fibre-channel', connector: 'lc', speedMbps: 28050, maxRangeM: 70,   fiber: 'mmf',  wavelengthNm: 850,  fcRate: 32 },
  '32gfc-lw': { name: '32GFC-LW', family: 'fibre-channel', connector: 'lc', speedMbps: 28050, maxRangeM: 10000, fiber: 'smf', wavelengthNm: 1310, fcRate: 32 },
  '64gfc-sw': { name: '64GFC-SW', family: 'fibre-channel', connector: 'lc', speedMbps: 57800, maxRangeM: 30,   fiber: 'mmf',  wavelengthNm: 850,  fcRate: 64 },
  '128gfc-sw': { name: '128GFC-SW', family: 'fibre-channel', connector: 'lc', speedMbps: 112200, maxRangeM: 30, fiber: 'mmf', wavelengthNm: 850, fcRate: 128 },
  '128gfc-lw': { name: '128GFC-LW', family: 'fibre-channel', connector: 'lc', speedMbps: 112200, maxRangeM: 10000, fiber: 'smf', wavelengthNm: 1310, fcRate: 128 },
  '64gfc-lw': { name: '64GFC-LW', family: 'fibre-channel', connector: 'lc', speedMbps: 57800, maxRangeM: 10000, fiber: 'smf', wavelengthNm: 1310, fcRate: 64 },

  // ---- fiber, 1G ----
  '1000base-sx': { name: '1000BASE-SX', family: 'fiber', connector: 'lc', speedMbps: 1000, maxRangeM: 550, fiber: 'mmf', wavelengthNm: 850 },
  '1000base-lx': { name: '1000BASE-LX', family: 'fiber', connector: 'lc', speedMbps: 1000, maxRangeM: 10000, fiber: 'both', wavelengthNm: 1310 },
  '1000base-ex': { name: '1000BASE-EX', family: 'fiber', connector: 'lc', speedMbps: 1000, maxRangeM: 40000, fiber: 'smf', wavelengthNm: 1310 },
  '1000base-zx': { name: '1000BASE-ZX', family: 'fiber', connector: 'lc', speedMbps: 1000, maxRangeM: 80000, fiber: 'smf', wavelengthNm: 1550 },

  // ---- fiber, 1G, single-strand (bidirectional / BiDi) ----
  // 1000BASE-BX10 carries a full gigabit in both directions over ONE strand of SMF by
  // splitting the band: one end transmits in the 1310 nm window and listens at 1490,
  // the other end does the opposite. The two halves are separate orderable parts, so
  // each is its own medium here rather than one medium with a "direction" flag - a
  // port really does hold one part or the other, and the part number differs:
  //
  //   -U  TX 1310 nm / RX 1490 nm      (Cisco GLC-BX-U)
  //   -D  TX 1490 nm / RX 1310 nm      (Cisco GLC-BX-D)
  //
  // "A 1000BASE-BX10-D device is always connected to a 1000BASE-BX10-U device with a
  // single strand of standard SMF with an operating transmission range up to 10 km."
  //   -- Cisco, SFP Modules for Gigabit Ethernet Applications, datasheet c78-366584
  //      (the same table rates GLC-BX-U at 1310 nm TX / 1490 nm RX and GLC-BX-D at
  //      1490 nm TX / 1310 nm RX; IEEE 802.3ah-2004 clause 59 defines 1000BASE-BX10.)
  //
  // 10 km is the datasheet figure for this class, and it is what maxRangeM says: a 25 m
  // run is *within* it, not the limit of it, and nothing here claims BX reaches 80 km -
  // that is 1000BASE-ZX, a duplex part.
  //
  // The pair is MIRRORED, which is the whole point: U mates with D and with nothing
  // else. Two U ends put two 1310 nm transmitters into the same strand while both
  // 1490 nm receivers sit deaf - not a bad cable, an unbuildable link. `matesWith`
  // is how this model states a medium-level mate that is NOT reflexive; see MEDIA_MATE
  // and commonMedia() below.
  '1000base-bx-u': {
    name: '1000BASE-BX10-U', family: 'fiber', connector: 'lc', speedMbps: 1000,
    maxRangeM: 10000, fiber: 'smf',
    wavelengthNm: 1310, txWavelengthNm: 1310, rxWavelengthNm: 1490,
    strands: 1, duplex: 'single', direction: 'U',
    matesWith: '1000base-bx-d', link: '1000base-bx'
  },
  '1000base-bx-d': {
    name: '1000BASE-BX10-D', family: 'fiber', connector: 'lc', speedMbps: 1000,
    maxRangeM: 10000, fiber: 'smf',
    wavelengthNm: 1490, txWavelengthNm: 1490, rxWavelengthNm: 1310,
    strands: 1, duplex: 'single', direction: 'D',
    matesWith: '1000base-bx-u', link: '1000base-bx'
  },
  // The RUN the two halves make, named as its own medium for the same reason the
  // hybrid patch cords are: neither end describes the span - "1000BASE-BX10-U" is a
  // module, "1000BASE-BX10" is the link. No cage offers this id; it appears only when
  // a U and a D meet (commonMedia), and `linkOnly` keeps it out of the media list
  // whenever a real module fits the pair, so it can never displace 1000BASE-LX as the
  // description of an ordinary SFP-to-SFP run.
  '1000base-bx': {
    name: '1000BASE-BX10 (U/D pair, single strand)', family: 'fiber', connector: 'lc',
    speedMbps: 1000, maxRangeM: 10000, fiber: 'smf',
    wavelengthsNm: [1310, 1490], strands: 1, duplex: 'single', linkOnly: true,
    pair: ['1000base-bx-u', '1000base-bx-d']
  },

  // ---- fiber, 10G ----
  '10gbase-sr': { name: '10GBASE-SR', family: 'fiber', connector: 'lc', speedMbps: 10000, maxRangeM: 300, fiber: 'mmf', wavelengthNm: 850 },
  '10gbase-lr': { name: '10GBASE-LR', family: 'fiber', connector: 'lc', speedMbps: 10000, maxRangeM: 10000, fiber: 'smf', wavelengthNm: 1310 },
  '10gbase-er': { name: '10GBASE-ER', family: 'fiber', connector: 'lc', speedMbps: 10000, maxRangeM: 40000, fiber: 'smf', wavelengthNm: 1550 },

  // ---- fiber, 25G ----
  '25gbase-sr': { name: '25GBASE-SR', family: 'fiber', connector: 'lc', speedMbps: 25000, maxRangeM: 100, fiber: 'mmf', wavelengthNm: 850 },
  '25gbase-lr': { name: '25GBASE-LR', family: 'fiber', connector: 'lc', speedMbps: 25000, maxRangeM: 10000, fiber: 'smf', wavelengthNm: 1310 },

  // ---- fiber, 40G ----
  '40gbase-sr4': { name: '40GBASE-SR4', family: 'fiber', connector: 'mpo', speedMbps: 40000, maxRangeM: 150, fiber: 'mmf', wavelengthNm: 850 },
  '40gbase-lr4': { name: '40GBASE-LR4', family: 'fiber', connector: 'lc', speedMbps: 40000, maxRangeM: 10000, fiber: 'smf', wavelengthNm: 1310 },

  // ---- fiber, 100G ----
  '100gbase-sr4': { name: '100GBASE-SR4', family: 'fiber', connector: 'mpo', speedMbps: 100000, maxRangeM: 100, fiber: 'mmf', wavelengthNm: 850 },
  '100gbase-lr4': { name: '100GBASE-LR4', family: 'fiber', connector: 'lc', speedMbps: 100000, maxRangeM: 10000, fiber: 'smf', wavelengthNm: 1310 },
  // 200G/400G ride in QSFP-DD cages. DR4/FR4 are the short and metro reaches;
  // an 800G class exists but no hardware in this catalogue uses it yet.
  '200gbase-dr4': { name: '200GBASE-DR4', family: 'fiber', connector: 'mpo', speedMbps: 200000, maxRangeM: 500, fiber: 'smf', wavelengthNm: 1311 },
  '200gbase-fr4': { name: '200GBASE-FR4', family: 'fiber', connector: 'lc', speedMbps: 200000, maxRangeM: 2000, fiber: 'smf', wavelengthNm: 1311 },
  '400gbase-dr4': { name: '400GBASE-DR4', family: 'fiber', connector: 'mpo', speedMbps: 400000, maxRangeM: 500, fiber: 'smf', wavelengthNm: 1311 },
  '400gbase-fr4': { name: '400GBASE-FR4', family: 'fiber', connector: 'lc', speedMbps: 400000, maxRangeM: 2000, fiber: 'smf', wavelengthNm: 1311 },

  // ---- subscriber access: coax, twisted pair, mains ----
  // These are SHARED mediums in reality: an HFC segment, a binder group, a ring
  // main. Modelling them as a point-to-point run is a simplification, but the
  // part that matters for a lab is honest: the class rate, the asymmetry, and the
  // fact that reach falls off with distance far sooner than fibre does.
  'docsis-31': { name: 'DOCSIS 3.1 (coax)', family: 'coax', connector: 'f', speedMbps: 10000, upstreamMbps: 1000, maxRangeM: 300, shared: true },
  'docsis-30': { name: 'DOCSIS 3.0 (coax)', family: 'coax', connector: 'f', speedMbps: 1000, upstreamMbps: 200, maxRangeM: 300, shared: true },
  'moca-25': { name: 'MoCA 2.5 (coax)', family: 'coax', connector: 'f', speedMbps: 2500, maxRangeM: 100, shared: true },
  // DOCSIS is asymmetric, and the two directions are different sized pipes on the same
  // F-connector. Without an upstream entry a 200 Mbps return-path port matches no medium and the
  // cable picker offers it nothing at all (issue #1039).
  'docsis-30-us': { name: 'DOCSIS 3.0 upstream (coax)', family: 'coax', connector: 'f', speedMbps: 200, maxRangeM: 300, shared: true, direction: 'upstream' },
  'docsis-31-us': { name: 'DOCSIS 3.1 upstream (coax)', family: 'coax', connector: 'f', speedMbps: 1000, maxRangeM: 300, shared: true, direction: 'upstream' },
  'moca-11': { name: 'MoCA 1.1 (coax)', family: 'coax', connector: 'f', speedMbps: 175, maxRangeM: 100, shared: true },
  'vdsl2-35b': { name: 'VDSL2 35b (twisted pair)', family: 'dsl', connector: 'rj11', speedMbps: 300, maxRangeM: 400 },
  'vdsl2-17a': { name: 'VDSL2 17a (twisted pair)', family: 'dsl', connector: 'rj11', speedMbps: 100, maxRangeM: 900 },
  'adsl2plus': { name: 'ADSL2+ (twisted pair)', family: 'dsl', connector: 'rj11', speedMbps: 24, maxRangeM: 3000 },
  'homeplug-av2': { name: 'HomePlug AV2 (mains)', family: 'powerline', connector: 'mains', speedMbps: 1000, maxRangeM: 300, shared: true },
  'ghn': { name: 'G.hn (mains)', family: 'powerline', connector: 'mains', speedMbps: 1700, maxRangeM: 300, shared: true },
  'homeplug-av': { name: 'HomePlug AV (mains)', family: 'powerline', connector: 'mains', speedMbps: 200, maxRangeM: 300, shared: true },
  'ghn-25': { name: 'G.hn 2.5G (mains)', family: 'powerline', connector: 'mains', speedMbps: 2500, maxRangeM: 300, shared: true },

  // ---- fiber, PON (single-mode, outside plant) ----
  // A PON is the one place where the connector belongs to the medium rather than
  // the cage: the same OLT port takes an SC/APC or an SC/UPC module, and the two
  // will not mate. GPON is 2.488 Gbit/s down over 1.244 up; XGS-PON is symmetric
  // 9.953. Reach is the class budget: 20 km at a 1:32 split.
  'gpon-sc-apc': { name: 'GPON (SC/APC)', family: 'fiber', connector: 'sc-apc', speedMbps: 2488, maxRangeM: 20000, fiber: 'smf', wavelengthNm: 1490, upstreamMbps: 1244 },
  'gpon-sc-upc': { name: 'GPON (SC/UPC)', family: 'fiber', connector: 'sc-upc', speedMbps: 2488, maxRangeM: 20000, fiber: 'smf', wavelengthNm: 1490, upstreamMbps: 1244 },

  // ---- fiber, 100M ----
  // 100BASE-FX: 1300 nm over multimode for 2 km, SC connectors on the media converters that
  // use it. This entry was missing while both SC cages already offered the id, so a PON
  // port advertised a medium that resolved to null - and the one device that needs it, the
  // Allied Telesis AT-MC102XL's sc-upc port at 100M, had no medium to be cabled with. The
  // id is declared here as sc-upc rather than for both polished SC cages: 100BASE-FX
  // terminates in a UPC ferrule, so an SC/APC PON port has no business offering it.
  '100base-fx': { name: '100BASE-FX', family: 'fiber', connector: 'sc-upc', speedMbps: 100, maxRangeM: 2000, fiber: 'mmf', wavelengthNm: 1310 },
  'xgspon-sc-apc': { name: 'XGS-PON (SC/APC)', family: 'fiber', connector: 'sc-apc', speedMbps: 9953, maxRangeM: 20000, fiber: 'smf', wavelengthNm: 1577, upstreamMbps: 9953 },
  'gpon-lc-upc': { name: 'GPON (LC/UPC)', family: 'fiber', connector: 'lc', speedMbps: 2488, maxRangeM: 20000, fiber: 'smf', wavelengthNm: 1490, upstreamMbps: 1244 },
  'xgspon-lc-upc': { name: 'XGS-PON (LC/UPC)', family: 'fiber', connector: 'lc', speedMbps: 9953, maxRangeM: 20000, fiber: 'smf', wavelengthNm: 1577, upstreamMbps: 9953 },
  'xgspon-sc-upc': { name: 'XGS-PON (SC/UPC)', family: 'fiber', connector: 'sc-upc', speedMbps: 9953, maxRangeM: 20000, fiber: 'smf', wavelengthNm: 1577, upstreamMbps: 9953 },
  // A hybrid cord is its own medium, because the physical run is a factory
  // assembly with one flat and one 8-degree endface - neither 'SC/APC' nor
  // 'SC/UPC' describes it. The service is the same GPON/XGS-PON plan as the two
  // polish-specific ids either side of it, so these are never offered by a cage:
  // they only appear when a hybrid cord bridges a UPC port and an APC one.
  'gpon-sc-hybrid': { name: 'GPON (SC hybrid UPC/APC)', family: 'fiber', connector: 'sc', speedMbps: 2488, maxRangeM: 20000, fiber: 'smf', wavelengthNm: 1490, upstreamMbps: 1244 },
  'xgspon-sc-hybrid': { name: 'XGS-PON (SC hybrid UPC/APC)', family: 'fiber', connector: 'sc', speedMbps: 9953, maxRangeM: 20000, fiber: 'smf', wavelengthNm: 1577, upstreamMbps: 9953 },

  // ---- DAC / AOC ----
  'dac-1g': { name: '1G DAC (passive)', family: 'dac', connector: 'sfp', speedMbps: 1000, maxRangeM: 3 },
  'dac-10g': { name: '10G DAC (passive)', family: 'dac', connector: 'sfp', speedMbps: 10000, maxRangeM: 7 },
  'dac-10g-active': { name: '10G DAC (active)', family: 'dac', connector: 'sfp', speedMbps: 10000, maxRangeM: 15 },
  'aoc-10g': { name: '10G AOC', family: 'dac', connector: 'sfp', speedMbps: 10000, maxRangeM: 20 },
  'dac-25g': { name: '25G DAC (passive)', family: 'dac', connector: 'sfp', speedMbps: 25000, maxRangeM: 5 },
  'dac-40g': { name: '40G QSFP+ DAC', family: 'dac', connector: 'qsfp', speedMbps: 40000, maxRangeM: 5 },
  'dac-100g': { name: '100G QSFP28 DAC', family: 'dac', connector: 'qsfp', speedMbps: 100000, maxRangeM: 3 },

  // ---- copper SFP (1000BASE-T module) ----
  '1000base-t-sfp': { name: '1000BASE-T SFP', family: 'copper', connector: 'sfp', speedMbps: 1000, maxRangeM: 100, cable: 'cat5e', poe: false },

  // ---- console / serial ----
  // A console port is not a data path and does not have a "line rate" - it has a baud rate,
  // and the baud rate is the thing that actually goes wrong. 9600 is the default on most
  // network hardware and 115200 is what everyone sets it to; a cable between a 9600 port and a
  // 115200 port is a real, common, silent failure, so each baud is its own medium.
  'console-rs232':      { name: 'Console (RS-232, 115200 baud)', family: 'console', connector: 'console', speedMbps: 0.1152, maxRangeM: 15, baud: 115200 },
  'console-rs232-57600': { name: 'Console (RS-232, 57600 baud)',  family: 'console', connector: 'console', speedMbps: 0.0576, maxRangeM: 15, baud: 57600 },
  'console-rs232-38400': { name: 'Console (RS-232, 38400 baud)',  family: 'console', connector: 'console', speedMbps: 0.0384, maxRangeM: 15, baud: 38400 },
  'console-rs232-19200': { name: 'Console (RS-232, 19200 baud)',  family: 'console', connector: 'console', speedMbps: 0.0192, maxRangeM: 15, baud: 19200 },
  'console-rs232-9600':  { name: 'Console (RS-232, 9600 baud)',   family: 'console', connector: 'console', speedMbps: 0.0096, maxRangeM: 15, baud: 9600 },
  'usb-console': { name: 'USB Console', family: 'console', connector: 'usb', speedMbps: 12, maxRangeM: 5 },

  // ---- wireless ----
  'wireless-2.4': { name: '2.4 GHz radio', family: 'wireless', connector: 'antenna', speedMbps: 600, maxRangeM: null, band: '2.4' },
  'wireless-5': { name: '5 GHz radio', family: 'wireless', connector: 'antenna', speedMbps: 1000, maxRangeM: null, band: '5' },
  'wireless-6': { name: '6 GHz radio (Wi-Fi 6E)', family: 'wireless', connector: 'antenna', speedMbps: 2400, maxRangeM: null, band: '6' },
  'wireless-7': { name: '6 GHz radio (Wi-Fi 7)', family: 'wireless', connector: 'antenna', speedMbps: 5760, maxRangeM: null, band: '6' },
  'wireless-60': { name: '60 GHz radio (802.11ad)', family: 'wireless', connector: 'antenna', speedMbps: 5000, maxRangeM: null, band: '60' },

  // ---- cellular (3GPP) ----
  //
  // A modem's air interface is neither copper nor Wi-Fi, and until now it had to pretend to
  // be one of them (issue #129): modelled as ethernet it invented an RJ45 socket that
  // validateLink would cable; modelled as wireless it joined the Wi-Fi population and could
  // be offered as an access point. Both are wrong for the same reason - a 3GPP link is a
  // link to a base station, not to a patch lead.
  //
  // Rates are the category peak the vendor publishes, not a per-device round number, so a
  // Cat 4 modem is 150 Mbps whatever its marketing department says.
  'lte': { name: 'LTE Cat 4', family: 'wireless', connector: 'wwan', speedMbps: 150, maxRangeM: null },
  'lte-a': { name: 'LTE-A Cat 6+', family: 'wireless', connector: 'wwan', speedMbps: 300, maxRangeM: null },
  '5g-sub6': { name: '5G NR sub-6', family: 'wireless', connector: 'wwan', speedMbps: 2500, maxRangeM: null },
  '5g-mmwave': { name: '5G NR mmWave', family: 'wireless', connector: 'wwan', speedMbps: 4000, maxRangeM: null }
};

function mediaById(id) { return MEDIA[id] || null; }

// ---------------------------------------------------------------------------
// medium-level mating
// ---------------------------------------------------------------------------
// CAGE_MATE answers "can these two cages be joined", which is a symmetric,
// reflexive question: an SFP cage mates with an SFP cage, and an SFP cage mates
// with itself. That is right for the hardware and WRONG for a single-strand
// optical run, where the thing that decides the link is what is plugged into the
// cage, not the cage. Two SFP cages mate by definition; a 1000BASE-BX10-U module
// in each of them does not.
//
// So the model needs a second, *medium-level* mate relation, and that relation is
// deliberately not reflexive and not symmetric:
//
//   MEDIA_MATE['1000base-bx-u'] = { with: '1000base-bx-d', link: '1000base-bx' }
//   MEDIA_MATE['1000base-bx-d'] = { with: '1000base-bx-u', link: '1000base-bx' }
//
// - `with` names the ONE medium this one can form a link with. An id that has a
//   `with` is never a link on its own, so sharing an id across the two ports is not
//   enough: commonMedia() intersects ids and then resolves complements, and a half
//   only ever enters the result through a complement (see there).
// - `link` names the medium the *run* is, because a U at one end and a D at the other
//   is not "a U link" and not "a D link" - the pair has its own id, exactly as a hybrid
//   UPC/APC patch cord has one.
//
// Adding 10G-BXU/10G-BXD or 40GBASE-SR-BD later is a row here plus the two media
// entries; nothing in canMate() or commonMedia() needs to change.
const MEDIA_MATE = {};
for (const id of Object.keys(MEDIA)) {
  const m = MEDIA[id];
  if (m && m.matesWith) MEDIA_MATE[id] = { with: m.matesWith, link: m.link || m.matesWith };
}

// Is this medium one half of a single-strand pair (so it can never be a link alone)?
function isPairedHalf(id) {
  return Object.prototype.hasOwnProperty.call(MEDIA_MATE, id);
}

function mediaMate(id) { return MEDIA_MATE[id] || null; }


// ---------------------------------------------------------------------------
// cages -- the physical connector/cage fitted to a port
// ---------------------------------------------------------------------------
const CAGES = {
  rj45: { name: 'RJ45', family: 'copper', label: 'RJ45 copper' },
  sfp: { name: 'SFP', family: 'optical', label: 'SFP cage' },
  'sfp+': { name: 'SFP+', family: 'optical', label: 'SFP+ cage (10G)' },
  sfp28: { name: 'SFP28', family: 'optical', label: 'SFP28 cage (25G)' },
  // A combo port is one physical cage position that takes EITHER an RJ45
  // copper port or an SFP module - never both at once. Real switches present
  // it as two logical interfaces that are mutually exclusive.
  combo: { name: 'Combo', family: 'combo', label: 'Combo RJ45 / SFP' },
  'qsfp+': { name: 'QSFP+', family: 'optical', label: 'QSFP+ cage (40G)' },
  qsfpdd: { name: 'QSFP-DD', family: 'optical', label: 'QSFP-DD cage (200/400G)' },
  qsfp28: { name: 'QSFP28', family: 'optical', label: 'QSFP28 cage (100G)' },
  // QSFP56 is the 200G member of the QSFP family: same physical connector as QSFP28 and
  // QSFP+, four lanes at 50G instead of 25G. It is not a QSFP-DD (which is double-density
  // and twice as wide), so a 200G port modelled as QSFP-DD would refuse the 100G optic that
  // physically fits it, and a 200G module in a QSFP28 cage would claim a rate the cage
  // cannot carry.
  qsfp56: { name: 'QSFP56', family: 'optical', label: 'QSFP56 cage (200G)' },
  // Fibre Channel gets its own cages rather than borrowing the Ethernet ones. The connector is
  // the same (LC on SFP/SFP28, SFP-DD for 64G) but the rate ladder is not: if FC rates lived in
  // the Ethernet cages, an SFP+ port that declares no speedCaps would inherit 8G/16G as its
  // defaults and an Ethernet-to-Ethernet link could negotiate a Fibre Channel rate.
  sfp56: { name: 'SFP56', family: 'optical', label: 'SFP56 cage (50G)' },
  // XFP came before SFP+ and is larger: 10 Gbit/s only, and an SFP+ module does not fit it.
  // OLT uplink cards are where it survives - FiberHome's HU2A is 2x10GE in XFP cages and
  // Huawei's H801X2CA is 2x10GE XFP - so modelling it as SFP+ would let a lab cable a module
  // that physically will not seat.
  xfp: { name: 'XFP', family: 'optical', label: 'XFP cage (10G)' },
  'fc-sfp': { name: 'SFP+ (FC)', family: 'fibre-channel', label: 'SFP+ cage, Fibre Channel 2/4/8/16G' },
  'fc-sfp28': { name: 'SFP28 (FC)', family: 'fibre-channel', label: 'SFP28 cage, Fibre Channel 32G' },
  'fc-sfpdd': { name: 'SFP-DD (FC)', family: 'fibre-channel', label: 'SFP-DD cage, Fibre Channel 64G' },
  'fc-qsfp28': { name: 'QSFP28 (FC)', family: 'fibre-channel', label: 'QSFP28 cage, Fibre Channel 128G (4 lanes)' },
  // CFP is a separate family of cages, not a bigger QSFP: the module is larger and latched
  // differently, so a CFP2 optic will not seat in a QSFP-DD cage however similar the rate looks.
  // Every optical transport platform uses it for its line side, and until now the catalogue had
  // no way to say "this port is CFP2" - line ports were modelled as QSFP56 with an apology in
  // the note (OptiXtrans E6616/E6608).
  //
  // Only CFP2 is declared. CFP, CFP4 and CFP8 exist as standards and would be one line each,
  // but this project does not carry vocabulary no device uses: the cable matrix reports a cage
  // that no spec references as unused, and speculative entries make that signal useless.
  cfp2: { name: 'CFP2', family: 'optical', label: 'CFP2 cage (100/200G)' },
  // SC is the PON connector. APC and UPC are separate cages deliberately: an
  // 8-degree angled ferrule and a flat one cannot mate, and forcing them costs
  // about 3 dB of loss and can chip the endface.
  'sc-apc': { name: 'SC/APC', family: 'optical', label: 'SC/APC (green, angled 8 deg)' },
  'lc-upc': { name: 'LC/UPC', family: 'optical', label: 'LC/UPC (blue, flat polish)' },
  'lc-apc': { name: 'LC/APC', family: 'optical', label: 'LC/APC (green, angled 8 deg)' },
  'sc-upc': { name: 'SC/UPC', family: 'optical', label: 'SC/UPC (blue, flat)' },
  // Subscriber-access connectors. An F-connector is not an RJ45 and a mains plug
  // never meets one, so each gets its own cage rather than being flattened into
  // copper ethernet.
  coax: { name: 'F-connector', family: 'coax', label: 'F-connector (coax)' },
  dsl: { name: 'RJ11', family: 'dsl', label: 'RJ11 (twisted pair)' },
  powerline: { name: 'Mains', family: 'powerline', label: 'Mains plug' },
  console: { name: 'Console', family: 'management', label: 'Console (RS-232)' },
  usb: { name: 'USB', family: 'management', label: 'USB' },
  antenna: { name: 'Antenna', family: 'wireless', label: 'Wireless radio' },
  // A cellular modem. Same family as an antenna - it carries no power and takes no cable -
  // but a distinct cage, because "this box has a 5G radio" and "this box has a Wi-Fi radio"
  // are different facts about it and the link inspector should not have to guess which.
  wwan: { name: 'Cellular', family: 'wireless', label: 'Cellular (3GPP) modem' }
};

// Which cages can physically mate with which.
// Bare connector tokens that are really cages, with the polish implied by the vendor's
// own connector type. Kept deliberately short: anything else that does not resolve to a
// real cage is reported as unknown rather than guessed at.
const CAGE_ALIAS = {
  lc: 'lc-upc',
  // Datasheets name the CONNECTOR, the engine names the CAGE. An F-connector is how
  // every DOCSIS port is described ("connector: f"), and an RJ11 is how every DSL line
  // port is described; the cages are coax and dsl. Without these the port resolved to
  // nothing, and before that it resolved to RJ45 copper - a cable modem's coax socket
  // presented as an Ethernet port that refused every cable, including its own twin.
  f: 'coax',
  'f-connector': 'coax',
  rj11: 'dsl',
  sc: 'sc-upc',
  // MCX is a small coax connector used on CMTS line cards and small-cell gear. A
  // MCX is a small coax connector used on CMTS line cards and small-cell gear: a different
  // shape from an F-connector, resolved to the coax cage because the engine has one and because
  // every MCX port in a real plant reaches the F-connector through a jumper anyway. Modelling
  // them as separate cages would make 24 CMTS return-path ports uncablable to nothing at all,
  // which is a worse lie than assuming the adapter.
  //
  // Original note: a different shape from an F-connector, but the engine has one coax cage and it is
  // still coax: leaving it unmapped made 40 CMTS line-card ports uncabliable.
  mcx: 'coax',
  // Radio connectors (issue #77). A spec describes a radio the way its datasheet does:
  // "antenna", "SMA", "RP-SMA", "N-type". None of those is an RJ45 socket, but an
  // unrecognised token used to become one - and a Wi-Fi radio presented as a copper
  // cage is a port the UI offers you as something to plug a patch lead into. The engine
  // has exactly one radio cage, so every aerial spelling resolves to it.
  antenna: 'antenna',
  sma: 'antenna',
  'rp-sma': 'antenna',
  rsma: 'antenna',
  'sma-female': 'antenna',
  'n-type': 'antenna',
  ntype: 'antenna',
  tnc: 'antenna',
  wireless: 'antenna',
  radio: 'antenna',
  wifi: 'antenna',
  'wi-fi': 'antenna',
  wlan: 'antenna'
};

const CAGE_MATE = {
  rj45: ['rj45', 'combo'],
  combo: ['combo', 'rj45', 'sfp', 'sfp+', 'sfp28'],
  sfp: ['sfp', 'sfp+', 'sfp28', 'sfp56', 'combo', 'fc-sfp', 'fc-sfp28'],
  'sfp+': ['sfp', 'sfp+', 'sfp28', 'sfp56', 'combo', 'fc-sfp', 'fc-sfp28', 'fc-sfpdd'],
  xfp: ['xfp'],
  sfp28: ['sfp', 'sfp+', 'sfp28', 'sfp56', 'combo', 'fc-sfp', 'fc-sfp28', 'fc-sfpdd'],
  sfp56: ['sfp', 'sfp+', 'sfp28', 'sfp56', 'combo'],
  'qsfp+': ['qsfp+', 'qsfp28', 'qsfpdd', 'qsfp56'],
  qsfp28: ['qsfp+', 'qsfp28', 'qsfpdd', 'qsfp56', 'fc-qsfp28'],
  // A QSFP-DD cage takes a QSFP28 or QSFP+ module and negotiates down to that
  // module's rate. Refusing the pair would make a 400G port unable to accept the
  // 100G optic most labs actually have.
  qsfpdd: ['qsfpdd', 'qsfp28', 'qsfp+', 'qsfp56'],
  qsfp56: ['qsfp56', 'qsfp28', 'qsfp+'],
  // CFP2 mates only with CFP2. This is the one place where "same rate, so it fits" is wrong in
  // both directions: a 200G CFP2 module and a 200G QSFP56 module carry the same speed and cannot
  // go in each other's cage.
  cfp2: ['cfp2'],
  // The FC cages mate with the Ethernet cages because the hardware does: an SFP+ socket takes
  // an 8G FC optic exactly as it takes a 10GBASE-SR one. What cannot join is the *link* - the
  // media lists have no common member, and canMate() names that as a protocol mismatch rather
  // than shrugging at "no shared medium".
  'fc-sfp': ['fc-sfp', 'sfp+', 'sfp28', 'fc-sfp28', 'fc-sfpdd'],
  'fc-sfp28': ['fc-sfp28', 'fc-sfp', 'sfp28', 'sfp+', 'fc-sfpdd'],
  'fc-sfpdd': ['fc-sfpdd', 'fc-sfp28', 'fc-sfp', 'sfp28', 'sfp+'],
  'fc-qsfp28': ['fc-qsfp28', 'qsfp28'],
  // SC never mates across polish: APC to APC, UPC to UPC, nothing else.
  'sc-apc': ['sc-apc'],
  'sc-upc': ['sc-upc'],
  // LC is the small-form-factor connector used on SFP/SFP+ PON ports. Same rule as
  // SC: shape must match and so must the polish, because an angled ferrule against a
  // flat one leaves an air gap and reflects the signal back at the laser.
  'lc-upc': ['lc-upc'],
  'lc-apc': ['lc-apc'],
  coax: ['coax'],
  dsl: ['dsl'],
  powerline: ['powerline'],
  console: ['console'],
  // A USB port mates with a USB port, not with a console port. A USB-to-serial adapter
  // is an external part, not a cable between two devices, and claiming the pair mated
  // made the answer depend on which end you asked about: usb said yes, console said no.
  usb: ['usb'],
  antenna: ['antenna']
};

function cagesMate(a, b) {
  const list = CAGE_MATE[a];
  return !!list && list.indexOf(b) !== -1;
}

// Ferrule geometry. Two connectors with the same shape but a different polish are
// the classic field mistake: an SC/APC (8 degree angled, green) ferrule pushed
// into an SC/UPC (flat, blue) socket does not seat, loses about 3 dB, and can
// chip the endface. That is not a "wrong cable, try another" error - it is a
// physically impossible link, so it gets its own verdict instead of hiding
// behind a generic connector mismatch.
const FERRULE = {
  'sc-apc': { shape: 'sc', polish: 'apc', colour: 'green', angleDeg: 8 },
  'sc-upc': { shape: 'sc', polish: 'upc', colour: 'blue', angleDeg: 0 },
  lc: { shape: 'lc', polish: 'upc', colour: 'blue', angleDeg: 0 },
  'lc-upc': { shape: 'lc', polish: 'upc', colour: 'blue', angleDeg: 0 },
  'lc-apc': { shape: 'lc', polish: 'apc', colour: 'green', angleDeg: 8 },
  mpo: { shape: 'mpo', polish: 'upc', colour: 'aqua', angleDeg: 0 }
};

function ferrule(cage) { return FERRULE[cage] || null; }

// Same shape, different polish: physically incompatible.
function polishMismatch(a, b) {
  const fa = ferrule(a), fb = ferrule(b);
  return !!(fa && fb && fa.shape === fb.shape && fa.polish !== fb.polish);
}

// ---------------------------------------------------------------------------
// per-cage media + speed capabilities
// ---------------------------------------------------------------------------
const CAGE_MEDIA = {
  // A cellular cage offers the 3GPP generations it is fast enough for, slowest first, and
  // always at least LTE - a modem that names a rate below the LTE floor is still a modem.
  wwan: function (maxMbps) {
    const order = ['lte', 'lte-a', '5g-sub6', '5g-mmwave'];
    const out = order.filter(function (id) { return MEDIA[id].speedMbps <= maxMbps; });
    return out.length ? out : ['lte'];
  },
  rj45: function (maxMbps) {
    const out = ['10base-t', '100base-tx', '1000base-t'];
    if (maxMbps >= 2500) out.push('2.5gbase-t');
    if (maxMbps >= 5000) out.push('5gbase-t');
    if (maxMbps >= 10000) out.push('10gbase-t');
    return out.filter(function (id) { return MEDIA[id].speedMbps <= maxMbps; });
  },
  // A combo port accepts either the copper side or the optical side, so its
  // media set is the union of both. Whether the RJ45 or the SFP half is in use
  // is decided by the cable plugged in, not by the cage.
  combo: function (maxMbps) {
    const copper = CAGE_MEDIA.rj45(maxMbps);
    const optical = CAGE_MEDIA.sfp();
    return copper.concat(optical.filter(function (id) { return copper.indexOf(id) === -1; }));
  },
  sfp: function () {
    // '1000base-t-sfp' is the copper SFP module, which is legitimate in this
    // cage. Bare '1000base-t' is RJ45 copper cabling and must NOT be offered
    // here: it let two fibre cages be joined by a copper run.
    // The BX10 halves belong here because an SFP cage really does take a GLC-BX-U or a
    // GLC-BX-D - that is what the cage is for. What the cage cannot tell you is which
    // one is in it, so both directions are listed and the PAIR decides (see MEDIA_MATE
    // and commonMedia): U with D is a link, U with U is refused. A spec that knows
    // which module is fitted can say so with `media: ["1000base-bx-u"]`, and then the
    // port can only ever meet a -D.
    return ['1000base-sx', '1000base-lx', '1000base-ex', '1000base-zx',
            '1000base-bx-u', '1000base-bx-d',
            '1000base-t-sfp', 'dac-1g'];
  },
  'sfp+': function () {
    // 1G modules go in an SFP+ slot and run at 1G, BX10 halves included: the cage is
    // the same and the module is the same part that works in a plain SFP cage.
    return ['10gbase-sr', '10gbase-lr', '10gbase-er', '1000base-sx', '1000base-lx',
      '1000base-bx-u', '1000base-bx-d',
      '1000base-t-sfp', 'dac-10g', 'dac-10g-active', 'aoc-10g'];
  },
  sfp28: function () {
    // An SFP28 cage takes 25G, 10G and 1G modules. Without the 1G optics an SFP28 port
    // refused a plain 1G SFP uplink, which the hardware accepts without complaint.
    //
    // The reaches are the whole module class, not a sample of it: a 1000BASE-EX/ZX SFP
    // and a 10GBASE-ER SFP+ plug into this cage and work exactly as they do in an SFP+
    // slot, so offering only SX/LX left those links unrepresentable. 100M is left out
    // on purpose (see CAGE_SPEEDS.sfp28); AOC and active-DAC assemblies stay in the
    // SFP+ entry because no catalogue part pairs them with a 25G cage yet.
    return ['25gbase-sr', '25gbase-lr', '10gbase-sr', '10gbase-lr', '10gbase-er',
            'dac-25g', 'dac-10g',
            '1000base-sx', '1000base-lx', '1000base-ex', '1000base-zx',
            '1000base-bx-u', '1000base-bx-d',
            '1000base-t-sfp', 'dac-1g'];
  },
  'qsfp+': function () { return ['40gbase-sr4', '40gbase-lr4', 'dac-40g']; },
  qsfp28: function () { return ['100gbase-sr4', '100gbase-lr4', 'dac-100g', '40gbase-sr4', '40gbase-lr4']; },
  // A CFP2 cage runs 100G or 200G optics and has no DAC variant: it is a line-side module, not a
  // patch-lead cage. The 100G entries matter because a muxponder board can be switched to its
  // 100G line mode, and 40G because a CFP2 port takes the older 40GBASE-LR4 optics too.
  cfp2: function () { return ['200gbase-fr4', '200gbase-dr4', '100gbase-lr4', '40gbase-lr4']; },
  sfp56: function () { return ['50gbase-sr', '50gbase-lr', '25gbase-sr', '25gbase-lr', 'dac-25g']; },
  xfp: function () { return ['10gbase-sr', '10gbase-lr', '10gbase-er']; },
  'fc-sfp': function () {
    return ['2gfc-sw', '2gfc-lw', '4gfc-sw', '4gfc-lw', '8gfc-sw', '8gfc-lw', '10gfc-sw', '10gfc-lw', '16gfc-sw', '16gfc-lw'];
  },
  'fc-sfp28': function () {
    // A 32G port runs 16G and 8G optics at their own rate; FC negotiates down the ladder.
    return ['32gfc-sw', '32gfc-lw', '16gfc-sw', '16gfc-lw', '8gfc-sw', '8gfc-lw'];
  },
  'fc-sfpdd': function () {
    return ['64gfc-sw', '64gfc-lw', '32gfc-sw', '32gfc-lw', '16gfc-sw', '16gfc-lw'];
  },
  'fc-qsfp28': function () {
    return ['128gfc-sw', '128gfc-lw', '32gfc-sw', '32gfc-lw'];
  },
  qsfp56: function () {
    return ['200gbase-dr4', '200gbase-fr4',
            // QSFP28/QSFP+ modules seat in a QSFP56 cage and run at their own rate
            '100gbase-sr4', '100gbase-lr4', '40gbase-sr4', '40gbase-lr4', 'dac-100g'];
  },
  qsfpdd: function () {
    return ['200gbase-dr4', '200gbase-fr4', '400gbase-dr4', '400gbase-fr4',
            // backward-compatible modules, which run at their own rate
            '100gbase-sr4', '100gbase-lr4', '40gbase-sr4', '40gbase-lr4', 'dac-100g'];
  },
  // SC is a connector, not a protocol: it is standard on PON and it is also what older
  // 100BASE-FX and 1000BASE-LX optics use. Offering only PON media left a 100 Mbps SC
  // media converter with no medium and no rate, so it could not be cabled to itself.
  // The APC variant deliberately does not offer 100BASE-FX or 1000BASE-LX: both terminate
  // in a UPC ferrule, and an APC ferrule cannot mate with one without a hybrid cord.
  'sc-apc': function (maxMbps) {
    const out = ['gpon-sc-apc'];
    if (maxMbps >= 9000) out.push('xgspon-sc-apc');
    return out;
  },
  'sc-upc': function (maxMbps) {
    const out = ['gpon-sc-upc', '100base-fx'];
    if (maxMbps >= 1000) out.push('1000base-lx');
    if (maxMbps >= 9000) out.push('xgspon-sc-upc');
    return out;
  },
  // LC is the connector, not the protocol. It is used on PON ports AND on ordinary
  // Ethernet optics (10GBASE-LR, 25G-LR, 100G-LR4 all terminate in LC/UPC), so the
  // media offered depends on the rate the port declares, not on the connector.
  'lc-upc': function (maxMbps) {
    const out = ['gpon-lc-upc'];
    if (maxMbps >= 9000) out.push('xgspon-lc-upc');
    if (maxMbps >= 100000) out.push('100gbase-lr4');
    else if (maxMbps >= 25000) out.push('25gbase-lr');
    else if (maxMbps >= 10000) out.push('10gbase-lr');
    else if (maxMbps >= 1000) out.push('1000base-lx');
    return out;
  },
  'lc-apc': function (maxMbps) {
    const out = ['gpon-lc-upc'];
    if (maxMbps >= 9000) out.push('xgspon-lc-upc');
    if (maxMbps >= 100000) out.push('100gbase-lr4');
    else if (maxMbps >= 25000) out.push('25gbase-lr');
    else if (maxMbps >= 10000) out.push('10gbase-lr');
    else if (maxMbps >= 1000) out.push('1000base-lx');
    return out;
  },
  coax: function (maxMbps) {
    // Both directions are offered, because both exist on the same connector: a CMTS return-path
    // port runs at 200 Mbps (3.0) or 1 Gbps (3.1), and without its own entry here it shared no
    // rate with any medium and ended up with none at all (issue #1039).
    const out = ['moca-11', 'moca-25', 'docsis-30', 'docsis-30-us'];
    if (maxMbps >= 1000) out.push('docsis-31', 'docsis-31-us');
    return out;
  },
  dsl: function (maxMbps) {
    const out = ['adsl2plus', 'vdsl2-17a'];
    if (maxMbps >= 300) out.push('vdsl2-35b');
    return out;
  },
  powerline: function (maxMbps) {
    const out = ['homeplug-av'];
    if (maxMbps >= 1000) out.push('homeplug-av2');
    if (maxMbps >= 1700) out.push('ghn');
    if (maxMbps >= 2500) out.push('ghn-25');
    return out;
  },
  console: function () {
    return ['console-rs232', 'console-rs232-57600', 'console-rs232-38400', 'console-rs232-19200', 'console-rs232-9600'];
  },
  usb: function () { return ['usb-console']; },
  // A radio carries bands, not a cable (issue #77). There is no copper here and no
  // optic: the medium is the band set its generation covers, and the generation follows
  // from the port's own rate. `generationBands` is the single source of truth shared with
  // derivePortHardware, which then narrows the set from the spec (explicit bands, 60 GHz
  // gear) - so the cage table and the derived port cannot disagree about what a radio
  // carries.
  antenna: function (maxMbps) { return generationBands(maxMbps || 0); }
};

const CAGE_SPEEDS = {
  // A cellular cage has no rate ladder of its own: the modem's category IS the rate. Falling
  // back to the copper ladder here made every modem "claim a line rate its cage cannot
  // carry" (150 Mbps on a 100 Mbps cage) - the invariant misreading a radio as copper.
  wwan: function (maxMbps) { return [maxMbps]; },
  rj45: function (maxMbps) {
    const out = [10, 100, 1000];
    if (maxMbps >= 2500) out.push(2500);
    if (maxMbps >= 5000) out.push(5000);
    if (maxMbps >= 10000) out.push(10000);
    return out.filter(function (s) { return s <= maxMbps; });
  },
  // A combo port runs either at copper rates or at the optical module's rate.
  combo: function (maxMbps) {
    const out = [10, 100, 1000];
    if (maxMbps >= 10000) out.push(10000);
    return out.filter(function (v) { return v <= maxMbps; });
  },
  // 2500BASE-X ships in SFP form (MikroTik hEX S 2025), like a 1G module in an SFP+ cage.
  sfp: function () { return [1000, 2500]; },
  'sfp+': function () { return [1000, 10000]; },
  // An SFP28 cage takes 1G SFP and 10G SFP+ modules as well as 25G SFP28 ones, and
  // the link runs at the module's own rate (issue #17).
  //
  // This is one part, not three: SFP28 (SFF-8402) keeps the SFP+ cage and mating
  // interface, "Backwards-compatibility: Shares same mating interface and cage
  // dimensions with the SFP+ connector" (TE zSFP+ 28 Gb/s I/O datasheet). Every
  // vendor that ships 25G ports documents the 1G case in its own words:
  //   Cisco Nexus 93180YC-FX: "48 10/25-Gigabit SFP+ downlink ports that support
  //     1-Gigabit, 10-Gigabit, and 25-Gigabit Ethernet connections".
  //   Arista 7050X3 Q&A: "The 25G SFP ports accommodate a wide range of 25G, 10GbE
  //     and 1GbE SFP transceivers and cables".
  //   Juniper QFX5120: "48 25GbE, 10GbE, or 1GbE SFP28 ports".
  //
  // The rate is the module's, never the cage's: a 1G SFP in this slot comes up at
  // 1G, and it only does so because the far end is 1G too - which is what the
  // speed intersection below produces. Two 25G ports still meet at 25G.
  //
  // Two real-world constraints are NOT modelled here, because neither changes what
  // will mate: the port does not autonegotiate down, it has to be set ("You can set
  // the downlink port speeds on a port-by-port basis" - Cisco), and on several
  // platforms that setting is per group of ports ("The set of 4 ports in each group
  // have a single port speed setting - 1/10G or 25G" - Arista; Aruba's 8325 needs
  // "interface groups (groups of 12 ports) to enable use of 1G or 10G transceivers
  // or DACs in the SFP28 ports").
  //
  // Nor is 1G universal: Aruba's transceiver guide warns that "although 10G and 1G
  // transceiver products may 'fit' into an SFP28 port, the particular switch model
  // or module may be limited in supporting lower speeds", and the 8325P and 9300
  // do not do 1G in this cage at all. That is why this is a DEFAULT and not a rule:
  // a device that knows better lists its own speedCaps and this table never runs.
  //
  // 100M is deliberately absent: a 25G port does not take a 100BASE-FX/T SFP, and
  // none of the three vendors above lists 100M among its SFP28 port speeds.
  sfp28: function (maxMbps) {
    const out = [1000, 10000, 25000];
    return out.filter(function (v) { return v <= maxMbps; });
  },
  'qsfp+': function () { return [40000]; },
  qsfp28: function () { return [40000, 100000]; },
  cfp2: function () { return [40000, 100000, 200000]; },
  qsfp56: function () { return [40000, 100000, 200000]; },
  'fc-sfp': function () { return [2125, 4250, 8500, 10519, 14025]; },
  sfp56: function () { return [25000, 50000]; },
  xfp: function () { return [10000]; },
  'fc-sfp28': function () { return [8500, 14025, 28050]; },
  'fc-sfpdd': function () { return [14025, 28050, 57800]; },
  'fc-qsfp28': function () { return [28050, 112200]; },
  qsfpdd: function (maxMbps) {
    const out = [40000, 100000, 200000, 400000];
    return out.filter(function (v) { return v <= maxMbps; });
  },
  'sc-apc': function (maxMbps) {
    return [100, 1000, 1244, 2488, 9953].filter(function (v) { return v <= maxMbps; });
  },
  'sc-upc': function (maxMbps) {
    return [100, 1000, 1244, 2488, 9953].filter(function (v) { return v <= maxMbps; });
  },
  'lc-upc': function (maxMbps) {
    const out = [1000, 1244, 2488, 9953, 10000, 25000, 100000];
    return out.filter(function (v) { return v <= maxMbps; });
  },
  'lc-apc': function (maxMbps) {
    const out = [1000, 1244, 2488, 9953, 10000, 25000, 100000];
    return out.filter(function (v) { return v <= maxMbps; });
  },
  coax: function (maxMbps) {
    const out = [175, 200, 1000];
    if (maxMbps >= 2500) out.push(2500);
    if (maxMbps >= 5000) out.push(5000);
    if (maxMbps >= 10000) out.push(10000);
    return out.filter(function (v) { return v <= maxMbps; }).concat([Math.min(1000, maxMbps)]).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
  },
  dsl: function (maxMbps) {
    const out = [24, 100];
    if (maxMbps >= 300) out.push(300);
    return out.filter(function (v) { return v <= maxMbps; });
  },
  powerline: function (maxMbps) {
    // A port's own maximum bounds what it can offer: a 1000M powerline port was
    // negotiating 2500M because this list ignored maxMbps.
    return [200, 1000, 1700, 2500].filter(function (v) { return v <= maxMbps; });
  },
  console: function () { return [0.0096, 0.0192, 0.0384, 0.0576, 0.1152]; },
  usb: function () { return [12]; },
  // A radio has no autonegotiation ladder: it runs at the rate the interface declares
  // and at nothing else. The 10/100/1000 rungs belong to an RJ45 cage, and offering
  // them here is how a Wi-Fi radio came to advertise 1000BASE-T (issue #77). A 25 Mbit/s
  // satellite WAN is 25, an 867 Mbit/s Wi-Fi radio is 867, never a gigabit.
  antenna: function (maxMbps) { return maxMbps > 0 ? [maxMbps] : []; }
};

// ---------------------------------------------------------------------------
// port hardware derivation
// ---------------------------------------------------------------------------
// Device specs are terse: { name: 'ether1', type: 'ethernet', speed: '1G' }.
// We derive a full hardware description from the name + type + speed, and let
// a spec override any field explicitly with a `hardware` block:
//   { "hardware": { "cage": "sfp+", "poeOut": 30 } }
// or per-field: { "connector": "sfp+", "poeOut": 30 }

// Interface types that are radios, whatever the spec author called them. Anything that
// falls through inferCage() becomes RJ45 copper, so this list is the difference between
// a Wi-Fi radio and an Ethernet socket (issue #77).
const WIRELESS_TYPE = /^(wireless|radio|wifi|wi-fi|wlan|wwan|cellular|lte|nr5g|5g-nr|satellite|microwave)$/;

function inferCage(ifaceSpec, maxMbps) {
  const name = String(ifaceSpec.name || '').toLowerCase();
  const type = String(ifaceSpec.type || 'ethernet').toLowerCase();

  // A radio is an antenna, never an RJ45 socket.
  //
  // This used to test only 'wireless' and 'radio', and everything else that reached the
  // bottom of this function became copper: a radio shown in the link inspector as an RJ45
  // cage, advertising 10/100/1000BASE-T and - because anything that enumerates "ports you
  // can plug into" goes by cage - offered as somewhere to plug a patch lead in, even
  // though validateLink refused the cable. The refusal was never the problem; the
  // description was (issue #77).
  // A cellular modem is neither copper nor Wi-Fi (issue #129). The name is checked before
  // the type because specs write these ports as `type: wireless` (borrowing the radio
  // family), and the type rule below would otherwise claim them for Wi-Fi.
  if (/^(?:wwan\d*|wan5g|modem\d*|lte\d*|nr5g|nr\d*|5g\d*)(?:$|[.\-_ /])/.test(name)) return 'wwan';
  if (WIRELESS_TYPE.test(type)) return 'antenna';
  if (type === 'console') return 'console';
  if (type === 'usb') return 'usb';
  // Subscriber-access line types are their own connector families.
  if (type === 'coax') return 'coax';
  if (type === 'dsl' || type === 'adsl' || type === 'vdsl') return 'dsl';
  if (type === 'powerline' || type === 'plc' || type === 'mains') return 'powerline';
  // A spec that never states a type: the interface name is the last honest signal. A port
  // called wlan0 or radio1 is a radio however the default type reads.
  if (/^(?:wlan|wifi|wi-?fi|radio|wwan|nr5g)\d*(?:$|[.\-_ /])/.test(name)) return 'antenna';
  if (/console|con\d|tty|aux/.test(name)) return 'console';
  if (/usb/.test(name)) return 'usb';

  // A PON port is an SC connector on the outside plant, not RJ45 copper. APC
  // (green, angled 8 degrees) is the norm on OLT and ONT PON ports; a spec that
  // knows better can say connector: "sc-upc".
  if (/sc\/?apc|scapc/.test(name)) return 'sc-apc';
  if (/sc\/?upc|scupc/.test(name)) return 'sc-upc';
  // A PON port's connector is a vendor choice, not a protocol rule, so only guess
  // when the name says which one. A bare 'pon' falls back to the ISP-conventional
  // SC/APC, but an explicit connector on the spec always wins - which is how the
  // SDX 611 gets its real LC/UPC port instead of being forced into SC.
  if (/lc\/?apc|lcapc/.test(name)) return 'lc-apc';
  if (/lc\/?upc|lcupc/.test(name)) return 'lc-upc';
  if (/sc\/?apc|scapc/.test(name)) return 'sc-apc';
  if (/sc\/?upc|scupc/.test(name)) return 'sc-upc';
  if (/gpon|xgs-?pon|xg-?s-?pon|(^|[-_ /])pon(\d|$)|^pon/.test(name)) return 'sc-apc';

  const optical = /sfp|qsfp|xfp|cfp|xe-|et-|fc\d/.test(name) ||
    /(^|[^0-9])(25|40|100)\s*g/i.test(String(ifaceSpec.speed || ''));

  if (!optical) return 'rj45';

  // A port named for its cage wins over its rate: qsfpdd1/1 carrying 200G is a
  // QSFP-DD cage, not a QSFP28 that happens to be fast.
  if (/qsfp-?dd|qsfpdd/.test(name)) return 'qsfpdd';
  // QSFP56 is named, not inferred from a rate: 200G over QSFP-DD is far more common, so a
  // bare 200G rate alone must keep resolving to QSFP-DD.
  if (/qsfp-?56|qsfp56/.test(name)) return 'qsfp56';

  if (maxMbps >= 200000) return 'qsfpdd';
  if (maxMbps >= 100000) return 'qsfp28';
  if (maxMbps >= 40000) return 'qsfp+';
  if (maxMbps >= 25000) return 'sfp28';
  if (maxMbps >= 10000) return 'sfp+';
  return 'sfp';
}

// Derive a complete port-hardware descriptor from a terse interface spec.
// The bands a radio supports.
//
// A datasheet states the bands or the generation; a lab spec usually states the rate. The
// generation follows from the rate (n / ac / ax / be), and the generation fixes the band
// set, so a Wi-Fi 5 radio is 2.4+5 rather than one or the other. A spec may say exactly
// which bands it has with `bands: ["2.4","5","6"]`, which always wins.
const WIRELESS_GENERATIONS = [
  { maxMbps: 600, label: '802.11n', media: ['wireless-2.4'] },
  { maxMbps: 1000, label: '802.11ac', media: ['wireless-2.4', 'wireless-5'] },
  { maxMbps: 2500, label: '802.11ax', media: ['wireless-2.4', 'wireless-5', 'wireless-6'] },
  { maxMbps: Infinity, label: '802.11be', media: ['wireless-2.4', 'wireless-5', 'wireless-6', 'wireless-7'] }
];

function bandMediaId(band) {
  const b = String(band).trim();
  if (b === '60' || /^60\s*ghz$/i.test(b)) return 'wireless-60';
  if (b === '6' || /^6\s*ghz$/i.test(b)) return 'wireless-6';
  return 'wireless-' + b;
}

// The band set a rate implies, and the only place that mapping lives: CAGE_MEDIA.antenna
// asks this, and so does the derived port below, so the two can never disagree about what
// a radio carries.
function generationBands(maxMbps) {
  for (const g of WIRELESS_GENERATIONS) {
    if (maxMbps <= g.maxMbps) return g.media.slice();
  }
  return WIRELESS_GENERATIONS[WIRELESS_GENERATIONS.length - 1].media.slice();
}

function wirelessBands(spec, maxMbps, dev) {
  const s = spec || {};
  if (Array.isArray(s.bands) && s.bands.length) return s.bands.map(bandMediaId);
  if (s.band !== undefined && s.band !== null) return [bandMediaId(s.band)];

  // 60 GHz gear is a different radio, not a faster one: a WiGig bridge and a Wi-Fi 7
  // phone both say "5G" but share nothing. Recognise it from what the device says it is.
  const hay = String((dev && dev.model) || '') + ' ' + String((dev && dev.description) || '');
  if (/60\s*ghz|802\.11ad|wigig/i.test(hay)) return ['wireless-60'];

  return generationBands(maxMbps);
}

function derivePortHardware(ifaceSpec, deviceSpec) {
  const spec = ifaceSpec || {};
  const dev = deviceSpec || {};
  // A port's declared speedCaps are what it can actually train at; `speed` is the label on the
  // box. Fibre Channel makes the difference visible: a "32G" FC port runs at 28.05 Gbit/s, so
  // taking the label as the rate would claim 32000 Mbps on a 28050 Mbps cage.
  let capMbps = (Array.isArray(spec.speedCaps) ? spec.speedCaps : [])
    .map(function (c) { return typeof c === 'number' ? c : parseSpeedMbps(c); })
    .filter(function (n) { return typeof n === 'number' && isFinite(n) && n > 0; });
  // A console port has a baud rate, and a spec author writes `baud: 115200`, not 0.1152 Mbps -
  // nobody thinks of RS-232 in megabits. Accepting the number in its own unit is the difference
  // between a spec that reads like a datasheet and one that quietly offers no medium at all when
  // the author writes 9600 and the engine hears 9600 Mbps. An explicit speedCaps in Mbps still
  // wins, because that field is unambiguous.
  if (!capMbps.length && spec.baud !== undefined && spec.baud !== null) {
    const baudList = Array.isArray(spec.baud) ? spec.baud : [spec.baud];
    capMbps = baudList.map(function (b) { return Number(b) / 1000000; })
      .filter(function (n) { return isFinite(n) && n > 0; });
  }
  // With no caps and no label, the rate is whatever the cage can carry. The old fallback was a
  // flat 1000 Mbps, which gave every console port in the catalogue a gigabit it could never run
  // and 84 coax ports a rate their medium does not have: a console cage carries 9600 baud to
  // 115200, and asking for a gigabit on one is a modelling error, not a fast port.
  //
  // The cage is resolved from the spec here rather than from `cage` below, because `cage` is what
  // inferCage() computes FROM this rate - asking the cage for its rates before that would be
  // circular. A spec that names its connector ('console', 'coax', 'sc-apc') has enough to answer.
  const cageRatesForDefault = (function () {
    const named = CAGE_ALIAS[String(spec.cage || spec.connector || '')] || String(spec.cage || spec.connector || '');
    const fn = CAGE_SPEEDS[named];
    if (!fn) return [];
    try { return fn(parseSpeedMbps(spec.speed) || 1000) || []; } catch (e) { return []; }
  })();
  let maxMbps = capMbps.length ? Math.max.apply(null, capMbps)
    : (parseSpeedMbps(spec.speed)
      || (cageRatesForDefault.length ? Math.max.apply(null, cageRatesForDefault) : 1000));
  let cage = String(spec.cage || spec.connector || inferCage(spec, maxMbps));

  // A handful of spec authors write the bare fibre token ('lc') because that is what
  // the datasheet calls it. 'lc' is a connector, not a cage - the cages are lc-upc and
  // lc-apc, because the polish is part of what will mate. Resolve the bare token to the
  // flat (UPC) variant rather than inventing a third unmateable cage.
  if (CAGE_ALIAS[cage]) cage = CAGE_ALIAS[cage];

  // An unrecognised cage must NOT inherit RJ45.
  //
  // This used to read CAGES[cage] || CAGES.rj45, which turned a typo or an unmodelled
  // connector into a copper port that advertised 10GBASE-T and then refused every
  // cable - including another port of the same kind - with the nonsense message
  // "Cannot mate RJ45 to RJ45". Two passive optical devices (an FS DWDM mux and an LC
  // patch panel, 64 ports) were in exactly that state. An unknown connector is now
  // reported as unknown: no media, no rate, no mates, and a refusal that says why.
  const known = Object.prototype.hasOwnProperty.call(CAGES, cage);
  const cageDef = known ? CAGES[cage]
    : { name: cage, family: 'unknown', label: cage + ' (not a modelled connector)' };
  let media = known ? (CAGE_MEDIA[cage] || CAGE_MEDIA.rj45)(maxMbps) : [];
  // A spec that names neither caps nor a rate is now given the cage's own top speed, computed
  // here because only here is the cage known: a port listing just its type ("console", "serial")
  // used to take the flat 1000 Mbps fallback and advertise a gigabit on a 115200 baud cage.
  if (!capMbps.length && !parseSpeedMbps(spec.speed) && known) {
    const ladder = (CAGE_SPEEDS[cage] || CAGE_SPEEDS.rj45)(maxMbps) || [];
    if (ladder.length) maxMbps = Math.max.apply(null, ladder);
  }
  let speeds = known ? (CAGE_SPEEDS[cage] || CAGE_SPEEDS.rj45)(maxMbps) : [];

  // Belt and braces. A cage table that forgets to filter by maxMbps is exactly how a
  // 1000 Mbps port came to negotiate a 2500 Mbps medium, so the port's own maximum is
  // applied here too - to the rates, and to the media that would carry them at a rate
  // the port cannot reach.
  speeds = speeds.filter(function (v) { return v <= maxMbps; });
  media = media.filter(function (id) {
    const m = MEDIA[id];
    if (!m || !m.speedMbps) return true;
    if (m.fiber) return true; // optical reach is budgeted, not rate-capped per medium
    // A 3GPP air interface is not rate-limited by its cage: the port's declared rate is the
    // modem's category, and the medium names the generation it speaks. Filtering here left
    // two modems declared at 100 Mbps with no media at all, which is worse than a slow
    // link - it is a port that cannot form any link (issue #129).
    if (m.family === 'wireless' && m.connector === 'wwan') return true;
    return m.speedMbps <= maxMbps;
  });

  // A radio carries the bands of its generation.
  //
  // This used to assign exactly ONE band from the port's declared rate, so a dual-band
  // phone became ["wireless-5"] only and a 2.4 GHz AP radio became ["wireless-2.4"] only,
  // and an AP and a phone shared no medium at all: every wireless device in the catalogue
  // was unconnectable (issue #28). Real hardware associates across bands; what a radio
  // cannot do is exceed its own generation, so the generation bounds the band set.
  //
  // The old line also read `maxMbps >= 5000 -> wireless-60`, which modelled a Wi-Fi 7
  // phone as millimetre-wave 802.11ad.
  if (cage === 'antenna') media = wirelessBands(spec, maxMbps, dev);

  // Explicit overrides.
  if (Array.isArray(spec.media)) media = spec.media.slice();
  if (Array.isArray(spec.supportedMedia)) media = spec.supportedMedia.slice();

  // A radio's media list is not a place for a patch lead.
  //
  // Everything above can be overridden by the spec, and a spec that writes
  // `media: ["1000base-t"]` on a radio is describing a cable that cannot exist. Copper or
  // optics in an antenna cage is precisely the confusion issue #77 is about, so the
  // family is enforced last: whatever else is true of this port, it carries radio bands or
  // it carries nothing. Unknown ids are left alone rather than invented away.
  if (cage === 'antenna') {
    media = media.filter(function (id) {
      const m = MEDIA[id];
      return !m || m.family === 'wireless';
    });
  }

  const hw = spec.hardware || {};

  const port = {
    name: spec.name,
    type: spec.type || 'ethernet',
    cage: cage,
    cageName: cageDef.name,
    family: cageDef.family,
    media: media,
    // A port that stated its rate - in speedCaps or in baud - keeps it. Falling back to the cage
    // ladder here is what silently widened a 9600-baud console into a 115200 one.
    speedCaps: (hw.speedCaps || (capMbps.length ? capMbps : speeds)).slice(),
    // A port restored from a saved board states the cap it had. Recomputing it from the cage gives the cage's
    // default, not this port's limit - which is how a 115.2 kbps console came back as a 1 Gbps port (#1321).
    maxSpeedMbps: (typeof spec.maxSpeedMbps === 'number' && isFinite(spec.maxSpeedMbps)) ? spec.maxSpeedMbps : maxMbps,
    // PoE
    poeOut: hw.poeOut !== undefined ? hw.poeOut : (spec.poeOut !== undefined ? spec.poeOut : null),
    poeIn: hw.poeIn !== undefined ? hw.poeIn : (spec.poeIn !== undefined ? spec.poeIn : null),
    // Whether this port sourced power because the spec said so, or because the engine guessed
    // from the device class. The two are not the same claim: a spec that says a port sources
    // power is a statement about hardware, while a guess is the engine filling a silence. Only
    // the guess is a defect when it lands on a device that does not switch (see the PoE
    // invariant in test/poe-inference.test.js).
    // `poeOutDeclared` answers "did the hardware say so, or did the engine guess?" - so a restored port has to
    // bring the answer with it, or every declared PoE port in a reloaded lab looks guessed (#1321).
    poeOutDeclared: (spec.poeOutDeclared !== undefined)
      ? !!spec.poeOutDeclared
      : (hw.poeOut !== undefined ? hw.poeOut : (spec.poeOut !== undefined ? spec.poeOut : null)) !== null,
    // distance / cabling hints
    maxRangeM: hw.maxRangeM !== undefined ? hw.maxRangeM
      : (typeof spec.maxRangeM === 'number' ? spec.maxRangeM : null)
  };

  // Best-effort PoE inference for common device classes when the spec is silent.
  //
  // Power only travels on copper. A fibre cage, a WDM strand or an antenna cannot source
  // or sink watts, whatever the box happens to be called - and inferring it there used to
  // put 89 PSE ports on non-RJ45 cages, including both SFP slots of an EdgeSwitch and the
  // 10G cages of an Aruba 6000 (see #105). The port is the authority on whether power can
  // flow, so the cage gates the inference before the device gets a say.
  const carriesPower = port.cage === 'rj45' || port.cage === 'combo';
  if (port.poeOut === null && port.poeIn === null && carriesPower) {
    if (isPoePse(dev, port.name)) port.poeOut = 15.4;     // 802.3af default
    else if (isPoePd(dev)) port.poeIn = 12.95;
  }

  // A port the datasheet names "PoE 1" has declared its job in the only place it can: the
  // port name comes from the spec file, and an NVR that documents eight PoE ports is not a
  // device the engine invented watts for. Without this, "did the engine guess?" would answer
  // yes for every documented PoE port on a non-switch, which is the opposite of the truth.
  if (!port.poeOutDeclared && port.poeOut &&
      /poe/i.test(String(port.name)) && !/poe[\s_-]?in\b|pdin/i.test(String(port.name))) {
    port.poeOutDeclared = true;
  }

  return port;
}

function isPoePse(dev, portName) {
  const name = String(portName || '');
  // A port that calls itself PoE is one, whatever the device is - unless it calls itself an
  // *input*. "poe_in" contains "poe", so the old rule made the inline splitters (planet
  // POE-E201, poe-texas GAF-12V12W) power sources on the strength of their own input jack's
  // name. A port that accepts power is not a port that supplies it.
  if (/poe[\s_-]?in\b|pdin|poe[\s_-]?pd\b/i.test(name)) return false;
  if (/poe/i.test(name)) return true;
  const model = String(dev.model || '') + ' ' + String(dev.label || '');
  const caps = dev.capabilities || [];
  const claimsPse = /poe/i.test(model) || caps.indexOf('poe-pse') !== -1;
  if (!claimsPse) return false;
  // On a PoE switch every access port sources power, and the ports are usually just
  // 'port1..24' or '1/1/1..' - there is no per-port marker to look for.
  //
  // Everywhere else the claim is about a *subset* of ports. An NVR's label says "16 PoE
  // ports" and it also has a LAN uplink; treating the label as a whole-device property made
  // the uplink a power source too. So off a switch, only the named PoE ports source power.
  //
  // 'l3-switch' counts: a 2930F with 370 W of PoE budget is a switch whether or not it
  // routes, and the first cut of this rule silently left three of them sourcing nothing.
  const cat = String(dev.category || '');
  return cat === 'switch' || cat === 'l3-switch';
}

function isPoePd(dev) {
  const model = String(dev.model || '') + ' ' + String(dev.label || '');
  const caps = dev.capabilities || [];
  if (caps.indexOf('poe-pd') !== -1) return true;
  // APs, PTP radios and IP cameras are typically PoE-powered.
  const cat = String(dev.category || '');
  if (cat === 'wireless' || cat === 'ptp' || cat === 'camera') return true;
  if (/litebeam|nanobeam|powerbeam|unifi|u6|u7|eap|wap|cube|lhg|sxt|mantbox/i.test(model)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// compatibility / negotiation
// ---------------------------------------------------------------------------

// Media that BOTH ports can carry, given their cages - plus the medium that two
// *complementary* halves make when they meet.
//
// The plain intersection is no longer the whole answer now that a medium can have a
// mate that is a different medium. Two 1000BASE-BX10-U ports intersect on
// '1000base-bx-u', and that intersection is a lie dressed as a fact: the id is shared,
// but there is no link and never can be. So a paired half never enters the result on
// its own - it enters only through its complement, as the run the pair actually makes
// ('1000base-bx'). Everything that is not a half is still reflexive and still comes
// straight out of the intersection, in the order the A port lists it.
function commonMedia(pa, pb) {
  if (!cagesMate(pa.cage, pb.cage)) return [];
  const setB = {};
  for (const m of pb.media) setB[m] = true;

  const out = pa.media.filter(function (m) { return setB[m] && !isPairedHalf(m); });

  // U at one end, D at the other: the only arrangement a single strand supports.
  for (const a of pa.media) {
    const mate = mediaMate(a);
    if (!mate || !setB[mate.with]) continue;
    if (out.indexOf(mate.link) === -1) out.push(mate.link);
  }
  return out;
}

// The optical *service* a polish-specific media id carries, with the ferrule
// taken off the end of the id: 'gpon-sc-upc' and 'gpon-sc-apc' are the same GPON
// wavelength plan, and the only thing that differs is the connector endface.
function serviceKeyOf(mediaId) {
  return String(mediaId).replace(/-(?:upc|apc)$/, '');
}

// Media two ports can share when a hybrid (UPC one end, APC the other) patch cord
// is what joins them.
//
// The cages deliberately do not mate - an 8-degree ferrule against a flat one is
// the failure this model exists to catch - so commonMedia() returns nothing. With
// a hybrid cord the *cord* is the medium: each port keeps its own ferrule, the
// transition happens inside a factory assembly, and the service either side is
// the same. So the intersection is taken over services rather than over cages,
// and a service that exists only in per-polish ids resolves to its '-hybrid'
// medium so the link is named for what is actually on the floor.
function commonMediaBridged(pa, pb) {
  const out = [];
  if (!pa || !pb || !Array.isArray(pa.media) || !Array.isArray(pb.media)) return out;
  for (const a of pa.media) {
    for (const b of pb.media) {
      let id = null;
      if (a === b) id = a;
      else if (serviceKeyOf(a) === serviceKeyOf(b)) {
        const hybridId = serviceKeyOf(a) + '-hybrid';
        if (MEDIA[hybridId]) id = hybridId;
      }
      if (id && out.indexOf(id) === -1) out.push(id);
    }
  }
  return out;
}

// Highest speed both ports support (ethernet auto-negotiation), or null.
function negotiateSpeed(pa, pb) {
  // A radio association is not a line-rate handshake.
  //
  // Two wired ports must agree on an exact rate: there is no such thing as a 1000 Mbps
  // link that runs at 574 because one end felt like it. A radio pair works the other way
  // round - the client takes the best rate the AP and the client and the band can all
  // sustain, so a 2.5 Gbps phone on a 574 Mbps 2.4 GHz radio associates at 574 instead of
  // refusing to connect. Requiring an exact intersection here is what made every wireless
  // pair in the catalogue unconnectable even once they shared a band (issue #28).
  if (pa && pb && pa.cage === 'antenna' && pb.cage === 'antenna') {
    const bandCap = Math.min.apply(null, [pa.maxSpeedMbps || 0, pb.maxSpeedMbps || 0].filter(Boolean));
    const mediaIds = commonMedia(pa, pb);
    // The BEST shared band sets the ceiling, not the worst: an association lands on the
    // fastest band both sides support, which is why a phone joins 5 GHz rather than
    // sitting on 2.4 at 600 Mbps because that band also happens to be available.
    let mediaCap = 0;
    for (const id of mediaIds) {
      const m = MEDIA[id];
      if (m && m.speedMbps) mediaCap = Math.max(mediaCap, m.speedMbps);
    }
    // The band is the ceiling: a 2.4 GHz association cannot exceed what 2.4 GHz carries
    // in this model, however fast the radios are.
    const rates = [bandCap, mediaCap || bandCap].filter(function (v) { return v > 0; });
    if (!rates.length) return null;
    return Math.round(Math.min.apply(null, rates));
  }

  const setB = {};
  for (const s of pb.speedCaps) setB[s] = true;
  const shared = pa.speedCaps.filter(function (s) { return setB[s]; });
  if (!shared.length) return null;
  return Math.max.apply(null, shared);
}

// Why two ports that each carry a single-strand module still make no link.
//
// Two reasons, and they are the two the parts catalogue already draws
// (engine/optical.js -> biDiPairsWith, same codes), so a user who moves between the
// module picker and the cable editor reads the same words for the same mistake:
//
//   E_BIDI_SAME_WAVELENGTH  both ends are the SAME half. Two 1310 nm transmitters into
//                           one strand, two deaf 1490 nm receivers. The single most
//                           common way to get a BiDi run wrong.
//   E_BIDI_MISMATCH         exactly one end is single-strand. A duplex 1310 nm optic
//                           hears this module's 1310 nm transmit well enough, but its
//                           own transmit never lands on the 1490 nm this receiver is
//                           tuned to - so one direction of the pair is dead, and a link
//                           with one dead direction is not a link.
function biDiRefusal(pa, pb) {
  const shared = pa.media.filter(function (id) {
    return isPairedHalf(id) && pb.media.indexOf(id) !== -1;
  });
  if (shared.length) {
    const id = shared[0], m = MEDIA[id], mate = mediaMate(id);
    return {
      ok: false, code: 'E_BIDI_SAME_WAVELENGTH',
      message: 'Both ends carry ' + m.name + '. Two ' + m.direction + ' ends cannot form a ' +
        'run: each transmits at ' + m.txWavelengthNm + ' nm into the same strand and listens ' +
        'at ' + m.rxWavelengthNm + ' nm, so the two transmitters face each other and neither ' +
        'receiver ever sees light. A single-strand link needs one ' + m.name + ' and one ' +
        MEDIA[mate.with].name + '.'
    };
  }
  const dirA = pa.media.filter(isPairedHalf);
  const dirB = pb.media.filter(isPairedHalf);
  if (dirA.length && dirB.length) return null;      // both ends single-strand, handled above
  const half = dirA.length ? dirA[0] : dirB[0];
  if (!half) return null;
  const m = MEDIA[half];
  const far = dirA.length ? pb : pa;
  const farIsOptical = far.media.some(function (id) {
    return MEDIA[id] && MEDIA[id].family === 'fiber';
  });
  return {
    ok: false, code: 'E_BIDI_MISMATCH',
    message: m.name + ' is a single-strand (BiDi) optic: it transmits at ' + m.txWavelengthNm +
      ' nm and receives at ' + m.rxWavelengthNm + ' nm over ONE fibre, so it only ever ' +
      'pairs with ' + MEDIA[m.matesWith].name + '. ' +
      (farIsOptical
        // Precise about what breaks: a duplex 1310 nm optic DOES hear this module's 1310 nm
        // transmit. What it cannot do is send one back on a wavelength this receiver is
        // looking at, so one direction of the pair is dead - and that is not a link.
        ? 'The far end is a two-strand duplex optic: it may hear this module\'s ' +
          m.txWavelengthNm + ' nm transmit, but its own transmit is not the ' +
          m.rxWavelengthNm + ' nm this receiver listens for, so one direction of the pair is ' +
          'dead - and a link with one dead direction is no link.'
        : 'The far end is not an optical medium at all, so this module has nothing to listen to.')
  };
}

// Can these two ports be cabled at all? Returns a structured verdict.
function canMate(pa, pb) {
  if (!pa || !pb) {
    return { ok: false, code: 'E_NO_PORT', message: 'Port does not exist.' };
  }
  if (pa.cage === 'antenna' || pb.cage === 'antenna') {
    if (pa.cage !== pb.cage) {
      return { ok: false, code: 'E_WIRELESS_TO_WIRED', message: 'A wireless radio cannot be cabled to a wired port.' };
    }
  }
  // Out-of-band before in-band: a console port is not a data port, and "these connectors do not
  // fit" is a worse explanation than "this is a management console". A USB console talking to a
  // USB console still mates, so this only fires when exactly one side is console-only.
  function consoleOnly(hw) {
    const list = (hw && hw.media) || [];
    if (!list.length) {
      // A console port with no medium at all is still a console port: the cage says so, and
      // that is what lets the refusal below explain the baud rate instead of the connector.
      return !!hw && (hw.cage === 'console' || hw.cage === 'usb');
    }
    return list.every(function (id) {
      const d = MEDIA[id];
      return d && (d.family === 'console' || d.family === 'management');
    });
  }
  if (consoleOnly(pa) !== consoleOnly(pb) && !(consoleOnly(pa) && consoleOnly(pb))) {
    const c = consoleOnly(pa) ? pa : pb;
    const o = consoleOnly(pa) ? pb : pa;
    return {
      ok: false, code: 'E_PROTOCOL_MISMATCH',
      message: c.cageName + ' is an out-of-band management console and ' + o.cageName +
        ' is a data port. A console link carries an operator typing at a baud rate, not frames ' +
        'from a network stack, so nothing routable ever crosses it. Cable the data port instead.'
    };
  }
  if (!cagesMate(pa.cage, pb.cage)) {
    if (polishMismatch(pa.cage, pb.cage)) {
      const fa = ferrule(pa.cage), fb = ferrule(pb.cage);
      return {
        ok: false, code: 'E_POLISH_MISMATCH',
        message: pa.cageName + ' and ' + pb.cageName + ' take the same ' +
          fa.shape.toUpperCase() + ' ferrule but not the same polish (' +
          fa.polish.toUpperCase() + (fa.angleDeg ? ' angled ' + fa.angleDeg + ' deg' : ' flat') +
          ' vs ' + fb.polish.toUpperCase() + (fb.angleDeg ? ' angled ' + fb.angleDeg + ' deg' : ' flat') +
          '). They are not intermateable - forcing it costs about 3 dB and can chip the endface.'
      };
    }
    return {
      ok: false, code: 'E_CONNECTOR_MISMATCH',
      message: 'Cannot mate ' + pa.cageName + ' to ' + pb.cageName + ' (incompatible connectors).'
    };
  }
  // Two console ports that share no baud rate: the cable fits, both ends are consoles, and every
  // character arrives as noise. Asked of the ports' declared rates rather than of commonMedia(),
  // because that intersects what the *cage* offers - both ends would appear to speak 9600 and the
  // link would come up "successfully" only to fail negotiation with a message about speed.
  if (consoleOnly(pa) && consoleOnly(pb)) {
    const baudSet = function (hw) {
      const fromCaps = ((hw && hw.speedCaps) || [])
        .map(function (n) { return Math.round(Number(n) * 1000000); })
        .filter(function (n) { return isFinite(n) && n > 0; });
      if (fromCaps.length) return fromCaps;
      return ((hw && hw.media) || []).map(function (id) { return MEDIA[id] && MEDIA[id].baud; })
        .filter(Boolean);
    };
    const ba = baudSet(pa), bb = baudSet(pb);
    if (ba.length && bb.length && !ba.some(function (n) { return bb.indexOf(n) !== -1; })) {
      return {
        ok: false, code: 'E_BAUD_MISMATCH',
        message: pa.cageName + ' runs at ' + ba.join('/') + ' baud and ' + pb.cageName +
          ' runs at ' + bb.join('/') + ' baud. No shared baud rate means the link comes up and ' +
          'every character arrives as noise - the classic console failure. Set both ends to ' +
          'the same speed.'
      };
    }
  }
  const media = commonMedia(pa, pb);
  if (!media.length) {
    // A pair that shares a single-strand id but no complementary half is refused for a
    // physical reason, and "no shared medium" would hide it: both ports agree perfectly
    // on what they carry. Say what is actually wrong first (issue #97).
    // An FC optic seats in the same socket as an Ethernet one, so the connector check passes and
    // the failure looks mysterious. It is not a cabling problem: the two ends carry different
    // protocols and no module in either port speaks the other's language.
    const famsA = new Set((pa.media || []).map(function (id) { return MEDIA[id] && MEDIA[id].family; }));
    const famsB = new Set((pb.media || []).map(function (id) { return MEDIA[id] && MEDIA[id].family; }));
    const aFc = famsA.has('fibre-channel'), bFc = famsB.has('fibre-channel');
    if (aFc !== bFc) {
      const fcPort = aFc ? pa : pb;
      const ethPort = aFc ? pb : pa;
      return {
        ok: false, code: 'E_PROTOCOL_MISMATCH',
        message: fcPort.cageName + ' is a Fibre Channel port and ' + ethPort.cageName +
          ' is Ethernet. The connector is the same LC/SFP family and the optic will even seat, ' +
          'but Fibre Channel carries FC frames at its own rate ladder (8/16/32/64G run at ' +
          '8.5/14.025/28.05/57.8 Gbit/s) and an Ethernet port has no FC login, so no frame ' +
          'ever crosses. Put an FC HBA or switch on the other end.'
      };
    }
    const bidi = biDiRefusal(pa, pb);
    if (bidi) return bidi;
    return {
      ok: false, code: 'E_NO_COMMON_MEDIA',
      message: 'No shared medium between ' + pa.cageName + ' and ' + pb.cageName + '.'
    };
  }
  const speed = negotiateSpeed(pa, pb);
  if (speed === null) {
    return {
      ok: false, code: 'E_NO_COMMON_SPEED',
      message: 'No common speed between ' + pa.cageName + ' and ' + pb.cageName +
        ' (A: ' + pa.speedCaps.join('/') + ', B: ' + pb.speedCaps.join('/') + ').'
    };
  }
  // A single-strand pair runs at the MODULE's rate, not the cage's.
  //
  // This is the one case where the medium, not the port, sets the speed: 1000BASE-BX10
  // is a 1 Gbps PMD, so two SFP+ cages that both clock 10G still make a 1G link when
  // the pair is a BX run, because the module in them is a 1G module. It only applies
  // when every medium the pair shares is a linkOnly run - i.e. the pair has nothing
  // else it could be - so no existing pair changes its number. validation.js clamps to
  // the chosen medium as well; this keeps canMate() honest on its own.
  let rate = speed;
  if (media.every(function (id) { return !!(MEDIA[id] && MEDIA[id].linkOnly); })) {
    for (const id of media) {
      if (typeof MEDIA[id].speedMbps === 'number' && MEDIA[id].speedMbps > 0) {
        rate = Math.min(rate, MEDIA[id].speedMbps);
      }
    }
  }
  return { ok: true, code: 'OK', media: media, speedMbps: rate };
}

// Preferred medium when several are possible (prefer fiber/DAC over copper SFP,
// prefer the highest speed).
function preferredMedia(mediaIds, maxMbps) {
  if (!mediaIds || !mediaIds.length) return null;
  // A port that negotiated 100 Mbps must not be described by a 2.5G PON medium. The
  // fastest-medium rule below is right when the candidates are all candidates, but a media
  // list is a connector's whole repertoire - the SC/UPC cage offers GPON *and* 100BASE-FX -
  // so two 100M media converters facing each other were being labelled 'GPON (SC/UPC)'
  // while running at 100 Mbps. Restrict to media the link can actually run at when any
  // candidate fits, and otherwise keep the full list rather than refusing to name it.
  let candidates = mediaIds;
  if (typeof maxMbps === 'number' && maxMbps > 0) {
    const fits = mediaIds.filter(function (id) {
      const m = MEDIA[id];
      return !m || typeof m.speedMbps !== 'number' || m.speedMbps <= maxMbps;
    });
    if (fits.length) candidates = fits;
  }
  const rank = { fiber: 3, dac: 2, copper: 1, console: 1, wireless: 1 };
  // A `linkOnly` medium describes a SPAN, not a module you choose: '1000base-bx' exists
  // only because a U met a D, and no cage offers it. Two ordinary SFP ports therefore
  // stay described as a 1000BASE-LX run - the medium every other cable in the matrix is
  // already named by - instead of being renamed for a pair of modules neither port is
  // known to hold. It still wins when it is the only thing the two ports can share,
  // which is precisely the U-at-one-end/D-at-the-other case.
  const onlyLinks = candidates.every(function (id) { return !!(MEDIA[id] && MEDIA[id].linkOnly); });
  const rankOf = function (id) {
    const m = MEDIA[id];
    if (m && m.linkOnly && !onlyLinks) return -1;
    return (m && rank[m.family]) || 0;
  };
  let best = candidates[0];
  for (const id of candidates) {
    const a = MEDIA[best]; const b = MEDIA[id];
    if (!b) continue;
    if (!a) { best = id; continue; }
    if (rankOf(id) > rankOf(best)) best = id;
    else if (rankOf(id) === rankOf(best) && b.speedMbps > a.speedMbps) best = id;
  }
  return best;
}

// Budget encoded in a model name ("... PoE+ 370W", "740W") is the only source
// most datasheets give us in the model string itself.
function parsePoeBudget(model) {
  if (!model) return 0;
  const m = String(model).match(/(\d{2,4})\s*W\b/i);
  if (!m) return 0;
  const w = parseInt(m[1], 10);
  return (w >= 30 && w <= 2000) ? w : 0;
}

module.exports = {
  CAGE_ALIAS,
  MEDIA, CAGES, CAGE_MATE, CAGE_MEDIA, CAGE_SPEEDS,
  MEDIA_MATE, mediaMate, isPairedHalf, biDiRefusal,
  parseSpeedMbps, formatSpeedMbps, parsePoeBudget, mediaById,
  cagesMate, derivePortHardware, commonMedia, commonMediaBridged, negotiateSpeed, canMate, preferredMedia,
  FERRULE, ferrule, polishMismatch,
  inferCage, isPoePse, isPoePd
};
