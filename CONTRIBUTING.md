# Contributing to Make Headroom!

Thanks for improving `pi-make-headroom`. This project is a Pi extension that installs and manages a pinned Headroom proxy in a dedicated Python venv.

## Before you start

- Read [`AGENTS.md`](AGENTS.md) and the nearest scoped `AGENTS.md` (`src/` or `test/`).
- For a bug, include the Pi version, OS, Python version, `HEADROOM_VERSION`, and the relevant `~/.pi/agent/make-headroom/proxy.log` tail.
- For a large change, open an issue first so the approach can be agreed before implementation.
- Never include API keys, prompts, or private message content in issues or logs.

## Requirements

- Node.js 22+ for the test runner (the runtime also works on Node 18+).
- Python 3.10+ only if you want to exercise the managed Headroom proxy.
- Pi 1.5+ only for the extension load check.
- No dependency installation is required: the package has no runtime npm dependencies.

## Setup

```bash
git clone https://github.com/Cirius1792/pi-make-headroom.git
cd pi-make-headroom
npm test
```

To load the extension from the checkout:

```bash
pi --no-extensions -e ./src/index.ts --list-models
```

## Commands

| Task | Command |
|------|---------|
| Run all tests | `npm test` |
| Run one test file | `node --test test/format-bridge.test.ts` |
| Module import check | `node --experimental-strip-types -e "await import('./src/proxy-manager.ts')"` |
| Verify package contents | `npm pack --dry-run` |
| Load the extension in Pi | `pi --no-extensions -e ./src/index.ts --list-models` |

There is no lint, typecheck, build, or CI gate yet. `npm test` is the only automated check; use the commands above for the relevant change.

## Development workflow

1. Create a branch from `main`.
2. Make the smallest change that solves the problem.
3. Add or update tests in `test/`.
4. Run `npm test` and paste the result in the PR.
5. If you touched extension wiring or process lifecycle, also run the module import check and the Pi load check.
6. Update `README.md` and `CHANGELOG.md` for user-visible changes.
7. Commit with a conventional message, for example `fix(proxy): release lock on cancellation`.
8. Open a pull request with the checklist below.

## Coding standards

- **No runtime npm dependencies.** Host packages are peer dependencies only.
- Use Node built-ins and `fetch`; do not add a helper library for something small.
- Use `import type` for `@earendil-works/pi-*` imports.
- Avoid TypeScript parameter properties, enums, and namespaces; the tests use Node's strip-only TypeScript mode.
- Preserve tool call IDs, tool results, thinking blocks, images, timestamps, usage, and provider fields when compressing.
- If Headroom output cannot be aligned safely, return the original transcript.
- Setup must stay lazy: `session_start` schedules work and returns; compression turns on later.
- Cancellation must kill the pip/venv/proxy process tree and release `install.lock`.
- Keep the proxy on loopback. Do not enable Headroom telemetry or the beacon by default.
- Never interpolate untrusted values into a shell command; pass arguments to `spawn`.

## Tests

- Use `node:test` and `node:assert/strict`; no external test framework.
- Unit tests must be offline and must not require a live Headroom proxy.
- Integration-style tests must set `HEADROOM_HOME` to a temp directory and clean it up.
- Do not write to `~/.pi` or a real venv from tests.
- A bug fix should include a test that fails without the fix.

## Pull request checklist

- [ ] `npm test` passes; output is pasted in the PR.
- [ ] Relevant module import or Pi load check passes.
- [ ] New behavior has a test.
- [ ] `README.md` and `CHANGELOG.md` are updated for user-visible changes.
- [ ] No new runtime dependency.
- [ ] No secrets, prompts, or private message content are included.
- [ ] No `node_modules`, venv, log, or `*.tgz` files are committed.

## AI-assisted contributions

AI assistance is welcome. Follow the same bar as human contributions:

- **Comprehension:** understand the problem and the code you changed.
- **Context:** explain the trade-offs and link the issue.
- **Continuity:** respond to review feedback and keep the change focused.
- Disclose AI assistance if your employer or the project requests it.
- Do not submit unreviewed, drive-by generated PRs.

## Security

Please report vulnerabilities privately through GitHub Security Advisories or by contacting the maintainer. Do not open a public issue for a vulnerability.

## License

By contributing, you agree that your contributions are licensed under the Apache-2.0 license, the same as this project.
