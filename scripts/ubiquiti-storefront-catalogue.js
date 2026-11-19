#!/usr/bin/env node
/**
 * Ask Ubiquiti's storefront *commerce backend* whether a SKU has a catalogue record at all.
 *
 * The store at `store.ui.com` is a Next.js front end over `https://ecomm.svc.ui.com/graphql`. The
 * per-SKU lookup, `storefrontProduct(slug:...)`, answers for anonymous callers, and what it returns is
 * a database row rather than a rendered page: `displaySku`, `status`, `historicalSlugs`, the
 * `technicalSpecification` table and the `documents` list (datasheet, install guide).
 *
 * That makes it a different instrument from the store's HTML. A 404 on a product page can be a route
 * that was removed, a locale that was never built, or a page switched off in front of a product that
 * still exists. A miss here means there is no catalogue row to render.
 *
 * Two things keep that claim honest, and both are why this script reports rather than judges:
 *
 *   * `status` is `SoldOut` for products that are gone but still on file - `udw` and `udm` both answer
 *     `SoldOut`, so a delisted product is still *found*. A miss is therefore not "retired".
 *   * `historicalSlugs` resolves old names - `udw` answers `["dream-wall","dream-wall-ea","udw",
 *     "unifi-dream-wall"]`. A product that was ever sold under another slug is reachable by that slug
 *     too, so an alias-only miss is weak.
 *
 * What a miss does NOT prove: Ubiquiti purges rows. `usg` and `uxg` are also NOT_FOUND while `udm`,
 * `udr` and `ucg-fiber` are found, so absence is "no record now", never "never shipped". Do not cite
 * this alone as proof a product never existed.
 *
 * Traps, measured 2026-11-19, recorded so nobody re-walks them:
 *   * introspection is refused - `{__schema{...}}` answers 400;
 *   * GraphQL *validation* errors are masked as N copies of `Internal Server Error`, so a bad field
 *     reads as a server fault. The count is still an oracle: adding a valid optional input field
 *     leaves it unchanged, an invalid one adds 1, and a missing required one removes 1;
 *   * the list query `storefrontProducts(input:...)` is NOT usable anonymously - it answers four
 *     masked errors for every input tried, so there is no catalogue-wide enumeration here. This
 *     script is deliberately slug-at-a-time;
 *   * `store.ui.com/robots.txt`, `/sitemap.xml` and `/products.json` all 404 (no Shopify-style
 *     listing, no sitemap); the bare `storeId` must be lowercase (`us`, not `US`).
 *
 * Usage:
 *   node scripts/ubiquiti-storefront-catalogue.js --slug udw
 *   node scripts/ubiquiti-storefront-catalogue.js --slug udw-pro,udwpro,dream-wall-pro
 *   node scripts/ubiquiti-storefront-catalogue.js --slug udw --store eu --json
 *
 * Exit code 0 when every lookup answered (a NOT_FOUND is an answer), 1 when a request failed.
 * Zero dependencies, like the rest of scripts/.
 *
 * See research/ubiquiti-udw-pro-absent-from-vendor-catalogue.md for the sweep this produced.
 */
'use strict';

const https = require('https');

const ENDPOINT = 'https://ecomm.svc.ui.com/graphql';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const QUERY = [
  'query GetProduct($slug:LowercaseTrimmedString!,$storeId:StoreId!,$language:LowercaseTrimmedString!,$displayCurrency:Currency!){',
  'storefrontProduct(slug:$slug,storeId:$storeId,language:$language,displayCurrency:$displayCurrency){',
  'id title displaySku slug status historicalSlugs}}'
].join('');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function post(body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = https.request(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        'User-Agent': UA,
        Origin: 'https://store.ui.com'
      },
      timeout: 30000
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* left null */ }
        resolve({ status: res.statusCode, json, raw: json ? null : data.slice(0, 300) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function lookup(slug, opts) {
  const res = await post({
    query: QUERY,
    variables: { slug, storeId: opts.store, language: opts.language, displayCurrency: opts.currency }
  });

  // A masked validation error is indistinguishable from a fault by message; only the shape tells us
  // the query itself was accepted. NOT_FOUND is the one error that is unambiguously an answer.
  if (res.json && res.json.errors) {
    const first = res.json.errors[0] || {};
    const code = first.extensions && first.extensions.code;
    if (code === 'NOT_FOUND') {
      return {
        slug, present: false,
        alternativeStores: (first.extensions && first.extensions.alternativeStores) || [],
        http: res.status
      };
    }
    return { slug, present: null, error: `HTTP ${res.status}: ${code || 'unparsed'} (${res.json.errors.length} error(s))`, http: res.status };
  }

  const p = res.json && res.json.data && res.json.data.storefrontProduct;
  if (!p) return { slug, present: null, error: `HTTP ${res.status}: no product and no error`, http: res.status };
  return {
    slug, present: true, http: res.status,
    id: p.id, title: p.title, displaySku: p.displaySku, status: p.status,
    historicalSlugs: p.historicalSlugs || []
  };
}

async function main() {
  const opts = {
    store: arg('store', 'us'),
    language: arg('language', 'en'),
    currency: arg('currency', 'USD')
  };
  const raw = arg('slug', 'udw');
  const slugs = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  const json = !!arg('json', false);

  const rows = [];
  for (const slug of slugs) rows.push(await lookup(slug, opts));

  if (json) {
    process.stdout.write(JSON.stringify({ endpoint: ENDPOINT, store: opts.store, rows }, null, 2) + '\n');
  } else {
    for (const r of rows) {
      if (r.present === true) {
        const hist = r.historicalSlugs.length ? ` hist=${JSON.stringify(r.historicalSlugs)}` : '';
        console.log(`${r.slug.padEnd(16)} FOUND    sku=${r.displaySku} status=${r.status}${hist}`);
      } else if (r.present === false) {
        console.log(`${r.slug.padEnd(16)} NOT_FOUND alternativeStores=${JSON.stringify(r.alternativeStores)}`);
      } else {
        console.log(`${r.slug.padEnd(16)} ERROR    ${r.error}`);
      }
    }
    console.log('\nNOT_FOUND means "no catalogue record now" - retired rows answer SoldOut and are still');
    console.log('found, and purged legacy rows miss too. See the header before citing this.');
  }

  process.exit(rows.some(r => r.present === null) ? 1 : 0);
}

main().catch(err => { console.error('probe failed:', err.message); process.exit(1); });
