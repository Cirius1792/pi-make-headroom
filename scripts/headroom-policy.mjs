import { readReleaseMetadata } from './release.mjs';

const PACKAGE = '@cltec/pi-make-headroom';
export const UPDATE_FILES = ['src/index.ts', 'package.json', 'CHANGELOG.md', 'README.md', 'docs/CONFIGURATION.md'];
export function stableParts(version) {
  if (typeof version !== 'string' || version.length > 64 || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version) || version.endsWith('\n')) {
    throw new Error('Expected canonical stable X.Y.Z version');
  }
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Unsafe version components');
  return parts;
}
export function compareStableVersions(left, right) {
  const a = stableParts(left), b = stableParts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
export function selectHeadroomRelease(pypi, currentPin) {
  stableParts(currentPin);
  if (!pypi?.releases || typeof pypi.releases !== 'object' || Array.isArray(pypi.releases)) throw new Error('Malformed PyPI releases');
  let latest = null;
  for (const [version, distributions] of Object.entries(pypi.releases)) {
    try { stableParts(version); } catch { continue; }
    if (!Array.isArray(distributions) || distributions.some(d => !d || typeof d.yanked !== 'boolean')) throw new Error('Malformed PyPI distributions');
    if (!distributions.some(d => !d.yanked) || compareStableVersions(version, currentPin) <= 0) continue;
    if (!latest || compareStableVersions(version, latest) > 0) latest = version;
  }
  return latest;
}
function replaceExactly(text, regex, replacement, count) {
  if (typeof text !== 'string' || [...text.matchAll(regex)].length !== count) throw new Error('Missing or ambiguous current-default documentation anchor');
  return text.replace(regex, replacement);
}
export function buildUpdateFiles(input, candidate, date) {
  const manifest = JSON.parse(input['package.json']);
  const metadata = readReleaseMetadata(`v${manifest.version}`, manifest, input['src/index.ts']);
  if (compareStableVersions(candidate, metadata.headroomVersion) <= 0) throw new Error('Candidate must be newer than the source pin');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Invalid release date');
  const [major, minor] = stableParts(manifest.version);
  const extensionVersion = `${major}.${minor + 1}.0`;
  stableParts(extensionVersion);
  const files = { ...input };
  files['src/index.ts'] = input['src/index.ts'].replace(/(^[ \t]*const[ \t]+DEFAULT_VERSION[ \t]*=[ \t]*)(["'])([^"'\r\n]+)\2([ \t]*;)/m, (_, prefix, quote, _old, suffix) => `${prefix}${quote}${candidate}${quote}${suffix}`);
  files['package.json'] = input['package.json'].replace(/("version"\s*:\s*")[^"]+("\s*[,}])/, `$1${extensionVersion}$2`);
  if (JSON.parse(files['package.json']).version !== extensionVersion) throw new Error('Ambiguous manifest version');
  const old = metadata.headroomVersion.replaceAll('.', '\\.');
  files['README.md'] = replaceExactly(input['README.md'], new RegExp(`(\x60headroom-ai\\[proxy\\]==)${old}(\x60)`, 'g'), `$1${candidate}$2`, 2);
  const table = new RegExp(`(\\| \x60HEADROOM_VERSION\x60 \\| \x60)${old}(\x60 \\|)`, 'g');
  files['README.md'] = replaceExactly(files['README.md'], table, `$1${candidate}$2`, 1);
  files['docs/CONFIGURATION.md'] = replaceExactly(input['docs/CONFIGURATION.md'], table, `$1${candidate}$2`, 1);
  files['docs/CONFIGURATION.md'] = replaceExactly(files['docs/CONFIGURATION.md'], new RegExp(`(^  "version": ")${old}(",$)`, 'gm'), `$1${candidate}$2`, 1);
  const changelog = input['CHANGELOG.md'];
  if (typeof changelog !== 'string' || [...changelog.matchAll(/^## \[Unreleased\]\s*$/gm)].length !== 1 || changelog.includes(`## [${extensionVersion}]`)) throw new Error('Missing or ambiguous Unreleased changelog');
  files['CHANGELOG.md'] = changelog.replace(/^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m, (_, notes) =>
    `## [Unreleased]\n\n## [${extensionVersion}] - ${date}\n\n${notes.trim() ? `${notes.trim()}\n` : ''}- Updated the default Headroom pin from \`${metadata.headroomVersion}\` to \`${candidate}\`.\n\n`);
  return { files, headroomVersion: candidate, extensionVersion };
}
export function assessCompatibility({ offlineResult, smokeResult, evidence: e, expected }) {
  const failed = reason => ({ ready: false, reason });
  if (offlineResult !== 'success' || smokeResult !== 'success') return failed('Validation job failed, was cancelled, or did not run');
  if (!e || e.schemaVersion !== 1 || e.extensionCommit !== expected.sha) return failed('Missing, invalid, or stale smoke evidence');
  if (e.requested?.piVersion !== expected.piVersion || e.actual?.piVersion !== expected.piVersion || e.requested?.headroomVersion !== expected.headroomVersion || e.actual?.headroomVersion !== expected.headroomVersion || !/^3\.11\.\d+$/.test(e.actual?.pythonVersion ?? '')) return failed('Smoke runtime or version identity mismatch');
  if (e.outcome !== 'passed' || e.cleanup?.status !== 'passed' || ['installation', 'healthStatus', 'compression'].some(c => e.checks?.[c]?.status !== 'passed')) return failed('Smoke installation, health, compression, or cleanup did not pass');
  return { ready: true, reason: 'Offline CI and exact-version compatibility smoke passed' };
}
export function releaseIntent(previous, current) {
  if (previous?.name !== PACKAGE || current?.name !== PACKAGE) throw new Error('Unexpected package identity');
  const order = compareStableVersions(current.version, previous.version);
  if (order < 0) throw new Error('Package version decreased');
  return order === 0 ? null : { version: current.version, tag: `v${current.version}` };
}
