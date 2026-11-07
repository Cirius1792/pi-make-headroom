<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-11-07 | Last verified: 2026-11-07 -->

# AGENTS.md — test

## Overview
`node:test` suites run with Node 22+ TypeScript stripping. Tests must be deterministic, offline, and leave no processes or files behind.

## Setup & environment
- Use `node:test` and `node:assert/strict` only; no test framework install.
- No network and no live Headroom proxy are required for unit tests.
- Integration-style tests must set `HEADROOM_HOME` to a temp directory and clean it up.

## Build & tests
| Task | Command |
|------|---------|
| All tests | `npm test` |
| One file | `node --test test/format-bridge.test.ts` |

## Conventions
- Use `node:test` and `node:assert/strict`.
- Name tests by behavior, not implementation.
- Test pure functions directly; for proxy tests, use a temp home and explicitly stop the manager.
- Do not depend on wall-clock timing or external services.
- Keep fixtures inline unless reuse is real.

## Security
- Never write to `~/.pi` or a real venv from tests.
- Never read API keys or environment secrets.
- Do not spawn a real pip install in unit tests.

## PR checklist
- [ ] `npm test` passes; output pasted.
- [ ] New behavior has a test that fails without the change.
- [ ] No temp files or processes remain.
- [ ] No network calls.

## Patterns to Follow
- `test/format-bridge.test.ts` for pure conversion tests.
- `test/ui.test.ts` for formatting tests.
- `test/proxy-manager.test.ts` for small pure helper tests.

## Troubleshooting
- `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`: use plain fields and string unions.
- Tests hang: check for unclosed child processes or timers.
