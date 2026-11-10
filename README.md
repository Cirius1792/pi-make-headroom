# Make Headroom!

**Managed [Headroom](https://pypi.org/project/headroom-ai/) context compression for [Pi](https://pi.dev) — pinned Python venv, lazy setup, no npm dependencies.**

[![CI](https://github.com/Cirius1792/pi-make-headroom/actions/workflows/ci.yml/badge.svg)](https://github.com/Cirius1792/pi-make-headroom/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40cltec%2Fpi-make-headroom)](https://www.npmjs.com/package/@cltec/pi-make-headroom)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Headroom is a compression proxy: it shrinks a conversation before the model reads it. This extension wires it into Pi. It provisions a private Python venv under `~/.pi/agent/make-headroom`, installs an exact `headroom-ai[proxy]` version, runs the proxy on loopback, and compresses each model request through Pi's `context` hook.

There is no service to install, no port to remember, and nothing left behind to clean up. The name is a pun: it makes headroom in your context window, and it provisions your Python environment on first run.

## What it handles for you

- **No npm dependencies.** Pi's host packages are peer dependencies; the extension uses Node built-ins and `fetch`.
- **A pinned version.** Installs exactly `headroom-ai[proxy]==0.44.0` by default, inside its own venv, never into the system Python.
- **Lazy setup.** Sessions start immediately. Install and startup happen in the background, and compression switches on when they finish.
- **A managed lifecycle.** Start, health-check, adopt, restart, and stop the proxy automatically.
- **Honest numbers.** The footer shows exact tokens saved and their share of baseline context.
- **Safe fallback.** If a request cannot be compressed or aligned safely, the original transcript is sent unchanged.

## Quick start

```bash
pi install npm:@cltec/pi-make-headroom
```

Start Pi. The footer shows `⏳ Headroom starting` while the venv is built, then `✓ Headroom up · ready`, then savings as requests go through.

The first run downloads Headroom and its proxy dependencies, which takes a few minutes. Later runs reuse the venv and start in seconds.

## Requirements

| Requirement | Detail |
| --- | --- |
| Pi | 1.5 or newer. |
| Python | **3.11 or newer** on `PATH`, or set `HEADROOM_PYTHON`. This is the supported minimum for Headroom upgrades. |
| Network | Needed on the first run so pip can populate the venv. |
| Disk | One venv with Headroom and its proxy dependencies, under `~/.pi/agent/make-headroom`. |
| Node | Nothing to install: the extension has no runtime npm dependencies. |

On Debian or Ubuntu, install `python3-venv` alongside Python. A `python3` without `ensurepip` cannot build the venv.

## Install

### From npm

```bash
pi install npm:@cltec/pi-make-headroom
```

### From Git

```bash
# latest main
pi install git:github.com/Cirius1792/pi-make-headroom

# reproducible
pi install git:github.com/Cirius1792/pi-make-headroom@<tag-or-commit>
```

### From a local checkout

```bash
pi install /path/to/pi-make-headroom
```

### For one run, without changing settings

```bash
pi -e npm:@cltec/pi-make-headroom
pi -e git:github.com/Cirius1792/pi-make-headroom
pi -e /path/to/pi-make-headroom
```

### Update

```bash
pi update npm:@cltec/pi-make-headroom
pi update git:github.com/Cirius1792/pi-make-headroom
```

An extension release can update the built-in Headroom pin. Explicit `HEADROOM_VERSION` or `config.json` versions—including a version in the starter config written on first run—are preserved and take precedence over that default. Change your configuration if you want to adopt a newer pin.

### Remove

```bash
/headroom stop                      # in Pi, so no proxy is left holding the port
pi remove npm:@cltec/pi-make-headroom # or the git: or local path you installed from
rm -rf ~/.pi/agent/make-headroom    # venv, config, logs
```

Before switching to the scoped package, remove any previous `pi-make-headroom` or original `pi-headroom` npm installation. Do not install them alongside `@cltec/pi-make-headroom`: they hook the same event and would compress the same transcript twice.

```bash
# Run only for packages you previously installed:
pi remove npm:pi-make-headroom
pi remove npm:pi-headroom
```

## First run

1. Creates `~/.pi/agent/make-headroom/venv` with `python -m venv`.
2. Installs the pinned version, by default `headroom-ai[proxy]==0.44.0`.
3. Starts `headroom proxy` on `127.0.0.1:8788`, or the next free port within 50.
4. Waits for `GET /health`, plus a brief wait for the optional Kompress model to warm up.

Setup runs in the background. The agent stays usable throughout: requests made before setup completes are sent uncompressed, and compression turns on by itself when the proxy is ready. A starter `config.json` is written at session start if the file is missing. With `HEADROOM_URL` set, all four steps are skipped and only `/health` is checked.

## How it works

For every model request Pi fires a `context` event with a copy of the conversation. The extension:

1. Converts Pi's provider-neutral messages to the OpenAI shape Headroom expects.
2. Calls `POST /v1/compress` on the local proxy with the active model id.
3. Re-applies the compressed text onto the original messages, keeping tool call ids, tool results, thinking blocks, images, timestamps, usage, and provider fields from the originals.
4. Returns the compressed copy for that one request. Session history is never modified.

If Headroom changes the message count or roles in a way that cannot be aligned safely, or if the request times out, or if the proxy errors, the original transcript is used for that request. One proxy restart is attempted per session.

Compression is not tied to one provider: it runs on the provider-neutral transcript Pi assembles, and the active model id is sent along so Headroom can pick a profile.

Headroom's `/v1/compress` runs its compression pipeline without calling an upstream model. The proxy is a local compression service; Pi still sends the compressed request to your configured provider.

Full lifecycle, module map, failure modes, and ADRs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status line

```text
✓ Headroom up · saved 12,345 tok (18%)
```

| Footer | Meaning |
| --- | --- |
| `⏳ Headroom starting` | Setup is running in the background. |
| `✓ Headroom up · ready` | Proxy is online; no request counted yet this session. |
| `✓ Headroom up · saved 12,345 tok (18%)` | Tokens removed from model requests, and their share of baseline. |
| `○ Headroom off` | Compression disabled, by `/headroom off` or `HEADROOM_DISABLED`. |
| `⚠ Headroom offline` | `/health` is not answering. |

`saved` is the exact cumulative count for the session. `18%` is `saved / baseline`, where baseline is the total uncompressed context across those same requests, so it is cumulative too — not a property of the current context window. `/headroom status` also reports savings as a share of the tokens actually sent. All counts are Headroom's local tokenizer estimates and can differ slightly from your provider's billed tokens.

## Commands

| Command | Effect |
| --- | --- |
| `/headroom` or `/headroom status` | Proxy state, pinned version, venv, logs, session totals, last compression. |
| `/headroom on` | Enable compression; starts setup in the background if needed. |
| `/headroom off` | Stop compressing and cancel an in-flight setup. The proxy stays warm. |
| `/headroom restart` | Restart the managed proxy; cancels an in-flight setup. |
| `/headroom stop` | Stop the managed proxy; cancels an in-flight setup. |
| `/headroom reinstall` | Delete the venv and install the pinned version again. |
| `/headroom health` | Check `/health` and print diagnostics. |

`/headroom-health` is an alias for `/headroom health`.

## Configuration

Precedence: environment variables, then `~/.pi/agent/make-headroom/config.json`, then defaults. The values you are most likely to change:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HEADROOM_VERSION` | `0.44.0` | Exact `headroom-ai` version to install. |
| `HEADROOM_PORT` | `8788` | First port to try; the next 49 are scanned if it is busy. |
| `HEADROOM_HOME` | `~/.pi/agent/make-headroom` | Venv, config, runtime state, and logs. |
| `HEADROOM_PYTHON` | auto | Interpreter used to create the venv. |
| `HEADROOM_URL` | unset | Use a proxy you run yourself instead of a managed one. |
| `HEADROOM_DISABLED` | unset | `1`, `true`, `yes`, or `on` skips Headroom entirely. |

All 16 variables, the `config.json` schema, validation rules, the Python floor per Headroom version, and tuning guidance: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Privacy and safety

- The proxy binds loopback, and `/v1/compress` is loopback-only. Compression never leaves your machine.
- Telemetry and the upload beacon are disabled on the proxy process unless you enable them.
- Nothing logs prompts, message content, API keys, or proxy tokens.
- The venv is dedicated to this extension; system Python is never modified.
- Untrusted values are passed to `spawn` as arguments, never interpolated into a shell command.

Details and reporting: [SECURITY.md](SECURITY.md).

## Troubleshooting

`⚠ Headroom offline` → read `~/.pi/agent/make-headroom/proxy.log`, then run `/headroom reinstall`.
`Python … was not found` → install Python **3.11+**, or set `HEADROOM_PYTHON`; on Debian/Ubuntu add `python3-venv`. The exact error depends on the selected Headroom pin.
`pip install failed` → `~/.pi/agent/make-headroom/install.log` has the full output; check the pin exists on PyPI.

For savings that stay at zero, lock timeouts, leftover proxies, a full reset, and removing the extension: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Documentation

| Document | Contents |
| --- | --- |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every environment variable, `config.json`, validation, tuning. |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptom-by-symptom fixes, logs, reset, uninstall. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System context, lifecycle, modules, failure modes. |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | Manual smoke checks and nightly tested Headroom update PRs. |
| [docs/AUTOMATIC-UPDATES.md](docs/AUTOMATIC-UPDATES.md) | How discovery, candidate validation, maintainer approval, and automatic releases fit together. |
| [docs/RELEASING.md](docs/RELEASING.md) | Configure trusted publishing and automatic releases after version-bump merges. |
| [docs/adr/](docs/adr/) | Architecture decision records. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, tests, PR workflow, coding standards. |
| [AGENTS.md](AGENTS.md) | Agent instructions: verified commands, invariants, boundaries. |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting and security scope. |
| [CHANGELOG.md](CHANGELOG.md) | Release notes. |

## Development

```bash
npm test
```

Tests use Node's built-in TypeScript support (Node 22+). No dependency install is required, and no test needs a live proxy. The extension source is TypeScript loaded by Pi's `jiti`. CI runs `npm test`, a module import check, and `npm pack --dry-run` on Node 22 and 24.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

## License

Apache-2.0. See [LICENSE](LICENSE).
