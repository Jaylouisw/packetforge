#!/usr/bin/env node
/**
 * Publish the repository: put a Cloudflare Access bypass in front of exactly one path.
 *
 * The project's canonical home is behind Cloudflare Access, so an anonymous visitor who follows the
 * README is redirected to a login page. They cannot read the code, the issues, or a badge. That is
 * not a privacy setting with a side effect - it is the thing that makes "open source" untrue, and
 * the reason thirty pull requests were opened on the GitHub mirror by people who never found this
 * forge.
 *
 * This creates ONE Access application for the public repository path, carrying a Bypass policy for
 * everyone. Everything else on the host keeps the existing Allow policy: /-/admin, /api, any other
 * repository. Cloudflare matches the most specific application, so the bypass cannot widen into the
 * admin UI.
 *
 * Credentials, either form:
 *
 *   CF_API_TOKEN     a scoped token:  Account > Access: Apps and Policies: Edit
 *   CF_GLOBAL_KEY    the account Global API Key, which needs CF_EMAIL alongside it
 *                    (sent as X-Auth-Email + X-Auth-Key; a scoped token goes in a Bearer header)
 *
 * The global key is account-wide - it can touch billing, DNS, R2 and every Access app - so prefer a
 * scoped token, keep the key in a 0600 file, and rotate it once this is done.
 *
 *   CF_ACCOUNT_ID    optional; discovered from GET /accounts when it is absent
 *   PF_HOST          default git.jayw.uk
 *   PF_PATH          default jaylouisw/packetforge
 *
 *   node scripts/cf-access-bypass.js            # dry run: show what would change
 *   node scripts/cf-access-bypass.js --apply    # create the application and policy
 *   node scripts/cf-access-bypass.js --check    # just report whether it is public yet
 */
'use strict';

const HOST = process.env.PF_HOST || 'git.jayw.uk';
const OWNER = process.env.PF_OWNER || 'jaylouisw';
const NAME = process.env.PF_NAME || 'packetforge';
// Matching the bare path also matches its children (issues, pulls, badges, src, .git), which is the
// whole point: a contributor needs every one of those, not a single page that returns 200.
const PATH = process.env.PF_PATH || (OWNER + '/' + NAME);

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
        kind: 'global-key', headers: {}, missing: 'CF_GLOBAL_KEY is set but CF_EMAIL is not - ' +
          'a global key authenticates as the account email, not on its own'
      };
    }
    return {
      kind: 'global-key',
      headers: { 'X-Auth-Email': email(), 'X-Auth-Key': globalKey() }
    };
  }
  return { kind: 'none', headers: {} };
}

/** The application body. Kept as a pure function so it can be asserted without a network. */
function appBody(opts) {
  const o = opts || {};
  return {
    name: (o.name || PATH) + ' (public read)',
    domain: (o.host || HOST) + '/' + (o.path || PATH),
    type: 'self_hosted',
    session_duration: '24h',
    // Bypass means Access does not prompt at all: the request goes straight through to Forgejo.
    // Forgejo's own visibility rules then decide what an anonymous user may see.
    allowed_idps: [],
    auto_redirect_to_identity: false,
    app_launcher_visible: false,
    skip_interstitial: true
  };
}

function policyBody(opts) {
  const o = opts || {};
  return {
    name: 'Public read of ' + (o.path || PATH),
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
  const url = 'https://' + HOST + '/' + PATH;
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
    console.log('  ' + (now.public ? 'PUBLIC — a stranger can read this repository'
      : 'NOT PUBLIC — Access is intercepting'));
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
    // A global key can look the account up; a scoped token may not be allowed to, so say so plainly.
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
  const wanted = appBody({});
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
    console.log(JSON.stringify(policyBody({}), null, 2));
    console.log('\nEverything else on ' + HOST + ' keeps its current policy.');
    console.log('Re-run with --apply to make it so.');
    return 0;
  }

  let app = existing[0];
  if (!app) {
    app = await call('POST', '/accounts/' + account() + '/access/apps', wanted);
    console.log('Created Access application ' + app.id + ' for ' + wanted.domain);
  } else {
    console.log('Using existing Access application ' + app.id + ' for ' + wanted.domain);
  }

  const policies = await call('GET', '/accounts/' + account() + '/access/apps/' + app.id + '/policies',
    null);
  const already = (policies || []).some(function (p) { return p.decision === 'bypass'; });
  if (already) {
    console.log('A bypass policy is already present.');
  } else {
    const pol = await call('POST', '/accounts/' + account() + '/access/apps/' + app.id + '/policies',
      policyBody({}));
    console.log('Created bypass policy ' + pol.id);
  }

  // Access changes take a moment at the edge; ask twice before believing either answer.
  let verdict = await checkPublic();
  if (!verdict.public) {
    await new Promise(function (r) { setTimeout(r, 4000); });
    verdict = await checkPublic();
  }
  console.log('\nNow: HTTP ' + verdict.status + (verdict.public ? ' — PUBLIC' : ' — still intercepted'));
  if (!verdict.public) {
    console.error('If this persists: the bypass app may be shadowed by a broader app on the same');
    console.error('host. Check that the repo path app takes precedence, and that the repository is');
    console.error('not private (Forgejo: Settings > Advanced).');
    return 1;
  }
  return 0;
}

if (require.main === module) {
  // exitCode, not process.exit(): calling exit() while undici's keep-alive socket is still open
  // trips a libuv assertion on Windows, and the crash swallowed the exit code - a refused run
  // reported success. The code has to survive the shutdown, so let Node drain naturally.
  main(process.argv.slice(2)).then(function (code) {
    process.exitCode = code;
  }).catch(function (e) {
    console.error(String(e && e.message || e));
    process.exitCode = 1;
  });
}

module.exports = {
  appBody: appBody, policyBody: policyBody, checkPublic: checkPublic,
  credential: credential, HOST: HOST, PATH: PATH
};
