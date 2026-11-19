#!/usr/bin/env node
/**
 * Fetch one Huawei product-documentation chapter from an e.huawei.com material page.
 *
 * The E6600 / E9600 / OceanProtect documentation sets are published one chapter per PDF, and the
 * only anonymous way in is a *material page*: https://e.huawei.com/en/documents/others/<32-hex>. That
 * page is server-rendered and carries the real asset path in its HTML, so the 19-digit asset token
 * never has to be guessed - only the 32-hex material hash, which search engines index.
 *
 * The asset lives on e.huawei.com, which answers 301 and redirects to e-file.huawei.com; this script
 * follows that hop and writes the PDF (or pptx/docx) to a caller-chosen directory. Nothing is written
 * into the repository by default: the second argument is required.
 *
 * Usage:
 *   node scripts/huawei-material-fetch.js <32-hex-hash | material-url> <outDir>
 *
 * Exit: 0 saved, 1 could not resolve or download.
 * See research/optixtrans-e6600-chassis-chapters.md for the worked example.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const MAX_HOPS = 5;
// The asset path as it appears in the material page: /marketingcloud/pep/asset/20000001/Material/
// <32-hex hash>/<token>/<file name>. Built from a plain string so the class needs no escaping;
// the file name can contain spaces, and a quote or angle bracket ends it.
const ASSET_RE = new RegExp('pep/asset/20000001/Material/[0-9a-f]{32}/[A-Za-z0-9]+/[^"<>]+');

// The host fingerprints the TLS client, not the headers: measured 2026-11-18, `https.get` with the
// crawler user-agent and `accept: */*` answers 403 (428-byte body) on a material page that answers
// 200 / 337,802 bytes to curl sending the same two headers from the same host in the same minute, and
// a browser user-agent changes nothing. So the transport is curl when it is on PATH; the node client
// stays as the fallback for hosts that have no curl.
const HAS_CURL = (() => {
  try { return spawnSync('curl', ['--version'], { stdio: 'ignore' }).status === 0; } catch (e) { return false; }
})();

function curlGet(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-material-'));
  const bodyFile = path.join(dir, 'body');
  const headerFile = path.join(dir, 'headers');
  try {
    const res = spawnSync('curl', [
      '-sS', '-L', '--max-time', '180', '-A', UA, '-H', 'accept: */*',
      '-o', bodyFile, '-D', headerFile, '-w', '%{http_code} %{url_effective}', url,
    ], { encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error('curl exited ' + res.status + ' for ' + url + ': ' + String(res.stderr || '').trim());
    }
    const line = String(res.stdout || '').trim();
    const cut = line.indexOf(' ');
    const status = Number(cut === -1 ? line : line.slice(0, cut));
    const finalUrl = cut === -1 ? url : line.slice(cut + 1).trim();
    // With -L the dump holds one block per hop; the last content-type belongs to the body on disk.
    const blocks = fs.readFileSync(headerFile, 'utf8').split(/\r?\n\r?\n/);
    let ctype = '';
    for (const b of blocks) {
      const m = /^content-type:\s*(.+)$/im.exec(b);
      if (m) { ctype = m[1].trim(); }
    }
    return { status, url: finalUrl || url, headers: { 'content-type': ctype }, body: fs.readFileSync(bodyFile) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function nodeGet(url, hops) {
  const budget = hops === undefined ? MAX_HOPS : hops;
  return new Promise((resolve, reject) => {
    if (budget <= 0) { reject(new Error('too many redirects from ' + url)); return; }
    https.get(url, { headers: { 'user-agent': UA, accept: '*/*' } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        resolve(nodeGet(next, budget - 1));
        return;
      }
      readAll(res).then((body) => resolve({ status: code, url, headers: res.headers, body }), reject);
    }).on('error', reject);
  });
}

function get(url) {
  return HAS_CURL ? Promise.resolve().then(() => curlGet(url)) : nodeGet(url);
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function materialUrl(arg) {
  if (/^https?:\/\//.test(arg)) { return arg; }
  if (!/^[0-9a-f]{32}$/.test(arg)) {
    throw new Error('expected a 32-hex material hash or a full e.huawei.com material URL, got: ' + arg);
  }
  return 'https://e.huawei.com/en/documents/others/' + arg;
}

async function main() {
  const arg = process.argv[2];
  const outDir = process.argv[3];
  if (!arg || !outDir) {
    console.error('usage: node scripts/huawei-material-fetch.js <32-hex-hash | material-url> <outDir>');
    process.exit(2);
  }

  const pageUrl = materialUrl(arg);
  const page = await get(pageUrl);
  const html = page.body.toString('utf8');
  const title = (/<title>([^<]*)/.exec(html) || [])[1] || '(no title)';
  const match = ASSET_RE.exec(html);
  console.log('page    ' + page.status + ' ' + pageUrl);
  console.log('title   ' + title.trim());
  if (!match) {
    console.error('no asset path in the page - this material page serves no downloadable file');
    process.exit(1);
  }

  // The file name may contain spaces, which the page prints literally; drop any trailing blanks.
  const assetRef = match[0].replace(/\s+$/, '');
  const assetPath = decodeURIComponent(assetRef);
  const assetUrl = 'https://e-file.huawei.com/marketingcloud/' + encodeURI(assetRef);
  console.log('asset   ' + assetUrl);
  const asset = await get(assetUrl);
  if (asset.status !== 200) {
    console.error('asset answered HTTP ' + asset.status + ' at ' + asset.url);
    process.exit(1);
  }
  const bytes = asset.body;
  const ctype = String(asset.headers['content-type'] || '');
  if (/^text\/html/i.test(ctype) || bytes.slice(0, 1).toString() === '<') {
    console.error('the asset resolved to HTML, not a document (final URL ' + asset.url + ') - the file name is wrong');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, path.basename(assetPath));
  fs.writeFileSync(dest, bytes);
  console.log('saved   ' + dest);
  console.log('type    ' + (asset.headers['content-type'] || 'unknown'));
  console.log('bytes   ' + bytes.length + ' (final URL ' + asset.url + ')');
}

main().catch((err) => {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
