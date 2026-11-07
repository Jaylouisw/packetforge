#!/usr/bin/env python3
"""Build devices-docsis.json (DOCSIS cable modems, CMTS/headend, xDSL gear).

Every spec carries a sourceUrl that was actually opened during research.
Port counts are transcribed from the vendor datasheet/spec page; chassis
entries model an explicitly stated module population (see "notes").
"""
import json
import os

devices = []


def coax(name, speed="1G", connector="f"):
    return {"name": name, "type": "coax", "speed": speed, "connector": connector}


def eth(name, speed="1G", connector=None, **kw):
    d = {"name": name, "type": "ethernet", "speed": speed}
    if connector:
        d["connector"] = connector
    d.update(kw)
    return d


def dsl(name, speed="100M"):
    return {"name": name, "type": "dsl", "speed": speed, "connector": "rj11"}


# --------------------------------------------------------------------------
# TASK A - DOCSIS cable modems (8)
# --------------------------------------------------------------------------

devices.append({
    "vendor": "arris",
    "model": "SB8200",
    "label": "SURFboard SB8200 DOCSIS 3.1 cable modem",
    "category": "modem",
    "description": "DOCSIS 3.1 cable modem with 32x8 bonded SC-QAM DOCSIS 3.0 channels plus 2x2 OFDM/OFDMA DOCSIS 3.1 channels, bridged to two 10/100/1000Base-T LAN ports off a single F-connector coax input.",
    "capabilities": ["l2-forward", "host", "dhcp-client", "http-server", "cli"],
    "interfaces": [
        coax("coax", "10G"),
        eth("lan1", "1G"),
        eth("lan2", "1G"),
    ],
    "sourceUrl": "https://www.surfboard.com/products/cable-modems/sb8200/",
    "notes": "Vendor spec table: two 1 GB Ethernet ports, 32 DS x 8 US DOCSIS 3.0 + 2x2 OFDM(A); datasheet rates the RF side at 10 Gbps DS / 2 Gbps US over 108-1218 MHz. Both LAN ports are bridged, so the pair shares one client-side MAC domain (no NAT, no routing).",
})

devices.append({
    "vendor": "arris",
    "model": "S33",
    "label": "SURFboard S33 DOCSIS 3.1 cable modem",
    "category": "modem",
    "description": "DOCSIS 3.1 cable modem with 32x8 SC-QAM plus 2x2 OFDM/OFDMA channels, giving one 2.5GBASE-T port and one 1GBASE-T port from a single coax drop.",
    "capabilities": ["l2-forward", "host", "dhcp-client", "http-server", "cli"],
    "interfaces": [
        coax("coax", "10G"),
        eth("lan1", "2.5G"),
        eth("lan2", "1G"),
    ],
    "sourceUrl": "https://www.surfboard.com/uk/products/cable-modems/s33/",
    "notes": "Vendor page lists 'One 2.5 Gigabit Ethernet Port and One 1 Gigabit Ethernet Port', 2 OFDM x 2 OFDMA DOCSIS 3.1 channels and 32x8 DOCSIS 3.0 bonding. The asymmetrical port pair is the point: a 2.5G client can exceed 1 Gbps while the second port stays gigabit.",
})

devices.append({
    "vendor": "netgear",
    "model": "CM1000",
    "label": "CM1000 Ultra-High Speed DOCSIS 3.1 cable modem",
    "category": "modem",
    "description": "DOCSIS 3.1 cable modem with 32 downstream / 8 upstream DOCSIS 3.0 SC-QAM channels plus 2 OFDM downstream and 2 OFDMA upstream channels, bridged to a single gigabit Ethernet port.",
    "capabilities": ["l2-forward", "host", "dhcp-client", "http-server", "cli"],
    "interfaces": [
        coax("coax", "10G"),
        eth("lan1", "1G"),
    ],
    "sourceUrl": "https://www.netgear.com/images/datasheet/networking/cablemodems/cm1000v2.pdf",
    "notes": "Datasheet 'Physical Specifications': One (1) LAN Gigabit Ethernet port, One (1) WAN coaxial cable connection. NETGEAR's own footnote caps throughput at the 1G port even though DOCSIS 3.1 allows 10 Gbps DS.",
})

