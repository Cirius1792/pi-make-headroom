# Publish a release to npm and GitHub

Use this guide to configure trusted publishing once, then release by pushing a stable `vX.Y.Z` tag. The npm package is **`@cltec/pi-make-headroom`**, not the previous unscoped package. GitHub Releases show the default Headroom pin read from that tag's `src/index.ts`; Headroom itself is installed later into the managed Python venv, not bundled in the npm archive.

## Prerequisites

- Maintainer access to `Cirius1792/pi-make-headroom`, with GitHub Actions enabled and permission to push release tags.
- Ownership of npm user scope `@cltec`, or publishing permission in the npm organization `cltec`.
- An npm account with verified email and two-factor authentication for the initial manual publication.
- Node 24 and npm **11.5.1 or newer** for trusted publishing. The workflow uses GitHub-hosted runners; self-hosted runners are not supported by this setup.
- Repository changes reviewed and merged through the normal pull-request process. Do not publish from an unreviewed or dirty checkout.

The workflow uses GitHub's built-in token for GitHub Releases and OIDC for npm. **Do not add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or a personal GitHub token as release secrets.** The repository URL in `package.json` must continue to match this GitHub repository.

## 1. Bootstrap the npm package once

Skip this step if `@cltec/pi-make-headroom` already exists and you maintain it. An existing unscoped package does not count: trusted publishers are configured per package.

Start from the reviewed checkout with scoped package version `0.1.0`:

```bash
node --version
npm --version
npm pkg get name version
npm test
npm pack --dry-run --ignore-scripts
```

Confirm the name is `@cltec/pi-make-headroom`, version is `0.1.0`, and the file list contains only `src/`, `README.md`, `LICENSE`, `CHANGELOG.md`, and `package.json`. In particular, never publish `.env`, credentials, logs, or local tooling.

Log in locally and publish. **The last command makes version `0.1.0` publicly available and cannot be undone by overwriting that version.**

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish --access public --registry=https://registry.npmjs.org/ --ignore-scripts
```

Complete npm's browser and 2FA prompts. Verify the public package at <https://www.npmjs.com/package/@cltec/pi-make-headroom>. Do not push `v0.1.0` as the first automated release: prepare a new version for the trusted publishing trial.

## 2. Authorize this GitHub workflow on npm

Open the scoped package on npm → **Settings → Trusted publishing → GitHub Actions**. Enter these values exactly (case-sensitive):

| Field | Value |
|---|---|
| Organization or user | `Cirius1792` |
| Repository | `pi-make-headroom` |
| Workflow filename | `release.yml` |
| Environment name | Leave blank |

The filename is **not** `.github/workflows/release.yml`. If the UI offers allowed actions, enable **direct `npm publish`**; staged-only permission would require manual approval for every publication. This workflow does not need permission to manage dist-tags separately.

The workflow must already exist at `.github/workflows/release.yml` in the repository. It grants `id-token: write` only to the publishing job and `contents: write` only to the GitHub Release job. No GitHub environment is configured, so leave npm's environment restriction blank.

Configure this when ready to release: npm currently requires the first successful publication within **two days** of adding the trusted publisher. If it expires, delete and recreate the configuration before retrying. See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/) for current requirements.

## 3. Prepare the next version in a pull request

For the first automated release, use `0.1.1` (manual bootstrap already used `0.1.0`):

```bash
git switch -c chore/release-v0.1.1
npm version 0.1.1 --no-git-tag-version
```

Update `CHANGELOG.md` with a `0.1.1` entry, then verify and commit:

```bash
npm test
npm pack --dry-run --ignore-scripts
git add package.json CHANGELOG.md
git commit -m "chore(release): prepare v0.1.1"
git push -u origin chore/release-v0.1.1
```

Open, review, and merge the pull request. The workflow does not bump versions or commit changes for you.

## 4. Push the release tag

Fetch the merged changes and verify that the commit you will tag contains the intended release and `package.json` version `0.1.1`:

```bash
git switch main
git pull --ff-only origin main
npm pkg get name version
git log -1 --oneline

git tag v0.1.1
git push origin v0.1.1
```

Push one release at a time and wait for completion. Releases share a concurrency group: an active publication is never cancelled by a newer tag, but GitHub retains at most one pending run in that group.

The **Release** workflow:

1. Runs tests on Node 22 and 24, checks module imports and packaging.
2. Requires a canonical stable tag matching `package.json` (`v0.1.1` ↔ `0.1.1`). Prerelease/build suffixes and leading zeroes are rejected.
3. Extracts the default Headroom pin from tagged source and packs one checked archive. Keep the single literal `const DEFAULT_VERSION` in the simple configuration prelude, before regex/template expressions; ambiguous pin text is rejected conservatively.
4. Publishes that archive publicly to npm using OIDC, without installing project dependencies.
5. Creates GitHub Release `v0.1.1`, including the npm install command, default `headroom-ai[proxy]==0.42.0` (or that tag's actual default), and generated GitHub change notes.

No GitHub Release is created if npm publication fails. Explicit `HEADROOM_VERSION` or `config.json` overrides are not changed by releasing the extension.

## 5. Verify and recover

Check all three outcomes:

- GitHub **Actions → Release** has successful validation, packaging, publishing, and GitHub Release jobs.
- npm lists `@cltec/pi-make-headroom@0.1.1`.
- GitHub Releases lists `v0.1.1` with the correct default Headroom version and install command.

For a public repository and public package, npm trusted publishing automatically generates provenance. After the first successful trusted publication, consider npm's **Publishing access → Require two-factor authentication and disallow tokens** setting, and protect `v*` tags using repository rulesets.

If publication fails:

- **Tag mismatch / invalid pin:** fix the release preparation through a PR before issuing a new tag. Do not move an already published tag or overwrite an npm version.
- **OIDC / authentication failure:** compare the exact owner, repository, workflow filename, environment, allowed actions, and expiry in npm settings. Verify the runner is GitHub-hosted and npm is >=11.5.1. `npm whoami` is not a test of OIDC authorization.
- **Registry outage / HTTP error:** the workflow stops instead of treating an error as an available version. Resolve the issue, then use GitHub's **Re-run failed jobs**.
- **npm succeeded but GitHub failed:** re-run failed jobs. If rerunning publishing too, it skips npm only when the registry's SHA-512 archive integrity matches the checked artifact. It then completes the missing GitHub Release. An existing GitHub Release is left unchanged.
- **Different archive integrity:** stop and investigate the published version and original workflow artifact. Do not disable the check to force a retry. Release a new version if the contents genuinely differ.
- **Expired artifact:** artifacts are retained for seven days. Re-run all jobs to rebuild from the same tagged checkout; a different npm archive still fails the integrity check safely.

See also [npm's public scoped package guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
