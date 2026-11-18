#!/usr/bin/env node
/**
 * Ask Huawei's documentation API whether a document is public, gated or absent - mechanically.
 *
 * Four OptiXtrans requests (#803, #807, #808, #810) are blocked on one thing: the service-board
 * chapters live inside a hardware description that answers `401 NOT LOGIN!` to an anonymous client.
 * Every pass on those threads re-typed the same seven `curl` commands and then argued in prose about
 * whether a `302 -> /view/notFound` meant "unpublished" or "gated". It means neither: `/enterprise/<lang>/doc/<id>`
 * cannot tell the two apart, but `/hedex/api/navi/<id>/first-level-tree` can:
 *
 *   200                              anonymously readable  -> go and read it
 *   401 {"message":"NOT LOGIN!"}     the document exists, behind the free Huawei account wall
 *   404 {"message":"No doc data found."}  no such document
 *
 * The whole point of this script is the *change* signal: a 401 that turns into a 200 is the moment a
 * blocked request becomes buildable, and nobody is going to notice that by hand once a week. The
 * manifest `research/huawei-gated-docs.json` carries the id list and the state each id had at the
 * baseline measured on 2026-11-18; this script exits 1 when any id no longer matches it.
 *
 * Usage:
 *   node scripts/huawei-doc-gate-probe.js              # probe all, compare with the baseline
 *   node scripts/huawei-doc-gate-probe.js --update     # write the observed states back as the baseline
 *   node scripts/huawei-doc-gate-probe.js --group e6600
 *   node scripts/huawei-doc-gate-probe.js --id EDOC1100625826
 *   node scripts/huawei-doc-gate-probe.js --json
 *
 * Zero dependencies, like the rest of scripts/. Huawei's support host wants a crawler UA (a browser UA
 * gets Akamai 403, and no UA gets a 302 to the SPA shell), which is what this sends.
 *
 * See research/huawei-gated-doc-probe.md for the baseline table and what each state implies.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'research', 'huawei-gated-docs.json');
const API = 'https://support.huawei.com/hedex/api/navi/{id}/first-level-tree';
const UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const PAUSE_MS = 250;

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const FLAG = {
  update: process.argv.includes('--update'),
  json: process.argv.includes('--json'),
  group: arg('group', null),
  id: arg('id', null),
};

function get(url, hops) {
  const budget = hops === undefined ? 3 : hops;
  return new Promise((resolve, reject) => {
    if (budget <= 0) { reject(new Error('too many redirects from ' + url)); return; }
    const req = https.get(url, { headers: { 'user-agent': UA, accept: 'application/json' }, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const code = res.statusCode || 0;
        const body = Buffer.concat(chunks).toString('utf8');
        if (code >= 300 && code < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).toString();
          resolve(get(next, budget - 1));
          return;
        }
        resolve({ code, body, location: res.headers.location || null });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout after 20s: ' + url)); });
    req.on('error', reject);
  });
}

function message(body) {
  try { return JSON.parse(body).message || ''; } catch (e) { return body.slice(0, 80).replace(/\s+/g, ' ').trim(); }
}

/** Map an HTTP status plus body onto the three states the threads care about. */
function classify(res) {
  if (res.code === 200) return 'public';
  if (res.code === 401) return 'gated';
  if (res.code === 404) return 'absent';
  if (res.code >= 300 && res.code < 400) return 'redirect';
  return 'error';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(doc) {
  const url = API.replace('{id}', doc.id);
  try {
    const res = await get(url);
    return { id: doc.id, status: res.code, state: classify(res), message: message(res.body), location: res.location };
  } catch (e) {
    return { id: doc.id, status: 0, state: 'error', message: e.message, location: null };
  }
}

async function main() {
  if (!fs.existsSync(MANIFEST)) {
    console.error('no manifest at ' + path.relative(ROOT, MANIFEST));
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  let docs = manifest.docs.slice();
  if (FLAG.group) docs = docs.filter((d) => d.group === FLAG.group);
  if (FLAG.id) docs = docs.filter((d) => d.id === FLAG.id);
  if (!docs.length) {
    console.error('no documents selected by --group/--id');
    process.exit(2);
  }

  const results = [];
  for (const doc of docs) {
    results.push(await probe(doc));
    await sleep(PAUSE_MS);
  }

  const changed = [];
  for (const r of results) {
    const doc = docs.find((d) => d.id === r.id);
    r.title = doc.title;
    r.group = doc.group;
    r.was = doc.state;
    if (!FLAG.update && r.state !== doc.state) changed.push(r);
  }

  if (FLAG.json) {
    process.stdout.write(JSON.stringify({ baseline: manifest.baseline, results, changed: changed.map((c) => c.id) }, null, 2) + '\n');
  } else {
    const counts = {};
    for (const r of results) counts[r.state] = (counts[r.state] || 0) + 1;
    console.log('baseline ' + manifest.baseline + ' - ' + results.length + ' documents, ' + new URL(API.replace('{id}', 'X')).host);
    console.log('');
    for (const r of results) {
      const mark = FLAG.update ? ' ' : (r.state === r.was ? ' ' : '!');
      const col = (r.state + '        ').slice(0, 8);
      console.log(mark + ' ' + r.id + '  ' + col + (r.status ? r.status + ' ' : '--- ') + (r.state === 'error' ? r.message : '') + '  ' + r.title);
      if (!FLAG.update && r.state !== r.was) console.log('    was ' + r.was + ' -> now ' + r.state + (r.message ? ' (' + r.message + ')' : ''));
    }
    console.log('');
    console.log('states: ' + Object.keys(counts).sort().map((k) => k + ' ' + counts[k]).join(', '));
    if (FLAG.update) {
      for (const r of results) {
        const doc = manifest.docs.find((d) => d.id === r.id);
        doc.state = r.state;
        doc.lastProbed = new Date().toISOString().slice(0, 10);
      }
      manifest.baseline = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
      console.log('baseline updated in ' + path.relative(ROOT, MANIFEST));
    } else if (changed.length) {
      console.log('');
      console.log('CHANGED since baseline: ' + changed.map((c) => c.id + ' ' + c.was + '->' + c.state).join(', '));
      console.log('A 401 -> 200 here means the chapter can be read anonymously: fetch it, write the spec, then run --update.');
    } else {
      console.log('');
      console.log('nothing changed since the baseline - no document has been published or unlocked.');
    }
  }

  process.exit(FLAG.update || !changed.length ? 0 : 1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