devices.append({
    "vendor": "netgear",
    "model": "CM2000",
    "label": "Nighthawk CM2000 2.5Gbps DOCSIS 3.1 cable modem",
    "category": "modem",
    "description": "Nighthawk DOCSIS 3.1 cable modem with 32x8 SC-QAM plus 2 OFDM / 2 OFDMA channels and a single 2.5GBASE-T LAN port.",
    "capabilities": ["l2-forward", "host", "dhcp-client", "http-server", "cli"],
    "interfaces": [
        coax("coax", "10G"),
        eth("lan1", "2.5G"),
    ],
    "sourceUrl": "https://www.netgear.com/images/datasheet/networking/cablemodems/cm2000.pdf",
    "notes": "Datasheet 'Standards': One (1) LAN 2.5Gbps Gigabit Ethernet port, One (1) WAN coaxial cable connection; 32 DS / 8 US SC-QAM + 2 OFDM + 2 OFDMA. Exactly one LAN port - no aggregation trick available.",
})

devices.append({
    "vendor": "netgear",
    "model": "CM3000",
    "label": "Nighthawk CM3000 mid/high-split DOCSIS 3.1 cable modem",
    "category": "modem",
    "description": "Mid/high-split DOCSIS 3.1 cable modem with 32 SC-QAM plus 2 OFDM downstream and 8 SC-QAM plus 2 OFDMA upstream channels, exposing one 2.5GBASE-T port and two aggregateable 1GBASE-T ports.",
    "capabilities": ["l2-forward", "host", "dhcp-client", "http-server", "cli"],
    "interfaces": [
        coax("coax", "10G"),
        eth("lan1", "2.5G"),
        eth("lan2", "1G"),
        eth("lan3", "1G"),
    ],
    "sourceUrl": "https://www.downloads.netgear.com/files/GDC/CM3000/CM3000_UM_EN.pdf",
    "notes": "User manual Table 5 'Technical specifications': Local one 2.5 Gbps RJ-45 port, Aggregate two 1 Gigabit RJ-45 ports, Internet coax DOCSIS 3.1; channels 2 OFDM + 32 SC-QAM DS, 2 OFDMA + 8 SC-QAM US. The two 1G ports bond for ~2 Gbps when the router supports LAG.",
})

devices.append({
    "vendor": "motorola",
    "model": "MB8600",
    "label": "MB8600 DOCSIS 3.1 cable modem, 4x GigE",
    "category": "modem",
    "description": "DOCSIS 3.1 cable modem with 32x8 DOCSIS 3.0 fallback plus DOCSIS 3.1 OFDM/OFDMA, and four gigabit LAN ports that can be link-aggregated for up to 3.8 Gbps of delivered throughput.",
    "capabilities": ["l2-forward", "host", "dhcp-client", "http-server", "cli"],
    "interfaces": [
        coax("coax", "10G"),
        eth("lan1", "1G"),
        eth("lan2", "1G"),
        eth("lan3", "1G"),
        eth("lan4", "1G"),
    ],
    "sourceUrl": "https://en-us.support.motorola.com/ci/fattach/get/68386861/1579624442/redirect/1/filename/MB8600-DataSheet-28317.pdf",
    "notes": "Datasheet: 'Four (4) 10/100/1000 Gigabit Ethernet LAN ports, with Auto-MDI/MDIX' and an F-type female 75 ohm service interface. Four ports exist because the modem is limited to 1 Gbps per port; 2-port bonding gives ~2 Gbps, 4-port ~3.8 Gbps.",
})

devices.append({
    "vendor": "motorola",
    "model": "MB8611",
    "label": "MB8611 DOCSIS 3.1 cable modem, 2.5G",
    "category": "modem",
    "description": "DOCSIS 3.1 cable modem with 32x8 DOCSIS 3.0 and DOCSIS 3.1 OFDM/OFDMA support, offering a single 2.5GBASE-T LAN port rated to 2,500 Mbps downstream.",
    "capabilities": ["l2-forward", "host", "dhcp-client", "http-server", "cli"],
    "interfaces": [
        coax("coax", "10G"),
        eth("lan1", "2.5G"),
    ],
    "sourceUrl": "https://en-us.support.motorola.com/app/answers/detail/a_id/176946/~/mb8611-technical-specifications",
    "notes": "Motorola support spec page: 'One 2.5 Gigabit Ethernet (GigE) LAN port (supports 10/100/1000/2500 Mbps)', downlink up to 2,500 Mbps / uplink up to 800 Mbps, SNMP v1/v2/v3 management.",
})

