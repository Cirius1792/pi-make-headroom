import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { githubRequest } from '../scripts/automation-github.mjs';
import { prepareUpdate, finalizeUpdate } from '../scripts/headroom-update.mjs';

// Real Git objects, snapshots, and push leases; only the external GitHub/PyPI APIs are replaced.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'headroom-update-'));
  const cwd = join(root, 'checkout'), remote = join(root, 'remote.git');
  mkdirSync(cwd);
  const git = (args: string[]) => {
    const text = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return args[0] === 'show' && args[1]?.includes(':') ? text : text.trimEnd();
  };
  const ref = (name: string) => { try { return git(['--git-dir', remote, 'rev-parse', '--verify', `refs/heads/${name}`]); } catch { return null; } };
  git(['init', '-b', 'main']); git(['config', 'user.name', 'github-actions[bot]']); git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  for (const path of ['src/index.ts', 'package.json', 'README.md', 'docs/CONFIGURATION.md', 'CHANGELOG.md']) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), readFileSync(new URL(`../${path}`, import.meta.url)));
  }
  git(['add', '.']); git(['commit', '-m', 'base']);
  git(['init', '--bare', remote]); git(['remote', 'add', 'origin', remote]); git(['push', 'origin', 'HEAD:refs/heads/main']);
  const prs: any[] = [], calls: any[] = [];
  const api = async (method: string, path: string, body?: any): Promise<any> => {
    calls.push({ method, path, body });
    if (path.startsWith('/git/ref/heads/')) { const sha = ref(path.slice('/git/ref/heads/'.length)); return sha ? { object: { sha } } : null; }
    if (path.startsWith('/git/commits/') && method === 'GET') {
      const sha = path.split('/').at(-1)!;
      return { sha, tree: { sha: git(['show', '-s', '--format=%T', sha]) }, parents: git(['show', '-s', '--format=%P', sha]).split(' ').filter(Boolean).map(sha => ({ sha })), message: git(['show', '-s', '--format=%B', sha]), author: { name: git(['show', '-s', '--format=%an', sha]) } };
    }
    if (path === '/git/trees') {
      git(['read-tree', body.base_tree]);
      for (const item of body.tree) {
        writeFileSync(join(cwd, item.path), item.content);
        git(['add', item.path]);
      }
      return { sha: git(['write-tree']) };
    }
    if (path === '/git/commits') return { sha: git(['commit-tree', body.tree, '-p', body.parents[0], '-m', body.message]) };
    if (path.startsWith('/pulls?')) return new URLSearchParams(path.split('?')[1]).get('page') === '1' ? prs : [];
    if (path === '/pulls' && method === 'POST') {
      const pr = { ...body, number: prs.length + 1, node_id: `PR_${prs.length + 1}`, state: 'open', user: { login: 'github-actions[bot]' }, head: { ref: body.head, sha: ref(body.head) }, base: { ref: body.base } };
      prs.push(pr); return pr;
    }
    if (path.startsWith('/pulls/') && method === 'PATCH') { const pr = prs.find(p => p.number === Number(path.split('/').at(-1))); Object.assign(pr, body); return pr; }
    if (path === '/graphql') {
      const pr = prs.find(p => p.node_id === body.variables.id);
      pr.draft = body.query.includes('convertPullRequestToDraft'); return { data: {} };
    }
    throw new Error(`Unexpected fixture API: ${method} ${path}`);
  };
  const options = { repository: 'owner/repo', baseSha: ref('main'), date: '2026-11-09', runUrl: 'https://github.com/owner/repo/actions/runs/1', piVersion: '1.5.0' };
  const deps = { repository: 'owner/repo', api, git, fetchPyPI: async () => ({ releases: { '0.43.1': [{ yanked: false }] } }) };
  return { root, cwd, git, ref, options, deps, prs, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function evidence(c: any) {
  return { schemaVersion: 1, extensionCommit: c.headSha, requested: { piVersion: '1.5.0', headroomVersion: '0.43.1' }, actual: { piVersion: '1.5.0', headroomVersion: '0.43.1', pythonVersion: '3.11.9' }, outcome: 'passed', checks: { installation: { status: 'passed' }, healthStatus: { status: 'passed' }, compression: { status: 'passed' } }, cleanup: { status: 'passed' } };
}

test('GitHub HTTP adapter handles status and malformed payloads without leaking credentials', async () => {
  const token = 'secret-token';
  assert.deepEqual(await githubRequest('/test', { token, request: async (_url: string, options: any) => { assert.equal(options.headers.Authorization, `Bearer ${token}`); return Response.json({ ok: true }); } }), { ok: true });
  assert.equal(await githubRequest('/test', { token, request: async () => new Response(null, { status: 204 }) }), null);
  assert.equal(await githubRequest('/test', { token, request: async () => new Response(null, { status: 404 }) }), null);
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(githubRequest('/test', { token, request: async () => new Response(token, { status }) }), error => !String(error).includes(token));
  }
  await assert.rejects(githubRequest('/test', { token, request: async () => { throw new Error(token); } }), error => !String(error).includes(token));
  await assert.rejects(githubRequest('/test', { token, request: async () => new Response('not json') }));
  await assert.rejects(githubRequest('/graphql', { token, request: async () => Response.json({ errors: [{ message: token }] }) }), error => !String(error).includes(token));
});

