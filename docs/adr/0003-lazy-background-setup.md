# ADR 0003: Lazy background setup

- Status: Accepted
- Date: 2026-11-07

## Context

A fresh install can take minutes: venv creation, pip downloads, proxy startup, and the optional Kompress model warmup. Awaiting that work in `session_start` prevents the user from using the agent until it finishes.

## Decision

Schedule setup from `session_start` and return immediately. The agent remains usable while setup runs in the background.

- `context` returns the original transcript until the proxy is online.
- The footer shows `Preparing Headroom in the background…` and setup progress.
- Compression turns on automatically when setup succeeds.
- Each setup run has a generation and attempt id. A stale run cannot publish a result or kill a newer proxy.
- `session_shutdown`, `/headroom off`, `/headroom stop`, `/headroom restart`, and `/headroom reinstall` cancel an in-flight setup and kill the process tree.

## Consequences

- The first requests in a session may be uncompressed.
- The extension needs explicit run cancellation and process-tree handling.
- Setup errors must be surfaced asynchronously without blocking the session.
- Tests must cover cancellation, stale runs, and lock release.
