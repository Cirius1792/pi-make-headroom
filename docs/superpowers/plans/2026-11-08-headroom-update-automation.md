# Headroom Update Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover newer stable Headroom releases nightly, prepare tested reviewable update PRs, and automatically tag and publish deliberate extension version increases after they reach `main`.

**Architecture:** Keep version/file decisions in a pure dependency-free policy module, GitHub HTTP calls behind one small injectable adapter, and update/tag coordination in separate CLI modules. Reuse the existing CI and real compatibility smoke through callable workflows, with immutable checkout SHAs. Preserve `release.yml` as the sole npm OIDC publisher.

**Tech Stack:** GitHub Actions, dependency-free Node ES modules, `node:test`, Git/GitHub REST and GraphQL APIs, existing Python 3.11 compatibility harness.

**Spec:** `docs/superpowers/specs/2026-11-08-headroom-update-automation-design.md` (approved).

## Global Constraints

- Fixed automated Pi baseline **`1.5.0`**, stored once in `scripts/headroom-automation.json` as `{"piVersion":"1.5.0"}`.
- Automated smoke uses **Python `3.11`** and its existing Node 22.19+ within Node 22; offline CI remains Node **22 and 24**.
- Nightly discovery at **03:17 UTC** (`17 3 * * *`), plus manual dispatch; newest canonical stable non-yanked PyPI release only, strictly newer than the current default.
- One managed branch **`automation/headroom-update`** and at most one open managed PR; no automatic merge or direct commits to `main`.
- Update PR includes the next minor extension version (`0.1.1` → `0.2.0`), pin, changelog, and current-default documentation references. Do not bump the repository pin/version while installing automation.
- Ready only after offline CI and exact-SHA smoke pass; all other test/evidence outcomes remain draft.
- A deliberate canonical stable version increase reaching `main` triggers validation, exact-SHA tagging, and explicit dispatch of **`release.yml` at the tag** using `GITHUB_TOKEN`.
- No new npm dependencies, tokens, GitHub App, protection bypass, or live publication during implementation. Preserve all smoke isolation, telemetry, cleanup, and publishing-integrity protections.
- Public supported minimum becomes **Python 3.11+** in user docs; retain already-working legacy-pin interpreter behavior rather than removing runtime compatibility.
- Never read or modify the unrelated untracked `.env` or `handoff.md`.

## Review Focus

1. A manually edited managed branch must not be overwritten; test ownership/snapshot checks and compare-and-swap ref updates in Task 2.
2. `main` or the managed head can advance during smoke; stale finalization must not promote a newer or outdated-base revision (Task 2).
3. A passing process with wrong-SHA, wrong-version, or failed-cleanup evidence is still incompatible (Tasks 1 and 3).
4. A tag may be annotated, conflicting, or created before dispatch fails; resolve its commit, never move it, and make dispatch retryable (Task 4).
5. A multi-commit push or rebase merge may contain a version bump before its final commit; compare the full push's before/after manifests, not merely the final commit's first parent (Task 4).

## Problem and grounding

Today `ci.yml` runs offline Node tests/import/package checks, `compatibility-smoke.yml` is manual with explicit Pi/Headroom versions, and `release.yml` publishes on `v*` tag pushes. `scripts/release.mjs` already validates package identity, tag/version agreement, a safe literal default pin, package contents, and published archive integrity. `e2e/harness.ts` defines schema-version-1 smoke evidence including `extensionCommit`, requested/actual versions, three checks, and cleanup. Reuse these contracts; do not invent another publishing path or replace live compatibility with unit tests.

## Design decisions

- Use PyPI rather than upstream GitHub releases because the installer consumes PyPI distributions; stable numeric selection avoids lexicographic ordering and prerelease surprises.
- Regenerate an update from `main`, not from prior bot commits, so repeat runs cannot compound minor bumps or changelog edits. Reuse an unchanged candidate SHA instead of creating daily date-only commits.
- Use direct reusable validation calls; bot-generated PR events are not a reliable automatic gate with `GITHUB_TOKEN`. Keep normal PR checks and branch protection intact.
- Revalidate after merge because candidate-branch results cannot prove the merged tree. Use push `before` and `after` SHAs for release intent.
- Explicit dispatch avoids a persistent credential solely to trigger tag-push workflows. A dispatch endpoint accepting a request is not proof npm publication completed; retain release workflow logs/recovery.

