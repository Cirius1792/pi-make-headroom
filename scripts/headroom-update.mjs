import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseMetadata } from './release.mjs';
import { UPDATE_FILES, assessCompatibility, buildUpdateFiles, selectHeadroomRelease, stableParts } from './headroom-policy.mjs';
import { actionsOutput, createGit, ensureCommit, readEvidence, repositoryApi, requireRepository, requireSha } from './automation-github.mjs';

const BRANCH = 'automation/headroom-update';
const BOT = 'github-actions[bot]';
const TRAILER = 'Headroom-Automation: ';
function sourceSnapshot(git, sha) {
  ensureCommit(git, sha);
  return Object.fromEntries(UPDATE_FILES.map(path => [path, git(['show', `${sha}:${path}`])]));
}
function marker(pr) {
  const match = /<!-- headroom-update:(\{[^\r\n]*\}) -->/.exec(pr.body ?? '');
  try { return match ? JSON.parse(match[1]) : null; } catch { return null; }
}
function owned(pr) { return pr.user?.login === BOT && pr.head?.ref === BRANCH && pr.base?.ref === 'main' && marker(pr); }
async function pullRequests(api, repository) {
  const prs = [];
  for (let page = 1; page <= 100; page++) {
    const query = new URLSearchParams({ state: 'all', head: `${repository.split('/')[0]}:${BRANCH}`, base: 'main', per_page: '100', page: String(page) });
    const batch = await api('GET', `/pulls?${query}`);
    if (!Array.isArray(batch)) throw new Error('Invalid pull request listing');
    prs.push(...batch);
    if (batch.length < 100) return prs;
  }
  throw new Error('Managed PR history exceeds bounded pagination');
}
async function setDraft(api, pr, draft) {
  if (pr.draft === draft) return;
  await api('POST', '/graphql', { query: `mutation($id:ID!) { ${draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview'}(input:{pullRequestId:$id}) { pullRequest { id } } }`, variables: { id: pr.node_id } });
  pr.draft = draft;
}
function validateCandidate(c) {
  requireSha(c.baseSha); requireSha(c.headSha); stableParts(c.piVersion); stableParts(c.headroomVersion); stableParts(c.extensionVersion);
  if (c.branch !== BRANCH) throw new Error('Unexpected managed branch');
  return c;
}
async function inspectManaged(head, { api, git }) {
  requireSha(head);
  const commit = await api('GET', `/git/commits/${head}`);
  const lines = commit?.message?.split('\n').filter(line => line.startsWith(TRAILER)) ?? [];
  let meta;
  try { meta = JSON.parse(lines[0]?.slice(TRAILER.length)); } catch { throw new Error('Unrecognized managed branch ownership'); }
  if (lines.length !== 1 || commit.author?.name !== BOT || commit.parents?.length !== 1 || commit.parents[0].sha !== meta.baseSha) throw new Error('Unexpected managed branch ownership or commits');
  requireSha(meta.baseSha); stableParts(meta.headroomVersion);
  const base = sourceSnapshot(git, meta.baseSha);
  const generated = buildUpdateFiles(base, meta.headroomVersion, meta.date);
  const actual = sourceSnapshot(git, head);
  if (UPDATE_FILES.some(path => actual[path] !== generated.files[path])) throw new Error('Managed branch has non-bot content edits');
  const changed = git(['diff', '--name-only', meta.baseSha, head]).split('\n').filter(Boolean);
  if (changed.some(path => !UPDATE_FILES.includes(path))) throw new Error('Managed branch has unrelated edits');
  return { ...meta, extensionVersion: generated.extensionVersion };
}
export async function prepareUpdate(options, deps) {
  const { repository, baseSha, date, piVersion } = options;
  requireRepository(repository); requireSha(baseSha); stableParts(piVersion);
  const { api, git, fetchPyPI } = deps;
  const main = await api('GET', '/git/ref/heads/main');
  if (main?.object?.sha !== baseSha) throw new Error('Main advanced before candidate preparation; retry discovery');
  const files = sourceSnapshot(git, baseSha);
  const manifest = JSON.parse(files['package.json']);
  const pin = readReleaseMetadata(`v${manifest.version}`, manifest, files['src/index.ts']).headroomVersion;
  const candidate = selectHeadroomRelease(await fetchPyPI(), pin);
  if (!candidate) return null;
  const prs = await pullRequests(api, repository);
  const open = prs.filter(p => p.state === 'open');
  if (open.length > 1 || open.some(p => !owned(p))) throw new Error('Unrecognized managed pull request ownership');
  if (prs.some(p => p.state === 'closed' && !p.merged_at && owned(p) && marker(p).headroomVersion === candidate)) return null;
  const branch = await api('GET', `/git/ref/heads/${BRANCH}`);
  const previousSha = branch?.object?.sha;
  const previous = previousSha ? await inspectManaged(previousSha, deps) : null;
  if (previous?.baseSha === baseSha && previous.headroomVersion === candidate) {
    return validateCandidate({ baseSha, headSha: previousSha, headroomVersion: candidate, extensionVersion: previous.extensionVersion, piVersion, branch: BRANCH });
  }
  if (open[0]) await setDraft(api, open[0], true);
  const generated = buildUpdateFiles(files, candidate, date);
  const base = await api('GET', `/git/commits/${baseSha}`);
  const tree = await api('POST', '/git/trees', { base_tree: requireSha(base?.tree?.sha), tree: UPDATE_FILES.map(path => ({ path, mode: '100644', type: 'blob', content: generated.files[path] })) });
  const metadata = { baseSha, headroomVersion: candidate, date };
  const commit = await api('POST', '/git/commits', { message: `chore(headroom): update to ${candidate}\n\n${TRAILER}${JSON.stringify(metadata)}`, tree: requireSha(tree?.sha), parents: [baseSha], author: { name: BOT, email: '41898282+github-actions[bot]@users.noreply.github.com' } });
  const headSha = requireSha(commit?.sha);
  ensureCommit(git, headSha);
  // GitHub's ref PATCH does not have an expected-old-SHA argument. A real push
  // lease provides compare-and-swap protection against intervening manual edits.
  git(['push', `--force-with-lease=refs/heads/${BRANCH}:${previousSha ?? ''}`, 'origin', `${headSha}:refs/heads/${BRANCH}`]);
  return validateCandidate({ baseSha, headSha, headroomVersion: candidate, extensionVersion: generated.extensionVersion, piVersion, branch: BRANCH });
}
export async function finalizeUpdate({ candidate: c, offlineResult, smokeResult, evidence, runUrl }, deps) {
  validateCandidate(c);
  const repository = requireRepository(deps.repository);
  const { api } = deps;
  const url = new URL(runUrl);
  if (url.origin !== 'https://github.com' || !url.pathname.startsWith(`/${repository}/actions/runs/`) || !/^\d+$/.test(url.pathname.split('/').at(-1)) || url.search || url.hash) throw new Error('Invalid workflow run URL');
  const fresh = async () => (await api('GET', `/git/ref/heads/${BRANCH}`))?.object?.sha === c.headSha && (await api('GET', '/git/ref/heads/main'))?.object?.sha === c.baseSha;
  if (!await fresh()) return { action: 'stale', ready: false };
  const managed = await inspectManaged(c.headSha, deps);
  if (managed.baseSha !== c.baseSha || managed.headroomVersion !== c.headroomVersion || managed.extensionVersion !== c.extensionVersion) throw new Error('Candidate metadata differs from managed source');
  const original = sourceSnapshot(deps.git, c.baseSha);
  const manifest = JSON.parse(original['package.json']);
  const oldPin = readReleaseMetadata(`v${manifest.version}`, manifest, original['src/index.ts']).headroomVersion;
  const prs = await pullRequests(api, repository);
  const open = prs.filter(p => p.state === 'open');
  if (open.length > 1 || open.some(p => !owned(p))) throw new Error('Unrecognized managed pull request ownership');
  if (!open.length && prs.some(p => p.state === 'closed' && marker(p)?.headSha === c.headSha)) return { action: 'closed', ready: false };
  const assessment = assessCompatibility({ offlineResult, smokeResult, evidence, expected: { sha: c.headSha, piVersion: c.piVersion, headroomVersion: c.headroomVersion } });
  const body = `<!-- headroom-update:${JSON.stringify(c)} -->\n## Headroom update\n\n- Headroom: \`${oldPin}\` → \`${c.headroomVersion}\`\n- Extension: \`${c.extensionVersion}\`\n- Pi: \`${c.piVersion}\`; Python: \`3.11\`\n- Candidate: \`${c.headSha}\`\n- Result: **${assessment.ready ? 'passed' : 'unproven / failed'}** — ${assessment.reason}\n\n[Workflow run](${runUrl}) · [Sanitized smoke artifact](${runUrl}#artifacts)\n\nMerging this version bump authorizes automatic tagging and npm publication after merged-commit validation.\n`;
  let pr = open[0];
  if (pr) { await setDraft(api, pr, true); await api('PATCH', `/pulls/${pr.number}`, { title: `chore(headroom): update to ${c.headroomVersion}`, body }); }
  else pr = await api('POST', '/pulls', { head: BRANCH, base: 'main', title: `chore(headroom): update to ${c.headroomVersion}`, body, draft: true });
  if (assessment.ready && await fresh()) {
    await setDraft(api, pr, false);
    if (!await fresh()) { await setDraft(api, pr, true); return { action: 'stale', ready: false }; }
    return { action: 'ready', ready: true };
  }
  return { action: 'draft', ready: false };
}
async function main() {
  const repository = requireRepository(process.env.GITHUB_REPOSITORY);
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Missing workflow token');
  const deps = { repository, api: repositoryApi(repository, token), git: createGit(repository, token), fetchPyPI: async () => {
    let response;
    try { response = await fetch('https://pypi.org/pypi/headroom-ai/json', { signal: AbortSignal.timeout(30_000), redirect: 'error' }); }
    catch { throw new Error('PyPI lookup failed or timed out'); }
    if (!response.ok) throw new Error(`PyPI lookup failed (HTTP ${response.status})`);
    return response.json();
  } };
  if (process.argv[2] === 'prepare') {
    const { piVersion } = JSON.parse(readFileSync('scripts/headroom-automation.json', 'utf8'));
    const c = await prepareUpdate({ repository, baseSha: process.env.BASE_SHA ?? deps.git(['rev-parse', 'HEAD']), date: new Date().toISOString().slice(0, 10), piVersion }, deps);
    actionsOutput(c ? { has_update: 'true', candidate_sha: c.headSha, base_sha: c.baseSha, headroom_version: c.headroomVersion, extension_version: c.extensionVersion, pi_version: c.piVersion } : { has_update: 'false' });
  } else if (process.argv[2] === 'finalize') {
    const c = { baseSha: process.env.BASE_SHA, headSha: process.env.CANDIDATE_SHA, headroomVersion: process.env.HEADROOM_VERSION, extensionVersion: process.env.EXTENSION_VERSION, piVersion: process.env.PI_VERSION, branch: BRANCH };
    const result = await finalizeUpdate({ candidate: c, offlineResult: process.env.OFFLINE_RESULT, smokeResult: process.env.SMOKE_RESULT, evidence: readEvidence(process.env.E2E_RESULT_PATH), runUrl: `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}` }, deps);
    actionsOutput({ action: result.action, ready: result.ready });
  } else throw new Error('Usage: node scripts/headroom-update.mjs prepare|finalize');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
