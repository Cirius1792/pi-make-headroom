# Troubleshooting

Most Headroom problems are visible in two places: the footer status line and `~/.pi/agent/make-headroom/proxy.log`.

## Start here

```text
/headroom status     # resolved config, version, venv, session totals, last request
/headroom health     # is /health answering right now?
```

`/headroom status` prints the proxy URL the extension actually resolved. If it is not the URL or version you expected, the problem is configuration, not the proxy — see [CONFIGURATION.md](CONFIGURATION.md).

| File | Contains |
| --- | --- |
| `~/.pi/agent/make-headroom/proxy.log` | Proxy stdout and stderr. Cleared when it exceeds 2 MB. |
| `~/.pi/agent/make-headroom/install.log` | `venv`, `ensurepip`, and `pip install` output, one block per attempt with exit codes and durations. Cleared when it exceeds 5 MB. |
| `~/.pi/agent/make-headroom/runtime.json` | pid, port, host, version, and venv of the last proxy this extension started. |
| `~/.pi/agent/make-headroom/install.lock` | Present only while an install is running. |

See [Files and state](CONFIGURATION.md#files-and-state) for every path the extension creates.

The extension never logs prompts, message content, API keys, or proxy tokens, so these files are safe to paste into an issue after a quick skim for paths you would rather not share.

## The footer is stuck on `⏳ Headroom starting`

**Why.** Setup runs in the background: finding Python, creating the venv, installing the pinned wheel, spawning the proxy, waiting for `/health`. The first run downloads Headroom and its proxy dependencies, so minutes are normal.

**Fix.** Watch the status line — it reports the current pip line. If it never moves, read `install.log`. If it stops at "Waiting for Headroom proxy…", read `proxy.log`.

## `⚠ Headroom offline`

**Why.** `/health` did not answer. Common causes: no network on the first run, a Python without `venv` or `ensurepip`, a port the proxy could not bind, or a crashed proxy.

**Fix.** Read the tail of `proxy.log`, then run `/headroom reinstall`. If the log mentions a version mismatch (`Proxy on port 8788 is version X, expected Y`), an old proxy is holding the port — run `/headroom stop`, then `/headroom on`.

## `Python 3.10+ was not found`

**Why.** No interpreter on `PATH` meets the pin's floor. Headroom 0.43+ needs Python 3.11+.

**Fix.** Install a newer Python, or point `HEADROOM_PYTHON` (or `python` in `config.json`) at an interpreter. On Debian and Ubuntu, `python3` alone is not enough — install `python3-venv` and `python3-pip` as well. The error names the newest version it did find, which is usually the one you need to upgrade.

## `pip install failed`

**Why.** The wheel for the pinned version did not build or download. A private index, a proxy, or a typo in `HEADROOM_VERSION` will all do this.

**Fix.** `install.log` holds the full pip output. Check that the exact version exists on [PyPI](https://pypi.org/project/headroom-ai/#history) and that your interpreter satisfies its `Requires-Python`. For a mirror, export `PIP_INDEX_URL`; the installer inherits your environment.

## `Timed out waiting for …/install.lock`

**Why.** Another Pi session is installing Headroom into the same home. The extension waits up to 20 minutes for the lock, then gives up.

**Fix.** Let the other session finish, or close it and rerun. A lock left by a killed process is detected automatically: a dead pid or a lock older than 30 minutes is treated as stale and removed.

## Setup was cancelled unexpectedly

**Why.** These actions cancel an in-flight install or start, kill the process tree, and release the lock: `/headroom off`, `/headroom stop`, `/headroom restart`, `/headroom reinstall`, and ending the session. Replacing the Pi session also invalidates the running setup so it cannot publish a stale result.

**Fix.** Run `/headroom on` and let setup finish. Nothing is corrupted by a cancellation — the venv is repaired on the next attempt.

## Savings stay at zero

**Why.** Depending on the Headroom version and the savings profile it selects, Headroom protects user messages and several tool outputs. It mostly compresses assistant prose, older tool results, and format-specific content. A short conversation can have nothing to compress.

**Fix.** Nothing is broken. `/headroom status` shows the last request's transforms; `none` confirms Headroom ran and chose not to shrink anything.

## The footer percentage looks too small

**Why.** The percentage is `saved / baseline`, where baseline is the *uncompressed* context for all requests in the session. Saving 2,000 tokens out of a 100,000-token baseline shows 2%.

**Fix.** Read the second figure in `/headroom status`, which also reports savings as a share of the tokens actually sent. Both are cumulative, not a property of the current context window. Percentages below 10% are shown with one decimal; below 0.1% as `<0.1%`.

## Token counts disagree with my provider's bill

**Why.** All counts come from Headroom's local tokenizer. Provider billing uses its own tokenizer, chat framing, and cache accounting.

**Fix.** Treat the numbers as a relative signal, not an invoice.

## A warning says the transcript could not be aligned

**Why.** Headroom returned a message list whose length or role order did not match the request. Replacing the wrong text would corrupt the conversation, so the extension discarded the compressed copy.

**Fix.** That request was sent uncompressed and nothing was lost. The warning appears once per session. If it repeats across sessions, capture `HEADROOM_VERSION` and the request shape for an issue.

## `Headroom is unavailable` mid-session

**Why.** A connection error or timeout during compression. The proxy either died or wedged.

**Fix.** The request went out uncompressed and the extension attempted one restart for that session. If the footer stays `offline`, run `/headroom restart`, then check `proxy.log`.

## Double compression

**Why.** The old `pi-headroom` package is installed alongside this one. Both hook the same `context` event, so a transcript can be compressed twice.

**Fix.** The extension warns on startup when it detects the old package. Remove it:

```bash
pi remove npm:pi-headroom
```

## A proxy is still running after Pi exited

**Why.** On a clean shutdown the extension stops the proxy it started. After an unclean exit — a crash, a killed terminal, `kill -9` — the detached proxy can survive, and that leftover is expected. The next session prefers to adopt a working proxy over installing and starting another.

**Fix.** Nothing, usually. The next session adopts the leftover if `runtime.json` matches the pinned version and host, and `/health` answers; otherwise it starts a fresh proxy on a free port. To kill a leftover deliberately, run `/headroom stop`. It signals the pid recorded in `runtime.json`, and only after checking that the process command line looks like a Headroom proxy.

## Start over

```text
/headroom stop
```

then, from a shell:

```bash
rm -rf ~/.pi/agent/make-headroom
```

The next session rebuilds the venv from scratch. This is safe: the directory holds only the venv, the config file, runtime state, and logs. If you customized `config.json`, copy it aside first.

## Remove the extension

```bash
pi remove npm:@cltec/pi-make-headroom # or the git: or local path you installed from
rm -rf ~/.pi/agent/make-headroom
```

Stopping the proxy first avoids leaving a process holding the port. Nothing is written anywhere else on the system, and the extension never installs into the system Python.

## Reporting a bug

Include the Pi version, OS, Python version (`python3 --version`), `HEADROOM_VERSION`, the output of `/headroom status`, and the last 40 lines of `proxy.log`. Remove anything private before pasting.
