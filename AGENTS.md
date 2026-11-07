<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-11-07 | Last verified: 2026-11-07 -->

# AGENTS.md

**Precedence:** the closest `AGENTS.md` to the files you are changing wins. Root holds global defaults. Explicit user prompts override these files.

## Commands
> Source: package.json and verified locally. No lint/typecheck/build is configured; do not invent one.

| Task | Command | ~Time |
|------|---------|-------|
| Test (all) | `npm test` | ~0.5s |
| Test (single file) | `node --test test/format-bridge.test.ts` | ~0.2s |
| Module import check | `node --experimental-strip-types -e "await import('./src/proxy-manager.ts')"` | ~0.2s |
| Package contents | `npm pack --dry-run` | ~0.5s |
| Pi load check | `pi --no-extensions -e ./src/index.ts --list-models` | ~2s |

> No dependency installation is required; there are no runtime npm dependencies. Tests need Node 22+; the runtime needs Python 3.10+ only when exercising the managed proxy.

## Workflow
1. Read this file and the nearest scoped `AGENTS.md`.
2. Read the relevant Golden Sample in `src/AGENTS.md` before editing.
3. Make the smallest change that solves the problem.
4. Run the smallest relevant check; run `npm test` before claiming done.
5. Paste command output as evidence. Never say "tested" or "all green" without it.

## File map
| Path | Purpose |
|------|---------|
| `src/` | Extension source. Detailed file map, golden samples, and terminology: `./src/AGENTS.md`. |
| `test/` | `node:test` suites. Conventions and cleanup rules: `./test/AGENTS.md`. |
| `README.md`, `CHANGELOG.md`, `docs/`, `SECURITY.md`, `.github/` | Human docs, architecture/ADRs, release notes, security policy, CI/PR template. |
| `package.json` | Manifest, scripts, peer dependencies. `dependencies` must stay empty. |

## Invariants
- `dependencies` stays empty. Host packages are peer dependencies only.
- `session_start` must not await setup. Lazy background setup is a product requirement.
- Preserve tool call IDs, tool results, thinking blocks, images, timestamps, usage, and provider fields. If alignment is unsafe, return the original transcript.
- Cancellation must kill the pip/venv/proxy process tree and release `install.lock`.
- The default home is `~/.pi/agent/make-headroom`. Tests must use a temp `HEADROOM_HOME`.
- The proxy binds loopback (`127.0.0.1`); `/v1/compress` is loopback-only.
- Telemetry/beacon are off by default. Do not enable them silently.
- Keep the default pin `0.42.0` unless the change is intentional and tested on Python 3.10+.
- Use `spawn(cmd, args)`; never interpolate untrusted text into a shell command.

## Boundaries

### Always
- Run `npm test` and paste the output.
- Add tests for changes to `format-bridge.ts`, `ui.ts`, or proxy helper logic.
- Update `CHANGELOG.md` for user-visible behavior.
- Use conventional commits: `type(scope): subject`.

### Ask first
- Add any dependency.
- Change the default Headroom version, port, or package name.
- Change public commands or the footer format.
- Modify CI or release configuration.

### Never
- Commit `node_modules`, venvs, logs, or `*.tgz`.
- Add runtime npm dependencies.
- Weaken cancellation, cleanup, or process-tree handling.
- Hardcode secrets or print message content/API keys.
- Edit `LICENSE` or push directly to `main`.

## Codebase state
- No lint/typecheck/build is configured. CI runs `npm test`, a module import check, and `npm pack --dry-run` on Node 22 and 24.
- Tests use Node 22+ built-in TypeScript stripping; the runtime loads TypeScript via Pi's `jiti`.
- Strip-only mode does not support parameter properties, enums, or namespaces. Use plain fields and string unions.
- Use `import type` for `@earendil-works/pi-*` imports.
- `npm pack --dry-run` must show only `src/`, `README.md`, `LICENSE`, `CHANGELOG.md`, and `package.json`.
- The package name is `pi-make-headroom`; do not install the old `pi-headroom` package alongside it.

## Scoped AGENTS.md
- `./src/AGENTS.md` — source invariants and conventions.
- `./test/AGENTS.md` — test conventions and cleanup rules.

