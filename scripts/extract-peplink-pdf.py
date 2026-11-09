#!/usr/bin/env python3
"""Extract WAN/LAN port counts and throughput from Peplink datasheet PDFs.

Reuses every datasheet URL recorded during earlier harvest attempts, downloads each
PDF once, extracts text with pypdf, and pulls the spec rows that decide a deployment.
"""
import glob
import json
import os
import re
import sys
import urllib.request

try:
    from pypdf import PdfReader
except ImportError:
    PdfReader = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF_DIR = os.path.join(ROOT, "research", "pdf")

PATTERNS = {
    "max_wan_lan": r"Maximum Ethernet WAN\s*/\s*LAN port\s*([^\n]{0,45})",
    "wan_rows": r"Number of Ethernet WAN port\s*([^\n]{0,30})",
    "lan_rows": r"Number of Ethernet LAN port\s*([^\n]{0,30})",
    "throughput": r"Router Throughput\s*([0-9.]+\s*[MG]bps)",
    "wifi": r"Wi-?Fi AP\s*(Yes|No)",
    "poe_in": r"PoE Input\s*(Yes|No)",
    "sfp": r"SFP LAN\s*/\s*WAN\s*(Yes|No)",
    "ethernet_ports": r"(\d+\s*[x\u00d7]\s*(?:GE|2\.5G|10G)[^\n]{0,40})",
}


def collect_urls():
    urls = {}
    for path in glob.glob(os.path.join(ROOT, "research", "_pep*.json")):
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
                    urls[u] = node.get("title") or node.get("code") or os.path.basename(path)
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)
    return urls


def download(url):
    name = re.sub(r"[^A-Za-z0-9]+", "_", url.split("/")[-1])[:60] + ".pdf"
    path = os.path.join(PDF_DIR, name)
    if os.path.exists(path) and os.path.getsize(path) > 20000:
        return path
    if any(x in url for x in ("balance-310-fiber-5g", "hd2-ip67", "ap-one-ax")):
        pass
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = resp.read()
        if len(data) < 20000:
            return None
        open(path, "wb").write(data)
        return path
    except Exception:
        return None


def pdf_text(path):
    if PdfReader is None:
        return ""
    try:
        reader = PdfReader(path)
        return "\n".join((page.extract_text() or "") for page in reader.pages[:8])
    except Exception:
        return ""


def main():
    os.makedirs(PDF_DIR, exist_ok=True)
    urls = collect_urls()
    print(f"{len(urls)} datasheet URLs recorded", file=sys.stderr)
    rows = {}
    for url, title in urls.items():
        path = download(url)
        if not path:
            continue
        text = pdf_text(path)
        if len(text) < 200:
            continue
        got = {}
        for key, pat in PATTERNS.items():
            m = re.search(pat, text)
            if m:
                got[key] = " ".join(m.group(1).split())
        if not got:
            continue
        got["title"] = title
        got["url"] = url
        rows[os.path.basename(path)] = got
    json.dump(rows, open(os.path.join(ROOT, "research", "_pep_pdf_rows.json"), "w"), indent=1)
    for name, r in sorted(rows.items()):
        print(f"{name[:38]:40s} wan={r.get('wan_rows','-'):10s} lan={r.get('lan_rows','-'):10s} "
              f"thr={r.get('throughput','-'):9s} max={r.get('max_wan_lan','-')}  {r.get('title','')[:28]}")


if __name__ == "__main__":
    main()
