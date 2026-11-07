import type { CompressResult, HealthInfo, OpenAIMessage } from "./types.ts";

export type HeadroomErrorKind = "connection" | "timeout" | "http" | "invalid";

export class HeadroomRequestError extends Error {
  readonly kind: HeadroomErrorKind;
  readonly status: number | undefined;

  constructor(kind: HeadroomErrorKind, message: string, status?: number) {
    super(message);
    this.name = "HeadroomRequestError";
    this.kind = kind;
    this.status = status;
  }
}

function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const anyGlobal = globalThis as unknown as {
    AbortSignal?: { timeout?: (ms: number) => AbortSignal };
  };
  if (anyGlobal.AbortSignal?.timeout) {
    return { signal: anyGlobal.AbortSignal.timeout(ms), cancel: () => undefined };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toPositiveInt(value: unknown, fallback: number): number {
  const n = toFiniteNumber(value, fallback);
  return n > 0 ? Math.floor(n) : fallback;
}

/**
 * A tiny dependency-free client for the local Headroom proxy.
 *
 * Only two endpoints are used:
 *  - GET  /health       liveness/readiness
 *  - POST /v1/compress  compress an OpenAI-format message list
 */
export class HeadroomClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl: string; apiKey?: string; timeoutMs?: number }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey || undefined;
    this.timeoutMs = toPositiveInt(options.timeoutMs, 30_000);
  }

  async health(timeoutMs = 3_000): Promise<HealthInfo | null> {
    const { signal, cancel } = timeoutSignal(timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: "GET",
        headers: this.headers(),
        signal,
      });
      if (!response.ok) return null;
      const data = (await response.json()) as Record<string, unknown>;
      if (!data || typeof data !== "object") return null;
      const checks =
        data.checks && typeof data.checks === "object"
          ? (data.checks as Record<string, unknown>)
          : undefined;
      const kompress =
        checks?.kompress && typeof checks.kompress === "object"
          ? (checks.kompress as Record<string, unknown>)
          : undefined;
      return {
        status: String(data.status ?? (data.ready === true ? "healthy" : "unknown")),
        ready: data.ready === true,
        version: data.version === undefined ? undefined : String(data.version),
        service: data.service === undefined ? undefined : String(data.service),
        kompressEnabled: kompress?.enabled === true,
        kompressReady: kompress?.ready === true,
        kompressStatus: kompress?.status === undefined ? undefined : String(kompress.status),
      };
    } catch {
      return null;
    } finally {
      cancel();
    }
  }

  async compress(
    messages: OpenAIMessage[],
    model: string,
    options?: { retries?: number },
  ): Promise<CompressResult> {
    const retries = Math.max(0, Math.min(3, options?.retries ?? 1));
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.compressOnce(messages, model);
      } catch (error) {
        lastError = error;
        if (error instanceof HeadroomRequestError) {
          const retryable = error.kind === "connection" || error.kind === "timeout";
          const serverError = error.kind === "http" && (error.status ?? 0) >= 500;
          if (!retryable && !serverError) throw error;
        } else {
          throw error;
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new HeadroomRequestError("connection", String(lastError));
  }

  private async compressOnce(messages: OpenAIMessage[], model: string): Promise<CompressResult> {
    const { signal, cancel } = timeoutSignal(this.timeoutMs);
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}/v1/compress`, {
        method: "POST",
        headers: {
          ...this.headers(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages, model }),
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new HeadroomRequestError(
          "timeout",
          `Compression timed out after ${Math.round(this.timeoutMs / 1000)}s`,
        );
      }
      throw new HeadroomRequestError(
        "connection",
        `Cannot reach Headroom at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      cancel();
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new HeadroomRequestError(
        "http",
        `Headroom returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        response.status,
      );
    }

    let data: Record<string, unknown>;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new HeadroomRequestError("invalid", "Headroom returned a non-JSON response");
    }

    if (!data || !Array.isArray(data.messages)) {
      throw new HeadroomRequestError("invalid", "Headroom response is missing a messages array");
    }

    const tokensBefore = toFiniteNumber(data.tokens_before);
    const tokensAfter = toFiniteNumber(data.tokens_after, tokensBefore);
    const tokensSaved = toFiniteNumber(data.tokens_saved, tokensBefore - tokensAfter);
    const ratio = toFiniteNumber(
      data.compression_ratio,
      tokensBefore > 0 ? tokensAfter / tokensBefore : 1,
    );

    return {
      // The proxy preserves message roles and count, so this can be aligned with
      // the original transcript positionally. See format-bridge.ts.
      messages: data.messages as OpenAIMessage[],
      tokensBefore,
      tokensAfter,
      tokensSaved,
      compressionRatio: ratio,
      transformsApplied: Array.isArray(data.transforms_applied)
        ? data.transforms_applied.map(String)
        : [],
      ccrHashes: Array.isArray(data.ccr_hashes) ? data.ccr_hashes.map(String) : [],
    };
  }

  private headers(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return "";
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: unknown; type?: unknown } | string;
        detail?: unknown;
      };
      if (typeof parsed.error === "string") return parsed.error;
      if (parsed.error && typeof parsed.error === "object") {
        const message = parsed.error.message;
        if (typeof message === "string") return message;
      }
      if (typeof parsed.detail === "string") return parsed.detail;
    } catch {
      // Not JSON; fall through to the raw text.
    }
    return text.slice(0, 500);
  } catch {
    return "";
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ("name" in error && (error as { name?: unknown }).name === "AbortError")
  );
}
