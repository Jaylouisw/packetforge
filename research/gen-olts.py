import json

HW = "https://e.huawei.com/hk/products/optical-access/ma5800"
NOK = "https://onestore.nokia.com/asset/i/185352"
CAL = "https://www.calix.com/products/platform/intelligent-access/systems/axos-e9-2.html"
ADT = "https://www.adtran.com/en/products-and-services/sdx-6000-series"
UI8 = "https://store.ui.com/us/en/products/uf-olt"
UI4 = "https://store.ui.com/us/en/products/uf-olt-4"
ZT320 = "https://fiberm.pl/zasoby/import/z/zxa10_c320_product_introduction-@0000000834.pdf"
ZT300 = "http://ztegpon.cz/pdf/ZXA10_C300_Product_Introduction.pdf"
FH = "https://www.thunder-link.com/tl-content/uploads/2026/07/Fiberhome-AN5516-01-OLT-Carrier-Grade-Routing-Solution-Brief-Deploying-High-Density-Optical-Aggregation.pdf"
HW5608 = "https://www.thunder-link.com/huawei-ma5608t_p565.html"

CARRIER_CAPS = ["l2-forward", "l3-forward", "cli", "dhcp-server", "dhcp-client"]
OLT_CAPS = ["l2-forward", "l3-forward", "cli", "dhcp-server"]

def pon(count, prefix, speed="2.5G", caps=(1244, 2488)):
    return {"prefix": prefix, "start": 1, "count": count, "type": "pon",
            "speed": speed, "connector": "sc-apc", "speedCaps": list(caps)}

def uplinks(n, prefix="xge0/", speed="10G", connector="sfp+", caps=(1000, 10000), start=1):
    return [{"name": "%s%d" % (prefix, i), "type": "ethernet", "speed": speed,
             "connector": connector, "speedCaps": list(caps)} for i in range(start, start + n)]

def mgmt(name="mgmt0", speed="1G"):
    return {"name": name, "type": "ethernet", "speed": speed}

devices = []

# 1 - Huawei MA5800-X7 ------------------------------------------------------
devices.append({
    "vendor": "huawei",
    "model": "MA5800-X7",
    "label": "MA5800-X7 OLT",
    "category": "olt",
    "description": ("Huawei SmartAX MA5800-X7 next-generation OLT, 6U chassis with 7 service slots "
                    "(slots 1-7), 2 control-board slots (8-9) and a universal slot 0; scales to 112 GPON "
                    "or 56 XGS-PON ports. This spec models one fully populated slot: a 16-port H901GPHF "
                    "GPON card (gpon1/1-16) plus the 4x 10GE SFP+ uplinks carried on a single MPLA control "
                    "board and 1 ETH management port = 21 ports. MPLG/MPLH control boards add 2x/4x 100GE."),
    "capabilities": CARRIER_CAPS,
    "portTemplate": pon(16, "gpon1/"),
    "interfaces": uplinks(4) + [mgmt()],
    "sourceUrl": HW,
})

# 2 - Huawei MA5800-X2 ------------------------------------------------------
devices.append({
    "vendor": "huawei",
    "model": "MA5800-X2",
    "label": "MA5800-X2 OLT",
    "category": "olt",
    "description": ("Huawei SmartAX MA5800-X2 compact OLT, 1U DC/AC chassis with 2 service slots and 2 "
                    "control-board slots (MPSA/MPSG/MPSD), max 32 GPON ports. This spec models one 16-port "
                    "H901GPHF GPON card (gpon1/1-16) + 4x 10GE/GE SFP+ uplinks on the MPSA control board + "
                    "1 ETH management port = 21 ports."),
    "capabilities": CARRIER_CAPS,
    "portTemplate": pon(16, "gpon1/"),
    "interfaces": uplinks(4) + [mgmt()],
    "sourceUrl": HW,
})

