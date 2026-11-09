#!/usr/bin/env python3
"""Teltonika datasheet row extractor.

Reads `research/_tel_urls.json` (request number -> candidate datasheet URLs), downloads
each PDF once into the gitignored `research/pdf/` cache, and prints the lines that decide
a deployment: Ethernet WAN/LAN port counts and speeds, SFP, PoE, Wi-Fi, mobile generation.

Teltonika states ports in prose inside a table, e.g.
    "WAN: 1 x WAN port (10/100/1000 Mbps)"
    "LAN: 3 x LAN ports (10/100/1000 Mbps)"
    "ETH: 1 x ETH port"
So the extractor looks for `<label>: <count> x <label> port (<speed>)` anywhere in the text,
plus a handful of capability flags.

Usage:  python scripts/teltonika-rows.py [--json out.json] [--only 441,440]
"""
import glob
import json
import os
import re
import sys
import urllib.request

try:
    from pypdf import PdfReader
except ImportError:  # pragma: no cover
    sys.exit("pypdf is required: python -m pip install pypdf")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF_DIR = os.path.join(ROOT, "research", "pdf")

PORT_RE = re.compile(
    r"\b(\d+)\s*[x\u00d7]\s*(WAN/LAN|WAN|LAN|ETH|SFP\+?)\s*ports?\s*,?\s*"
    r"((?:\d+/)*\d+\s*(?:Mbps|Gbps)|[^\n,;)]{0,28})",
    re.IGNORECASE,
)

# Teltonika writes port speed as a slash chain, "10/100/1000/2500 Mbps", meaning the port
# negotiates to any of those. The highest member is what it can actually deliver.
SPEED_CLASS = [
    (r"10000", "10G"),
    (r"2500|2\.5G", "2.5G"),
    (r"1000|1G", "1G"),
    (r"100", "100M"),
    (r"10", "10M"),
]


def speed_of(text):
    flat = text.strip()
    for pat, cls in SPEED_CLASS:
        if re.search(r"(?<![\d/])" + pat + r"(?![\d/])|(?<=/)" + pat + r"(?![\d/])", flat):
            return cls
    m = re.search(r"\b(\d+)\s*(?:Mbps|Gbps)", flat)
    if m:
        n = int(m.group(1))
        for limit, cls in ((10000, "10G"), (2500, "2.5G"), (1000, "1G"), (100, "100M")):
            if n >= limit:
                return cls
    return "?"
FLAGS = {
    "wifi": r"\b(Wi-?Fi|802\.11\s?[abgnacx]{1,3})\b",
    "poe_pse": r"PoE\s*(?:out|output|PSE|802\.3af|802\.3at)",
    "poe_pd": r"PoE\s*(?:in|input)",
    "mobile5g": r"\b(5G)\b",
    "mobile4g": r"\b(4G|LTE)\b",
    "cat": r"LTE\s*Cat\s*(\d+)",
    "modes": r"(\d+)\s*x\s*(?:SIM|SIM cards)",
    "serial": r"\b(RS232|RS485)\b",
    "din": r"\bDIN rail\b",
    "ip": r"\bIP(\d{2})\b",
}


def fetch(url):
    name = re.sub(r"[^A-Za-z0-9]+", "_", url.split("/")[-1])[:70] + ".pdf"
    path = os.path.join(PDF_DIR, name)
    if os.path.exists(path) and os.path.getsize(path) > 15000:
        return path
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; packetforge-research)"})
        with urllib.request.urlopen(req, timeout=40) as resp:
            blob = resp.read()
        if len(blob) < 15000:
            return None
        with open(path, "wb") as fh:
            fh.write(blob)
        return path
    except Exception:
        return None


def text_of(path):
    try:
        return "\n".join((p.extract_text() or "") for p in PdfReader(path).pages[:8])
    except Exception:
        return ""


def rows_of(text):
    flat = " ".join(text.split())
    ports = {}
    for m in PORT_RE.finditer(flat):
        count = int(m.group(1))
        label = m.group(2).upper().replace("SFP+", "SFP")
        speed = speed_of(m.group(3))
        ports.setdefault(label, []).append(f"{count}x{speed}")
    out = {"ports": ports}
    for key, pat in FLAGS.items():
        m = re.search(pat, flat, re.IGNORECASE)
        if m:
            out[key] = m.group(1) if m.groups() else True
    return out


def main():
    only = None
    if "--only" in sys.argv:
        only = set(sys.argv[sys.argv.index("--only") + 1].split(","))
    os.makedirs(PDF_DIR, exist_ok=True)
    src = os.path.join(ROOT, "research", "_tel_urls.json")
    data = json.load(open(src, encoding="utf-8"))
    results = {}
    for num, rec in sorted(data.items(), key=lambda kv: int(kv[0])):
        if only and str(num) not in only:
            continue
        hit = None
        for url in rec["urls"][:3]:
            path = fetch(url)
            if not path:
                continue
            rows = rows_of(text_of(path))
            if not rows["ports"]:
                continue
            rows["name"] = rec["name"]
            rows["source"] = url
            hit = rows
            break
        results[num] = hit or {"name": rec["name"], "ports": None}
        r = results[num]
        ports = r.get("ports")
        desc = " ".join(f"{k}={','.join(v)}" for k, v in (ports or {}).items()) or "PORTS?"
        flags = " ".join(k for k in ("wifi", "poe_pse", "poe_pd", "mobile5g", "serial", "din") if r.get(k))
        ip = f"IP{r['ip']}" if r.get("ip") else ""
        cat = f"cat{r['cat']}" if r.get("cat") else ""
        print(f"#{num:<4} {rec['name'][:26]:28s} {desc[:70]:72s} {flags} {cat} {ip}")
    json.dump(results, open(os.path.join(ROOT, "research", "_tel_rows.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
