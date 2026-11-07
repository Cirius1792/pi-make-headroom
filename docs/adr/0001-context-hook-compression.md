# ADR 0001: Compress through the `context` hook

- Status: Accepted
- Date: 2026-11-07

## Context

The original `pi-headroom` extension uses the `headroom-ai` JavaScript SDK and a locally running Headroom proxy. An alternative is to route Pi's provider traffic through the proxy by changing the provider base URL.

That routing approach couples the extension to each provider's transport, streaming behavior, authentication, and error format. It also makes the extension harder to keep dependency-free.

## Decision

Compress the transcript in Pi's `context` event and call Headroom's `POST /v1/compress` endpoint directly with `fetch`.

- No `headroom-ai` npm dependency.
- Pi keeps its normal provider transport.
- The extension owns message conversion and alignment.

## Consequences

- Works with any provider or API that Pi supports through the `context` hook.
- The proxy is a compression service, not a transparent LLM proxy. Streaming, provider retries, and auth stay in Pi.
- The extension must align compressed messages safely. If it cannot, it must return the original transcript.
- Retrieval markers produced by Headroom are not actionable because the extension does not inject a retrieve tool. Compression falls back to the original transcript when alignment is unsafe.
- One extra localhost HTTP round trip is added to each model request.
