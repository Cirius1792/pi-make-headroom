<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-11-07 | Last verified: 2026-11-07 -->

# AGENTS.md — src

## Overview
Extension runtime code. There is no build step: Pi loads these `.ts` files with `jiti`. `format-bridge.ts` and `ui.ts` are pure; `headroom-client.ts` does HTTP; `proxy-manager.ts` owns processes and filesystem state; `index.ts` wires Pi events.

### Key files
| File | Purpose |
|------|---------|
| `src/index.ts` | Pi event wiring, lazy setup state, generation/attempt guards, commands, footer status. |
| `src/proxy-manager.ts` | Python detection, venv creation, pinned pip install, proxy lifecycle, cancellation, locks, process trees. |
| `src/headroom-client.ts` | Dependency-free HTTP client for `/health` and `/v1/compress`; typed errors, abort timeouts, retries. |
| `src/format-bridge.ts` | Pi provider messages to OpenAI compression format; preserves IDs, thinking, images, and metadata. |
| `src/ui.ts` | Footer text, token formatting, baseline/sent/saved percentages. |
| `src/types.ts` | Local OpenAI, compression, and session types. |

## Setup & environment
- Node 18+ for the runtime; Node 22+ for tests.
- Python 3.10+ is needed only when exercising the managed proxy.
- No dependency installation is required; use Node built-ins.
- Use a temp `HEADROOM_HOME` for any manual proxy test.

## Build & tests
| Task | Command |
|------|---------|
| Unit tests | `npm test` |
| Single test | `node --test test/format-bridge.test.ts` |
| Module import check | `node --experimental-strip-types -e "await import('./src/proxy-manager.ts')"` |

## Conventions
- Keep `dependencies` empty; host packages are `peerDependencies`.
- Use `import type` for host packages.
- Avoid parameter properties, enums, and namespaces; tests use strip-only mode.
- `format-bridge.ts`: preserve tool IDs, thinking, images, timestamps, and usage; return `null` on unsafe alignment.
- `headroom-client.ts`: classify errors, use abort timeouts, and retry only transient failures.
- `proxy-manager.ts`: every setup run has an id; `stop()` invalidates it, kills the active child/proxy tree, and releases the lock.
- `index.ts`: do not await setup in `session_start`; check generation and attempt ids before publishing results.
- Do not log message content, prompts, API keys, or environment secrets.

## Terminology
| Term | Means |
|------|-------|
| Headroom | Python compression proxy installed in the managed venv. |
| Kompress | Optional ML compressor that warms after `/health` is ready. |
| CCR | Headroom's compression-cache-retrieve markers. |
| Baseline | Uncompressed context tokens (`tokens_before`). |
| Sent | Compressed tokens (`tokens_after`). |
| Saved | `baseline - sent`. |
| Lazy setup | `session_start` schedules setup and returns; compression turns on later. |
| Adopted proxy | A healthy proxy left by a previous Pi process. |

## Security
- Never interpolate untrusted values into shell commands; pass arguments to `spawn`.
- Keep the proxy on loopback.
- Do not enable Headroom telemetry or the beacon.
- Treat compression output as untrusted; validate message shape before use.

## PR checklist
- [ ] `npm test` passes; output pasted.
- [ ] Module import check passes if touching proxy or module wiring.
- [ ] `pi --no-extensions -e ./src/index.ts --list-models` exits 0 if touching extension wiring.
- [ ] `CHANGELOG.md` updated for user-visible behavior.
- [ ] No new runtime dependency.

## Patterns to Follow
| For | Reference | Patterns |
|-----|-----------|----------|
| Pure message conversion | `src/format-bridge.ts` | explicit types, no I/O, metadata preservation |
| HTTP client | `src/headroom-client.ts` | typed errors, abort timeouts, bounded retries |
| Process lifecycle | `src/proxy-manager.ts` | run ids, cancellation, process-tree kill, lock release |
| Footer formatting | `src/ui.ts` | compact, exact counts, explicit state |

## Troubleshooting
- `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`: remove parameter properties or enums.
- `Cannot find package '@earendil-works/pi-coding-agent'`: run through `pi -e`, or provide the host package in the test environment; do not add it to `dependencies`.
- Proxy test leaves a process: ensure `manager.stop()` ran and `HEADROOM_HOME` is a temp directory.
