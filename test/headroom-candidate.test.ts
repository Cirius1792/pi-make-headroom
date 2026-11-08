import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { UPDATE_FILES, buildUpdateFiles } from '../scripts/headroom-policy.mjs';
import { readReleaseMetadata } from '../scripts/release.mjs';

test('coordination tests remain valid after the repository package version and default pin change', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'headroom-candidate-'));
  try {
    const files = Object.fromEntries(UPDATE_FILES.map(path => [path, readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')]));
    const manifest = JSON.parse(files['package.json']);
    const pin = readReleaseMetadata(`v${manifest.version}`, manifest, files['src/index.ts']).headroomVersion;
    const candidate = `${Number(pin.split('.')[0]) + 1}.0.0`;
    const generated = buildUpdateFiles(files, candidate, '2026-11-08');
    const snapshot = { ...generated.files };
    for (const path of ['scripts/headroom-policy.mjs', 'scripts/headroom-update.mjs', 'scripts/automation-github.mjs', 'scripts/release.mjs', 'test/headroom-update.test.ts']) {
      snapshot[path] = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    }
    for (const [path, content] of Object.entries(snapshot)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    // Only the existing regeneration case runs in the modified checkout. This
    // is not recursive, and it never installs Headroom or contacts GitHub.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // Permit an independent runner rather than suppressing nested test discovery.
    let output = '';
    assert.doesNotThrow(() => { output = execFileSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^candidate regeneration', 'test/headroom-update.test.ts'], {
      cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
    }); }, 'unit fixtures must not inherit the release candidate version/pin');
    assert.match(output, /# pass 1\n/, 'the isolated regeneration case must actually execute');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
