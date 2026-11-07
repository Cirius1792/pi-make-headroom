# ADR 0002: Managed pinned Python venv

- Status: Accepted
- Date: 2026-11-07

## Context

Headroom is a Python package. Installing it into the system Python can fail on externally managed environments (PEP 668), can conflict with other tools, and can drift between versions. Users should not need to prepare Python dependencies manually.

## Decision

Create a dedicated venv under `~/.pi/agent/make-headroom/venv` and install an exact `headroom-ai[proxy]` version from PyPI.

- Default pin: `0.42.0`.
- Override with `HEADROOM_VERSION` or `config.json`.
- Use the venv's Python and `headroom` executable for the proxy.
- Record the installed version and reinstall when the pin or extras change.

## Consequences

- Reproducible installs that do not touch the system Python.
- First run downloads Headroom and its proxy dependencies; later runs reuse the venv.
- Requires Python 3.10+ (3.11+ for Headroom 0.43+).
- The extension must manage venv creation, pip errors, install locks, and cleanup.
- The venv is an implementation detail and should not be committed.
