#!/usr/bin/env python3
"""Netgear datasheet port/PoE extractor.

Reads `research/_ng_urls.json` (model -> candidate datasheet URLs), downloads each PDF once
into the gitignored `research/pdf/` cache, and prints every line that states ports or power.

Netgear writes it in prose and tables both ways:

    "5 Gigabit Ethernet ports"
    "24x Gigabit ports, 2x SFP"
    "PoE+ power budget: 190W"
    "8 PoE+ ports"

so the extractor prints the lines rather than guessing a schema, and the caller decides.

Usage:  python scripts/netgear-rows.py [--only GS724TP,JGS516PE]
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

INTEREST = re.compile(
    r"(?:"
    r"\d+\s*x?\s*(?:gigabit|10/100/1000|1g|gbe|sfp)[a-z0-9 +/.,\-]{0,40}"
    r"|sfp\+?[a-z0-9 +/.,\-]{0,30}"
    r"|poe\+?[a-z0-9 +/.,%\-]{0,40}"
    r"|power budget[a-z0-9 +/.,\-]{0,30}"
    r"|budget[a-z0-9 +/.,\-]{0,24}\d+\s*w"
    r")",
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
        return "\n".join((p.extract_text() or "") for p in PdfReader(path).pages[:12])
    except Exception:
        return ""


def main():
    only = None
    if "--only" in sys.argv:
        only = set(sys.argv[sys.argv.index("--only") + 1].split(","))
    os.makedirs(PDF_DIR, exist_ok=True)
    data = json.load(open(os.path.join(ROOT, "research", "_ng_urls.json"), encoding="utf-8"))
    out = {}
    for model, urls in data.items():
        if only and model not in only:
            continue
        lines = None
        used = None
        for url in urls[:2]:
            path = fetch(url)
            if not path:
                continue
            text = text_of(path)
            if len(text) < 300:
                continue
            flat = " ".join(text.split())
            hits = []
            for m in INTEREST.finditer(flat):
                s = " ".join(m.group(0).split())
                if len(s) < 8:
                    continue
                if s.lower() not in [h.lower() for h in hits]:
                    hits.append(s)
            if not hits:
                continue
            lines = hits[:16]
            used = os.path.basename(path)
            break
        out[model] = {"lines": lines, "file": used}
        print(f"== {model}")
        for h in (lines or ["   (nothing extracted)"]):
            print("    ", h[:110])
    json.dump(out, open(os.path.join(ROOT, "research", "_ng_rows.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
