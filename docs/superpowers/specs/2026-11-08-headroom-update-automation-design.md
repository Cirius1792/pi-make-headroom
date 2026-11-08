# Automated Headroom updates and releases

Status: approved by the maintainer in conversation on 2026-11-08. Implementation is pending; this document alone does not install automation.

## Intent

Keep the extension's default Headroom pin current without manually discovering releases, editing version files, or pushing release tags. A maintainer reviews and merges an update PR; merging a deliberate extension version bump authorizes automatic tagging and publication through the existing trusted npm publishing workflow.

This design is for maintainers and implementers. The implementation will update the operational instructions in [RELEASING.md](../../RELEASING.md) and [COMPATIBILITY.md](../../COMPATIBILITY.md).

## Agreed behavior

- Discover new Headroom releases nightly by querying PyPI, where the managed installer obtains `headroom-ai`.
- Consider only the newest stable, non-yanked release, not every intervening release. Compare numeric version components, never version strings lexicographically.
- Run the existing real compatibility smoke with fixed Pi `1.5.0` and Python `3.11`. This smoke, not ordinary offline CI alone, is the compatibility gate.
- A passing update becomes a ready-for-review PR; a failing update becomes a draft PR with failure evidence. There is no automatic merge.
- Include a minor extension version bump in the update PR, e.g. `0.1.1` to `0.2.0`, plus the Headroom pin and changelog/documentation updates.
- Automatically tag and release deliberate extension version bumps merged or pushed into `main`, including manually prepared releases unrelated to Headroom. Ordinary pushes without a version increase do not publish.
- State Python **3.11+** as the supported minimum in the README and align the related documentation. Do not add a separate Python-floor approval policy: an upstream release incompatible with Python 3.11 fails the normal smoke gate.

## Approaches

1. **Selected: nightly PyPI discovery, reviewable PR, automatic release after merge.** This automates routine work while keeping maintainer review before irreversible publication. A scheduled check does not need cooperation from the upstream repository.
2. **Not selected: publish immediately after a nightly compatibility pass.** This removes the requested PR review boundary and lets upstream changes directly publish extension releases.
3. **Not selected: retain manual release tags after PR merge.** This is safe but leaves manual work the user explicitly wants automated.

For triggering publication, use the built-in `GITHUB_TOKEN` and explicitly dispatch `release.yml` at the new tag. A tag pushed with this token does not itself trigger a `push` workflow. A GitHub App or personal access token is not needed solely to make tagging trigger publication. Preserve the existing manual tag-push trigger as well.

## Discovery and update PR

### Schedule and candidate selection

Builder-selected default: run once nightly at **03:17 UTC**, with `workflow_dispatch` for manual checks and retries. GitHub schedules are best-effort; this is not a guarantee of discovery immediately after an upstream upload. Do not add an aging delay.

Query `https://pypi.org/pypi/headroom-ai/json` with a bounded timeout. Validate the response before using any values in git, files, workflow outputs, or API calls. An eligible version is canonical stable `X.Y.Z`, with at least one non-yanked distribution available. Exclude alpha, beta, release candidate, development, post, local, and epoch versions. Select the greatest eligible numeric version strictly newer than the repository's literal default pin. Do not silently fall back to an older candidate because the newest fails installation or smoke.

A registry timeout, malformed response, or HTTP error fails discovery visibly and creates no update PR. No new eligible version is a successful no-op. Do not infer a missing version from a registry failure.

### Preparing a candidate

Read current `main` and the unambiguous literal `DEFAULT_VERSION` in `src/index.ts`. Use dependency-free helpers and conservative source validation, following `scripts/release.mjs`; do not import Pi-dependent extension wiring to discover the pin.

Use a single managed branch, `automation/headroom-update`, and at most one open managed update PR. Prepare the candidate from current `main`, changing only:

- the default pin in `src/index.ts`;
- `package.json`, to the next minor version with patch reset to zero;
- a release entry in `CHANGELOG.md` identifying the old/new pin;
- current-default version references in README/configuration documentation, keeping historical evidence and fixture versions intact.

Derive the extension version from current `main` on every regeneration, not from a previous bot commit. Rechecking the same candidate must not repeatedly increment the version or append duplicate changelog entries. If `main` changes, regenerate and retest the managed branch before claiming the new revision is compatible. New upstream candidates supersede the older candidate in this one PR. Identify the managed branch/PR explicitly and refuse to overwrite an unrelated branch or non-bot edits.

### Validation and PR state

Run both offline CI (Node 22 and 24, module import, package checks) and the real compatibility smoke against the **exact candidate commit**, not the scheduled workflow's original `main` checkout. Make the existing CI and compatibility workflows callable while preserving their present push/PR/manual entry points. Add an explicit checkout-ref input where needed; use immutable commit SHAs for automated calls.

Store the automated Pi baseline `1.5.0` once in a small automation configuration file. Keep the smoke's existing explicit Pi-version input for manual investigations. Python stays `3.11`, with the current isolated installs, mocked LLM, bounded deadlines, telemetry-off behavior, sanitization, and cleanup checks unchanged.

The finalization job runs after validation even when tests fail. It creates or updates the managed PR:

- **Ready:** offline CI succeeds and the smoke reports installation, health/status, compression, and cleanup passed, with requested/actual versions and source SHA matching the candidate.
- **Draft:** validation fails, times out, or produces missing/invalid evidence. A failed infrastructure setup is not evidence of compatibility, but should be distinguished from an assertion failure in the PR summary.

