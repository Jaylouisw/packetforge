#!/usr/bin/env node
/**
 * Make the public demo reachable by anyone: a Cloudflare Access bypass for one hostname.
 *
 * `packetforge-demo.jayw.uk` sits under the `*.jayw.uk` wildcard Access application, whose
 * policy is "allow / passkey" (Pocket ID is the identity provider). The demo is meant to be a
 * public sandbox - an anonymous visitor should see the app, not a login wall - so this creates a
 * host-scoped Access application carrying a Bypass policy for everyone. Cloudflare matches the
 * most specific application, so the bypass cannot widen into any other host on the domain.
 *
 * This is the same mechanism `scripts/cf-access-bypass.js` uses for the `git.jayw.uk` public
 * read, but scoped to a whole hostname (no path) rather than a repository path.
 *
 * Credentials, either form:
 *
 *   CF_API_TOKEN     a scoped token:  Account > Access: Apps and Policies: Edit
 *   CF_GLOBAL_KEY    the account Global API Key, which needs CF_EMAIL alongside it
 *                    (sent as X-Auth-Email + X-Auth-Key; a scoped token goes in a Bearer header)
 *
 *   CF_ACCOUNT_ID    optional; discovered from GET /accounts when it is absent
 *   PF_DEMO_HOST     default packetforge-demo.jayw.uk
 *
 *   node scripts/cf-demo-public.js            # dry run: show what would change
 *   node scripts/cf-demo-public.js --apply    # create the application and policy
 *   node scripts/cf-demo-public.js --check    # just report whether it is public yet
 */
'use strict';

const HOST = process.env.PF_DEMO_HOST || 'packetforge-demo.jayw.uk';

const API = 'https://api.cloudflare.com/client/v4';

function token() { return process.env.CF_API_TOKEN || ''; }
function globalKey() { return process.env.CF_GLOBAL_KEY || ''; }
function email() { return process.env.CF_EMAIL || ''; }
function account() { return process.env.CF_ACCOUNT_ID || ''; }

/** Which credential is in play, and the headers it needs. */
function credential() {
  if (token()) return { kind: 'token', headers: { Authorization: 'Bearer ' + token() } };
  if (globalKey()) {
    if (!email()) {
      return {
        kind: 'global-key', headers: {},
        missing: 'CF_GLOBAL_KEY is set but CF_EMAIL is not - a global key authenticates as the account email, not on its own'
      };
    }
    return { kind: 'global-key', headers: { 'X-Auth-Email': email(), 'X-Auth-Key': globalKey() } };
  }
  return { kind: 'none', headers: {} };
}

/** The application body. Kept pure so it can be asserted without a network. */
function appBody() {
  return {
    name: HOST + ' (public demo)',
    domain: HOST,
    type: 'self_hosted',
    session_duration: '24h',
    // Bypass means Access does not prompt at all: the request goes straight through to the app.
    allowed_idps: [],
    auto_redirect_to_identity: false,
    app_launcher_visible: false,
    skip_interstitial: true
  };
}

function policyBody() {
  return {
    name: 'Public access to ' + HOST,
    decision: 'bypass',
    precedence: 1,
    include: [{ everyone: {} }]
  };
}

