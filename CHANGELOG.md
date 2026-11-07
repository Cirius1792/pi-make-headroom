# Changelog

## [0.1.0] - 2026-11-07

- Initial release.
- Installs a pinned `headroom-ai[proxy]` version into a dedicated Python venv.
- Starts and manages the local Headroom proxy with health checks, restart, adoption, and clean shutdown.
- Compresses model requests through Pi's `context` hook while preserving tool calls, tool results, thinking blocks, images, and provider metadata.
- Runs setup lazily in the background so the agent is usable immediately.
- Shows exact tokens saved and the saved share of baseline context in the footer.