devices.append({
    "vendor": "technicolor",
    "model": "CGA4236",
    "label": "MARLIN L CGA4236 DOCSIS 3.1 cable gateway",
    "category": "modem",
    "description": "DOCSIS 3.1 / EuroDOCSIS 3.1 cable gateway with 32x8 bonded channels plus 2x2 OFDM(A), four GE LAN ports (one 2.5GBASE-T plus three gigabit), dual-band Wi-Fi 6, two FXS voice ports and a USB 3.1 port.",
    "capabilities": ["l2-forward", "l3-forward", "nat", "firewall", "dhcp-server",
                     "dhcp-client", "wireless", "http-server", "cli"],
    "interfaces": [
        coax("coax", "5G"),
        eth("lan1", "2.5G"),
        eth("lan2", "1G"),
        eth("lan3", "1G"),
        eth("lan4", "1G"),
        {"name": "fxs1", "type": "ethernet", "speed": "100M", "connector": "rj11"},
        {"name": "fxs2", "type": "ethernet", "speed": "100M", "connector": "rj11"},
        {"name": "usb1", "type": "usb"},
        {"name": "wlan1", "type": "wireless", "speed": "600M", "connector": "antenna"},
        {"name": "wlan2", "type": "wireless", "speed": "4.8G", "connector": "antenna"},
    ],
    "sourceUrl": "https://gditechnology.com/manuals/Technicolor_CGA4236_specs.pdf",
    "notes": "Spec sheet: '4 GE LAN ports (1 2.5 Gigabit Ethernet and 3 GE LAN ports optional)', 2x2 OFDM(A) D3.1 / 32x8 D3.0, 2 FXS, 1 USB 3.1 Gen 1, Wi-Fi 6 3x3 @2.4 GHz + 4x4 @5 GHz. Coax rated 5 Gbps DS (3.6 Gbps with 2 OFDM, up to 5 Gbps with 32 SC-QAM added). Unlike the pure modems above this one routes, NATs and serves DHCP, so it terminates the LAN.",
})

# --------------------------------------------------------------------------
# TASK B - CMTS / cable headend (6)
# --------------------------------------------------------------------------

e6000_if = []
# RSM-2 front panel: 2x 100G QSFP28 + 2x 10G SFP+; RPIC-2Q rear: 1x 100G + 8x 10G
for i in (1, 2):
    e6000_if.append(eth("nsi100g%d" % i, "100G", "qsfp28", speedCaps=[40000, 100000]))
e6000_if.append(eth("nsi100g3", "100G", "qsfp28", speedCaps=[40000, 100000]))
for i in (1, 2):
    e6000_if.append(eth("nsi10g%d" % i, "10G", "sfp+", speedCaps=[1000, 10000]))
for i in range(3, 11):
    e6000_if.append(eth("nsi10g%d" % i, "10G", "sfp+", speedCaps=[1000, 10000]))
# DCAM-2: 16 downstream RF ports per module (MCX via DPIC-2)
for i in range(1, 17):
    e6000_if.append(coax("ds%d" % i, "1G", "mcx"))
# UCAM-2: 24 upstream RF ports in 12 connector groups (MCX via UPIC)
for i in range(1, 25):
    e6000_if.append(coax("us%d" % i, "100M", "mcx"))
e6000_if.append(eth("mgmt", "1G"))
e6000_if.append({"name": "console", "type": "console", "connector": "rj45"})