async function call(method, path, body) {
  const cred = credential();
  if (cred.missing) throw new Error(cred.missing);
  if (cred.kind === 'none') throw new Error('No Cloudflare credential: set CF_API_TOKEN or CF_GLOBAL_KEY + CF_EMAIL');
  const res = await fetch(API + path, {
    method: method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, cred.headers),
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(function () { return {}; });
  if (!res.ok || json.success === false) {
    const detail = (json.errors || []).map(function (e) { return e.code + ' ' + e.message; }).join('; ');
    const err = new Error('Cloudflare ' + method + ' ' + path + ' -> HTTP ' + res.status +
      (detail ? ' (' + detail + ')' : ''));
    err.status = res.status;
    throw err;
  }
  return json.result;
}

/** Does an anonymous request get through? This is the only check that matters. */
async function checkPublic() {
  const url = 'https://' + HOST + '/';
  try {
    const res = await fetch(url, { redirect: 'manual' });
    const location = res.headers.get('location') || '';
    const redirectedToLogin = /cloudflareaccess\.com\/cdn-cgi\/access\/login/.test(location);
    return {
      url: url,
      status: res.status,
      location: location,
      public: res.status === 200 && !redirectedToLogin
    };
  } catch (e) {
    return { url: url, status: 0, location: '', public: false, error: String(e.message || e) };
  }
}

async function main(argv) {
  const apply = argv.indexOf('--apply') !== -1;
  const checkOnly = argv.indexOf('--check') !== -1;

  if (checkOnly || !apply) {
    const now = await checkPublic();
    console.log('Anonymous access to ' + now.url);
    console.log('  HTTP ' + now.status + (now.location ? '  -> ' + now.location.slice(0, 90) : ''));
    console.log('  ' + (now.public ? 'PUBLIC - a stranger can open the demo'
      : 'NOT PUBLIC - Access is intercepting'));
    if (checkOnly) return now.public ? 0 : 1;
    if (now.public) {
      console.log('\nNothing to do.');
      return 0;
    }
  }

  const cred = credential();
  if (cred.missing) {
    console.error('\n' + cred.missing);
    return 2;
  }
  if (cred.kind === 'none') {
    console.error('\nCannot apply: no Cloudflare credential found.');
    console.error('Set either:');
    console.error('  CF_API_TOKEN   a token with  Account > Access: Apps and Policies: Edit');
    console.error('  CF_GLOBAL_KEY + CF_EMAIL   the account Global API Key and the account email');
    return 2;
  }
  if (!account()) {
    const accts = await call('GET', '/accounts');
    if (!accts || !accts.length) {
      console.error('\nCould not discover an account id. Set CF_ACCOUNT_ID explicitly.');
      return 2;
    }
    process.env.CF_ACCOUNT_ID = accts[0].id;
    console.log('Account: ' + accts[0].name + ' (' + accts[0].id + ')');
  }
  console.log('Credential: ' + (cred.kind === 'global-key' ? 'Global API Key as ' + email() : 'scoped token'));

  const apps = await call('GET', '/accounts/' + account() + '/access/apps');
  const wanted = appBody();
  const existing = (apps || []).filter(function (a) {
    return String(a.domain || '').toLowerCase() === wanted.domain.toLowerCase();
  });

  if (existing.length && !apply) {
    console.log('\nAn Access application already covers ' + wanted.domain +
      ' (id ' + existing[0].id + '). It will be left alone.');
  }

  if (!apply) {
    console.log('\nDry run. Would create:');
    console.log(JSON.stringify(wanted, null, 2));
    console.log('\nWith policy:');
    console.log(JSON.stringify(policyBody(), null, 2));
    console.log('\nRe-run with --apply to make it so.');
    return 0;
  }

  let app = existing[0];
  if (!app) {
    app = await call('POST', '/accounts/' + account() + '/access/apps', wanted);
    console.log('Created Access application ' + app.id + ' for ' + wanted.domain);
  } else {
    console.log('Using existing Access application ' + app.id + ' for ' + wanted.domain);
  }

  const policies = await call('GET', '/accounts/' + account() + '/access/apps/' + app.id + '/policies', null);
  const already = (policies || []).some(function (p) { return p.decision === 'bypass'; });
  if (already) {
    console.log('A bypass policy is already present.');
  } else {
    const pol = await call('POST', '/accounts/' + account() + '/access/apps/' + app.id + '/policies', policyBody());
    console.log('Created bypass policy ' + pol.id);
  }

  // Access changes take a moment at the edge; ask twice before believing either answer.
  let verdict = await checkPublic();
  if (!verdict.public) {
    await new Promise(function (r) { setTimeout(r, 4000); });
    verdict = await checkPublic();
  }
  console.log('\nNow: HTTP ' + verdict.status + (verdict.public ? ' - PUBLIC' : ' - still intercepted'));
  if (!verdict.public) {
    console.error('If this persists: the bypass app may be shadowed by a broader app on the same');
    console.error('host. Check that the host app takes precedence over the wildcard app.');
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(function (code) {
    process.exitCode = code;
  }).catch(function (e) {
    console.error(String(e && e.message || e));
    process.exitCode = 1;
  });
}

module.exports = { appBody: appBody, policyBody: policyBody, checkPublic: checkPublic, credential: credential, HOST: HOST };