test('candidate regeneration is idempotent and does not compound the minor bump', async () => {
  const f = fixture(); try {
    const first = await prepareUpdate(f.options, f.deps);
    assert.equal(first.extensionVersion, '0.2.0');
    assert.equal(f.ref('automation/headroom-update'), first.headSha);
    const retry = await prepareUpdate({ ...f.options, date: '2026-11-10' }, f.deps);
    assert.equal(retry.headSha, first.headSha);
    const newer = await prepareUpdate(f.options, { ...f.deps, fetchPyPI: async () => ({ releases: { '0.44.0': [{ yanked: false }] } }) });
    assert.equal(newer.extensionVersion, '0.2.0');
    assert.equal(newer.headroomVersion, '0.44.0');
    assert.equal(f.git(['show', '-s', '--format=%P', newer.headSha]), f.options.baseSha);
  } finally { f.cleanup(); }
});

test('validation creates one ready PR, retries update it, and failures demote it', async () => {
  const f = fixture(); try {
    const c = await prepareUpdate(f.options, f.deps);
    const args = { candidate: c, offlineResult: 'success', smokeResult: 'success', evidence: evidence(c), runUrl: f.options.runUrl };
    assert.equal((await finalizeUpdate(args, f.deps)).ready, true);
    await finalizeUpdate(args, f.deps);
    assert.equal(f.prs.length, 1); assert.equal(f.prs[0].draft, false);
    assert.match(f.prs[0].body, /0\.42\.0.*0\.43\.1/); assert.match(f.prs[0].body, new RegExp(c.headSha));
    await finalizeUpdate({ ...args, smokeResult: 'failure', evidence: null }, f.deps);
    assert.equal(f.prs[0].draft, true);
  } finally { f.cleanup(); }
});

test('first failed validation still creates a draft PR', async () => {
  const f = fixture(); try {
    const c = await prepareUpdate(f.options, f.deps);
    assert.equal((await finalizeUpdate({ candidate: c, offlineResult: 'failure', smokeResult: 'skipped', evidence: null, runUrl: f.options.runUrl }, f.deps)).ready, false);
    assert.equal(f.prs[0].draft, true);
  } finally { f.cleanup(); }
});

test('registry errors have no branch or PR side effects', async () => {
  const f = fixture(); try {
    await assert.rejects(prepareUpdate(f.options, { ...f.deps, fetchPyPI: async () => { throw new Error('outage'); } }));
    assert.equal(f.ref('automation/headroom-update'), null); assert.equal(f.prs.length, 0);
    assert.equal(await prepareUpdate(f.options, { ...f.deps, fetchPyPI: async () => ({ releases: {} }) }), null);
  } finally { f.cleanup(); }
});

