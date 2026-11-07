# Changelog

## [Unreleased]

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