devices.append({
    "vendor": "commscope",
    "model": "E6000",
    "label": "E6000 Converged Edge Router (Gen 2: RSM-2 + DCAM-2 + UCAM-2)",
    "category": "router",
    "description": "Integrated CCAP / CMTS chassis modelled with the Gen 2 module set: one RSM-2 plus RPIC-2Q giving 3x 100G QSFP28 and 10x 10G SFP+ network-side uplinks, one DCAM-2 with 16 downstream RF ports and one UCAM-2 with 24 upstream RF ports across 12 connector groups.",
    "capabilities": ["l3-forward", "dhcp-server", "dhcp-client", "http-server", "cli"],
    "interfaces": e6000_if,
    "sourceUrl": "https://katalog.vector.net/wp-content/uploads/import/ARRIS%20E6000%20Downstream%20Cable%20Access%20Module%202%20karta%20katalogowa.pdf",
    "notes": "Counted: DCAM-2 = '16 physical ports per slot' (MCX, requires DPIC-2); UCAM-2 = '24 physical ports organized into 12 connector groups', 288 SC-QAMs (12 per port) + 2x 96 MHz OFDMA per port; RSM-2 = 2x 100G QSFP28 + 2x 10G SFP+ on the front panel, RPIC-2Q adds 1x 100G QSFP28 + 8x 10G SFP+ (3x 100G / 10x 10G total per RSM pair), plus 100/1000BASE-T mgmt RJ-45 and an RJ-45 console. One downstream and one upstream module are modelled; the chassis holds many more CAM slots, so per-service-group port maths has to be scaled by the module count an operator fits.",
})

cbr_if = []
for i in range(1, 9):
    cbr_if.append(coax("ds%d" % i, "1G"))          # 8 DS ports on CBR-LC-8D31-16U31
for i in range(1, 17):
    cbr_if.append(coax("us%d" % i, "100M"))        # 16 US ports on the same line card
for i in (1, 2):
    cbr_if.append(eth("sup100g%d" % i, "100G", "qsfp28", speedCaps=[40000, 100000]))
for i in (1, 2):
    cbr_if.append(eth("sup-mgmt%d" % i, "1G"))
cbr_if.append({"name": "console", "type": "console", "connector": "rj45"})

devices.append({
    "vendor": "cisco",
    "model": "cBR-8",
    "label": "cBR-8 Converged Broadband Router (CCAP)",
    "category": "router",
    "description": "13 RU, 10-slot CCAP chassis (8 subscriber-side line-card slots, 2 supervisor slots) modelled with one CBR-LC-8D31-16U31 line card: 8 downstream and 16 upstream coax ports, plus a supervisor PIC carrying two 100G QSFP28 NSI uplinks and two RJ-45 GE management ports.",
    "capabilities": ["l3-forward", "dhcp-server", "dhcp-client", "http-server", "cli"],
    "interfaces": cbr_if,
    "sourceUrl": "https://www.cisco.com/c/en/us/products/collateral/video/cbr-8-converged-broadband-router/datasheet-c78-733099.pdf",
    "notes": "Datasheet Table 1: '13 RU and 10-slot chassis (8 subscriber side slots, 2 supervisor slots)', '64 service groups (56 SG with N+1) for ICCAP', '8DS ports X 16 US ports'; per line card 768 D3.0 QAMs plus 2 OFDM blocks per DS port and 96 US channels plus 2 OFDMA blocks per US port. Supervisor PIC = 'Two Integrated 1x100G NSI backhaul interfaces' + 'Two RJ45 GE network management ports'. One line card is modelled of 8 possible; a fully loaded chassis would be 64 DS / 128 US ports.",
})

c100_if = []
for i in range(1, 9):
    c100_if.append(coax("ds%d" % i, "1G"))         # RFD: 8 F-type DS ports per module
for i in range(1, 17):
    c100_if.append(coax("us%d" % i, "1G"))         # RFU 16-port variant: F-type
for i in range(1, 9):
    c100_if.append(eth("smm10g%d" % i, "10G", "sfp+", speedCaps=[1000, 10000]))
c100_if.append(eth("mgmt", "100M"))
c100_if.append({"name": "console", "type": "console", "connector": "rj45"})