test('non-bot changes to the managed branch are never overwritten or promoted', async () => {
  const f = fixture(); try {
    const c = await prepareUpdate(f.options, f.deps);
    const manual = f.git(['commit-tree', f.git(['show', '-s', '--format=%T', c.headSha]), '-p', c.headSha, '-m', 'manual change']);
    f.git(['push', 'origin', `${manual}:refs/heads/automation/headroom-update`]);
    await assert.rejects(prepareUpdate(f.options, f.deps), /managed|ownership/i);
    assert.equal(f.ref('automation/headroom-update'), manual);
    assert.equal((await finalizeUpdate({ candidate: c, offlineResult: 'success', smokeResult: 'success', evidence: evidence(c), runUrl: f.options.runUrl }, f.deps)).action, 'stale');
    assert.equal(f.prs.length, 0);
  } finally { f.cleanup(); }
});

test('main advancement blocks promotion and regenerates from the new base', async () => {
  const f = fixture(); try {
    const c = await prepareUpdate(f.options, f.deps);
    const newerMain = f.git(['commit-tree', f.git(['show', '-s', '--format=%T', f.options.baseSha]), '-p', f.options.baseSha, '-m', 'main advanced']);
    f.git(['push', 'origin', `${newerMain}:refs/heads/main`]);
    assert.equal((await finalizeUpdate({ candidate: c, offlineResult: 'success', smokeResult: 'success', evidence: evidence(c), runUrl: f.options.runUrl }, f.deps)).action, 'stale');
    const next = await prepareUpdate({ ...f.options, baseSha: newerMain }, f.deps);
    assert.equal(next.baseSha, newerMain); assert.equal(next.extensionVersion, '0.2.0');
  } finally { f.cleanup(); }
});

test('push leases protect a branch changed during preparation', async () => {
  const f = fixture(); try {
    const c = await prepareUpdate(f.options, f.deps);
    const manual = f.git(['commit-tree', f.git(['show', '-s', '--format=%T', c.headSha]), '-p', c.headSha, '-m', 'concurrent manual edit']);
    const git = (args: string[]) => {
      if (args[0] === 'push') f.git(['push', 'origin', `${manual}:refs/heads/automation/headroom-update`]);
      return f.git(args);
    };
    await assert.rejects(prepareUpdate(f.options, { ...f.deps, git, fetchPyPI: async () => ({ releases: { '0.44.0': [{ yanked: false }] } }) }));
    assert.equal(f.ref('automation/headroom-update'), manual);
  } finally { f.cleanup(); }
});

test('candidate metadata cannot misrepresent the source and regeneration demotes a ready PR', async () => {
  const f = fixture(); try {
    const c = await prepareUpdate(f.options, f.deps);
    const args = { candidate: c, offlineResult: 'success', smokeResult: 'success', evidence: evidence(c), runUrl: f.options.runUrl };
    await assert.rejects(finalizeUpdate({ ...args, candidate: { ...c, headroomVersion: '0.99.0' } }, f.deps));
    await finalizeUpdate(args, f.deps);
    assert.equal(f.prs[0].draft, false);
    await prepareUpdate(f.options, { ...f.deps, fetchPyPI: async () => ({ releases: { '0.44.0': [{ yanked: false }] } }) });
    assert.equal(f.prs[0].draft, true);
  } finally { f.cleanup(); }
});

test('closed rejection suppresses the same candidate but not a newer release', async () => {
  const f = fixture(); try {
    const c = await prepareUpdate(f.options, f.deps);
    await finalizeUpdate({ candidate: c, offlineResult: 'failure', smokeResult: 'failure', evidence: null, runUrl: f.options.runUrl }, f.deps);
    f.prs[0].state = 'closed'; f.prs[0].merged_at = null;
    assert.equal(await prepareUpdate(f.options, f.deps), null);
    const newer = await prepareUpdate(f.options, { ...f.deps, fetchPyPI: async () => ({ releases: { '0.44.0': [{ yanked: false }] } }) });
    assert.equal(newer.headroomVersion, '0.44.0');
  } finally { f.cleanup(); }
});