## What changes where

| File | Responsibility |
| --- | --- |
| `scripts/headroom-policy.mjs` (new) | Pure version selection, file transformations, smoke evidence validation, release-intent decisions. |
| `scripts/headroom-automation.json` (new) | One automated Pi baseline. |
| `scripts/automation-github.mjs` (new) | Bounded authenticated GitHub requests and minimal REST/GraphQL operations. |
| `scripts/headroom-update.mjs` (new) | Prepare/reuse managed candidate and finalize PR state; CLI `prepare` / `finalize`. |
| `scripts/tag-release.mjs` (new) | Plan a release-intent push and create/verify tag then dispatch; CLI `plan` / `publish`. |
| `test/headroom-policy.test.ts` (new) | Pure policy and transformation regressions. |
| `test/headroom-update.test.ts` (new) | Update coordination with fake API and disposable real Git repositories. |
| `test/tag-release.test.ts` (new) | Release intent, tag identity, API failures, dispatch retry. |
| `test/automation-workflows.test.ts` (new) | Workflow trigger/input/ref/permission/gate regression checks. |
| `test/release.test.ts` | Manual release dispatch/ref guard coverage. |
| `.github/workflows/ci.yml` | Add callable entry point and explicit checkout-ref input; retain existing triggers/check names. |
| `.github/workflows/compatibility-smoke.yml` | Add callable entry point and explicit checkout-ref input; preserve manual smoke. |
| `.github/workflows/headroom-update.yml` (new) | Nightly preparation, read-only exact-candidate tests, always-run PR finalization. |
| `.github/workflows/auto-tag.yml` (new) | Main-push release intent, exact-merged-SHA validation, tag and dispatch. |
| `.github/workflows/release.yml`, `scripts/release.mjs` | Dispatch entry point and actual-tag-ref validation; preserve existing publisher. |
| `README.md`, `docs/{CONFIGURATION,COMPATIBILITY,RELEASING,TROUBLESHOOTING}.md`, `CHANGELOG.md` | Python minimum, automation behavior, permissions/activation and recovery instructions. |

## Tasks and implementation order

### Task 1: Pure update and release policy

**Files:** Create `scripts/headroom-policy.mjs`, `scripts/headroom-automation.json`, and `test/headroom-policy.test.ts`.

**Interfaces:** Export these functions, with plain objects and JSDoc rather than new runtime types:
- `compareStableVersions(left, right) -> -1 | 0 | 1`: validate canonical stable versions, compare numeric components, reject unsafe numeric components rather than round them.
- `selectHeadroomRelease(pypi, currentPin) -> string | null`: select maximum eligible version with at least one explicitly non-yanked distribution; validate the PyPI object and distinguish malformed data from no eligible upgrade.
- `buildUpdateFiles(files, candidate, date) -> { files, headroomVersion, extensionVersion }`: `files` is a path-to-UTF-8-text object containing the five editable files; use existing `readReleaseMetadata` to validate identity/pin and derive the next minor from the base manifest.
- `assessCompatibility({offlineResult, smokeResult, evidence, expected}) -> { ready, reason }`: `expected` is `{sha, piVersion, headroomVersion}`; require both job results `success`, schema `1`, exact SHA and requested/actual version matches, Python `3.11.x`, three checks plus cleanup passed, and `outcome: passed`.
- `releaseIntent(previousManifest, currentManifest) -> null | {version, tag}`: equal versions no-op; validate package identity and canonical versions; only a strict increase authorizes a tag.