devices.append({
    "vendor": "casa",
    "model": "C100G",
    "label": "C100G Converged Cable Access Platform (CCAP)",
    "category": "router",
    "description": "13 RU, 14-slot CCAP chassis (12 subscriber slots + 2 switch/management modules) modelled with one DS8x96 downstream module (8 F-type DS ports), one 16-port US upstream module and an SMM8x10G switch module providing eight 10G SFP+ uplinks.",
    "capabilities": ["l3-forward", "dhcp-server", "dhcp-client", "http-server", "cli"],
    "interfaces": c100_if,
    "sourceUrl": "https://www.alcadon.com/PDF/PDF2019/CASA22957.pdf",
    "notes": "Casa datasheet: '13 RU, 14 slot chassis (12 subscriber slots, 2 management modules)'; 'RF I/O Downstream Module (RFD): Number of ports 8 per module, Connector F-type, 75 ohm'; 'RF I/O Upstream Module (RFU): 16 or 32 ports per module - 16 port F-type, 32 port MCX'; SMM8x10G = eight 10GbE; mgmt = RS232 RJ45 + 10/100BASE-T. Capacity: 1,024 DS channels per DS card, 6,144 DS channels in a fully loaded chassis, up to 255 service groups with DAA.",
})

reef_if = []
for i in (1, 2):
    reef_if.append(coax("ds%d" % i, "1G"))          # 2 RPDs per line card, 1 DS each
for i in range(1, 5):
    reef_if.append(coax("us%d" % i, "100M"))        # 2 RPDs x 2 US each

devices.append({
    "vendor": "harmonic",
    "model": "CableOS Reef RPS",
    "label": "CableOS Reef Dense Remote PHY Shelf (1 line card modelled)",
    "category": "modem",
    "description": "2 RU passive Remote PHY shelf for Harmonic's CableOS virtualised CMTS, housing 9 hot-swap line cards each carrying two independent Pebble RPDs of 1DS x 2US; modelled here with a single line card, so 2 downstream and 4 upstream coax ports.",
    "capabilities": ["l2-forward", "cli"],
    "interfaces": reef_if,
    "sourceUrl": "https://amt.com/wp-content/uploads/2024/10/Harmonic_DS_Reef_Dense-R-PHY-Shelf.pdf",
    "notes": "Counted: '9 linecards per chassis, each with 2 RPDs' => 18 RPDs / 18 service groups; 'each with two independent Remote PHY devices of 1DSx2US ports' => 2 DS + 4 US per line card (18 DS / 36 US fully loaded). RPD spec: up to 158 SC-QAMs or 6x 192 MHz OFDM per RPD, 5-204 MHz US, 1218 MHz DS. A full shelf is modelled as one line card because only one card's worth of RF ports is needed to represent a service group pair; the RPD uplinks are Ethernet tunnels to the CableOS Core (software vCMTS on a 1-RU x86 server) and the datasheet publishes no connector count for them, so none are modelled.",
})

om_if = []
for i in range(1, 5):
    om_if.append(coax("fwd%d" % i, "1G"))           # 4x4 segmentation: 4 forward segments
for i in range(1, 5):
    om_if.append(coax("rtn%d" % i, "100M"))         # 4 return segments

devices.append({
    "vendor": "commscope",
    "model": "OM6000",
    "label": "Opti Max OM6000 1.2 GHz 4x4 HFC segmentable node",
    "category": "modem",
    "description": "1.2 GHz 4x4 segmentable HFC optical node that terminates the fibre node in a DOCSIS plant: four forward RF segment outputs and four return RF segment inputs, 10 application module slots in the lid for optics, EDFA, PON extension or a Remote PHY device.",
    "capabilities": ["l2-forward"],
    "interfaces": om_if,
    "sourceUrl": "https://digicomm.com/wp-content/uploads/2023/12/commscope_OM6000-Node-HFC_DS.pdf",
    "notes": "Counted: 4x4 switchable segmentation => 4 forward + 4 return RF segments; 'provisions for ten optics modules in the lid and four RF modules in the base', 10 application module slots + 2 SG4 auxiliary slots, 6 housing ports total, optical connector SC/APC, 54/85/102/258-1218 MHz DS with upstream to 204 MHz. The optical side is not modelled as a port because the lid modules are ordered separately (analog Rx/Tx, digital return SFP, or an RPD); this node is the RF boundary in the simulator, not an IP host.",
})

