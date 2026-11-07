# Pi / Headroom compatibility smoke test

Status: agreed scope; implementation design for review. No implementation is authorized by this document alone.

## Purpose

Give a maintainer a small, repeatable check that the extension still installs and compresses requests with a specified Pi / Headroom version pair. The same check supports upgrading either component independently. This is a smoke test, not a claim that every extension behaviour is covered.

## Agreed scope

Run real Pi, the real packaged extension from the checked-out commit, and real Headroom. Mock only the upstream LLM API. Verify exactly three happy paths: installation, health/status, and compression through Pi to the mock LLM.

The initial workflow is manual, Linux-only, and accepts two required string inputs with no defaults:

| Input | Meaning |
| --- | --- |
| `pi_version` | Exact published version of `@earendil-works/pi-coding-agent`. |
| `headroom_version` | Exact published version of `headroom-ai`, installed with the extension's default `proxy` extras. |

Accept exact npm semantic release/prerelease versions for Pi. For Headroom, this first iteration accepts canonical `X.Y.Z` releases and `X.Y.ZaN`, `X.Y.ZbN`, or `X.Y.ZrcN` prereleases (numeric components have no leading zeroes except zero itself). Reject noncanonical spellings such as `0.43.0-rc.1`, post/dev/local/epoch forms, tags such as `latest`/`next`, ranges, wildcards, whitespace, and missing values before invoking package managers. Do not silently replace an unavailable version. This deliberately narrow input contract matches the extension's strict installed-version comparison without changing production code or installing a normalization dependency. Retain requested and actual installed versions in the report.

One invocation tests one pair and one extension commit. Node 22 (at least 22.19) and Python 3.11 are fixed environment choices for this first iteration, not additional inputs. Record their actual versions. A pair requiring a different runtime fails with an actionable environment error; it does not establish that the extension is incompatible on every runtime.

## Approaches

1. **Real CLI driven through RPC — selected.** Exercises package loading, session startup, the extension's context hook, real proxy provisioning, HTTP compression, and provider serialization. RPC provides machine-readable status and turn completion without terminal automation.
2. **Direct HTTP/client integration test — rejected for this task.** Simpler, but misses installation into Pi, hook wiring, and what Pi actually sends upstream.
3. **SDK or terminal-driven test — deferred.** An SDK-only test misses the requested CLI installation path; terminal automation adds dependencies and rendering fragility without improving these three checks.

These choices implement the real-Pi direction agreed in the conversation. Full lifecycle and failure coverage were deliberately removed from the first iteration.

## Execution model

- Keep the existing offline `npm test` suite and existing CI workflow unchanged. Put live-test code outside `test/**/*.test.ts` and invoke it explicitly from a separate `workflow_dispatch` workflow.
- Use Node built-ins only for the test harness. Do not add project npm dependencies or change production code to make the test pass.
- Install the selected Pi npm package into a disposable prefix, not globally and not into the repository. Verify both its package metadata and the CLI-reported version.
- Create the extension archive using `npm pack` from the checkout, unpack it into the disposable workspace, and register that directory using the installed Pi's `install` command. Do not load `src/index.ts` directly, and do not test the published npm extension instead of the checkout.
- Give Pi an empty temporary working directory and temporary `PI_CODING_AGENT_DIR`. Give the extension a separate temporary `HEADROOM_HOME`, the requested `HEADROOM_VERSION`, and the selected Python interpreter. Clear inherited Headroom overrides, especially `HEADROOM_URL` and `HEADROOM_DISABLED`, so the managed-install path cannot be bypassed.
- Configure a local OpenAI-compatible provider in the temporary `models.json`, using a dummy key and the known model ID `gpt-4o`. A loopback HTTP server captures requests and returns deterministic streaming assistant responses. No real credentials or paid provider are used.
- Disable unrelated resources and automatic model-catalog/update traffic through the supported Pi controls. Preserve the extension's default telemetry/beacon protections. Network access for npm, pip, and necessary Headroom assets is permitted; this is not an offline job.
- Drive the installed Pi as an RPC subprocess. Correlate responses by ID, consume stdout continuously using LF-delimited framing, and distinguish command acceptance from completed model work. Do not require a newer completion event if an older supported Pi exposes an equivalent idle/message check.
- Wait for setup using bounded polling of observable state, not a fixed sleep or an awaited replacement for the extension's lazy startup.

## Acceptance checks

### 1. Installation

