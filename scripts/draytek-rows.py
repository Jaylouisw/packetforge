#!/usr/bin/env python3
"""DrayTek datasheet row extractor.

Reads `research/_dray_urls.json` (request number -> candidate datasheet URLs), downloads
each PDF once into the gitignored `research/pdf/` cache, and prints the port lines.

DrayTek states ports in several shapes across its datasheet history:

    Fixed WAN Port: 1 x GbE RJ-45
    WAN: 2 x GbE
    LAN: 4 x GbE (Switch)
    LAN: 8-port 10/100/1000Base-T
    PoE: 8 x PoE+ (120 W)

so the extractor normalises a port line into `<count> x <speed>` and keeps the label, and
prints every line that mentions WAN, LAN, SFP, PoE or GbE next to the model, rather than
guessing at one canonical phrasing.

Usage:  python scripts/draytek-rows.py [--only 694,693] [--lines 3]
"""
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

SPEED = r"(?:10/100/1000/2500|10/100/1000|10/100|2\.5G|GbE|GE|2\.5GbE|Gigabit|Fast Ethernet)"
PORT_LINE = re.compile(
    r"((?:Fixed\s+)?(?:WAN|LAN|LAN/WAN|ETH|SFP|SFP\+|PoE)[A-Za-z0-9 /+\-]{0,24}?)"
    r"\s*:?\s*(\d+)\s*(?:x|-port\s*|\s+port[s]?\s+)?(" + SPEED + r"[A-Za-z0-9 /+\-]{0,18})",
    re.IGNORECASE,
)


def fetch(url):
    name = re.sub(r"[^A-Za-z0-9]+", "_", url.split("/")[-1])[:70] + ".pdf"
    path = os.path.join(PDF_DIR, name)
    if os.path.exists(path) and os.path.getsize(path) > 15000:
        return path
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; packetforge-research)"})
        with urllib.request.urlopen(req, timeout=45) as resp:
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
        return "\n".join((p.extract_text() or "") for p in PdfReader(path).pages[:10])
    except Exception:
        return ""


def main():
    only = None
    if "--only" in sys.argv:
        only = set(sys.argv[sys.argv.index("--only") + 1].split(","))
    want_lines = 3
    if "--lines" in sys.argv:
        want_lines = int(sys.argv[sys.argv.index("--lines") + 1])
    os.makedirs(PDF_DIR, exist_ok=True)
    data = json.load(open(os.path.join(ROOT, "research", "_dray_urls.json"), encoding="utf-8"))
    out = {}
    for num, rec in sorted(data.items(), key=lambda kv: -int(kv[0])):
        if only and str(num) not in only:
            continue
        rows = None
        for url in rec["urls"][:3]:
            path = fetch(url)
            if not path:
                continue
            text = text_of(path)
            if len(text) < 300:
                continue
            flat = " ".join(text.split())
            hits = []
            for m in PORT_LINE.finditer(flat):
                label = " ".join(m.group(1).split())[:26]
                speed = " ".join(m.group(3).split())[:22]
                hits.append(f"{label} = {m.group(2)}x{speed}")
            if not hits:
                continue
            rows = {"name": rec["name"], "hits": list(dict.fromkeys(hits))[:14], "source": url}
            break
        out[num] = rows or {"name": rec["name"], "hits": None}
        r = out[num]
        print(f"#{num} {rec['name'][:40]}")
        for h in (r["hits"] or ["  (no port lines extracted)"])[: want_lines + 6]:
            print("     ", h)
    json.dump(out, open(os.path.join(ROOT, "research", "_dray_rows.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
