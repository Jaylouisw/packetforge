'use strict';
// Is the sign-up form actually being served?
//
// `DISABLE_REGISTRATION` lives in app.ini, so the only way to know whether people can create an
// account is to ask the instance and read the answer. This script does that, and it fails loudly,
// because the failure mode is silent: the forge looks healthy, the repository reads fine, and the
// sign-up page returns `200` with the words "Registration is disabled" printed on it.
//
//   node scripts/check-signup.js            # report the posture
//   node scripts/check-signup.js --check    # exit 1 if nobody can sign up
//   node scripts/check-signup.js --base http://odin:3000
//
// Zero dependencies, like everything else in scripts/.
const http = require('http');
const https = require('https');
const { URL } = require('url');

// Pure: everything about the answer that can be decided from the HTML alone.
function assessSignup(html) {
  const body = String(html == null ? '' : html);
  const lower = body.toLowerCase();
  const out = {
    open: false,
    captcha: false,
    fields: [],
    reason: ''
  };
  if (!body) {
    out.reason = 'empty response';
    return out;
  }
  if (lower.indexOf('registration is disabled') !== -1 || lower.indexOf('registration disabled') !== -1) {
    out.reason = 'the page says registration is disabled (DISABLE_REGISTRATION = true)';
    return out;
  }
  for (const f of ['user_name', 'email', 'password']) {
    if (new RegExp('name="' + f + '"').test(body)) out.fields.push(f);
  }
  // A captcha is either Forgejo's own image endpoint or a third-party widget.
  // Forgejo's own endpoint, or the widget class a third-party provider injects - which is spelled
  // "h-captcha"/"cf-turnstile" with hyphens, not the provider's own one-word name.
  out.captcha = /\/captcha\/[A-Za-z0-9]+\.png/i.test(body) ||
    /recaptcha|h-?captcha|turnstile|mcaptcha/i.test(body);
  if (out.fields.length < 3) {
    out.reason = 'the sign-up form is missing fields (' + (out.fields.join(', ') || 'none') + ') - this is not the sign-up page';
    return out;
  }
  out.open = true;
  return out;
}

function request(target, options) {
  return new Promise(function (resolve, reject) {
    let url;
    try { url = new URL(target); } catch (e) { return reject(e); }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: (options && options.method) || 'GET',
      headers: (options && options.headers) || {},
      timeout: 15000
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('timed out after 15s')); });
    req.on('error', reject);
    if (options && options.body) req.write(options.body);
    req.end();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.indexOf('--check') !== -1;
  const baseArg = args.indexOf('--base');
  const base = (baseArg !== -1 ? args[baseArg + 1] : process.env.PF_FORGE_URL || 'https://git.jayw.uk').replace(/\/+$/, '');
  const repo = process.env.PF_FORGE_REPO || 'jaylouisw/packetforge';

  const results = [];
  function line(ok, label, detail) {
    results.push({ ok: ok, label: label, detail: detail });
    console.log((ok ? '  ok   ' : '  FAIL ') + label + (detail ? '  - ' + detail : ''));
  }

  console.log('Sign-up posture for ' + base);
  console.log('');

  let page = null;
  try {
    page = await request(base + '/user/sign_up');
  } catch (e) {
    line(false, 'the sign-up page answers', e.message);
  }
  if (page) {
    line(page.status === 200, 'the sign-up page answers 200', 'got ' + page.status);
    const verdict = assessSignup(page.body);
    line(verdict.open, 'the form is being served', verdict.open ? verdict.fields.join(', ') : verdict.reason);
    line(verdict.captcha, 'a captcha is on the form', verdict.captcha ? '' : 'no captcha found - a public form without one fills with bots');
    if (verdict.open && !verdict.captcha) {
      console.log('         (set ENABLE_CAPTCHA = true and CAPTCHA_TYPE = image in [service])');
    }
  }

  // Anonymous read must stay open: a login wall in front of a public repository is a different bug.
  try {
    const api = await request(base + '/api/v1/repos/' + repo);
    line(api.status === 200, 'anonymous read of ' + repo + ' works', 'got ' + api.status);
  } catch (e) {
    line(false, 'anonymous read of ' + repo + ' works', e.message);
  }

  // Anonymous write must stay closed. If this ever passes, the sign-up form is the least of it.
  try {
    const post = await request(base + '/api/v1/repos/' + repo + '/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 12 },
      body: '{"title":"x"}'
    });
    line(post.status === 401 || post.status === 403, 'anonymous issue creation is refused', 'got ' + post.status);
  } catch (e) {
    line(true, 'anonymous issue creation is refused', e.message);
  }

  const failed = results.filter(function (r) { return !r.ok; });
  console.log('');
  console.log(failed.length ? failed.length + ' check(s) failed' : 'all ' + results.length + ' checks passed');
  if (check && failed.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('check-signup: ' + e.message);
    process.exitCode = 1;
  });
}

module.exports = { assessSignup };