- [x] **Step 1: Write failing policy tests.** Assert numeric ordering (`0.9.0 < 0.10.0`), newest stable selection, prerelease/dev/post/local/epoch exclusion, all-yanked exclusion, missing distribution metadata rejection, empty/no-new-release no-op, malformed payload rejection, and unsafe numeric/injection strings rejected. Mocked HTTP failures are added at the I/O boundary in Task 2.
- [x] **Step 2: Run** `node --test test/headroom-policy.test.ts`; expect module-not-found failure before implementation.
- [x] **Step 3: Implement version selection and the automation config.** Add fetch-independent pure code, and store `1.5.0` only in the configuration (test expectations/docs may repeat it).
- [x] **Step 4: Add failing transformation tests.** Given base `0.1.1` and pin `0.42.0`, candidate `0.43.1` yields extension `0.2.0`; running against the same base yields byte-identical output. Preserve quote/style and unrelated source text, refuse ambiguous/nonliteral pins, edit only current-default README/config references, and preserve historical versions/test fixtures. Move existing Unreleased notes once into the new dated release entry alongside the pin update, leaving an empty Unreleased section. Preserve historical release sections. Abort when required documentation/changelog anchors are ambiguous.
- [x] **Step 5: Implement `buildUpdateFiles`.** Transform only `src/index.ts`, `package.json`, `CHANGELOG.md`, `README.md`, and `docs/CONFIGURATION.md`; no global replace of every historical version string.
- [x] **Step 6: Add and implement evidence/release-intent tests.** Assert ready for correct successful evidence; draft for missing/invalid JSON, wrong SHA, requested/actual mismatch, wrong Python, each failed/not-run check, cleanup failure, or failed/cancelled/skipped jobs. Assert unchanged package version no-op, `0.1.1 → 0.2.0` intent, malformed/decreased version rejection, and package-identity mismatch rejection.
- [x] **Step 7: Run** `node --test test/headroom-policy.test.ts` and `npm test`; require zero failures. Commit only this task's files as `feat(automation): add Headroom update and release policy`.

### Task 2: Managed branch and PR coordination

**Files:** Create `scripts/automation-github.mjs`, `scripts/headroom-update.mjs`, `test/headroom-update.test.ts`.

**Consumes:** Task 1 policy functions/config and existing release metadata validation.

**Produces:**
- `githubRequest(path, {method, body, token, request = fetch}) -> Promise<object | null>`: GitHub-relative REST path or `/graphql`, bounded timeout, explicit JSON handling/status classification; never print tokens or raw response bodies. Endpoint owners must distinguish a genuine 404 from authentication/outage errors.
- `prepareUpdate(options, deps) -> Promise<null | Candidate>`: `options` contains `{repository, baseSha, runUrl, date, piVersion}`; `deps` supplies `{githubRequest, fetchPyPI, git}`. `git(args)` is an argument-array command boundary operating in an explicit checkout. Candidate is `{baseSha, headSha, headroomVersion, extensionVersion, piVersion, branch}`.
- `finalizeUpdate({candidate, offlineResult, smokeResult, evidence, runUrl}, deps) -> Promise<{action, ready}>`: assess evidence, recheck current managed head/base/PR ownership, then create/update/draft/promote the one PR. Stale finalization returns `action: stale` without promoting.
- CLI `prepare` emits validated single-line Actions outputs `candidate_sha`, `base_sha`, `headroom_version`, `extension_version`, `pi_version`, and `has_update`. CLI `finalize` reads only these validated metadata values plus a bounded smoke JSON file and job results. Use standard `GITHUB_REPOSITORY`, `GITHUB_TOKEN`, and `GITHUB_RUN_ID` context via environment, never command-text interpolation.

- [x] **Step 1: Write failing adapter tests.** Exercise mocked 200/201/204, genuine 404, 401/403/429/5xx, network timeout, malformed JSON, and pagination where listing managed PR history. Assert credentials never appear in error text.
- [x] **Step 2: Run** `node --test test/headroom-update.test.ts`; expect missing-module/export failure. Implement the minimal bounded GitHub adapter and injected PyPI lookup.
- [x] **Step 3: Write failing preparation tests in disposable Git repositories.** First candidate produces one commit from the intended base and next-minor files; unchanged base/candidate reuses its exact head/date; newer candidate or changed main regenerates from base rather than compounding changes. Registry failures create no branch/PR. Rejected closed/unmerged PR skips the same candidate, but a newer version is eligible. All fixtures use temporary directories and cleanup.
- [x] **Step 4: Implement managed-branch ownership and compare-and-swap updates.** Use a bot-owned PR marker and bot commit trailers recording base SHA, candidate, and preparation date. Reconstruct the expected generated snapshot from that recorded base/date to verify an existing branch before reuse/replacement. Reject extra commits, changed files/content, unexpected PR ownership, or ref races. Push only `automation/headroom-update`, using a lease on its previously observed SHA. Do not use a force push without a lease. Mark an existing managed PR draft before replacing its head; do not create a new PR before validation finalization.
- [x] **Step 5: Write failing finalization tests.** Passing evidence creates ready PR; failed/missing evidence creates draft; repeat finalization updates one PR/body rather than duplicating comments. A later failure demotes a previously ready managed PR. Main advancement, head replacement, non-bot edits, or closed/merged PR during testing cannot be promoted. Escape Markdown/HTML metacharacters in summaries; include candidate SHA, versions, run/artifact links and classified outcome without raw command logs.
- [x] **Step 6: Implement finalization and CLI metadata validation.** Re-fetch base/head immediately before state changes and refuse stale evidence; enforce typed/validated versions and SHAs on all outputs/inputs. Distinguish discovery error (no new PR) from validation error (draft PR). Treat an interrupted prepare/finalize as recoverable on the next run, not proof of success.
- [x] **Step 7: Run** `node --test test/headroom-policy.test.ts test/headroom-update.test.ts` and `npm test`; require zero failures. Commit as `feat(automation): coordinate managed Headroom update pull requests`.

