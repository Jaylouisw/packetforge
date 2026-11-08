// The two Cloudflare credential shapes are not interchangeable: a scoped token goes in a Bearer
// header, a Global API Key goes in X-Auth-Email + X-Auth-Key. Sending the wrong one returns
// "9103 Unknown X-Auth-Key or X-Auth-Email", which reads like a bad key rather than a bad header.
// These assertions pin the mapping so that failure cannot come back.

const assert = require('assert');
const { credential } = require('../scripts/cf-access-bypass.js');

let passed = 0;
function check(name, fn) {
  const saved = {};
  for (const k of ['CF_API_TOKEN', 'CF_GLOBAL_KEY', 'CF_EMAIL']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// A scoped token goes in a Bearer header.
check('scoped token becomes a Bearer header', () => {
  process.env.CF_API_TOKEN = 'tok_abc123';
  const c = credential();
  assert.strictEqual(c.kind, 'token');
  assert.strictEqual(c.headers.Authorization, 'Bearer tok_abc123');
  assert.ok(!('X-Auth-Key' in c.headers), 'a token must not be sent as a global key');
});

// A global key needs the account email, and is sent as a header pair.
check('global key becomes X-Auth-Email + X-Auth-Key', () => {
  process.env.CF_GLOBAL_KEY = 'k' .repeat(37);
  process.env.CF_EMAIL = 'owner@example.com';
  const c = credential();
  assert.strictEqual(c.kind, 'global-key');
  assert.strictEqual(c.headers['X-Auth-Email'], 'owner@example.com');
  assert.strictEqual(c.headers['X-Auth-Key'], 'k'.repeat(37));
  assert.ok(!('Authorization' in c.headers),
    'a global key in a Bearer header is exactly the 9103 rejection this exists to avoid');
});

// The key alone is not enough, and saying so is better than a 403 from Cloudflare.
check('global key without email reports what is missing', () => {
  process.env.CF_GLOBAL_KEY = 'k'.repeat(37);
  const c = credential();
  assert.strictEqual(c.kind, 'global-key');
  assert.deepStrictEqual(c.headers, {});
  assert.ok(/CF_EMAIL/.test(c.missing || ''), 'the message must name the missing variable');
});

// Nothing set is a distinct state from a half-set credential.
check('no credential at all is reported as none', () => {
  const c = credential();
  assert.strictEqual(c.kind, 'none');
  assert.deepStrictEqual(c.headers, {});
});

// Prefer the narrow credential: a token that only touches Access over a key that touches everything.
check('a scoped token wins when both are present', () => {
  process.env.CF_API_TOKEN = 'tok_abc123';
  process.env.CF_GLOBAL_KEY = 'k'.repeat(37);
  process.env.CF_EMAIL = 'owner@example.com';
  const c = credential();
  assert.strictEqual(c.kind, 'token');
  assert.ok(!('X-Auth-Key' in c.headers), 'the account-wide key must not be used when a token exists');
});

console.log('\n' + passed + ' passed, 0 failed');