# 3 - Huawei MA5608T -------------------------------------------------------
devices.append({
    "vendor": "huawei",
    "model": "MA5608T",
    "label": "MA5608T OLT",
    "category": "olt",
    "description": ("Huawei SmartAX MA5608T mini OLT, 2U chassis with 2 service slots and 2 control-board "
                    "slots, max 32 GPON ports (2x 16-port GPFD). This spec models a GPBD 8-port GPON card "
                    "(gpon1/1-8) + an MCUD1 control board providing 2x GE SFP and 2x 10GE SFP+ uplinks + "
                    "1 ETH management port = 13 ports."),
    "capabilities": CARRIER_CAPS,
    "portTemplate": pon(8, "gpon1/"),
    "interfaces": [
        {"name": "ge0/1", "type": "ethernet", "speed": "1G", "connector": "sfp", "speedCaps": [1000]},
        {"name": "ge0/2", "type": "ethernet", "speed": "1G", "connector": "sfp", "speedCaps": [1000]},
        {"name": "xge0/1", "type": "ethernet", "speed": "10G", "connector": "sfp+", "speedCaps": [1000, 10000]},
        {"name": "xge0/2", "type": "ethernet", "speed": "10G", "connector": "sfp+", "speedCaps": [1000, 10000]},
        mgmt(),
    ],
    "sourceUrl": HW5608,
})

# 4 - ZTE ZXA10 C320 -------------------------------------------------------
devices.append({
    "vendor": "zte",
    "model": "ZXA10 C320",
    "label": "ZXA10 C320 OLT",
    "category": "olt",
    "description": ("ZTE ZXA10 C320 compact OLT, 2U 19-inch chassis with 2 service-card slots and 2 "
                    "main-control switching slots (SMXA, GPON/P2P/XG-PON1). This spec models one GTGH "
                    "16-port GPON card in service slot 2 (gpon2/1-16) + 2x 10GE SFP+ uplinks (one per SMXA "
                    "when both control cards are fitted) + 1 out-of-band management FE port = 19 ports."),
    "capabilities": CARRIER_CAPS,
    "portTemplate": pon(16, "gpon2/"),
    "interfaces": uplinks(2, prefix="xge2/") + [mgmt("mgmt0", "100M")],
    "sourceUrl": ZT320,
})

# 5 - ZTE ZXA10 C300 -------------------------------------------------------
devices.append({
    "vendor": "zte",
    "model": "ZXA10 C300",
    "label": "ZXA10 C300 OLT",
    "category": "olt",
    "description": ("ZTE ZXA10 C300 carrier OLT, 10U vertical-slot chassis: 14 service slots in the "
                    "19-inch (21-slot) shelf, 16 in the 21-inch (23-slot) shelf, 2 control/switch slots "
                    "(SCXN 480G or SCTM 2.56T) and 2 uplink-card slots, up to 16384 GPON users. This spec "
                    "models one GTGH 16-port GPON card (gpon2/1-16) + one XUTQ 4x 10GE SFP+ uplink card + "
                    "1 out-of-band management port = 21 ports."),
    "capabilities": CARRIER_CAPS,
    "portTemplate": pon(16, "gpon2/"),
    "interfaces": uplinks(4, prefix="xge19/") + [mgmt("mgmt0", "100M")],
    "sourceUrl": ZT300,
})

# 6 - Nokia 7360 ISAM FX-8 -------------------------------------------------
devices.append({
    "vendor": "nokia",
    "model": "7360 ISAM FX-8",
    "label": "7360 ISAM FX-8 OLT",
    "category": "olt",
    "description": ("Nokia 7360 ISAM FX-8 access node/OLT, 8RU shelf with 8 line-termination (LT) slots and "
                    "2 NT controller slots on a 2x 100G/slot backplane; 128 GPON ports at 16 ports/slot. "
                    "This spec models one 16-port GPON LT card in slot 1 (1/1/1-16) + the four configurable "
                    "10G/1G SFP+ network links on the FANT-F controller = 20 ports. No dedicated management "
                    "port; management is in-band via 5520 AMS."),
    "capabilities": OLT_CAPS,
    "portTemplate": pon(16, "1/1/"),
    "interfaces": uplinks(4, prefix="1/9/"),
    "sourceUrl": NOK,
})