devices.append({
    "vendor": "hitron",
    "model": "CODA60",
    "label": "CODA60 DOCSIS 4.0 mid/high/ultra-high tri-split cable modem",
    "category": "modem",
    "description": "DOCSIS 4.0 cable modem with switchable mid (5-85 MHz), high (5-204 MHz) and ultra-high (5-396 MHz) upstream splits against a 1794 MHz downstream, supporting 5 configurable 192 MHz OFDM channels and 32 SC-QAM downstream, presented as a single 10GBASE-T LAN port.",
    "capabilities": ["l2-forward", "host", "dhcp-client", "http-server", "cli"],
    "interfaces": [
        coax("coax", "10G"),
        eth("lan1", "10G"),
    ],
    "sourceUrl": "https://us.hitrontech.com/wp-content/uploads/2024/08/DS-CODA60.pdf",
    "notes": "DOCSIS 4.0 reference point. Datasheet: '1x RF F-Type 75 ohm Female Connector, 1x RJ-45 10GBASE-T Ethernet Port'; D4.0 support for 5 OFDM channels up to 192 MHz and 7 OFDMA channels up to 96 MHz, 32 SC-QAM DS / 8 SC-QAM US bonded; tri-split 108-1794 / 258-1794 / 492-1794 MHz DS. Deploys in DOCSIS 3.1 mode first and upgrades in place.",
})

# --------------------------------------------------------------------------
# TASK C - xDSL (5)
# --------------------------------------------------------------------------

devices.append({
    "vendor": "draytek",
    "model": "Vigor166",
    "label": "Vigor166 G.fast & VDSL2 35b supervectoring modem",
    "category": "modem",
    "description": "G.fast (106/212 MHz, up to 1 Gbps) modem/router that falls back to VDSL2 profile 35b supervectoring and ADSL2+, with one RJ-11 DSL port and two gigabit Ethernet LAN ports.",
    "capabilities": ["l2-forward", "l3-forward", "nat", "firewall", "dhcp-server",
                     "dhcp-client", "http-server", "cli"],
    "interfaces": [
        dsl("dsl0", "1G"),
        eth("lan1", "1G"),
        eth("lan2", "1G"),
    ],
    "sourceUrl": "https://www.draytek.com/products/vigor166/",
    "notes": "Vendor page: '1x RJ-11 for G.fast/VDSL2 35b/ADSL2+' and '2x GbE RJ-45' LAN. G.fast gives 1 Gbps on short loops (hence 1G on the DSL side here); VDSL2 35b is capped at 300 Mbps and ADSL2+ at 24 Mbps. Bridgeable to a separate router, so it appears as both modem and (optionally) router.",
})

devices.append({
    "vendor": "draytek",
    "model": "Vigor167",
    "label": "Vigor167 VDSL2 35b supervectoring / ADSL2+ modem",
    "category": "modem",
    "description": "VDSL2 profile 35b supervectoring and ADSL2+ modem/router with a single RJ-11 DSL port, two gigabit Ethernet LAN ports and an SPI firewall.",
    "capabilities": ["l2-forward", "l3-forward", "nat", "firewall", "dhcp-server",
                     "dhcp-client", "http-server", "cli"],
    "interfaces": [
        dsl("dsl0", "100M"),
        eth("lan1", "1G"),
        eth("lan2", "1G"),
    ],
    "sourceUrl": "https://www.draytek.com/products/vigor167/",
    "notes": "Vendor spec table: 1x VDSL2 35b/ADSL2+ RJ-11 WAN, 2x GbE RJ-45 LAN, RJ-45 console, SNMP v2/v2c/v3, TR-069. VDSL2 35b tops out at 300 Mbps down, but the port class is the copper xDSL class - 100M is the conservative line rate; 35b vectoring is what lets it exceed it on short loops.",
})

devices.append({
    "vendor": "netgear",
    "model": "DM200",
    "label": "DM200 Broadband High-Speed VDSL/ADSL modem",
    "category": "modem",
    "description": "VDSL/VDSL2 and ADSL/ADSL2+ bridge modem with auto-detection for universal DSL, one RJ-11 DSL port and exactly one 10/100 Ethernet LAN port.",
    "capabilities": ["l2-forward", "l3-forward", "nat", "dhcp-server", "dhcp-client",
                     "http-server", "cli"],
    "interfaces": [
        dsl("dsl0", "100M"),
        eth("lan1", "100M"),
    ],
    "sourceUrl": "https://www.netgear.com/images/pdf/DM200_DS_01Apr16.pdf",
    "notes": "Datasheet 'Standards': 'One (1) LAN Ethernet RJ-45 port' and 'One (1) VDSL/ADSL RJ-11 port'. The datasheet omits the LAN rate; the user manual's LED table settles it - 'green for 100 Mbps and amber for 10 Mbps' - so it is a 10/100 port, not gigabit. Single LAN port means only one device or one router can hang off it.",
})

