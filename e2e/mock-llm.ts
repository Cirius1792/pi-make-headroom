import { createServer } from "node:http";

interface CapturedRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
}
interface RequestStream extends AsyncIterable<Uint8Array | string> {
  method?: string;
  url?: string;
  headers: { "content-type"?: string };
}
interface ResponseSink {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body?: string): unknown;
}
const MAX_BODY = 4_194_304;

/** Deterministic OpenAI chat-completions streaming response; never interpolates text into SSE framing. */
export function encodeAssistantSse(text: string, model: string): string {
  const chunk = (delta: Record<string, string>, finish: string | null) => `data: ${JSON.stringify({
    id: "chatcmpl-headroom-smoke", object: "chat.completion.chunk", created: 0, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
}
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validateRequest(value: unknown): CapturedRequest {
  if (!isObject(value) || value.model !== "gpt-4o" || value.stream !== true ||
      !Array.isArray(value.messages) || value.messages.length === 0) throw new Error("invalid request");
  const messages = value.messages.map(message => {
    if (!isObject(message) || !["system", "developer", "user", "assistant"].includes(String(message.role))) throw new Error("invalid message");
    const content = message.content;
    if (typeof content !== "string" && !(Array.isArray(content) && content.length > 0 &&
        content.every(part => isObject(part) && part.type === "text" && typeof part.text === "string"))) throw new Error("invalid content");
    return { role: message.role as string, content: structuredClone(content) };
  });
  return { model: value.model, messages };
}

/** Socket-free HTTP boundary, shared by offline tests and the real loopback server. */
export function createMockLlm() {
  const requests: CapturedRequest[] = [];
  const replies: string[] = [];
  return {
    requests,
    enqueueAssistant(text: string): void { replies.push(text); },
    async handle(request: RequestStream, response: ResponseSink): Promise<void> {
      try {
        if (request.method !== "POST" || request.url !== "/v1/chat/completions" ||
            !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) throw new Error("unexpected request");
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_BODY) throw new Error("body limit");
          chunks.push(buffer);
        }
        const captured = validateRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (replies.length === 0) throw new Error("no scripted reply");
        // Bound retained in-memory history. A small fixed smoke fixture needs far less.
        if (requests.length >= 64) throw new Error("request limit");
        requests.push(captured);
        const text = replies.shift()!;
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        response.end(encodeAssistantSse(text, captured.model));
      } catch {
        // No raw request/exception details in responses or logs.
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "mock: unexpected request or missing scripted response", type: "invalid_request_error" } }));
      }
    },
  };
}

export async function startMockLlm(): Promise<{
  baseUrl: string;
  requests: CapturedRequest[];
  enqueueAssistant(text: string): void;
  close(): Promise<void>;
}> {
  const mock = createMockLlm();
  const server = createServer((request, response) => { void mock.handle(request, response); });
  server.requestTimeout = 30_000;
  server.headersTimeout = 30_000;
  server.on("clientError", (_error, socket) => { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = () => reject(new Error("mock: listen failed"));
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => { server.off("error", onError); resolve(); });
    });
  } catch {
    server.close();
    throw new Error("mock: listen failed");
  }
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("mock: missing loopback address"); }
  let closing: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, requests: mock.requests, enqueueAssistant: mock.enqueueAssistant,
    close() {
      return closing ??= new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(new Error("mock: close failed")) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
