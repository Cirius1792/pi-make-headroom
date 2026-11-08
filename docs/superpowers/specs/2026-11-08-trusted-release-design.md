# Tag-triggered trusted releases

## Intent and approval

Automate public npm publication and GitHub Release creation when the maintainer pushes a version tag. The user selected npm trusted publishing and approved preparing the repository with `0.1.0` as the manual bootstrap publication and `v0.1.1` as the first automated release.

## Approaches

- **Selected: npm trusted publishing (OIDC).** Authorize the GitHub repository and `release.yml` in npm package settings. No persistent npm publishing secret; a first manual publication is needed if the package does not already exist.
- **Rejected: npm publishing token in GitHub Secrets.** Easier bootstrap but adds credential storage and rotation.
- **Rejected: staged publication for every release.** Requires recurring manual approval rather than the requested tag-to-release automation.

## Design

- Rename the public npm package to `@cltec/pi-make-headroom`, keep version `0.1.0`, and declare public npm publishing. Preserve the repository URL and npm dependency-free runtime.
- Add `.github/workflows/release.yml`, triggered by pushed `v*` tags. Initially accept stable canonical `vX.Y.Z` releases only; reject malformed tags, prereleases, and mismatches with `package.json` before publication.
- Run tests on Node 22 and 24, the module import check, and package checks before publication. Use a GitHub-hosted runner with Node 24 and npm CLI >=11.5.1 for OIDC; grant `id-token: write` only to the publishing job and `contents: write` only to the release-creation job.
- Pack once and publish that checked archive using `npm publish --access public`. Do not install project dependencies or run a nonexistent build.
- Read the literal `DEFAULT_VERSION` from tagged `src/index.ts` without importing Pi-dependent extension wiring. Fail closed if it is missing or ambiguous. Include `Default Headroom version: headroom-ai[proxy]==<pin>` in the GitHub release body, along with the npm package/version and generated GitHub change notes.
- Create the GitHub Release only after npm publication succeeds. Serialize releases without cancelling an in-progress publish. Support recovery after npm succeeds but GitHub fails: verify the registry archive integrity against the local archive before skipping an existing npm version, then finish the missing GitHub Release. Do not treat arbitrary registry/authentication failures as an absent version.
- Update npm installation examples, package badge, release how-to guide, and changelog. Explicitly warn against installing scoped and previous unscoped extensions together. Preserve Git checkout URLs and local-directory examples.

## Maintainer steps

1. Review and merge the preparation changes using the repository's normal PR workflow.
2. Confirm ownership of npm scope `@cltec`, verified email, and 2FA; inspect package contents and manually publish `0.1.0` with public access if absent.
3. Configure the npm trusted publisher: owner `Cirius1792`, repository `pi-make-headroom`, filename `release.yml`, no environment restriction, direct `npm publish` allowed. Complete the first trusted publication within npm's documented configuration validation window.
4. Prepare `0.1.1` and changelog in a commit, merge it, then push tag `v0.1.1` on that commit. Inspect Actions, npm, and the GitHub Release.

## Constraints and non-goals

No actual publication, tags, pushes, npm login, or account changes during implementation. Do not read `.env` or modify the unrelated untracked `handoff.md`. No runtime code changes, Headroom pin changes (`0.42.0`), dependencies, existing CI changes, prerelease channels, or automatic version bumps. Updating stale package-name guidance in agent rules is allowed only to reflect the explicitly approved rename.

## Builder calls

Use GitHub CLI for GitHub Release creation and generated notes, avoiding another release action dependency. Keep release validation/metadata and retry decisions in a small dependency-free helper outside the published package, with offline Node tests. The maintainer remains responsible for protecting release tags and for npm/GitHub account configuration.
