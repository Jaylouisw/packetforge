#!/usr/bin/env node
/**
 * Count every product card on Ubiquiti's tech-spec site, so "the product is not on techspecs" is a
 * count and not a grep of one page.
 *
 * `techspecs.ui.com` is not one index. It is a set of category grids - `/unifi/cloud-gateways`,
 * `/unifi/integrations`, `/unifi/switching`, ... plus `/uisp` - and a product's category cannot be
 * inferred from its name. The UniFi Mobile Router is a *router* filed under `/unifi/integrations/`,
 * and the Dream Wall is a gateway filed under `/unifi/cloud-gateways/`. Reading one grid and
 * concluding "no such product" is how a real SKU gets missed; reading all of them is cheap: eight
 * GETs, ~5.6 MB, and the cards are in the server-rendered RSC payload as
 * `<h6 …>title</h6><p …>SKU</p>` inside the escaped JSON.
 *
 * What the cards are good for: an inventory of what Ubiquiti *merchandises* - the SKU strings on a
 * category shelf. Pro tiers are first-class cards (`UDM` / `UDM-Pro` / `UDM-Pro-Max` sit beside each
 * other in cloud-gateways; 70 of the 398 SKUs counted on 2026-11-19 carry a `-Pro` tier), so an
 * absent Pro card is a statement about the shelf. It is **not** an inventory of the pages this host
 * serves: measured 2026-11-19, five UXG product pages answer 200 at their own URL while no grid
 * carries a card for any of them (`uxg-lite`, `uxg-max`, `uxg-fiber`, `uxg-enterprise`, `uxg-pro`).
 * A specific SKU is settled by the direct slug probes below - 200 = page exists, 3xx = this host
 * does not have it - never by a card count alone. What the cards are NOT good for: any field. A
 * card carries a title and a SKU, no ports.
 * Nothing may be written to `devices/` from this script; it only reports.
 *
 * Traps, measured 2026-11-19, recorded so nobody re-walks them:
 *   * `/unifi` (609,944 B) and `/amplifi` (609,946 B) are **landing pages that render the console
 *     cards**, not product families. `/amplifi` is not a real route at all; a naive census that
 *     trusted "200 + cards" would count the gateway grid twice and add a phantom AmpliFi family.
 *     Fixed routes only, and the duplicate-SKU check below prints what overlaps.
 *   * An unknown slug inside a real category is a **307 to `/`** with a 1-byte body, and
 *     `dl.ui.com/ds/<bogus>_ds.pdf` is a **302 to `techspecs.ui.com/`**. Neither is the 200-with-
 *     front-page-body that earlier passes recorded, so `curl -L` now turns a miss into a 200 hit on
 *     the site home page. This script never follows a redirect: a 3xx is a miss.
 *   * `/robots.txt` and `/sitemap.xml` are 307s to `/` - there is no sitemap, so the enumeration is
 *     the fixed grids plus direct slug probes, and the grids are not complete (see SLUG_PROBES).
 *   * Card titles are HTML-escaped and the pages are CloudFront-cached; compare `content-length`
 *     across passes rather than assuming a page is current.
 *
 * Usage:
 *   node scripts/ubiquiti-techspecs-census.js                    # counts + Dream Wall lines
 *   node scripts/ubiquiti-techspecs-census.js --match udw        # any SKU/title matching /udw/i
 *   node scripts/ubiquiti-techspecs-census.js --match 'pro$' --json
 *
 * Exit code 0 when every family answered 200 and yielded cards, 1 otherwise.
 * Zero dependencies, like the rest of scripts/.
 *
 * See research/ubiquiti-udw-pro-techspecs-slug-census.md for the sweep this produced.
 */
'use strict';

const https = require('https');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Fixed routes. Do not derive these from /unifi's landing page: it links the same seven categories
// but its own body is a console grid, so a parser that "followed the links" would also count /unifi.
const FAMILIES = [
  { family: 'unifi', route: '/unifi/accessories', grid: 'accessories' },
  { family: 'unifi', route: '/unifi/cloud-gateways', grid: 'cloud-gateways' },
  { family: 'unifi', route: '/unifi/door-access', grid: 'door-access' },
  { family: 'unifi', route: '/unifi/integrations', grid: 'integrations' },
  { family: 'unifi', route: '/unifi/physical-security', grid: 'physical-security' },
  { family: 'unifi', route: '/unifi/switching', grid: 'switching' },
  { family: 'unifi', route: '/unifi/wifi', grid: 'wifi' },
  { family: 'uisp', route: '/uisp', grid: 'uisp' }
];