# 7 - Nokia 7360 ISAM FX-16 ------------------------------------------------
devices.append({
    "vendor": "nokia",
    "model": "7360 ISAM FX-16",
    "label": "7360 ISAM FX-16 OLT",
    "category": "olt",
    "description": ("Nokia 7360 ISAM FX-16 large access node/OLT, ~14RU shelf with 16 LT slots, 256 GPON "
                    "ports per shelf (16 ports x 16 slots), 10 Tb/s system capacity. This spec models one "
                    "16-port GPON LT card in slot 1 (1/1/1-16) + 4x 10G/1G SFP+ links on the FANT-F "
                    "controller + the optional FNIO-A NTIO card adding 8x 10G/1G SFP+ = 28 ports."),
    "capabilities": OLT_CAPS,
    "portTemplate": pon(16, "1/1/"),
    "interfaces": uplinks(4, prefix="1/17/") + uplinks(8, prefix="1/18/"),
    "sourceUrl": NOK,
})

# 8 - Calix E9-2 -----------------------------------------------------------
devices.append({
    "vendor": "calix",
    "model": "E9-2",
    "label": "AXOS E9-2 Intelligent Access Appliance",
    "category": "olt",
    "description": ("Calix AXOS E9-2 modular access appliance/OLT that scales to 16 PON line cards in one "
                    "managed system. This spec models one GP1612 line card in slot 1: 16 SFP GPON ports "
                    "(gpon1/1-16) + its 2x QSFP-28 40/100G uplinks = 18 ports. The CLX3001 control card "
                    "separately adds 2x QSFP-28, 8x SFP+ and 2x SFP for aggregation."),
    "capabilities": OLT_CAPS,
    "portTemplate": pon(16, "gpon1/"),
    "interfaces": [
        {"name": "qsfp1/1", "type": "ethernet", "speed": "100G", "connector": "qsfp28", "speedCaps": [40000, 100000]},
        {"name": "qsfp1/2", "type": "ethernet", "speed": "100G", "connector": "qsfp28", "speedCaps": [40000, 100000]},
    ],
    "sourceUrl": CAL,
})

# 9 - Adtran SDX 6320 ------------------------------------------------------
devices.append({
    "vendor": "adtran",
    "model": "SDX 6320",
    "label": "SDX 6320 10G Combo PON OLT",
    "category": "olt",
    "description": ("Adtran SDX 6320-16 disaggregated 10G Combo PON OLT, 1.5RU fixed-configuration box "
                    "(no card slots): 16 combo PON ports that carry GPON and XGS-PON simultaneously, "
                    "4x 100GbE QSFP28 and 4x 10GbE SFP+ uplinks, 1 out-of-band management port = 25 ports."),
    "capabilities": OLT_CAPS,
    "portTemplate": pon(16, "pon", speed="10G", caps=(2488, 9953)),
    "interfaces": (
        [{"name": "qsfp1/%d" % i, "type": "ethernet", "speed": "100G", "connector": "qsfp28",
          "speedCaps": [40000, 100000]} for i in range(1, 5)]
        + uplinks(4, prefix="xge1/")
        + [mgmt("mgmt0")]
    ),
    "sourceUrl": ADT,
})

# 10 - Ubiquiti UF-OLT -----------------------------------------------------
devices.append({
    "vendor": "ubiquiti",
    "model": "UF-OLT",
    "label": "UFiber OLT 8",
    "category": "olt",
    "description": ("Ubiquiti UFiber UF-OLT GPON OLT, 1U fixed box (no card slots): 8 GPON SFP ports (2.488G "
                    "down / 1.244G up, 128 ONUs per port, 1024 clients), 2x 10G SFP+ uplinks, 1 Ethernet "
                    "out-of-band management port and 1 in-band Ethernet port = 12 ports. Layer-2 GPON core "
                    "with 4062 VLANs."),
    "capabilities": ["l2-forward", "cli", "dhcp-server"],
    "portTemplate": pon(8, "gpon"),
    "interfaces": uplinks(2, prefix="sfp+") + [mgmt("mgmt0"), mgmt("eth0")],
    "sourceUrl": UI8,
})