### Task 3: Callable exact-SHA validation and nightly workflow

**Files:** Modify `.github/workflows/{ci,compatibility-smoke}.yml`; create `.github/workflows/headroom-update.yml` and `test/automation-workflows.test.ts`.

**Consumes:** Task 2 CLI outputs and `finalize` contract.

**Produces:** Reusable CI with optional string `checkout_ref`; reusable compatibility smoke with required string `pi_version`, `headroom_version`, optional string `checkout_ref`; defaults preserve each original event's checkout behavior. Automated callers pass full commit SHAs. Preserve artifact name `compatibility-smoke-result` and schema `1`.

- [x] **Step 1: Add failing workflow contract tests.** Assert original CI push/PR and smoke manual inputs remain, both have `workflow_call`, explicit refs reach checkout, credentials are not persisted, original Node matrix and Python/deadlines remain, and no runtime dependency install is introduced. Use focused text/structure assertions for regression contracts, not a home-grown YAML parser. Validate actual syntax with `actionlint` when available.
- [x] **Step 2: Run** `node --test test/automation-workflows.test.ts`; expect assertions to fail against existing workflows. Add the reusable entry points and checkout input to both workflows without changing existing job/check names.
- [x] **Step 3: Add failing nightly orchestration tests.** Assert schedule `17 3 * * *`, manual trigger, constant managed-branch mutation concurrency, read-only validation permissions, pinned Pi from one config, candidate SHA passed to both reusable calls, and finalization guarded by `always()` plus a successfully prepared candidate. A test failure must not skip draft-PR finalization; cancelled/missing results cannot yield ready.
- [x] **Step 4: Implement `.github/workflows/headroom-update.yml`.** Jobs: `prepare` (trusted main checkout; contents/PR write), `offline` (reusable CI, contents read), `smoke` (reusable smoke, contents read), `finalize` (trusted main helper checkout; contents read/PR write). Pass no write token to the smoke job. Capture the exact helper/base ref in preparation and use that trusted immutable ref in finalization; do not execute candidate files there. Download the smoke report in finalization; absent or invalid report yields draft, not promotion. Calls to reusable workflows must propagate only required permissions, not inherit broad secrets.
- [x] **Step 5: Add scenario assertions with Task 2 stubs.** Simulate preparation → CI/smoke success → ready, preparation → smoke failure → draft, no candidate → no validation/PR, and stale candidate → no promotion. Verify `HEADROOM_VERSION` supplied to smoke equals the candidate's source default, not the old main pin.
- [x] **Step 6: Run** the workflow/helper tests, `npm test`, and `actionlint .github/workflows/*.yml` if installed. Record unavailable tooling as a limitation, not successful validation. Commit as `ci(headroom): discover and test nightly update candidates`.

### Task 4: Exact-commit automatic tags and release dispatch

**Files:** Create `scripts/tag-release.mjs`, `test/tag-release.test.ts`, `.github/workflows/auto-tag.yml`; modify `scripts/release.mjs`, `test/release.test.ts`, `.github/workflows/release.yml`, and workflow contract tests.

**Consumes:** `releaseIntent`, `assessCompatibility`, Task 2 API adapter, reusable CI/smoke, and fixed Pi config.

