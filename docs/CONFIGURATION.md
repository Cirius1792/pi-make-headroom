# Configuration

Everything `pi-make-headroom` reads comes from one of two places: environment variables, or `~/.pi/agent/make-headroom/config.json`. Nothing is set inside Pi itself.

**Precedence:** environment variables win over `config.json`, and `config.json` wins over the built-in defaults. A value that fails validation is ignored, and the next source in that chain is used.

## The config file

The extension writes `~/.pi/agent/make-headroom/config.json` on the first session if the file does not exist. The generated file is a starting point, not a full schema:

```json
{
  "_comment": "pi-make-headroom configuration. Environment variables override these values.",
  "version": "0.42.0",
  "extras": "proxy",
  "port": 8788,
  "host": "127.0.0.1"
}
```

You can add the remaining keys yourself. Every key is optional:

| Key | Type | Maps to | Validation |
| --- | --- | --- | --- |
| `version` | string | `HEADROOM_VERSION` | Must start with a digit; `0.42.0`, `0.43.0rc1`, `0.42.0+local` are accepted. |
| `extras` | string | `HEADROOM_EXTRAS` | Lowercase letters, digits, `_ , . -`; or `""` for no extras. |
| `port` | number | `HEADROOM_PORT` | Integer, 1–65535. |
| `host` | string | `HEADROOM_HOST` | Any string. Keep it on loopback. |
| `python` | string | `HEADROOM_PYTHON` | Interpreter path. A leading `~` is expanded. |
| `compressTimeoutMs` | number | `HEADROOM_COMPRESS_TIMEOUT_MS` | Integer, 1000–3600000. |
| `installTimeoutMs` | number | `HEADROOM_INSTALL_TIMEOUT_MS` | Integer, 1000–3600000. |
| `startTimeoutMs` | number | `HEADROOM_START_TIMEOUT_MS` | Integer, 1000–3600000. |
| `url` | string | `HEADROOM_URL` | Must start with `http://` or `https://`; trailing slashes are stripped. |

`config.json` is re-read at every `session_start`, so edits take effect on the next Pi session, not mid-session. An explicit `version`, including the starter value written on first run, overrides future changes to the extension's built-in pin. Updating the extension does not rewrite this file.

