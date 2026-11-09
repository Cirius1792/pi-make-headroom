# How automatic Headroom updates work

The update system turns a new upstream Headroom release into a tested pull request, then turns an approved version-bump merge into an extension release. It automates discovery, validation, and release execution—not the decision to accept an upgrade.

**Running discovery does not publish anything. Merging a deliberate extension version increase into `main` authorizes publication after the merged commit passes validation.** No update PR is automatically merged.

This page explains the mechanism. For repository setup and release recovery, use the [release guide](RELEASING.md#enable-headroom-update-automation); for the smoke test itself, use the [compatibility guide](COMPATIBILITY.md).

## Three workflows, two validation stages

| Workflow | Trigger | Responsibility |
| --- | --- | --- |
| [Headroom update](../.github/workflows/headroom-update.yml) | Nightly at **03:17 UTC**, or manual dispatch | Discover the newest eligible Headroom version, prepare a candidate, validate it, and create/update its draft or ready PR. |
| [Auto tag release](../.github/workflows/auto-tag.yml) | A push to `main`, including a PR merge | Detect an extension version increase, validate the exact merged commit, create or verify its tag, and request publication. |
| [Release](../.github/workflows/release.yml) | Explicit dispatch at a version tag, or a manually pushed `v*` tag | Validate the stable tag, prepare one checked npm archive, publish it, then create the GitHub Release. |

GitHub's nightly schedule is best-effort, not an exact-time guarantee. A manual **Headroom update** run follows the same discovery policy as the nightly run.

There are two validation stages because the candidate and the merged result can differ. Passing before review establishes that the proposed update works. Passing again after merge establishes that the commit actually being released works.

## 1. Discovery compares upstream with the built-in pin

Discovery reads the `DEFAULT_VERSION` literal in `src/index.ts` on `main`, then queries PyPI's `headroom-ai` release metadata. It chooses only the newest canonical stable `X.Y.Z` version newer than that pin and with at least one non-yanked distribution.

Prerelease, development, post-release, and local-version forms are not candidates. The workflow does not test every intervening release or fall back to an older candidate when the newest one fails. A registry/network error fails the run; it is not reported as “no update.”

If no newer eligible release exists, downstream validation and PR finalization are skipped. A previously rejected candidate is also skipped, as described below.

Discovery has no version inputs. It uses the pin and automation configuration from reviewed `main`, rather than a maintainer's local environment or an individual user's configuration.

## 2. One managed branch holds the proposed release

The workflow maintains **`automation/headroom-update`** and at most one open managed update PR. It generates a candidate directly from the current `main` snapshot, changing only:

- `src/index.ts`: the built-in Headroom pin.
- `package.json`: the next **minor** extension version, with patch reset to zero.
- `CHANGELOG.md`: a dated release entry carrying the Unreleased notes and pin change.
- `README.md` and `docs/CONFIGURATION.md`: the current-default examples and tables.

For example, if `main` contains extension `0.1.1` and Headroom `0.42.0`, discovering Headroom `0.43.1` proposes extension **`0.2.0`** with that new pin. The extension and Headroom versions are separate version sequences.

Rerunning discovery for an unchanged base and candidate reuses the same commit. A newer upstream candidate can replace it on the same branch and PR. The extension version is recalculated from `main`, so reruns do not repeatedly increment it.

The branch is automation-owned. Before replacing it, helpers verify the generated files, commit metadata, parent commit, and allowed file list. The push uses an expected-old-commit lease so intervening edits are not overwritten. Manual edits or unrecognized ownership stop automation rather than being silently discarded.

## 3. Validation is tied to the candidate commit

The preparation job passes the immutable candidate SHA (Git commit identifier) to two reusable workflows:

- **Offline CI** runs tests on Node 22 and 24, checks module imports, and checks package contents.
- **Compatibility smoke** runs real Pi, the packed candidate extension, and real managed Headroom. Only the upstream LLM is mocked, so no paid LLM credentials are needed.

The automated smoke baseline is **Pi `1.5.0`**, configured in [`scripts/headroom-automation.json`](../scripts/headroom-automation.json), and **Python `3.11`**. Headroom is the exact discovered candidate. The Pi baseline does not automatically float to the latest Pi release.

Smoke checks installation, health/status, and compression, and requires successful cleanup of its disposable processes and installations. Its sanitized **`compatibility-smoke-result`** artifact contains `compatibility-smoke-result.json`, including the extension commit, requested and actual versions, runtime versions, check outcomes, and cleanup result.

This is a networked integration check: installing Pi, Headroom, and model/tokenizer assets can take several minutes. A provisioning failure leaves compatibility unproven; it does not necessarily establish a software incompatibility. A pass covers the fixed version pair and tested environment, not every provider, platform, runtime, or failure scenario.

## 4. Evidence determines draft versus ready

Finalization requires both validation jobs to succeed and the report to match the exact candidate SHA, requested/actual Pi and Headroom versions, and Python 3.11. All three smoke checks, the overall outcome, and cleanup must pass.

| Situation | Result |
| --- | --- |
| Both jobs succeed and matching evidence passes | Create/update the managed PR and mark it ready for review. |
| A validation job fails, or evidence is missing, stale, mismatched, or failed | Keep/create the PR as draft, with the workflow run and sanitized evidence links. |
| `main` or the managed branch changes during the run | Refuse stale finalization; regenerate and validate again on a subsequent discovery run. |
| The workflow is cancelled | Do not run the promotion finalizer. |
| Preparation fails before producing a candidate | Fail the workflow; a PR may not be created. Inspect the run rather than waiting for a draft. |

The finalizer checks out the trusted base commit, not candidate code, and rechecks the branch and PR identities before mutations. Candidate-validation jobs have read-only repository permissions. These boundaries keep PR-write credentials separate from the candidate's validation execution.

“Ready” means the automation's gates passed, not that branch protection has been bypassed. Required PR checks, reviews, and any GitHub workflow approvals remain separate requirements.

Closing an unmerged managed PR rejects the Headroom version recorded in its actual head commit. Later discovery runs do not recreate that same candidate; a newer upstream release remains eligible. Closing is therefore a rejection, not the normal way to request a transient retry.

## 5. A version-bump merge starts a new release gate

Every push to `main` starts **Auto tag release**, but ordinary pushes with an unchanged package version stop after planning. This includes documentation-only merges. The planner compares the package versions at the full push's before/after commits; any deliberate stable version increase is eligible, not just Headroom-generated updates.

For an increase, it reruns offline CI and real smoke against the exact pushed commit, using that commit's default Headroom pin. Candidate-PR evidence is not reused as merged-commit evidence.

After both gates pass, the tag job verifies the release commit remains on `main`'s history and creates `vX.Y.Z` at that exact SHA—not at a newer moving `main` tip. Existing tags are never moved: a same-tag/same-commit retry is allowed; a tag pointing elsewhere stops the run.

The job then explicitly dispatches `release.yml` at the tag. This is necessary because a tag created with GitHub's built-in `GITHUB_TOKEN` does not trigger another push-event workflow. The **Release** workflow rejects branch-ref dispatches, including `main`; its input must be a stable version tag matching `package.json`.

## 6. Publication uses the checked archive

**Release** runs its validation, prepares one archive and release notes, and publishes that archive to **`@cltec/pi-make-headroom`** using npm trusted publishing/OIDC, which authenticates GitHub Actions without a stored npm publishing token. The configured trusted publisher remains `release.yml`; no new npm token, personal GitHub token, or GitHub App is required.

Only after npm succeeds does it create the GitHub Release. A successful dispatch request is not proof that either publication step finished. Retrying an already-published version is permitted only when the checked archive's integrity matches the registry; it never overwrites a published npm version.

Prepare one release at a time and wait for completion. The release workflows do not cancel an active release for a newer one, but their concurrency groups are not durable queues for every intermediate version bump. See [release verification and recovery](RELEASING.md#5-verify-and-recover) before retrying failed publication.

## What changes for extension users

This system publishes a new extension version; it does not immediately modify every user's installed extension or managed venv. Users receive the new built-in default when they upgrade the extension and use that default.

Explicit `HEADROOM_VERSION` and `config.json` version settings remain unchanged and take precedence. This includes a version in the starter configuration written on first run. An extension upgrade does not silently opt those users into the new pin. See [configuration](CONFIGURATION.md).

## Trying discovery without approving a release

The workflow must exist on GitHub's default branch, and Actions must be allowed to create PRs. After the [activation prerequisites](RELEASING.md#enable-headroom-update-automation) are satisfied, use **Actions → Headroom update → Run workflow** on `main`, or:

```bash
gh workflow run headroom-update.yml --repo Cirius1792/pi-make-headroom --ref main
gh run list --repo Cirius1792/pi-make-headroom --workflow headroom-update.yml
```

Inspect the run, candidate SHA, PR state, and smoke artifact. No PR means you should distinguish “no update” or a rejected candidate from an early preparation failure. A draft means validation is failed or unproven, not approval to merge.

**Do not merge the generated version bump merely to finish a trial:** that merge authorizes the post-merge tagging and publication path. Leave the PR open while investigating, rerun discovery for a transient problem, or close it only when deliberately rejecting that candidate.