// Direct slug probes. The grids above are shelves, not an index of the pages this host serves:
// measured 2026-11-19, five UXG pages answer 200 while no grid carries a card for any of them, so a
// missing card proves nothing about a page. A specific SKU is settled here instead - 200 is a page
// at its own URL, any 3xx is the host saying it has no such product (the 307 goes to `/` with a
// 1-byte body; never follow it). Two positive controls and one negative control are probed beside
// the real question so a change in the host's routing shows up as a mismatch rather than as a
// silent "absent".
const SLUG_PROBES = [
  { grid: 'cloud-gateways', slug: 'udw', route: '/unifi/cloud-gateways/udw', expect: 'page', why: 'positive control: the Dream Wall page' },
  { grid: 'cloud-gateways', slug: 'udm-pro-max', route: '/unifi/cloud-gateways/udm-pro-max', expect: 'page', why: 'positive control: a Pro tier on the same grid' },
  { grid: 'cloud-gateways', slug: 'uxg-lite', route: '/unifi/cloud-gateways/uxg-lite', expect: 'page', why: 'off-grid: live page, no card' },
  { grid: 'cloud-gateways', slug: 'uxg-max', route: '/unifi/cloud-gateways/uxg-max', expect: 'page', why: 'off-grid: live page, no card' },
  { grid: 'cloud-gateways', slug: 'uxg-fiber', route: '/unifi/cloud-gateways/uxg-fiber', expect: 'page', why: 'off-grid: live page, no card' },
  { grid: 'cloud-gateways', slug: 'uxg-enterprise', route: '/unifi/cloud-gateways/uxg-enterprise', expect: 'page', why: 'off-grid: live page, no card' },
  { grid: 'cloud-gateways', slug: 'uxg-pro', route: '/unifi/cloud-gateways/uxg-pro', expect: 'page', why: 'off-grid: live page, no card' },
  { grid: 'cloud-gateways', slug: 'udw-pro', route: '/unifi/cloud-gateways/udw-pro', expect: 'absent', why: 'the SKU #130 asks for' },
  { grid: 'cloud-gateways', slug: 'bogus-xyz', route: '/unifi/cloud-gateways/bogus-xyz', expect: 'absent', why: 'negative control' }
];

async function runProbes() {
  const out = [];
  for (const p of SLUG_PROBES) {
    const res = await get(p.route).catch(e => ({ error: e.message }));
    let verdict;
    if (res.error) verdict = 'error';
    else if (res.status === 200) verdict = 'page';
    else if (res.status >= 300 && res.status < 400) verdict = 'absent';
    else verdict = 'http-' + res.status;
    out.push({ ...p, status: res.status || null, bytes: res.bytes || null, location: res.location || null, verdict });
  }
  return out;
}

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function get(route) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'techspecs.ui.com',
      path: route,
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      timeout: 45000
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        bytes: Buffer.concat(chunks).length,
        location: res.headers.location || null,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// One card = one ProductCard block: href to the product page, <img alt="name">, <h6>title</h6>,
// <p>SKU</p>. The href and the text are both inside the escaped RSC payload, so the quotes are
// backslash-escaped in the raw bytes; splitting on the wrapper class is sturdier than one big regex.
function parseCards(html, grid) {
  const marker = 'ProductCard-styles__CardWrapper';
  const slugRe = new RegExp('/unifi/' + grid + '/([a-z0-9._-]+)|^/(uisp)/([a-z0-9._-]+)');
  const textRe = /<h6[^>]*>([^<]*)<\/h6><p[^>]*>([^<]*)<\/p>/;
  const out = [];
  const parts = html.split(marker).slice(1);
  for (const part of parts) {
    const m = part.match(textRe);
    if (!m) continue;
    const s = part.slice(0, 600).match(slugRe);
    out.push({
      slug: s ? (s[1] || s[3]) : null,
      title: m[1].replace(/&amp;/g, '&'),
      sku: m[2].replace(/&amp;/g, '&')
    });
  }
  return out;
}

