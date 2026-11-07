# Check a Pi / Headroom version pair

Use this maintainer smoke check before proposing a Pi or Headroom upgrade. One invocation exercises real Pi, the packed extension from the checkout, and real managed Headroom. Only the upstream LLM is mocked: no paid LLM or API credentials are needed.

## Before running

- Use Linux with `/proc`, Git, `tar`, npm, Node **22.19+ within Node 22**, and Python **3.11** with `venv`, `ensurepip`, and pip support. These are fixed smoke-test runtimes, not the extension's general runtime requirements.
- Start from a clean checkout of the commit you want to check. The runner records `git rev-parse HEAD` and packs the working checkout; uncommitted changes would make that SHA misleading. Do not install project npm dependencies.
- Allow npm/PyPI package downloads and Headroom model/tokenizer assets. Access to npm, `pypi.org`/`files.pythonhosted.org`, and asset hosts such as `huggingface.co` must work; additional hosts depend on the selected releases. Downloads need disk space and can take several minutes. This is not an offline check, and exact top-level versions do not lock transitive dependencies.
- Choose two exact published versions. Pi accepts npm semantic release/prerelease versions, not tags or ranges. Headroom accepts canonical `X.Y.Z`, `X.Y.ZaN`, `X.Y.ZbN`, or `X.Y.ZrcN` only, with no numeric leading zeroes except zero itself. Do not use `latest`, wildcards, whitespace, or Headroom post/dev/local/epoch forms or spellings such as `0.43.0-rc.1`. Invalid or unavailable versions fail; the runner never substitutes another release.

The current baseline candidate, Pi `1.5.0` with Headroom `0.42.0`, has passed this runner locally three times on Linux with Node `22.19.0` and Python `3.11.15` from fresh workspaces: all three checks passed, cleanup passed, and target-turn savings were `32346` tokens (`101580` to `174` historical assistant characters). This is a validated baseline for these fixed runtimes, not a guarantee for other versions or environments. The GitHub workflow has not yet been dispatched, so remote acceptance is still pending.

## Run in GitHub Actions

1. Ensure the separate [Compatibility smoke workflow](../.github/workflows/compatibility-smoke.yml) is available in the repository's Actions UI. GitHub requires a dispatchable workflow on the default branch; select the branch containing the commit you want to check.
2. Open **Actions → Compatibility smoke → Run workflow**.
3. Set both required strings, **pi_version** and **headroom_version**, to your exact candidate versions. Neither has a default. Run the workflow.
4. Read the job summary and download the **compatibility-smoke-result** artifact. It contains only `compatibility-smoke-result.json`; the job writes it at `${{ runner.temp }}/compatibility-smoke-result.json`.

The one Ubuntu job provisions Node 22 and Python 3.11 and passes the selected interpreter's absolute path. The runner has a 30-minute overall deadline; the job has a 35-minute timeout. It uses disposable installations, not cached venvs or Pi homes, and does not change the existing offline CI checks. If setup fails before a report exists, the summary says no smoke result was produced; the job still fails. Abrupt runner termination can prevent report publication.

## Run locally

From the clean repository root, enter your candidate versions and invoke the same runner:

```bash
read -r -p 'Exact Pi version: ' PI_VERSION
read -r -p 'Exact canonical Headroom version: ' HEADROOM_VERSION
PI_VERSION="$PI_VERSION" \
HEADROOM_VERSION="$HEADROOM_VERSION" \
HEADROOM_PYTHON="$(command -v python3.11)" \
node --experimental-strip-types e2e/smoke.ts
```

`HEADROOM_PYTHON` must resolve to an executable absolute path for Python 3.11. If omitted, the runner searches `PATH` for `python3.11`. The default sanitized report is **`.agents/compatibility-smoke/result.json`** under the checkout. To keep it elsewhere, pass an absolute `E2E_RESULT_PATH` outside the disposable workspace to the same invocation. The runner also prints the sanitized result to stdout and exits nonzero on failure; do not discard that exit status.

The runner installs the selected Pi into a temporary prefix, packs the checkout with `npm pack`, and registers the unpacked extension via Pi's `install` command. The extension provisions the selected `headroom-ai` version with its default `proxy` extras. The runner isolates Pi and Headroom homes, clears inherited credentials and Headroom overrides, and disables telemetry/beacons. Normal completion and handled failures remove run-owned processes and temporary installations; the result JSON remains. Do not commit reports, archives, venvs, or logs.

## Decide what the result means

Require `outcome: "passed"`, all three `checks` statuses `passed`, and `cleanup.status: "passed"`. Compare `requested` and `actual` versions, runtime versions, and `extensionCommit` with the intended pair/checkout. Missing actual versions mean that stage was not reached, not that the requested version was installed.

The three happy paths are:

1. **Installation:** managed venv and requested Headroom distribution, owned proxy, and extension online state—not just a successful pip command.
2. **Health/status:** `/headroom status` and `/headroom health` through Pi, plus the managed loopback `/health` JSON response.
3. **Compression:** a fixed redundant conversation through Pi to a local mock LLM, reduced historical assistant text, a positive target-turn saved-token delta, and a completed assistant turn. The report's `compression` fields contain character lengths, before/after token counters, and `targetSavedTokens`, not message content. Missing numeric evidence is not zero savings or a pass.

For a failure, read `failure.stage`, `failure.category`, and the sanitized `failure.message` first:

- `input`, `environment`, or `provisioning`: correct the exact versions, runtime, package availability, TLS trust, or asset/network access, then rerun the same pair. A download/setup failure does not establish incompatibility. Do not bypass TLS verification or substitute versions to obtain a pass.
- `protocol` or `timeout`: locate the reported Pi/RPC/setup/turn stage before deciding whether this is provisioning or an integration problem.
- `assertion`: investigate the named check and version pair. A healthy proxy or positive cumulative counter alone cannot pass compression; do not weaken the assertions for a no-reduction result.
- `cleanup`: the invocation failed even if the three checks passed; investigate resource cleanup separately.

A failed prerequisite leaves later checks `not_run`; this is a failed invocation, not a successful skip. The summary and sanitized artifact should agree. Do not upload raw RPC/process logs or temporary homes to diagnose a failure.

A pass covers **three happy paths for one version pair, one extension commit, and one Linux/runtime environment**, not a full compatibility guarantee. It does not cover lifecycle/fault scenarios, tools/images/thinking, terminal rendering, other providers or operating systems, or a runtime matrix. Keep using the existing offline tests and review any production fixes separately.
