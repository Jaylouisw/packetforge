#!/usr/bin/env node
/**
 * Ask Ubiquiti's firmware index whether a hardware platform exists - mechanically.
 *
 * Two requests are blocked because the SKU may not exist at all (#130 UDW-PRO, and every "is there a
 * Pro variant?" follow-up on it). Every pass on that thread argued the question from marketing pages,
 * which is the wrong instrument: a product page is written by a copywriter and can lag or vanish, but
 * `fw-update.ui.com` is the machine-readable index the update daemon on the device itself polls. It is
 * keyed by *platform code*, the same code that names the firmware binary (`2d04-UDW-6.0.17-...bin`),
 * and Ubiquiti gives Pro variants their own code rather than sharing the parent's - `UDMPRO`,
 * `UDMPROSE`, `UDMPROMAX` and `UXMAX` all sit in the same index as `UDM` and `UX`. So a platform code
 * that is absent is absent the way a model number is absent, and a wildcard miss cannot hide a product
 * whose firmware would have to name itself.
 *
 * The filter is `eq` on `platform` and is case-insensitive (`udw` matches `UDW`). One thing to keep
 * straight while reading results: the endpoint pages at 25 records by default, so an answer without
 * `limit=1000` undercounts every platform with a long release history - `UDW` reads 25 instead of 27.
 *
 * Usage:
 *   node scripts/ubiquiti-firmware-index.js --platform udw
 *   node scripts/ubiquiti-firmware-index.js --family UDWPRO,UDW-PRO,UDW2      # batch, for spellings
 *   node scripts/ubiquiti-firmware-index.js --product unifi-dream             # platform census
 *   node scripts/ubiquiti-firmware-index.js --platform udw --json
 *
 * Exit code is 0 when every query answered, 1 when a request failed - a count of zero is an answer,
 * not an error, and is reported as `present: false`.
 *
 * Zero dependencies, like the rest of scripts/.
 *
 * See research/ubiquiti-firmware-platform-census.md for the census this produced on 2026-11-19.
 */
'use strict';

const https = require('https');

const API = 'https://fw-update.ubnt.com/api/firmware';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX = 1000;

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${res.statusCode} ${url}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`unparseable JSON from ${url}`)); }
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error(`timeout ${url}`)));
    req.on('error', reject);
  });
}

// The API ignores an unknown filter value and answers an empty envelope, so "absent" and "empty" look
// identical at the HTTP layer - which is exactly why the nonsense control matters and why this returns
// a structured present/absent rather than a bare number.
async function byPlatform(code) {
  const url = `${API}?limit=${MAX}&filter=${encodeURIComponent('eq~~platform~~' + code)}`;
  const doc = await fetchJson(url);
  const fw = (doc._embedded && doc._embedded.firmware) || [];
  // Sort records, not two parallel arrays: `latest` and `latest_version` must describe the same release,
  // or the note quotes a version that is three years older than the date printed beside it.
  const sorted = fw.slice().sort((a, b) => String(a.created).localeCompare(String(b.created)));
  const newest = sorted[sorted.length - 1];
  return {
    query: code,
    url,
    present: fw.length > 0,
    releases: fw.length,
    first: newest ? sorted[0].created : null,
    latest: newest ? newest.created : null,
    latest_version: newest ? newest.version : null,
    platforms: [...new Set(fw.map((f) => f.platform))],
    products: [...new Set(fw.map((f) => f.product))],
  };
}

async function byProduct(code) {
  const url = `${API}?limit=${MAX}&filter=${encodeURIComponent('eq~~product~~' + code)}`;
  const doc = await fetchJson(url);
  const fw = (doc._embedded && doc._embedded.firmware) || [];
  const counts = {};
  for (const f of fw) counts[f.platform] = (counts[f.platform] || 0) + 1;
  const platforms = Object.keys(counts).sort().map((p) => ({ platform: p, releases: counts[p] }));
  return { query: code, url, releases: fw.length, platforms };
}

function renderPlatform(r) {
  if (!r.present) {
    console.log(`${r.query}: absent - 0 releases (${r.url})`);
    return;
  }
  console.log(`${r.query}: ${r.releases} releases, ${r.first.slice(0, 10)} -> ${r.latest.slice(0, 10)}, latest ${r.latest_version}`);
  console.log(`  platform codes: ${r.platforms.join(', ')}   products: ${r.products.join(', ')}`);
  console.log(`  ${r.url}`);
}

(async () => {
  const asJson = process.argv.includes('--json');
  const platform = arg('platform');
  const family = arg('family');
  const product = arg('product');

  if (!platform && !family && !product) {
    console.log('usage: node scripts/ubiquiti-firmware-index.js --platform <code> | --family <a,b,c> | --product <code> [--json]');
    process.exit(2);
  }

  let failed = false;
  const out = {};

  if (platform) {
    try {
      out.platform = await byPlatform(platform);
      if (!asJson) renderPlatform(out.platform);
    } catch (e) { failed = true; console.error(`${platform}: ${e.message}`); }
  }

  if (family) {
    const codes = String(family).split(',').map((s) => s.trim()).filter(Boolean);
    out.family = [];
    for (const code of codes) {
      try {
        const r = await byPlatform(code);
        out.family.push(r);
        if (!asJson) renderPlatform(r);
      } catch (e) { failed = true; console.error(`${code}: ${e.message}`); }
    }
  }

  if (product) {
    try {
      out.product = await byProduct(product);
      if (!asJson) {
        console.log(`${product}: ${out.product.releases} releases across ${out.product.platforms.length} platform codes`);
        for (const p of out.product.platforms) console.log(`  ${p.platform.padEnd(12)} ${p.releases}`);
        console.log(`  ${out.product.url}`);
      }
    } catch (e) { failed = true; console.error(`${product}: ${e.message}`); }
  }

  if (asJson) console.log(JSON.stringify(out, null, 2));
  process.exit(failed ? 1 : 0);
})();
