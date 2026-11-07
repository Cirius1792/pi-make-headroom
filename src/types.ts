/**
 * Minimal OpenAI-compatible message types used by Headroom's `POST /v1/compress`.
 *
 * These are deliberately local definitions. The extension must not depend on the
 * `headroom-ai` JavaScript SDK: the only Headroom code it uses is the Python
 * package installed into the managed virtual environment.
 */

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type OpenAIMessage =
  | { role: "system"; content: string | OpenAIContentPart[] }
  | { role: "user"; content: string | OpenAIContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export interface CompressResult {
  messages: OpenAIMessage[];
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  compressionRatio: number;
  transformsApplied: string[];
  ccrHashes: string[];
}

export interface HealthInfo {
  status: string;
  ready: boolean;
  version?: string;
  service?: string;
  /** Headroom's optional ML compressor. It warms after /health is ready. */
  kompressEnabled?: boolean;
  kompressReady?: boolean;
  kompressStatus?: string;
}

export interface SessionTotals {
  /** Number of compression requests whose response was applied (or was a no-op). */
  calls: number;
  /** Sum of `tokens_before` across counted requests. */
  baselineTokens: number;
  /** Sum of `tokens_after` across counted requests. */
  compressedTokens: number;
  /** Sum of `tokens_saved` across counted requests. */
  savedTokens: number;
}

export interface LastCompression {
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  compressionRatio: number;
  transforms: string[];
  at: number;
}