# 11 - Ubiquiti UF-OLT-4 ---------------------------------------------------
devices.append({
    "vendor": "ubiquiti",
    "model": "UF-OLT-4",
    "label": "UFiber OLT 4",
    "category": "olt",
    "description": ("Ubiquiti UFiber UF-OLT-4 compact GPON OLT: 4 GPON SFP ports (128 ONUs each, 512 clients), "
                    "1x 10G SFP+ uplink and 1 Ethernet out-of-band management port = 6 ports. Fanless 1U "
                    "half-width Layer-2 PON headend for small FTTH builds."),
    "capabilities": ["l2-forward", "cli", "dhcp-server"],
    "portTemplate": pon(4, "gpon"),
    "interfaces": uplinks(1, prefix="sfp+") + [mgmt("mgmt0")],
    "sourceUrl": UI4,
})

# 12 - Fiberhome AN5516-01 -------------------------------------------------
devices.append({
    "vendor": "fiberhome",
    "model": "AN5516-01",
    "label": "AN5516-01 OLT",
    "category": "olt",
    "description": ("Fiberhome AN5516-01 large-capacity OLT, 11U 19-inch chassis with 16 service slots and "
                    "a 3.2 Tbit/s backplane, up to 256 GPON ports. This spec models one GCOB 16-port GPON "
                    "card (gpon1/1-16) plus one HU2A uplink card: 2x 10GE SFP+ and 2 combo GE optical/"
                    "electrical positions (each counted as an RJ45 + SFP pair) = 22 ports."),
    "capabilities": OLT_CAPS,
    "portTemplate": pon(16, "gpon1/"),
    "interfaces": [
        {"name": "xge1/1", "type": "ethernet", "speed": "10G", "connector": "sfp+", "speedCaps": [1000, 10000]},
        {"name": "xge1/2", "type": "ethernet", "speed": "10G", "connector": "sfp+", "speedCaps": [1000, 10000]},
        {"name": "ge1/1", "type": "ethernet", "speed": "1G", "comboWith": "ge1/1-sfp", "comboRole": "rj45"},
        {"name": "ge1/1-sfp", "type": "ethernet", "speed": "1G", "connector": "sfp", "speedCaps": [1000],
         "comboWith": "ge1/1", "comboRole": "sfp"},
        {"name": "ge1/2", "type": "ethernet", "speed": "1G", "comboWith": "ge1/2-sfp", "comboRole": "rj45"},
        {"name": "ge1/2-sfp", "type": "ethernet", "speed": "1G", "connector": "sfp", "speedCaps": [1000],
         "comboWith": "ge1/2", "comboRole": "sfp"},
    ],
    "sourceUrl": FH,
})

path = r"C:\Users\jay\packetforge\research\incoming\devices-olts.json"
with open(path, "w", encoding="utf-8") as f:
    json.dump(devices, f, indent=2)
    f.write("\n")

# ---- self validation ------------------------------------------------------
ALLOWED_CAT = {"router","switch","l3-switch","firewall","ont","olt","modem","powerline","nas","desktop",
               "laptop","phone","tablet","printer","camera","nvr","iot","server","wireless","ptp","cloud"}
ALLOWED_CAP = {"cli","dhcp-client","dhcp-server","firewall","host","http-server","l2-forward","l3-forward",
               "nat","wireless"}
ALLOWED_SPEED = {"100M","1G","2.5G","5G","10G","25G","40G","100G"}
ALLOWED_CONN = {"sfp","sfp+","sfp28","qsfp+","qsfp28","sc-apc","sc-upc"}

data = json.load(open(path, encoding="utf-8"))
print("devices:", len(data))
print("%-22s %-18s %5s %5s %5s  %s" % ("vendor","model","pon","intf","total","src"))
for d in data:
    assert d["category"] in ALLOWED_CAT, d["model"]
    assert set(d["capabilities"]) <= ALLOWED_CAP, (d["model"], d["capabilities"])
    assert d["vendor"] == d["vendor"].lower()
    assert d["sourceUrl"].startswith("http")
    pt = d.get("portTemplate")
    pon_n = pt["count"] if pt else 0
    for it in d["interfaces"]:
        assert it["speed"] in ALLOWED_SPEED, it
        if "connector" in it:
            assert it["connector"] in ALLOWED_CONN, it
    total = pon_n + len(d["interfaces"])
    assert str(total) in d["description"], (d["model"], total)
    print("%-22s %-18s %5d %5d %5d  %s" % (d["vendor"], d["model"], pon_n, len(d["interfaces"]),
                                          total, d["sourceUrl"][:40]))
print("OK")
