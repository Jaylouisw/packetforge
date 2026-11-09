#!/usr/bin/env python3
"""Peplink datasheet row extractor.

Consumes `research/_pep_urls2.json` (candidate datasheet URLs per request) plus any
URL already recorded in `research/_pep*.json`, downloads each PDF once into
`research/pdf/` (gitignored), reads the text layer, and prints the spec rows that
decide a deployment: WAN/LAN port counts, router throughput, SpeedFusion throughput,
Wi-Fi, PoE, SFP.

Usage:  python scripts/peplink-rows.py [--json out.json]
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

ROW_PATTERNS = {
    "wan": r"Number of Ethernet WAN port\s*([^\n]{0,32})",
    "lan": r"Number of Ethernet LAN port\s*([^\n]{0,32})",
    "summary": r"Maximum Ethernet WAN\s*/\s*LAN port\s*([^\n]{0,45})",
    "throughput": r"Router Throughput\s*([0-9.]+\s*[MG]bps)",
    "speedfusion": r"SpeedFusion VPN Throughput \(No Encryption\)\s*([0-9.]+\s*[MG]bps)",
    "speedfusion_aes": r"SpeedFusion VPN Throughput \(256-bit AES\)\s*([0-9.]+\s*[MG]bps)",
    "wifi": r"Wi-?Fi AP\s*(Yes|No)",
    "poe_in": r"PoE Input\s*(Yes|No)",
    "sfp": r"SFP LAN\s*/\s*WAN\s*(Yes|No)",
    "eth_generic": r"(\d+\s*[x\u00d7]\s*(?:GE|2\.5G|10G|FE)[^\n]{0,45})",
    "poe_ports": r"(\d+\s*[x\u00d7]\s*100/1000M Ethernet LAN with 802\.3at PoE Output[^\n]{0,20})",
    "wan_ports_raw": r"(\d+\s*[x\u00d7]\s*100/1000M\s*\n?\s*Ethernet WAN)",
}


def candidate_urls():
    """Request number -> list of candidate PDF URLs, newest first."""
    out = {}
    path = os.path.join(ROOT, "research", "_pep_urls2.json")
    if os.path.exists(path):
        data = json.load(open(path, encoding="utf-8"))
        for num, rec in data.items():
            out.setdefault(str(num), {"name": rec.get("name", ""), "urls": []})
            for u in rec.get("urls", []):
                if u not in out[str(num)]["urls"]:
                    out[str(num)]["urls"].append(u)
    for path in glob.glob(os.path.join(ROOT, "research", "_pep*.json")):
        if os.path.basename(path) in ("_pep_urls2.json",):
            continue
        try:
            data = json.load(open(path, encoding="utf-8"))
        except Exception:
            continue
        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                u = node.get("url")
                if isinstance(u, str) and u.lower().endswith(".pdf"):
                    key = "misc"
                    out.setdefault(key, {"name": "recorded earlier", "urls": []})
                    if u not in out[key]["urls"]:
                        out[key]["urls"].append(u)
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)
    return out


def fetch(url):
    name = re.sub(r"[^A-Za-z0-9]+", "_", url.split("/")[-1])[:70] + ".pdf"
    path = os.path.join(PDF_DIR, name)
    if os.path.exists(path) and os.path.getsize(path) > 20000:
        return path
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; packetforge-research)"})
        with urllib.request.urlopen(req, timeout=40) as resp:
            blob = resp.read()
        if len(blob) < 20000:
            return None
        with open(path, "wb") as fh:
            fh.write(blob)
        return path
    except Exception:
        return None


def text_of(path):
    try:
        reader = PdfReader(path)
    except Exception:
        return ""
    return "\n".join((page.extract_text() or "") for page in reader.pages[:8])


def rows_of(text):
    got = {}
    for key, pat in ROW_PATTERNS.items():
        m = re.search(pat, text)
        if m:
            got[key] = " ".join(m.group(1).split())
    return got


def main():
    as_json = "--json" in sys.argv
    os.makedirs(PDF_DIR, exist_ok=True)
    results = {}
    for num, rec in candidate_urls().items():
        best = None
        for url in rec["urls"][:3]:
            path = fetch(url)
            if not path:
                continue
            text = text_of(path)
            if len(text) < 300:
                continue
            rows = rows_of(text)
            if not rows:
                continue
            rows["source"] = url
            rows["file"] = os.path.basename(path)
            best = rows
            # prefer a hit that produced real port rows
            if ("wan" in rows) or ("lan" in rows) or ("eth_generic" in rows):
                break
        if best:
            results[num] = {"name": rec["name"], **best}
    if as_json:
        print(json.dumps(results, indent=1))
        return
    for num, r in sorted(results.items(), key=lambda kv: str(kv[0])):
        print(f"#{num:<5s} {r['name'][:22]:24s} wan={str(r.get('wan','-'))[:22]:24s} lan={str(r.get('lan','-'))[:22]:24s} "
              f"thr={str(r.get('throughput','-')):9s} sf={str(r.get('speedfusion','-')):9s} "
              f"aes={str(r.get('speedfusion_aes','-')):9s} wifi={str(r.get('wifi','-')):3s} poe={str(r.get('poe_in','-')):3s} "
              f"| {r.get('eth_generic','')[:34]}")
    json.dump(results, open(os.path.join(ROOT, "research", "_pep_rows2.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