**Produces:**
- `planRelease({beforeSha, afterSha}, deps) -> Promise<null | ReleasePlan>`: inspect manifests at push endpoints; ReleasePlan is `{sha, version, tag, headroomVersion, piVersion}`. Validate nonzero full SHAs and manifest/pin identity. Do not derive the before version solely from the last commit's parent.
- `publishRelease({plan, offlineResult, smokeResult, evidence}, deps) -> Promise<{tag, sha, dispatched}>`: revalidate exact-SHA evidence, create or verify the tag, explicitly dispatch `release.yml` with `{ref: plan.tag}`. `deps` supplies the GitHub request and Git boundary; never run npm publish here.
- `validateReleaseRef(refType, refName) -> string` exported by `scripts/release.mjs`: require `refType === 'tag'` and canonical `vX.Y.Z`; return the tag. The release workflow supplies real `github.ref_type`/`github.ref_name` via environment to the prepare CLI; explicit local CLI tests also supply those environment values.

- [x] **Step 1: Write failing release-intent integration tests.** An unchanged version skips all tag/dispatch operations; a multi-commit push/rebase with an earlier version bump produces the final `afterSha` release plan. Reject zero/unavailable before SHAs, wrong identity, decreased/malformed version, invalid SHA strings, and ambiguous pin. No inference from unrelated current worktree contents.
- [x] **Step 2: Run** `node --test test/tag-release.test.ts`; expect missing exports. Implement the read-only `plan` CLI, emitting `should_release`, `release_sha`, `release_tag`, `headroom_version`, and `pi_version` with validated values.
- [x] **Step 3: Write failing tag/dispatch tests.** Successful exact-SHA validation creates a lightweight tag then dispatches at that tag. Existing lightweight/annotated tags resolving to the same SHA dispatch again; conflicting/dangling/unresolvable tags fail without updating/deleting refs. If tag creation races, re-read and verify instead of overwriting. A failed dispatch followed by rerun reuses the same tag. Failed checks/missing/wrong evidence create neither tag nor dispatch. Bound annotated-tag dereferencing and handle genuine-not-found separately from API outages.
- [x] **Step 4: Implement `publishRelease` and its CLI.** Re-read the tagged source identity before dispatch; job executes only trusted merged source, never artifact code. An API dispatch acknowledgement means only dispatch accepted, not published. Preserve existing publisher integrity checks as the authority for publication recovery.
- [x] **Step 5: Add failing release-ref tests.** `('tag', 'v0.2.0')` accepted; branch `main`, branch named `v0.2.0`, malformed/prerelease tags rejected. Update prepare-CLI fixture environment accordingly; preserve all existing release tests. Implement the guard and add `workflow_dispatch` to `release.yml`; both manual tag push and explicit dispatch must reach the same validation/publishing jobs.
- [x] **Step 6: Implement `.github/workflows/auto-tag.yml` and contract assertions.** Trigger only push to `main`; jobs `plan` → read-only reusable `offline` and `smoke` → `tag` with narrowly scoped contents/actions write. Gate tag job on both successful jobs and exact-SHA smoke artifact verification. Checkout/pass the original push SHA, never the latest `main` tip. Use global non-cancelling tag coordination concurrency. Retain ordinary `ci.yml` main runs even if validation duplicates work; avoiding complex cross-workflow privilege/evidence coupling is worth this small cost.
- [x] **Step 7: Run** `node --test test/tag-release.test.ts test/release.test.ts test/automation-workflows.test.ts`, `npm test`, and available actionlint. Commit as `feat(release): tag validated main version bumps and dispatch publishing`.

### Task 5: Documentation, complete regression evidence, and activation handoff

**Files:** Modify `README.md`, `docs/CONFIGURATION.md`, `docs/COMPATIBILITY.md`, `docs/RELEASING.md`, `docs/TROUBLESHOOTING.md`, and `CHANGELOG.md`. Preserve historical compatibility evidence and explicit legacy-pin runtime behavior. Do not edit agent-rule files as incidental cleanup; they remain authoritative about historical technical capability.

**Consumes:** Exact implemented workflow names, commands, permissions, and recovery behavior from Tasks 1–4.

**Produces:** Maintainer activation/recovery guide and accurate user-visible requirements; no actual GitHub/npm configuration or publication.

