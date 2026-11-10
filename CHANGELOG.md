# Changelog

## [Unreleased]

## [0.3.0] - 2026-11-10

- Updated the default Headroom pin from `0.43.1` to `0.44.0`.

## [0.2.0] - 2026-11-08

- Added nightly PyPI discovery and tested Headroom update PRs: fixed Pi 1.5.0/Python 3.11 compatibility smoke, minor extension-version bumps, and draft PRs when validation fails.
- Added automatic exact-commit tags and explicit trusted-release dispatch after validated version increases reach `main`; normal commits do not publish.
- Documented Python 3.11+ as the supported minimum and clarified that explicit configuration pins survive extension updates.
- Updated the default Headroom pin from `0.42.0` to `0.43.1`.

## [0.1.1] - 2026-11-08

- Renamed the npm package to `@cltec/pi-make-headroom`; remove previous unscoped npm installations before switching to avoid duplicate compression.
- Added tag-triggered npm trusted publishing and GitHub Releases showing the default Headroom version from the tagged source, plus a maintainer release guide.
- Added a manual `Compatibility smoke` workflow and maintainer guide for checking an exact Pi / Headroom version pair with the packed checkout, real managed Headroom, and a local mock LLM; publishes a sanitized result without implying a full compatibility guarantee.
- Restructured `README.md` as a landing page: quick start, requirements, install variants, status line, commands, and links.
- Added `docs/CONFIGURATION.md`: all 16 environment variables, the `config.json` schema, validation rules, version and Python pins, and tuning.
- Added `docs/TROUBLESHOOTING.md`: symptom-by-symptom fixes, log files, full reset, and uninstall.

## [0.1.0] - 2026-11-07

- Initial release.
- Installs a pinned `headroom-ai[proxy]` version into a dedicated Python venv.
- Starts and manages the local Headroom proxy with health checks, restart, adoption, and clean shutdown.
- Compresses model requests through Pi's `context` hook while preserving tool calls, tool results, thinking blocks, images, and provider metadata.
- Runs setup lazily in the background so the agent is usable immediately.
- Shows exact tokens saved and the saved share of baseline context in the footer.
