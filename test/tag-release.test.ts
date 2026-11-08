import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planRelease, publishRelease } from '../scripts/tag-release.mjs';

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'headroom-tag-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
  git(['init', '-b', 'main']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  mkdirSync(join(cwd, 'src')); mkdirSync(join(cwd, 'scripts'));
  const writeManifest = (version: string) => writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: '@cltec/pi-make-headroom', version }));
  writeManifest('0.1.1'); writeFileSync(join(cwd, 'src/index.ts'), 'const DEFAULT_VERSION = "0.43.1";\n');
  writeFileSync(join(cwd, 'scripts/headroom-automation.json'), '{"piVersion":"1.5.0"}');
  git(['add', '.']); git(['commit', '-m', 'before']); const beforeSha = git(['rev-parse', 'HEAD']);
  writeManifest('0.2.0'); git(['add', '.']); git(['commit', '-m', 'version bump']);
  writeFileSync(join(cwd, 'notes.md'), 'commit after version bump'); git(['add', '.']); git(['commit', '-m', 'after']); const afterSha = git(['rev-parse', 'HEAD']);
  const calls: any[] = [], tags = new Map<string, any>(), annotated = new Map<string, any>();
  let dispatchFailures = 0;
  const api = async (method: string, path: string, body?: any): Promise<any> => {
    calls.push({ method, path, body });
    if (path.startsWith('/compare/')) return { status: 'identical' };
    if (path.startsWith('/git/ref/tags/')) return tags.get(path.slice('/git/ref/tags/'.length)) ?? null;
    if (path.startsWith('/git/tags/')) return annotated.get(path.split('/').at(-1)!) ?? null;
    if (path === '/git/refs') { const ref = { ref: body.ref, object: { type: 'commit', sha: body.sha } }; tags.set(body.ref.slice('refs/tags/'.length), ref); return ref; }
    if (path === '/actions/workflows/release.yml/dispatches') { if (dispatchFailures-- > 0) throw new Error('dispatch outage'); return null; }
    throw new Error(`Unexpected API ${method} ${path}`);
  };
  return { git, api, calls, tags, annotated, beforeSha, afterSha, failDispatch: () => { dispatchFailures = 1; }, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}
function args(plan: any) {
  return { plan, offlineResult: 'success', smokeResult: 'success', evidence: { schemaVersion: 1, extensionCommit: plan.sha, requested: { piVersion: '1.5.0', headroomVersion: '0.43.1' }, actual: { piVersion: '1.5.0', headroomVersion: '0.43.1', pythonVersion: '3.11.9' }, outcome: 'passed', cleanup: { status: 'passed' }, checks: { installation: { status: 'passed' }, healthStatus: { status: 'passed' }, compression: { status: 'passed' } } } };
}

test('release intent compares the full push, not just the final commit parent', async () => {
  const f = fixture(); try {
    const plan = await planRelease({ beforeSha: f.beforeSha, afterSha: f.afterSha }, f);
    assert.deepEqual(plan, { sha: f.afterSha, version: '0.2.0', tag: 'v0.2.0', headroomVersion: '0.43.1', piVersion: '1.5.0' });
    const parent = f.git(['rev-parse', 'HEAD^']);
    assert.equal(await planRelease({ beforeSha: parent, afterSha: f.afterSha }, f), null);
    for (const beforeSha of ['0'.repeat(40), 'invalid', `${f.beforeSha}\n`]) await assert.rejects(planRelease({ beforeSha, afterSha: f.afterSha }, f));
    await assert.rejects(planRelease({ beforeSha: f.afterSha, afterSha: f.beforeSha }, f), /decreased/);
  } finally { f.cleanup(); }
});

test('validated main source creates an exact-SHA tag then explicitly dispatches the tag ref', async () => {
  const f = fixture(); try {
    const plan = await planRelease({ beforeSha: f.beforeSha, afterSha: f.afterSha }, f);
    assert.deepEqual(await publishRelease(args(plan), f), { tag: 'v0.2.0', sha: f.afterSha, dispatched: true });
    assert.deepEqual(f.tags.get('v0.2.0').object, { type: 'commit', sha: f.afterSha });
    const dispatch = f.calls.find(c => c.path === '/actions/workflows/release.yml/dispatches');
    assert.equal(dispatch.method, 'POST'); assert.deepEqual(dispatch.body, { ref: 'v0.2.0' });
  } finally { f.cleanup(); }
});

test('dispatch failures are retryable without moving or recreating an existing tag', async () => {
  const f = fixture(); try {
    const plan = await planRelease({ beforeSha: f.beforeSha, afterSha: f.afterSha }, f);
    f.failDispatch(); await assert.rejects(publishRelease(args(plan), f), /dispatch outage/);
    await publishRelease(args(plan), f);
    assert.equal(f.calls.filter(c => c.path === '/git/refs').length, 1);
    assert.equal(f.calls.filter(c => c.path.endsWith('/dispatches')).length, 2);
  } finally { f.cleanup(); }
});

test('annotated tags resolve to the commit and conflicting or dangling tags stop dispatch', async () => {
  const f = fixture(); try {
    const plan = await planRelease({ beforeSha: f.beforeSha, afterSha: f.afterSha }, f);
    const annotation = 'c'.repeat(40);
    f.tags.set('v0.2.0', { object: { type: 'tag', sha: annotation } });
    f.annotated.set(annotation, { object: { type: 'commit', sha: f.afterSha } });
    await publishRelease(args(plan), f);
    const count = f.calls.filter(c => c.path.endsWith('/dispatches')).length;
    f.annotated.set(annotation, { object: { type: 'commit', sha: f.beforeSha } });
    await assert.rejects(publishRelease(args(plan), f), /tag/i);
    f.annotated.delete(annotation);
    await assert.rejects(publishRelease(args(plan), f), /tag/i);
    assert.equal(f.calls.filter(c => c.path.endsWith('/dispatches')).length, count);
  } finally { f.cleanup(); }
});

test('creation races re-read and verify the tag instead of overwriting it', async () => {
  const f = fixture(); try {
    const plan = await planRelease({ beforeSha: f.beforeSha, afterSha: f.afterSha }, f);
    const api = async (method: string, path: string, body?: any) => {
      if (path === '/git/refs') { f.tags.set('v0.2.0', { object: { type: 'commit', sha: f.afterSha } }); throw new Error('already created'); }
      return f.api(method, path, body);
    };
    assert.equal((await publishRelease(args(plan), { ...f, api })).dispatched, true);
  } finally { f.cleanup(); }
});

test('failed or stale evidence and source identity never produce tags or dispatch', async () => {
  const f = fixture(); try {
    const plan = await planRelease({ beforeSha: f.beforeSha, afterSha: f.afterSha }, f);
    await assert.rejects(publishRelease({ ...args(plan), offlineResult: 'failure' }, f));
    await assert.rejects(publishRelease({ ...args(plan), evidence: null }, f));
    await assert.rejects(publishRelease({ ...args(plan), plan: { ...plan, headroomVersion: '0.99.0' } }, f));
    await assert.rejects(publishRelease(args(plan), { ...f, api: async () => ({ status: 'diverged' }) }));
    assert.equal(f.tags.size, 0);
    assert.equal(f.calls.filter(c => c.path.endsWith('/dispatches')).length, 0);
  } finally { f.cleanup(); }
});
