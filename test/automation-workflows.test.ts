import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const workflow = (name: string) => readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
test('main release chain revalidates the pushed SHA and dispatch preserves the trusted publisher', () => {
  const text = workflow('auto-tag'), release = workflow('release');
  assert.match(text, /branches: \[main\]/);
  assert.match(text, /BEFORE_SHA: \$\{\{ github\.event\.before \}\}/);
  assert.match(text, /AFTER_SHA: \$\{\{ github\.sha \}\}/);
  assert.equal((text.match(/checkout_ref: \$\{\{ needs\.plan\.outputs\.release_sha \}\}/g) ?? []).length, 2);
  assert.match(text, /needs: \[plan, offline, smoke\]/);
  assert.match(text, /actions: write/);
  assert.match(text, /cancel-in-progress: false/);
  assert.doesNotMatch(text, /secrets: inherit|id-token: write|npm publish/);
  assert.match(release, /workflow_dispatch:/);
  assert.match(release, /RELEASE_REF_TYPE: \$\{\{ github\.ref_type \}\}/);
  assert.match(release, /id-token: write/);
});

// Narrow configuration contracts: actionlint separately validates YAML/expression syntax.
// These catch a dropped checkout ref, gate, or permission boundary in the actual wiring.
test('reusable validators retain original entry points and check out caller-selected commits read-only', () => {
  const ci = workflow('ci'), smoke = workflow('compatibility-smoke');
  assert.match(ci, /pull_request:/); assert.match(ci, /branches: \[main\]/);
  assert.match(smoke, /workflow_dispatch:/);
  for (const text of [ci, smoke]) {
    assert.match(text, /workflow_call:/);
    assert.match(text, /checkout_ref:/);
    assert.match(text, /ref: \$\{\{ inputs\.checkout_ref \|\| github\.sha \}\}/);
    assert.match(text, /persist-credentials: false/);
    assert.doesNotMatch(text, /contents: write|id-token: write/);
  }
  assert.match(ci, /node: \[22, 24\]/);
  assert.match(smoke, /python-version: '3\.11'/);
  assert.match(smoke, /timeout-minutes: 35/);
});

test('nightly orchestration gates promotion on exact-candidate CI and smoke, including failure finalization', () => {
  const text = workflow('headroom-update');
  assert.match(text, /cron: ['"]17 3 \* \* \*['"]/);
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /cancel-in-progress: false/);
  assert.match(text, /uses: \.\/\.github\/workflows\/ci\.yml/);
  assert.match(text, /uses: \.\/\.github\/workflows\/compatibility-smoke\.yml/);
  assert.equal((text.match(/checkout_ref: \$\{\{ needs\.prepare\.outputs\.candidate_sha \}\}/g) ?? []).length, 2);
  assert.match(text, /if: \$\{\{ always\(\) && needs\.prepare\.outputs\.has_update == 'true' \}\}/);
  assert.match(text, /ref: \$\{\{ needs\.prepare\.outputs\.base_sha \}\}/);
  assert.match(text, /OFFLINE_RESULT: \$\{\{ needs\.offline\.result \}\}/);
  assert.match(text, /SMOKE_RESULT: \$\{\{ needs\.smoke\.result \}\}/);
  assert.match(text, /headroom_version: \$\{\{ needs\.prepare\.outputs\.headroom_version \}\}/);
  assert.doesNotMatch(text, /secrets: inherit|id-token: write|pull_request_target/);
});