Two values are sanitized for safety rather than rejected: `HEADROOM_HOME` pointing at a filesystem root (`/` or `C:\`) falls back to the default home, because `/headroom reinstall` deletes `<home>/venv`.

## Environment variables

### Core

| Variable | Default | Meaning |
| --- | --- | --- |
| `HEADROOM_VERSION` | `0.42.0` | Exact `headroom-ai` version to install. Changing it triggers a reinstall on the next setup. |
| `HEADROOM_EXTRAS` | `proxy` | pip extras. Keep `proxy`: it provides the proxy server the extension talks to. |
| `HEADROOM_PORT` | `8788` | First port to try. The extension scans the next 49 ports if it is busy. |
| `HEADROOM_HOST` | `127.0.0.1` | Bind address for the managed proxy. |
| `HEADROOM_HOME` | `~/.pi/agent/make-headroom` | Venv, config, runtime state, and logs. |
| `HEADROOM_PYTHON` | auto | Interpreter used to create the venv. When unset, the extension probes `python3`, `python`, then `python3.13` down to `python3.10` (on Windows, `py -3.x` first). |
| `HEADROOM_DISABLED` | unset | Set to `1`, `true`, `yes`, or `on` to skip Headroom entirely. The footer shows `○ Headroom off`. |

### Timeouts

| Variable | Default | Meaning |
| --- | --- | --- |
| `HEADROOM_COMPRESS_TIMEOUT_MS` | `30000` | Per-request compression timeout. A timeout sends that request uncompressed and keeps the proxy online. |
| `HEADROOM_INSTALL_TIMEOUT_MS` | `900000` | Ceiling for the `pip install`. Raise it on slow links; the first run can take minutes. |
| `HEADROOM_START_TIMEOUT_MS` | `90000` | How long to wait for `/health` after spawning `headroom proxy`. |

### External proxy

| Variable | Default | Meaning |
| --- | --- | --- |
| `HEADROOM_URL` | unset | Use a proxy you run yourself instead of a managed one. Skips the venv entirely. |
| `HEADROOM_PROXY_TOKEN` | unset | Bearer token sent to a token-protected proxy. |
| `HEADROOM_API_KEY` | unset | Fallback for `HEADROOM_PROXY_TOKEN`. |

With `HEADROOM_URL` set, the extension only checks `/health` at startup. `/headroom reinstall` refuses to run, and there is no process to start, restart, or stop, because none was created by this extension.

### Privacy

| Variable | Default | Meaning |
| --- | --- | --- |
| `HEADROOM_TELEMETRY` | `off` | The extension sets it to `off` unless you set a value. |
| `HEADROOM_BEACON` | `off` | The extension sets it to `off` unless you set a value. |
| `DO_NOT_TRACK` | `1` | Set by the extension for the proxy process unless already present. |

These three are applied to the child process environment only. Your shell is not modified.

### Pass-through variables

The proxy and the installer are spawned with a copy of your environment, so variables the extension does not read still reach them. Two cases worth knowing:

- **`HEADROOM_MODE`** is read by Headroom, not by this extension. It works when exported in your shell, and it cannot be set from `config.json` because the file has no key for it. Headroom may pick `cache` mode for coding profiles; `token` compresses harder at the risk of provider prefix-cache churn.
- **pip variables** such as `PIP_INDEX_URL` or `PIP_EXTRA_INDEX_URL` apply to the install, which is how you point the venv at a mirror or a corporate index.

## Version pins and Python

**Python 3.11+ is the supported minimum**, including the nightly compatibility check. Use an interpreter that also satisfies the selected Headroom release's `Requires-Python` metadata.

For backward compatibility, the installer retains these version-dependent technical floors for older explicit pins; this does not extend the supported baseline below Python 3.11:

| Headroom | Python |
| --- | --- |
| `0.42.x` and earlier | 3.10+ |
| `0.43.0` and later | 3.11+ |

The extension records `{version, extras, installedAt}` in `~/.pi/agent/make-headroom/venv/installed.json` and cross-checks it against `importlib.metadata`. If the pin, the extras, or the installed distribution disagree, the venv is repaired before the proxy starts.

`~/.pi/agent/make-headroom/requirements.txt` is generated from the pin. Do not edit it; change `version` or `HEADROOM_VERSION` instead.

## Files and state

Everything lives under `HEADROOM_HOME`, by default `~/.pi/agent/make-headroom`. Nothing is written outside it, and the system Python is never modified.

| Path | Contents | Notes |
| --- | --- | --- |
| `venv/` | Dedicated Python virtual environment. | Deleted by `/headroom reinstall`; recreated on the next setup. |
| `venv/installed.json` | `{version, extras, installedAt}` marker. | Used to detect a pin change. |
| `requirements.txt` | Generated `headroom-ai[extras]==version` line. | Regenerated on every install; do not edit. |
| `config.json` | Your configuration. | Written only if missing. |
| `runtime.json` | pid, port, host, version, venv of the last started proxy. | Lets the next session adopt a live proxy. |
| `install.lock` | Held while an install runs. | A dead pid or a lock older than 30 minutes is treated as stale. |
| `install.log` | `venv`, `ensurepip`, and `pip install` output. | One block per attempt; cleared above 5 MB. |
| `proxy.log` | Proxy stdout and stderr. | Cleared above 2 MB. |

`~/.pi/agent/make-headroom/venv` is the only large item. Deleting `HEADROOM_HOME` after `/headroom stop` removes every trace of the extension.

## Tuning

- **Faster first run.** Pre-warm the venv with `/headroom on` in a throwaway session, or raise `HEADROOM_INSTALL_TIMEOUT_MS` on a slow connection.
- **Latency.** Every model request makes one loopback HTTP call. On a large transcript this is measurable. Lower `HEADROOM_COMPRESS_TIMEOUT_MS` if you would rather send uncompressed than wait.
- **Port collisions.** Ports are probed before spawning, so a busy `8788` moves to the next free port. If all 50 are busy, startup fails with an explicit error; set `HEADROOM_PORT` to a free range.
- **Long transcripts.** Headroom's savings depend on the profile it selects. Long conversations with large tool outputs compress best.

## Verifying a configuration

```text
/headroom status
```

shows the resolved proxy URL, the pinned version, the pinned-versus-reported version, the venv path, the log path, the session counters, and the last request's transforms. It reports what the extension actually resolved, which is the fastest way to confirm that an environment variable took effect.
