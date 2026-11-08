import assert from 'node:assert/strict';
import test from 'node:test';
import { assessCompatibility, buildUpdateFiles, compareStableVersions, releaseIntent, selectHeadroomRelease } from '../scripts/headroom-policy.mjs';

const manifest = { name: '@cltec/pi-make-headroom', version: '0.1.1' };
const files = {
  'package.json': JSON.stringify(manifest),
  'src/index.ts': 'const DEFAULT_VERSION = "0.42.0";\n// Preserve this comment.\n',
  'README.md': 'Default `headroom-ai[proxy]==0.42.0`.\nInstalls `headroom-ai[proxy]==0.42.0`.\n| `HEADROOM_VERSION` | `0.42.0` | default |\nHistorical baseline: 0.42.0\n',
  'docs/CONFIGURATION.md': '```json\n{\n  "version": "0.42.0",\n  "extras": "proxy"\n}\n```\n| `HEADROOM_VERSION` | `0.42.0` | default |\nHistorical baseline: 0.42.0\n',
  'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n- Pending feature.\n\n## [0.1.1] - 2026-11-08\n\n- Previous release with 0.42.0.\n',
};
const distribution = { filename: 'headroom.whl', yanked: false };
const sha = 'a'.repeat(40);
const expected = { sha, piVersion: '1.5.0', headroomVersion: '0.43.1' };
function passed() {
  return {
    schemaVersion: 1, extensionCommit: sha, requested: { piVersion: '1.5.0', headroomVersion: '0.43.1' },
    actual: { piVersion: '1.5.0', headroomVersion: '0.43.1', pythonVersion: '3.11.9', nodeVersion: 'v22.23.0' },
    checks: { installation: { status: 'passed' }, healthStatus: { status: 'passed' }, compression: { status: 'passed' } },
    cleanup: { status: 'passed' }, outcome: 'passed',
  };
}

test('numeric comparison orders 0.10 after 0.9 without accepting unsafe versions', () => {
  assert.equal(compareStableVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareStableVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareStableVersions('1.0.0', '1.0.0'), 0);
  for (const value of ['01.2.3', '1.2.3\n', '1.2.3;echo unsafe', '9007199254740992.0.0', '1.2.3rc1']) {
    assert.throws(() => compareStableVersions(value, '1.0.0'));
  }
});

test('discovery selects only the newest stable non-yanked distribution', () => {
  const releases = Object.fromEntries(['0.9.0', '0.10.0', '0.11.0rc1', '0.11.0a1', '0.11.0b1', '0.11.0.dev1', '0.11.0.post1', '0.11.0+local', '1!0.11.0'].map(v => [v, [distribution]]));
  releases['0.12.0'] = [{ ...distribution, yanked: true }];
  releases['0.13.0'] = [];
  assert.equal(selectHeadroomRelease({ releases }, '0.8.0'), '0.10.0');
  assert.equal(selectHeadroomRelease({ releases }, '0.10.0'), null);
  assert.equal(selectHeadroomRelease({ releases: {} }, '0.10.0'), null);
  assert.equal(selectHeadroomRelease({ releases: { '0.11.0': [{ ...distribution, yanked: true }, distribution] } }, '0.10.0'), '0.11.0');
});

test('discovery rejects malformed registry structure rather than reporting no upgrade', () => {
  for (const value of [null, {}, { releases: [] }, { releases: { '0.43.1': null } }, { releases: { '0.43.1': [{}] } }]) {
    assert.throws(() => selectHeadroomRelease(value, '0.42.0'));
  }
});

test('file preparation bumps once from the base, retaining history and unrelated source', () => {
  const first = buildUpdateFiles(files, '0.43.1', '2026-11-09');
  assert.equal(first.extensionVersion, '0.2.0');
  assert.equal(first.headroomVersion, '0.43.1');
  assert.deepEqual(buildUpdateFiles(files, '0.43.1', '2026-11-09'), first);
  assert.equal(JSON.parse(first.files['package.json']).version, '0.2.0');
  assert.equal(first.files['src/index.ts'], 'const DEFAULT_VERSION = "0.43.1";\n// Preserve this comment.\n');
  assert.match(first.files['README.md'], /Historical baseline: 0\.42\.0/);
  assert.match(first.files['docs/CONFIGURATION.md'], /"version": "0\.43\.1"/);
  assert.match(first.files['docs/CONFIGURATION.md'], /Historical baseline: 0\.42\.0/);
  assert.match(first.files['README.md'], /\| `HEADROOM_VERSION` \| `0\.43\.1`/);
  assert.match(first.files['CHANGELOG.md'], /## \[0\.2\.0\] - 2026-11-09/);
  assert.equal(first.files['CHANGELOG.md'].split('- Pending feature.').length, 2);
  assert.match(first.files['CHANGELOG.md'], /Previous release with 0\.42\.0/);
  assert.equal(files['src/index.ts'].includes('0.42.0'), true, 'input is not mutated');
});

test('file preparation fails closed on ambiguous source, anchors, date and stale candidates', () => {
  assert.throws(() => buildUpdateFiles({ ...files, 'src/index.ts': files['src/index.ts'].repeat(2) }, '0.43.1', '2026-11-09'));
  assert.throws(() => buildUpdateFiles({ ...files, 'README.md': 'no known defaults' }, '0.43.1', '2026-11-09'));
  assert.throws(() => buildUpdateFiles({ ...files, 'CHANGELOG.md': 'no unreleased heading' }, '0.43.1', '2026-11-09'));
  assert.throws(() => buildUpdateFiles(files, '0.43.1', 'not a date'));
  assert.throws(() => buildUpdateFiles(files, '0.42.0', '2026-11-09'));
});

test('compatibility requires both jobs and exact recorded identity', () => {
  const run = { offlineResult: 'success', smokeResult: 'success', evidence: passed(), expected };
  assert.equal(assessCompatibility(run).ready, true);
  for (const status of ['failure', 'cancelled', 'skipped', '']) {
    assert.equal(assessCompatibility({ ...run, offlineResult: status }).ready, false);
    assert.equal(assessCompatibility({ ...run, smokeResult: status }).ready, false);
  }
  for (const evidence of [null, {}, { ...passed(), extensionCommit: 'b'.repeat(40) }, { ...passed(), schemaVersion: 2 }, { ...passed(), outcome: 'failed' }, { ...passed(), cleanup: { status: 'failed' } }, { ...passed(), actual: { ...passed().actual, pythonVersion: '3.12.0' } }, { ...passed(), requested: { ...passed().requested, piVersion: '1.6.0' } }, { ...passed(), actual: { ...passed().actual, headroomVersion: '0.42.0' } }]) {
    assert.equal(assessCompatibility({ ...run, evidence }).ready, false);
  }
  for (const check of ['installation', 'healthStatus', 'compression']) {
    assert.equal(assessCompatibility({ ...run, evidence: { ...passed(), checks: { ...passed().checks, [check]: { status: 'not_run' } } } }).ready, false);
  }
});

test('release intent is explicit, canonical, increasing and scoped to this package', () => {
  assert.equal(releaseIntent(manifest, manifest), null);
  assert.deepEqual(releaseIntent(manifest, { ...manifest, version: '0.2.0' }), { version: '0.2.0', tag: 'v0.2.0' });
  for (const version of ['0.1.0', 'v0.2.0', '0.2.0rc1', '0.02.0']) {
    assert.throws(() => releaseIntent(manifest, { ...manifest, version }));
  }
  assert.throws(() => releaseIntent(manifest, { name: 'another-package', version: '0.2.0' }));
});