devices.append({
    "vendor": "tp-link",
    "model": "TD-W9970",
    "label": "TD-W9970 300Mbps Wireless N USB VDSL2 modem router",
    "category": "router",
    "description": "VDSL2/ADSL2+ modem router with a 2.4 GHz 802.11n access point, one RJ-11 DSL port, four 10/100 Ethernet LAN ports and a USB 2.0 port for storage or printer sharing.",
    "capabilities": ["l2-forward", "l3-forward", "nat", "firewall", "dhcp-server",
                     "dhcp-client", "wireless", "http-server", "cli"],
    "interfaces": [
        dsl("dsl0", "100M"),
        eth("lan1", "100M"),
        eth("lan2", "100M"),
        eth("lan3", "100M"),
        eth("lan4", "100M"),
        {"name": "usb1", "type": "usb"},
        {"name": "wlan1", "type": "wireless", "speed": "300M", "connector": "antenna"},
    ],
    "sourceUrl": "https://static.tp-link.com/res/down/doc/TD-W9970_V1_Datasheet.pdf",
    "notes": "Datasheet 'Interface': 4x 10/100Mbps RJ45 ports, 1 RJ11 port, 1 USB 2.0 port. VDSL2 per ITU-T G.993.2 with ADSL2+ fallback; 2x 5dBi fixed antennas, 802.11b/g/n only (2.4 GHz). Note the LAN side is Fast Ethernet, so this box cannot pass more than ~94 Mbps even on a fast VDSL2 line.",
})

ma_if = [dsl("vdsl%d" % i, "100M") for i in range(1, 257)]   # 4 x 64-port H80DVCPM
for i in range(1, 5):
    ma_if.append(eth("giu10g%d" % i, "10G", "sfp+", speedCaps=[1000, 10000]))
ma_if.append(eth("mgmt", "1G"))
ma_if.append({"name": "console", "type": "console", "connector": "rj45"})

devices.append({
    "vendor": "huawei",
    "model": "MA5600T",
    "label": "SmartAX MA5600T DSLAM/OLT (4x 64-port VDSL2 boards)",
    "category": "olt",
    "description": "10U copper/fibre access shelf used as a large-capacity DSLAM: 23 board slots (2 SCU control, 16 service, 2 GIU uplink), modelled here with four 64-port VDSL2 over POTS vectoring boards and four 10GE GIU uplinks.",
    "capabilities": ["l2-forward", "l3-forward", "dhcp-server", "dhcp-client",
                     "http-server", "cli"],
    "interfaces": ma_if,
    "sourceUrl": "https://www.router-switch.com/media/upload/product-pdf/huawei-smartax-ma5600t-datasheet.pdf",
    "notes": "Counted: MA5600T-ETSI/IEC subrack 'supports 23 board slots', 16 service slots, 2 SCU slots, 2 GIU slots; 'Maximum uplink port (GIU): 4*GE, 4*10GE'; 3.2 Tbit/s backplane. VDSL2 boards available: H805VDSF 24-port, H80BCVME 48-port VDSL2+POTS combo, H80DVCPM 64-port VDSL2 over POTS with vectoring (chosen here). Shelf maximum is 768 VDSL2 or 1024 ADSL2+ ports in a fully loaded subrack - this spec models 4 of the 16 service slots (256 VDSL2 lines) to keep the port list usable in a lab topology; scale board count for a full subrack.",
})

out = {"devices": devices}

path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "devices-docsis.json")
with open(path, "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=2)
    fh.write("\n")

print("wrote", path)
print("devices:", len(devices))
for d in devices:
    print(" %-11s %-22s %-9s ports=%d" % (d["vendor"], d["model"], d["category"], len(d["interfaces"])))
