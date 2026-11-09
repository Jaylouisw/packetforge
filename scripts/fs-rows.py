#!/usr/bin/env python3
"""FS.com datasheet port extractor.

FS publishes per-model datasheets as PDFs under `resource.fs.com/mall/resource/<model>-*.pdf`,
and the *product pages* render their spec table in JavaScript - which means a plain fetch of
`fs.com/products/<id>.html` returns images and no ports at all. The PDFs are the reliable source,
and this script reads their text layer.

The port rows survive `pdftotext -layout` intact but the label column is often lost, so this
prints the lines that mention a port rather than trying to parse a table:

    Button        1 x 10/100/1000Base-T RJ45 Ethernet port with auto-negotiation
                  1 x 2.5GE combo SFP port (10/100/1000Base-T electrical port)
                  1 x RJ45 console port (serial console port)

Usage:
  python scripts/fs-rows.py research/pdf/fs-ap-n505.pdf [more.pdf ...]
  python scripts/fs-rows.py --urls ap-n505,ap-t567          # try the URL patterns
"""
import os
import re
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF_DIR = os.path.join(ROOT, "research", "pdf")
UA = {"User-Agent": "Mozilla/5.0 (compatible; packetforge-research)"}

# Ordered by how often they hit. FS is not consistent about the filename suffix.
URL_PATTERNS = [
    "https://resource.fs.com/mall/resource/{s}-access-point-datasheet.pdf",
    "https://resource.fs.com/mall/resource/{s}-datasheet.pdf",
    "https://resource.fs.com/mall/resource/{s}-switch-datasheet.pdf",
    "https://resource.fs.com/mall/resource/{s}-ap-datasheet.pdf",
]

INTEREST = re.compile(
    r"(?:"
    r"\d+\s*x\s*(?:10/100/1000|1000Base-T|2\.5GE|2\.5G|10GE|25GE|100GE|400GE|GE|SFP\+?|QSFP\d*|RJ45)"
    r"|802\.3af|802\.3at|802\.3bt"
    r"|PoE\+?|max(?:imum)? power consumption"
    r")",
    re.IGNORECASE,
)


def fetch(slug):
    os.makedirs(PDF_DIR, exist_ok=True)
    path = os.path.join(PDF_DIR, "fs-%s.pdf" % slug)
    if os.path.exists(path) and os.path.getsize(path) > 20000:
        return path
    for pattern in URL_PATTERNS:
        url = pattern.format(s=slug)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as resp:
                blob = resp.read()
        except Exception:
            continue
        if blob[:4] != b"%PDF" or len(blob) < 20000:
            continue
        with open(path, "wb") as fh:
            fh.write(blob)
        return path
    return None


def lines_of(path):
    try:
        out = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, timeout=60)
        return out.stdout.decode("utf-8", "replace").split("\n")
    except Exception:
        return []


def main(argv):
    args = argv[1:]
    if not args:
        print(__doc__)
        return 1
    paths = []
    if args[0] == "--urls":
        for slug in args[1].split(","):
            slug = slug.strip().lower()
            p = fetch(slug)
            print("%-14s %s" % (slug, p or "no datasheet at the known URL patterns"))
            if p:
                paths.append(p)
    else:
        paths = args

    for path in paths:
        print("\n== %s" % os.path.basename(path))
        hits, seen = [], set()
        for line in lines_of(path):
            flat = " ".join(line.split())
            if len(flat) < 6 or not INTEREST.search(flat):
                continue
            if flat.lower() in seen:
                continue
            seen.add(flat.lower())
            hits.append(flat[:120])
        for h in hits[:14]:
            print("   " + h)
        if not hits:
            print("   (no port lines - the text layer may be empty; try pdftotext by hand)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