From an empty managed home, the extension creates its own venv, installs the requested Headroom distribution, starts the managed proxy, and becomes online. Read the installed distribution version using that venv's Python and `importlib.metadata`; require equality with the accepted canonical input. Verify that the proxy endpoint and venv reported by the extension belong to this run, rather than an unrelated existing service.

Pass evidence: requested/actual Pi versions, requested/actual Headroom versions, a venv under the temporary home, and the extension reaching online state. A successful `pip install` alone is insufficient.

### 2. Health and status

Send `/headroom status` and `/headroom health` through Pi RPC. Require successful command handling and extension notifications reporting online state and the expected version. Directly query the resolved loopback `/health` URL and require a successful JSON health response. Do not hardcode port 8788: the extension may legitimately select the next free port.

The health endpoint and extension commands are distinct interfaces; both are checked. Terminal footer rendering is not checked.

### 3. Compression

After setup is online, build a small scripted conversation through real Pi. The mock LLM supplies deliberately redundant historical assistant text; subsequent short prompts make that text eligible for compression. Use a bounded, fixed fixture sequence calibrated against a known working pair, not an unbounded search for a compressible request. A single protected user prompt is not an adequate fixture.

Before the final target prompt, retrieve the original conversation through RPC. Compare its fixture-bearing assistant text with the corresponding historical text in the final request captured by the mock LLM. Require all of the following:

- The target request arrives at the mock LLM with the expected model, roles, and final user prompt.
- The fixture-bearing historical text is actually shorter than the original conversation's text; disappearing or misaligned messages must not count as successful compression.
- The extension's cumulative saved-token count increases around the final target turn, rather than merely being positive from an earlier turn.
- Pi consumes the mock response and finishes the turn with the expected assistant text, without a provider error.

Do not assert an exact compression ratio, exact compressed wording, or a machine-specific latency. A healthy proxy, successful conversation, direct `/v1/compress` call, or positive counter alone cannot pass this check. Silent fallback to the original request must fail.

## Results, deadlines, and cleanup

Produce a small JSON result and a GitHub job summary containing the extension commit, requested/actual component versions, runtime versions, each check's outcome, and the failing stage if any. Keep upstream request bodies in memory only; report lengths/counters, not fixture content, prompts, or keys. Upload only the sanitized result, not the temporary home, raw RPC stream, raw process output, or arbitrary logs.

Use a 30-minute overall harness deadline and a 35-minute CI job timeout. Bound provisioning/setup, RPC commands, prompts, and cleanup within that overall deadline. A failed or timed-out prerequisite marks subsequent checks as not run and fails the job; it is not a successful skip. Package resolution/installation and protocol failures must be distinguished from failed health/compression assertions in the result.

Always request orderly Pi shutdown and close the mock server, then kill remaining verified run-owned processes if needed and remove temporary files, installations, archives, and homes. The extension starts detached install/proxy processes, so Pi's process group and `runtime.json` alone are not sufficient ownership records. Propagate a unique per-run environment marker through every child and use Linux `/proc` scans to find marked descendants, even before runtime state exists or after reparenting. Record PID/start-time identity, revalidate ownership before signalling individual PIDs, and rescan through bounded TERM/KILL escalation; never signal unrelated group members. Cleanup must be installed as soon as resources are created and cover failures and SIGTERM/SIGINT, not only the passing path. Cleanup is harness safety, not an expansion into lifecycle regression testing. Abrupt runner termination remains subject to GitHub's process/container cleanup.

The workflow succeeds only when all three checks pass and normal cleanup succeeds. Never commit generated archives, venvs, logs, installed packages, or credentials.

## Explicit non-goals

- Fault injection, malformed responses, retries, timeout semantics, and fallback regression scenarios.
- Restart, reinstall, cancellation, adoption/reuse, configuration-precedence, or command-matrix regression scenarios.
- Tool-call, thinking, image, or provider-metadata preservation coverage beyond the existing unit tests.
- Terminal UI rendering, additional LLM protocols, operating systems, or runtime matrices.
- Scheduled discovery of releases, automatic upgrade PRs, changing the default Headroom pin, or release automation.
- Reproducible transitive dependency resolution: exact top-level Pi/Headroom pins do not lock their entire dependency trees.

## Implementation boundaries

The implementation adds test infrastructure, a separate manual workflow, and usage documentation/release notes. It must preserve the current Headroom default `0.42.0`, package names, public commands, footer format, and empty runtime dependency set. The agreed work includes the new workflow, not unrelated changes to existing CI or release configuration. If the known baseline fails, diagnose and report that failure; production fixes require a separately reviewed change rather than weakening the smoke assertions.
