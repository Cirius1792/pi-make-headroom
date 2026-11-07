# Make Headroom!

**Managed Headroom context compression for Pi — pinned Python venv, lazy setup, no npm dependencies.**

[![CI](https://github.com/Cirius1792/pi-make-headroom/actions/workflows/ci.yml/badge.svg)](https://github.com/Cirius1792/pi-make-headroom/actions/workflows/ci.yml)

[github.com/Cirius1792/pi-make-headroom](https://github.com/Cirius1792/pi-make-headroom)

Transparent context compression for [Pi](https://pi.dev) using [Headroom](https://pypi.org/project/headroom-ai/), with a managed, pinned Python virtual environment and **no npm dependencies**.

The extension installs an exact `headroom-ai[proxy]` version into `~/.pi/agent/make-headroom/venv`, starts the local Headroom proxy, and compresses the transcript before every model call through Pi's `context` hook.

The name is a pun: it makes headroom in your context window, and on first run it provisions the Python environment for you.

## Features

- **No npm dependencies.** Pi's host packages are peer dependencies; the extension uses Node built-ins and `fetch`.
- **Pinned Headroom version.** Installs exactly `headroom-ai[proxy]==0.42.0` by default, in its own venv.
- **Lazy setup.** The session starts immediately; install/start runs in the background.
- **Managed lifecycle.** Start, health-check, restart, adopt, and stop the proxy automatically.
- **Footer savings.** Shows exact tokens saved and the saved share of baseline context.
- **Safe fallback.** If compression cannot be applied, the original transcript is sent unchanged.

## Requirements

- Pi 1.5 or newer.
- Python 3.10 or newer on `PATH` (or set `HEADROOM_PYTHON`). Headroom 0.43+ needs Python 3.11+.
- Network access on the first run, so pip can download Headroom into the dedicated venv.
- No npm install and no `node_modules` are needed by the extension.

## Install

### From npm

```bash
pi install npm:pi-make-headroom
```

### From Git

Install the latest `main`:

```bash
pi install git:github.com/Cirius1792/pi-make-headroom
```

Pin a tag or commit for a reproducible install:

```bash
pi install git:github.com/Cirius1792/pi-make-headroom@<tag-or-commit>
```

Update a Git install:

```bash
pi update git:github.com/Cirius1792/pi-make-headroom
```

### From a local checkout

```bash
pi install /path/to/pi-make-headroom
```

### Try it for one run

Without adding it to settings:

```bash
pi -e npm:pi-make-headroom
# or
pi -e git:github.com/Cirius1792/pi-make-headroom
# or
pi -e /path/to/pi-make-headroom
```

Remove the original `pi-headroom` package if it is still installed. Running both extensions compresses the same transcript twice:

```bash
pi remove npm:pi-headroom
```

## First run

On the first `session_start`, the extension:

1. Creates `~/.pi/agent/make-headroom/venv` with `python -m venv`.
2. Installs the pinned version, by default `headroom-ai[proxy]==0.42.0`.
3. Starts the proxy on `127.0.0.1:8788` (or the next free port).
4. Waits for `GET /health` and for the optional Kompress compression model to warm up.
5. Begins compressing every model request.

Setup runs in the background. The session and the agent stay usable immediately; model requests made before setup finishes are sent uncompressed, and compression turns on automatically when setup completes. The footer shows setup progress.

The first run can take a few minutes because pip downloads Headroom and its proxy dependencies. Later runs reuse the venv and start in a few seconds.

The default configuration is written to `~/.pi/agent/make-headroom/config.json` if the file does not exist.

## Footer

While a session runs, the footer status line shows:

```text
✓ Headroom up · saved 12,345 tok (18%)
```

- `saved 12,345 tok` is the exact cumulative number of tokens removed from model requests in this session.
- `18%` is `saved / baseline`, where baseline is the total uncompressed context tokens for the same requests. `/headroom status` also shows the saved share of the tokens actually sent.
- Before the first request: `✓ Headroom up · ready`.
- When compression is disabled: `○ Headroom off`.
- When the proxy is unreachable: `⚠ Headroom offline`.

The percentage is cumulative across requests. It is not the reduction of the current context window. Token counts are Headroom's local tokenizer estimates, so they can differ slightly from the provider's billed token count.

## Commands

| Command | Effect |
|---|---|
| `/headroom` or `/headroom status` | Show proxy state, pinned version, venv, logs, session totals, and the last compression. |
| `/headroom on` | Enable compression and start setup in the background if needed. |
| `/headroom off` | Stop compressing. Cancels an in-flight setup; the proxy stays warm. |
| `/headroom restart` | Restart the managed proxy (cancels an in-flight setup). |
| `/headroom stop` | Stop the managed proxy and cancel an in-flight setup. |
| `/headroom reinstall` | Delete the venv and install the pinned version again. |
| `/headroom health` | Check `/health` and show diagnostics. |
| `/headroom-health` | Same as `/headroom health`. |

## Configuration

Precedence: environment variables, then `~/.pi/agent/make-headroom/config.json`, then the defaults.

| Environment variable | Default | Meaning |
|---|---|---|
| `HEADROOM_VERSION` | `0.42.0` | Exact `headroom-ai` version to install. |
| `HEADROOM_EXTRAS` | `proxy` | pip extras. Keep `proxy`; it provides the proxy server. |
| `HEADROOM_PORT` | `8788` | First port to try. The extension scans up to 49 more ports if it is busy. |
| `HEADROOM_HOST` | `127.0.0.1` | Bind address. |
| `HEADROOM_HOME` | `~/.pi/agent/make-headroom` | Venv, config, runtime state, and logs. |
| `HEADROOM_PYTHON` | auto | Python interpreter used to create the venv. |
| `HEADROOM_COMPRESS_TIMEOUT_MS` | `30000` | Per-request compression timeout. |
| `HEADROOM_INSTALL_TIMEOUT_MS` | `900000` | pip install timeout. |
| `HEADROOM_START_TIMEOUT_MS` | `90000` | Proxy startup timeout. |
| `HEADROOM_URL` | unset | Use an external proxy instead of managing one. |
| `HEADROOM_PROXY_TOKEN` | unset | Bearer token for a token-protected proxy. `HEADROOM_API_KEY` also works. |
| `HEADROOM_DISABLED` | unset | Set to `1`, `true`, `yes`, or `on` to skip Headroom. |
| `HEADROOM_MODE` | proxy default | Passed through to the proxy. The proxy may choose `cache` mode for coding profiles. Set `token` for more aggressive compression at the risk of provider prefix-cache churn. |
| `HEADROOM_TELEMETRY` | `off` | The extension sets this to `off` unless you set it. |
| `HEADROOM_BEACON` | `off` | The extension sets this to `off` unless you set it. |

Example `config.json`:

```json
{
  "version": "0.42.0",
  "extras": "proxy",
  "port": 8788,
  "host": "127.0.0.1"
}
```

To pin a different version, edit `version` or set `HEADROOM_VERSION`. The extension reinstalls when the version or extras change. Headroom 0.43+ requires Python 3.11+.

## How it works

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map, lifecycle, failure modes, and ADRs. For every model request, Pi fires the `context` event with a copy of the conversation. The extension:

1. Converts Pi's provider-neutral messages to the OpenAI message shape expected by Headroom.
2. Calls `POST /v1/compress` on the local proxy with the active model id.
3. Re-applies the compressed text to the original messages. Tool call ids, tool results, thinking blocks, images, timestamps, usage, and provider fields come from the originals, so only what the model reads changes.
4. Returns the compressed copy for that one request. The session history is not modified.

If Headroom changes the message count or roles in a way that cannot be aligned safely, the extension keeps the original transcript for that request. It also falls back to the original transcript on a timeout or proxy error, and tries one proxy restart per session.

Headroom's `/v1/compress` entry point runs its compression pipeline without calling an upstream model. The proxy is a local compression service; Pi still sends the compressed request to its configured provider.

## Logs and state

| Path | Contents |
|---|---|
| `~/.pi/agent/make-headroom/venv` | Dedicated Python virtual environment. |
| `~/.pi/agent/make-headroom/config.json` | Default configuration. |
| `~/.pi/agent/make-headroom/requirements.txt` | Exact pip requirement used for the venv. |
| `~/.pi/agent/make-headroom/runtime.json` | Port, pid, version, and venv of the running proxy. |
| `~/.pi/agent/make-headroom/install.log` | pip and venv output. |
| `~/.pi/agent/make-headroom/proxy.log` | Proxy stdout and stderr. |

The proxy is stopped on normal Pi exit if this extension started it. `/headroom stop` and `/headroom off` also cancel an in-flight install. A proxy adopted from a previous Pi process is left running so the next session can reuse it; if Pi exits uncleanly, the detached proxy may survive and be reused next time.

## Troubleshooting

**`Headroom offline` after startup.** Read `~/.pi/agent/make-headroom/proxy.log`. Common causes: no network on the first run, a Python without `venv`/`ensurepip`, or a port collision. Run `/headroom reinstall`.

**`Python 3.10+ was not found`.** Install Python 3.10 or newer, or set `HEADROOM_PYTHON` to an interpreter path. On Debian/Ubuntu, install `python3-venv` as well.

**`pip install failed`.** The extension logs the full pip output to `install.log`. Check the pinned version exists on PyPI and that the interpreter meets its `Requires-Python` value.

**Savings stay at zero.** Depending on the Headroom version and savings profile, Headroom may protect user messages and several tool outputs. It mostly compresses assistant prose, older tool results, and format-specific content. A short conversation may have nothing to compress. Use `/headroom status` to see the last request's transforms.

**The footer shows a smaller percentage than expected.** The percentage is `saved / baseline`, where baseline is the uncompressed context size. A request that saves 2,000 of 100,000 baseline tokens shows 2%.

**Double compression.** Remove the original `pi-headroom` package. This extension warns on startup if it finds it.

## Documentation

| Document | Contents |
|---|---|
| [AGENTS.md](AGENTS.md) | Agent instructions: verified commands, invariants, boundaries. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, PR workflow, coding standards. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System context, lifecycle, modules, failure modes. |
| [docs/adr/](docs/adr/) | Architecture decision records. |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting and security scope. |
| [CHANGELOG.md](CHANGELOG.md) | Release notes. |

## Development

```bash
npm test
```

The tests use Node's built-in TypeScript support (Node 22+). No dependency install is required. The extension source is TypeScript loaded by Pi's `jiti` loader. CI runs `npm test`, a module import check, and `npm pack --dry-run` on Node 22 and 24.

## Repository

[github.com/Cirius1792/pi-make-headroom](https://github.com/Cirius1792/pi-make-headroom)

## License

Apache-2.0.
