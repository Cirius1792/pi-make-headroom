import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

export function requireSha(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value) || value.endsWith('\n') || /^0+$/.test(value)) throw new Error('Expected nonzero full commit SHA');
  return value;
}
export function requireRepository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || value.endsWith('\n')) throw new Error('Invalid repository');
  return value;
}
export async function githubRequest(path, { method = 'GET', body, token, request = fetch } = {}) {
  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path)) throw new Error('Invalid GitHub API path');
  let response;
  try {
    response = await request(`https://api.github.com${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
  } catch { throw new Error('GitHub request failed or timed out'); }
  if (response.status === 404 || response.status === 204) return null;
  if (!response.ok) throw new Error(`GitHub request failed (HTTP ${response.status})`);
  try {
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error();
    const result = JSON.parse(text);
    if (result?.errors) throw new Error();
    return result;
  } catch { throw new Error('Invalid GitHub response'); }
}
export function repositoryApi(repository, token, request = fetch) {
  requireRepository(repository);
  return (method, path, body) => githubRequest(path === '/graphql' ? path : `/repos/${repository}${path}`, { method, body, token, request });
}
export function createGit(repository, token) {
  requireRepository(repository);
  // Environment-based config keeps credentials out of argv and persisted git config.
  const env = { ...process.env };
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` });
  return args => {
    try {
      const text = execFileSync('git', args, { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
      return args[0] === 'show' && args[1]?.includes(':') ? text : text.trimEnd();
    }
    catch { throw new Error('Git operation failed; inspect workflow context, not credential-bearing command output'); }
  };
}
export function ensureCommit(git, sha) {
  requireSha(sha);
  try { git(['cat-file', '-e', `${sha}^{commit}`]); }
  catch { git(['fetch', '--no-tags', 'origin', sha]); }
}
export function actionsOutput(values) {
  const text = Object.entries(values).map(([key, value]) => {
    if (!/^[a-z_]+$/.test(key) || /[\r\n]/.test(String(value))) throw new Error('Unsafe Actions output');
    return `${key}=${value}\n`;
  }).join('');
  process.stdout.write(text);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
}
export function readEvidence(path) {
  try {
    const content = readFileSync(path, 'utf8');
    return content.length <= 1_000_000 ? JSON.parse(content) : null;
  } catch { return null; }
}