function uniqSku(rows) {
  const seen = new Map();
  for (const r of rows) {
    const k = r.sku.toUpperCase();
    if (!seen.has(k)) seen.set(k, r);
  }
  return seen;
}

async function main() {
  const matchArg = arg('match', 'udw|dream');
  const wantJson = !!arg('json', false);
  const needle = matchArg === true ? /udw|dream/i : new RegExp(String(matchArg), 'i');

  const pages = [];
  let ok = true;
  for (const f of FAMILIES) {
    const res = await get(f.route).catch(e => ({ error: e.message }));
    if (res.error || res.status !== 200) {
      ok = false;
      pages.push({ ...f, error: res.error || ('HTTP ' + res.status + (res.location ? ' -> ' + res.location : '')) });
      continue;
    }
    const cards = parseCards(res.body, f.grid);
    if (!cards.length) ok = false;
    pages.push({ ...f, bytes: res.bytes, status: res.status, cards });
  }

  const probes = await runProbes();
  const mismatch = probes.filter(p => p.verdict !== p.expect);
  if (mismatch.length) ok = false;

  // Pages the host serves that no shelf carries. This is the measurement that says a card count is
  // not an inventory: if this list is non-empty, "no card" cannot be read as "no page".
  const shelves = new Map(pages.filter(p => p.cards).map(p => [p.grid, new Set(p.cards.map(c => c.slug))]));
  const offGrid = probes.filter(p => p.verdict === 'page' && p.grid && shelves.has(p.grid) && !shelves.get(p.grid).has(p.slug));

  const all = pages.flatMap(p => (p.cards || []).map(c => ({ ...c, grid: p.grid, family: p.family })));
  const bySku = uniqSku(all);
  const dupes = [...bySku.keys()].filter(k => all.filter(r => r.sku.toUpperCase() === k).length > 1);
  const hits = [...bySku.values()].filter(r => needle.test(r.sku) || needle.test(r.title));

  if (wantJson) {
    process.stdout.write(JSON.stringify({
      families: pages.map(p => ({ route: p.route, status: p.status, bytes: p.bytes, cards: (p.cards || []).length, error: p.error })),
      cards: all.length, uniqueSkus: bySku.size, duplicateSkus: dupes,
      probes: probes.map(p => ({ route: p.route, status: p.status, bytes: p.bytes, verdict: p.verdict, expect: p.expect })),
      offGrid: offGrid.map(p => p.route),
      probeMismatch: mismatch.map(p => p.route),
      match: String(matchArg), hits
    }, null, 2) + '\n');
    process.exit(ok ? 0 : 1);
  }

  console.log('Ubiquiti techspecs product-card census (fixed routes only, redirects never followed)');
  for (const p of pages) {
    if (p.error) { console.log(`  ${p.route.padEnd(30)} ${p.error}`); continue; }
    console.log(`  ${p.route.padEnd(30)} 200 ${String(p.bytes).padStart(7)} B  ${String(p.cards.length).padStart(3)} cards`);
  }
  console.log(`\nCards: ${all.length}   Unique SKUs: ${bySku.size}   Duplicated across grids: ${dupes.length}${dupes.length ? ' (' + dupes.slice(0, 8).join(', ') + (dupes.length > 8 ? ', ...' : '') + ')' : ''}`);

  console.log('\nDirect slug probes (200 = page at its own URL, 3xx = the host has no such product)');
  for (const p of probes) {
    const state = p.verdict === p.expect ? 'ok ' : 'MISMATCH';
    console.log(`  ${state} ${p.route.padEnd(38)} ${String(p.status).padStart(3)} ${String(p.bytes || 0).padStart(7)} B  ${p.verdict.padEnd(7)} ${p.why}`);
  }
  console.log(`\nPages with no card on their own shelf: ${offGrid.length}${offGrid.length ? ' (' + offGrid.map(p => p.slug).join(', ') + ')' : ''}`);
  if (offGrid.length) console.log('  -> a card count is a shelf inventory, not a page inventory; settle a SKU on its slug probe.');

  console.log(`\nMatching /${matchArg}/i: ${hits.length}`);
  for (const h of hits) console.log(`  ${h.sku.padEnd(22)} ${h.title.padEnd(34)} ${h.family}/${h.grid}${h.slug ? '/' + h.slug : ''}`);
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error('census failed:', e.message); process.exit(1); });