- [x] **Step 1: Update README requirements to `Python 3.11 or newer`**, align Python requirement/troubleshooting wording in related user docs, and distinguish the supported baseline from the historical version-dependent installer floor. Keep currently shipped default pin `0.42.0` accurate until a separate update PR is merged.
- [x] **Step 2: Document nightly/manual discovery, draft/ready outcomes, baseline Pi location, exact-SHA evidence, and closed/rejected candidate behavior.** Explain Actions permission to create PRs and approve bot PR runs if required by GitHub/protection; do not imply direct reusable runs replace branch-required checks.
- [x] **Step 3: Revise the release how-to.** Merging a deliberate package version increase becomes the routine release authorization; manual tag-push remains supported. Explain `GITHUB_TOKEN` explicit dispatch, same-tag/same-SHA retry, conflicting tag refusal, version-bump rebasing when another release lands, one-release-at-a-time/concurrency limitations, draft failure investigation, and existing npm integrity recovery. Note that npm trusted publishing remains bound to `release.yml`.
- [x] **Step 4: Add an Unreleased changelog entry** for automation and Python 3.11 supported minimum. Do not bump `package.json` or `DEFAULT_VERSION` for installing the workflows. Check documentation links and exact names against implemented files.
- [x] **Step 5: Run and paste final evidence:** `npm test`; `node --experimental-strip-types -e "await import('./src/proxy-manager.ts')"`; `npm pack --dry-run --ignore-scripts`; `git diff --check`; `actionlint .github/workflows/*.yml` if available. Require no failed tests, import exit 0, only approved package paths, and no workflow diagnostics. Do not install dependencies to manufacture a passing check. If Node/npm remains unavailable, stop before claiming verified implementation and report the blocked commands.
- [x] **Step 6: Request a fresh whole-branch review** against the approved spec and this plan; resolve substantive findings with regression tests. Run affected tests plus `npm test` again after any fixes. Commit docs as `docs(automation): explain Headroom update and automatic release workflow`.
- [x] **Step 7: Hand off activation for explicit maintainer authorization.** List enabling PR creation, merging the implementation, manually running discovery, inspecting one ready/draft trial, and eventually approving a real version-bump merge. Local API-stub tests do not prove real GitHub permissions or npm publication. Do not push tags, publish, or merge merely to demonstrate success.

## Execution prerequisites and review status

- Maintainer approved native execution. All five tasks were implemented on `docs/headroom-update-automation`, with no remote pushes, merges, tag creation, or publication.
- The original shell lacked Node/npm. Verified official portable Node **24.11.0** and **22.19.0** now live under ignored `.agents/tools`; no project dependencies were added. Both runtimes pass **151 tests, 0 failures**. Node 22 import and package checks pass; package contents remain 11 approved files.
- `actionlint` **1.7.11** was built into ignored tooling via Go checksum-verified modules; all workflows validate without diagnostics.
- Fresh whole-branch review identified cancellation, closed-regenerated-PR rejection, and stale PR-write races. All were reproduced RED and corrected GREEN in one fix pass; a further regression ensures refreshed draft state is used rather than an old HTTP snapshot. Failure summaries expose only allowlisted stage/category/status values. Detailed evidence/rulings are in this plan's ignored `.superpowers/sdd/2026-11-08-headroom-update-automation/progress.md` ledger.
- Activation remains a maintainer action: allow Actions PR creation, review/merge the implementation, then run a discovery trial and authorize a real version-bump merge. Real GitHub permission/PR/tag-dispatch behavior and npm publication have not been live-tested. A subsequent act 0.2.97 Docker trial did execute both reusable CI matrices (151 tests each), real Pi 1.5.0 / Headroom 0.43.1 / Python 3.11.18 smoke (including cleanup), artifact transfer, and release packaging successfully. The synthetic unpublished candidate was stopped by the real-main ancestry guard before remote tagging. Nightly discovery orchestration had only a dry run. These local trials do not prove the remaining real GitHub/npm outcomes.
- Act follow-up found repository-dependent test fixtures that failed after a legitimate default-pin/version bump. Fixed historical fixtures and added `test/headroom-candidate.test.ts`, observed RED→GREEN with a real changed-defaults snapshot. Full local results and reproduction settings are in ignored `.agents/act-checks/RESULTS.md`; the sanitized real smoke JSON is `.agents/act-checks/compatibility-smoke-result.json`.
- This checklist is complete as implementation work, not authorization to activate or publish. The local plan remains uncommitted, following the plan-review convention.
