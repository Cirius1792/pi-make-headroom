/**
 * Format bridge between Pi's provider-neutral messages and the OpenAI message
 * shape understood by Headroom's `POST /v1/compress`.
 *
 * Headroom's live-zone compression operates on content inside messages and does
 * not add, drop, or reorder messages. The bridge therefore aligns the compressed
 * list with the original list positionally and re-applies the compressed text to
 * the original message objects. Structural metadata (timestamps, usage, tool call
 * IDs, thinking blocks, provider fields) comes from the original message, so a
 * single compressed copy only changes what the model reads.
 */

import type {
  AssistantMessage,
  ImageContent,
  Message,
  SystemMessage,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";

import type {
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIToolCall,
} from "./types.ts";

export interface OpenAIPair {
  openai: OpenAIMessage;
  source: Message;
}

/** Convert Pi provider-facing messages into Headroom's OpenAI input shape. */
export function piToOpenAI(messages: Message[]): OpenAIPair[] {
  const pairs: OpenAIPair[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "system":
        pairs.push({ openai: convertSystem(message), source: message });
        break;
      case "user":
        pairs.push({ openai: convertUser(message), source: message });
        break;
      case "assistant":
        pairs.push({ openai: convertAssistant(message), source: message });
        break;
      case "toolResult":
        pairs.push({ openai: convertToolResult(message), source: message });
        break;
    }
  }

  return pairs;
}

/**
 * Convert compressed OpenAI messages back to Pi messages.
 *
 * Returns `null` when the response cannot be aligned safely. The caller then
 * keeps the original transcript for that request. This is intentionally strict:
 * sending a partially aligned transcript is worse than skipping one compression.
 */
export function openAIToPi(compressed: OpenAIMessage[], pairs: OpenAIPair[]): Message[] | null {
  if (compressed.length !== pairs.length) return null;

  const result: Message[] = [];
  for (let i = 0; i < compressed.length; i++) {
    const next = applyCompressed(compressed[i], pairs[i].source);
    if (!next) return null;
    result.push(next);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pi -> OpenAI
// ---------------------------------------------------------------------------

function convertSystem(message: SystemMessage): OpenAIMessage {
  return {
    role: "system",
    content: typeof message.content === "string" ? message.content : joinText(message.content),
  };
}

function convertUser(message: UserMessage): OpenAIMessage {
  if (typeof message.content === "string") {
    return { role: "user", content: message.content };
  }

  const hasImages = message.content.some((part) => part.type === "image");
  if (!hasImages) {
    return { role: "user", content: joinText(message.content) };
  }

  const parts: OpenAIContentPart[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${part.mimeType};base64,${part.data}` },
      });
    }
  }
  return { role: "user", content: parts };
}

function convertAssistant(message: AssistantMessage): OpenAIMessage {
  const text = message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");

  const toolCalls = message.content
    .filter((part): part is ToolCall => part.type === "toolCall")
    .map(
      (call): OpenAIToolCall => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: safeStringify(call.arguments),
        },
      }),
    );

  return {
    role: "assistant",
    content: text.length > 0 ? text : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function convertToolResult(message: ToolResultMessage): OpenAIMessage {
  return {
    role: "tool",
    content: joinText(message.content),
    tool_call_id: message.toolCallId,
  };
}

// ---------------------------------------------------------------------------
// OpenAI -> Pi
// ---------------------------------------------------------------------------

function applyCompressed(compressed: OpenAIMessage, source: Message): Message | null {
  switch (source.role) {
    case "system":
      // Headroom does not compress system messages by default, and system
      // messages can carry Pi prompt sections and tool declarations. Keep them.
      return compressed.role === "system" ? source : null;

    case "user":
      return compressed.role === "user" ? applyToUser(source, compressed) : null;

    case "assistant":
      return compressed.role === "assistant" ? applyToAssistant(source, compressed) : null;

    case "toolResult":
      return compressed.role === "tool" ? applyToToolResult(source, compressed) : null;

    default:
      return null;
  }
}

function applyToUser(source: UserMessage, compressed: Extract<OpenAIMessage, { role: "user" }>): UserMessage {
  const text = openAIText(compressed.content);
  if (text === null) return source;

  if (typeof source.content === "string") {
    return { ...source, content: text };
  }

  const images = source.content.filter((part): part is ImageContent => part.type === "image");
  const content: (TextContent | ImageContent)[] = [];
  if (text.length > 0 || images.length === 0) {
    content.push({ type: "text", text });
  }
  content.push(...images);
  return { ...source, content };
}

function applyToAssistant(
  source: AssistantMessage,
  compressed: Extract<OpenAIMessage, { role: "assistant" }>,
): AssistantMessage {
  const compressedText = openAIText(compressed.content);
  const originalText = source.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");

  // If Headroom returned no text field at all, keep the original text rather
  // than silently dropping an assistant message.
  const text = compressedText === null ? originalText : compressedText;

  const thinking = source.content.filter((part) => part.type === "thinking");
  const toolCalls = source.content.filter((part): part is ToolCall => part.type === "toolCall");

  const content: AssistantMessage["content"] = [...thinking];
  if (text.length > 0) content.push({ type: "text", text });
  content.push(...toolCalls);

  return { ...source, content };
}

function applyToToolResult(
  source: ToolResultMessage,
  compressed: Extract<OpenAIMessage, { role: "tool" }>,
): ToolResultMessage {
  const text = openAIText(compressed.content);
  if (text === null) return source;

  const images = source.content.filter((part): part is ImageContent => part.type === "image");
  const content: (TextContent | ImageContent)[] = [];
  if (text.length > 0 || images.length === 0) {
    content.push({ type: "text", text });
  }
  content.push(...images);
  return { ...source, content };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function joinText(parts: (TextContent | ImageContent | ToolCall)[]): string {
  return parts
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function openAIText(content: string | OpenAIContentPart[] | null): string | null {
  if (content === null) return null;
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<OpenAIContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}