If an existing ready PR is regenerated, put it back into draft before testing the new revision. Only successful checks for its current head can make it ready again. Superseded runs must not change the state of a newer revision. Cancelled or interrupted runs never promote a PR; a later nightly/manual run can retry.

The PR body includes old/new Headroom pins, extension version, fixed Pi/Python versions, candidate SHA, outcome, run link, and sanitized smoke evidence/artifact link. Reruns update this information rather than adding repeated comments.

Use direct/reusable workflow jobs for automation validation rather than relying on PR events generated by `GITHUB_TOKEN`. Repository settings must allow Actions to create PRs. If branch protection requires separate PR-triggered CI, preserve those checks and document any GitHub approval needed for bot-created PR workflow runs; do not bypass protection or claim that a PR body replaces required checks.

## Automatic tags after changes reach main

Add a workflow triggered by pushes to `main`, which also covers normal PR merges. Compare the package version before and after the push. A canonical stable version increase is release intent; an unchanged version is a no-op, while a changed but malformed or decreased version fails visibly. Do not automatically increment versions on `main` and do not create commits on `main`.

For a release-intent push:

1. Record the exact pushed commit SHA and validate the package identity, version, and default Headroom pin.
2. Call offline CI and the compatibility smoke for that exact merged SHA, using Pi `1.5.0`, Python `3.11`, and its pinned Headroom version. Candidate-branch evidence alone is not sufficient because the merge can change the result.
3. After both pass, create `v<package.json version>` at that SHA. Do not substitute the then-current tip of `main` if it has advanced.
4. Explicitly dispatch `release.yml` using the tag as the workflow ref. Dispatch is necessary because `GITHUB_TOKEN` tag creation does not generate another push-triggered workflow run.

The existing release workflow gains `workflow_dispatch`. Both entry points must require an actual canonical version-tag ref matching `package.json`; dispatching against `main` must fail closed. Keep npm OIDC publication in `release.yml`, preserving its checked archive, package-content checks, integrity-verified retries, generated notes, and GitHub Release only after npm succeeds.

Automatic tagging applies to any deliberate version increase, not only bot PRs. This does not authorize agents to push directly to `main`, merge PRs, or publish during implementation.

## Permissions, retries, and failures

Separate write-enabled git/PR/tag operations from read-only validation jobs. Real Headroom installation and smoke checks must not run with PR/tag write permissions, npm publishing credentials, or OIDC permission. Pass validated versions through environment variables/arguments, not interpolated shell commands. Keep action versions explicit and preserve the absence of runtime npm dependencies.

Use `contents: write` only where branch/tag creation needs it, `pull-requests: write` only for PR operations, and `actions: write` only where release dispatch needs it. The release workflow retains its existing narrowly scoped OIDC and release permissions. No new personal token, npm token, GitHub App, or branch-protection bypass is part of this design.

Serialize managed-branch mutation and guard every PR-state update with its expected head SHA. Serialize tag coordination without cancelling active release operations. GitHub concurrency is not a durable FIFO queue: keep the existing maintainer guidance to prepare one release at a time rather than promising to publish every intermediate push during a burst.

A rerun must verify an existing tag resolves to the intended commit, never move it, and fail on a conflicting tag. If the correct tag already exists, retry release dispatch so a previous dispatch failure is recoverable. Duplicate release dispatches remain safe through serialization and the existing archive-integrity checks. Do not republish different contents under the same npm version.

Errors remain visible through failed Actions runs, the draft PR, and existing summaries/artifacts. No new email, issue-per-failure system, automatic rollback, automatic merging, prerelease channel, or transitive-dependency locking is included. Recovery is a manual workflow rerun or a reviewed follow-up version, never tag movement.

## Scope of implementation and verification

Expected changes are the two new orchestration workflows, callable CI/smoke entry points, release dispatch/ref guards, dependency-free automation helpers/configuration, offline regression tests, README/configuration/release/compatibility documentation, and changelog. Preserve Python 3.10 handling for explicit legacy pins if it already works; declaring 3.11 as the supported baseline does not require removing backward-compatible interpreter code.

Do not change the default pin merely while installing this automation. The first nightly/manual update will propose the then-current upstream version through the normal PR path. Do not modify unrelated `.env` or `handoff.md`, add dependencies, publish, push tags, or change account settings during implementation.

Offline tests cover version selection, yanked/prerelease filtering, registry failures, safe pin edits, idempotent minor bumps, stale candidate/PR guards, validation-to-draft decisions, version-change release intent, exact-SHA tagging, conflicting/existing tags, and dispatch retry behavior. API effects should be testable with fixtures or stubs, without contacting GitHub/npm to publish.

Run `npm test`, the module import check, `npm pack --dry-run`, and workflow syntax validation where tooling is available. A live compatibility run on the candidate is required operational evidence, not something offline unit tests prove. Verify real PR creation/state changes and tag-to-dispatch behavior in a maintainer-approved GitHub trial before claiming the end-to-end automation is proven; any real npm publication remains explicitly authorized.

## Builder decisions and approval boundary

The builder may choose helper names, the automation configuration path, small GitHub CLI/API wrappers, test fixture organization, and exact workflow job boundaries consistent with the behavior above. Closed-PR retry details should honor a maintainer's explicit rejection rather than repeatedly recreating the same rejected candidate; newer candidates may still produce updates. No additional runtime-support policy is required.

Design approval authorizes implementation of CI/release configuration changes. It does not itself authorize running irreversible production publication, merging the implementation PR, pushing release tags, or changing repository/npm account settings.

Reference: [GitHub workflow-to-workflow triggering rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
