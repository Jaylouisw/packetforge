'use strict';

// #2082: a pull request that reaches 0 check statuses and stays there. The run is never
// created for the head, so nothing can re-check it, and the branch - now sitting on
// current `main` - is never pushed again, so nothing retries. Every rebase the
// maintenance pass performs with the run's own token turns a checked pull request into
// an unmergeable one.
//
// The guard is what makes the pass refuse that push. These tests hold it in place in
// both workflows, and check that the checker itself notices the three ways the guard can
// be wrong: absent, after the push it was meant to stop, and present but not a refusal.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { audit } = require('../scripts/check-rebase-push-guard');

const ROOT = path.join(__dirname, '..');

function codes(text) {
  return audit(text, 'test.yml').map(function (f) { return f.code; });
}

const GUARD = [
  '            if [ -n "${RUN_TOKEN:-}" ] && [ "${TOKEN}" = "${RUN_TOKEN}" ]; then',
  '              warn "only the run token - not pushing"',
  '              exit 0',
  '            fi'
];

const PUSH = [
  '              if bounded 180 git push \\',
  '                   --force-with-lease="refs/heads/${head_ref}:${head_sha}" \\',
  '                   origin "HEAD:refs/heads/${head_ref}"; then',
  '                echo "rebased and pushed"',
  '              fi'
];

function workflow(env, body) {
  return [
    'name: test',
    'jobs:',
    '  rebase:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Rebase if behind, then arm',
    '        env:',
    env,
    '        run: |',
    '          set +e',
    ...body
  ].join('\n');
}

const ENV_WITH = '          TOKEN: ${{ secrets.FORGEJO_TOKEN || github.token }}\n          RUN_TOKEN: ${{ github.token }}';
const ENV_WITHOUT = '          TOKEN: ${{ secrets.FORGEJO_TOKEN || github.token }}';

test('a force-push with no run-token guard is reported', () => {
  assert.deepStrictEqual(codes(workflow(ENV_WITHOUT, PUSH)), ['E_NO_RUN_TOKEN']);
});

test('a guard that runs before the push is accepted', () => {
  assert.deepStrictEqual(codes(workflow(ENV_WITH, GUARD.concat(PUSH))), []);
});

test('a guard placed after the push is reported', () => {
  const findings = audit(workflow(ENV_WITH, PUSH.concat(GUARD)), 'test.yml');
  assert.deepStrictEqual(findings.map(function (f) { return f.code; }), ['E_PUSH_WITHOUT_GUARD']);
});

test('a guard that does not stop the pass is reported', () => {
  const talkOnly = [
    '            if [ "${TOKEN}" = "${RUN_TOKEN}" ]; then',
    '              echo "only the run token, pushing anyway"',
    '            fi'
  ];
  assert.deepStrictEqual(codes(workflow(ENV_WITH, talkOnly.concat(PUSH))), ['E_GUARD_DOES_NOT_STOP']);
});

test('a commented-out guard does not count', () => {
  const commented = GUARD.map(function (l) { return '          # ' + l.trim(); });
  assert.deepStrictEqual(codes(workflow(ENV_WITH, commented.concat(PUSH))), ['E_PUSH_WITHOUT_GUARD']);
});

test('both maintenance workflows guard their force-push', () => {
  const files = ['.forgejo/workflows/pr-rebase.yml', '.forgejo/workflows/auto-rebase.yml'];
  const findings = [];
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    assert.ok(fs.existsSync(abs), rel + ' should exist');
    findings.push.apply(findings, audit(fs.readFileSync(abs, 'utf8'), rel));
  }
  assert.deepStrictEqual(findings, []);
});
