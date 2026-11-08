import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseMetadata } from './release.mjs';
import { assessCompatibility, releaseIntent, stableParts } from './headroom-policy.mjs';
import { actionsOutput, createGit, ensureCommit, readEvidence, repositoryApi, requireRepository, requireSha } from './automation-github.mjs';

function sourcePlan(sha, git) {
  requireSha(sha); ensureCommit(git, sha);
  const manifest = JSON.parse(git(['show', `${sha}:package.json`]));
  const metadata = readReleaseMetadata(`v${manifest.version}`, manifest, git(['show', `${sha}:src/index.ts`]));
  const { piVersion } = JSON.parse(git(['show', `${sha}:scripts/headroom-automation.json`]));
  stableParts(piVersion);
  return { sha, version: metadata.version, tag: metadata.tag, headroomVersion: metadata.headroomVersion, piVersion };
}
export async function planRelease({ beforeSha, afterSha }, { git }) {
  requireSha(beforeSha); requireSha(afterSha);
  ensureCommit(git, beforeSha); ensureCommit(git, afterSha);
  const previous = JSON.parse(git(['show', `${beforeSha}:package.json`]));
  const current = JSON.parse(git(['show', `${afterSha}:package.json`]));
  return releaseIntent(previous, current) ? sourcePlan(afterSha, git) : null;
}
async function resolveTag(ref, api) {
  let object = ref?.object;
  for (let depth = 0; depth < 5; depth++) {
    if (!object) break;
    requireSha(object.sha);
    if (object.type === 'commit') return object.sha;
    if (object.type !== 'tag') break;
    object = (await api('GET', `/git/tags/${object.sha}`))?.object;
  }
  throw new Error('Tag cannot be resolved safely to a commit');
}
export async function publishRelease({ plan, offlineResult, smokeResult, evidence }, { git, api }) {
  const source = sourcePlan(plan.sha, git);
  if (['sha', 'version', 'tag', 'headroomVersion', 'piVersion'].some(key => plan[key] !== source[key])) throw new Error('Release plan differs from source identity');
  const assessment = assessCompatibility({ offlineResult, smokeResult, evidence, expected: { sha: plan.sha, piVersion: plan.piVersion, headroomVersion: plan.headroomVersion } });
  if (!assessment.ready) throw new Error(assessment.reason);
  const ancestry = await api('GET', `/compare/${plan.sha}...main`);
  if (!['ahead', 'identical'].includes(ancestry?.status)) throw new Error('Release commit is no longer on main');
  const path = `/git/ref/tags/${plan.tag}`;
  let ref = await api('GET', path);
  if (!ref) {
    try { ref = await api('POST', '/git/refs', { ref: `refs/tags/${plan.tag}`, sha: plan.sha }); }
    catch (error) { ref = await api('GET', path); if (!ref) throw error; }
  }
  if (await resolveTag(ref, api) !== plan.sha) throw new Error('Existing tag points to another commit; refusing to move it');
  await api('POST', '/actions/workflows/release.yml/dispatches', { ref: plan.tag });
  return { tag: plan.tag, sha: plan.sha, dispatched: true };
}
async function main() {
  const repository = requireRepository(process.env.GITHUB_REPOSITORY);
  const token = process.env.GITHUB_TOKEN;
  const deps = { git: createGit(repository, token), api: repositoryApi(repository, token) };
  if (process.argv[2] === 'plan') {
    const plan = await planRelease({ beforeSha: process.env.BEFORE_SHA, afterSha: process.env.AFTER_SHA }, deps);
    actionsOutput(plan ? { should_release: 'true', release_sha: plan.sha, release_tag: plan.tag, headroom_version: plan.headroomVersion, pi_version: plan.piVersion } : { should_release: 'false' });
  } else if (process.argv[2] === 'publish') {
    if (!token) throw new Error('Missing workflow token');
    const plan = { sha: process.env.RELEASE_SHA, tag: process.env.RELEASE_TAG, version: process.env.RELEASE_TAG?.slice(1), headroomVersion: process.env.HEADROOM_VERSION, piVersion: process.env.PI_VERSION };
    const result = await publishRelease({ plan, offlineResult: process.env.OFFLINE_RESULT, smokeResult: process.env.SMOKE_RESULT, evidence: readEvidence(process.env.E2E_RESULT_PATH) }, deps);
    actionsOutput({ tag: result.tag, sha: result.sha, dispatched: result.dispatched });
  } else throw new Error('Usage: node scripts/tag-release.mjs plan|publish');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
