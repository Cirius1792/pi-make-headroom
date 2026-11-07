import assert from "node:assert/strict";
import test from "node:test";

import { openAIToPi, piToOpenAI } from "../src/format-bridge.ts";

function usage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

test("user string round trip keeps timestamp and replaces text", () => {
  const source = { role: "user", content: "hello", timestamp: 1 };
  const pairs = piToOpenAI([source as never]);

  assert.deepEqual(pairs[0].openai, { role: "user", content: "hello" });

  const result = openAIToPi([{ role: "user", content: "hi" }], pairs);
  assert.ok(result);
  assert.equal(result[0].role, "user");
  assert.equal((result[0] as { content: unknown }).content, "hi");
  assert.equal((result[0] as { timestamp: number }).timestamp, 1);
});

test("user images are converted to data URLs and preserved on the way back", () => {
  const source = {
    role: "user",
    content: [
      { type: "text", text: "describe" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ],
    timestamp: 2,
  };
  const pairs = piToOpenAI([source as never]);
  const openai = pairs[0].openai;

  assert.ok(Array.isArray(openai.content));
  assert.deepEqual(openai.content[0], { type: "text", text: "describe" });
  assert.deepEqual(openai.content[1], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,AAAA" },
  });

  const result = openAIToPi([{ role: "user", content: "a short description" }], pairs);
  assert.ok(result);
  assert.deepEqual((result[0] as { content: unknown }).content, [
    { type: "text", text: "a short description" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ]);
});

test("assistant thinking and tool calls survive text compression", () => {
  const source = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "I will read the file" },
      { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
    ],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4o",
    usage: usage(),
    stopReason: "toolUse",
    timestamp: 3,
  };

  const pairs = piToOpenAI([source as never]);
  assert.deepEqual(pairs[0].openai, {
    role: "assistant",
    content: "I will read the file",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "read", arguments: "{\"path\":\"a.ts\"}" },
      },
    ],
  });

  const result = openAIToPi(
    [
      {
        role: "assistant",
        content: "Read a.ts",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: "{\"path\":\"a.ts\"}" },
          },
        ],
      },
    ],
    pairs,
  );

  assert.ok(result);
  const content = (result[0] as { content: any[] }).content;
  assert.deepEqual(content[0], { type: "thinking", thinking: "plan" });
  assert.deepEqual(content[1], { type: "text", text: "Read a.ts" });
  assert.deepEqual(content[2], {
    type: "toolCall",
    id: "call_1",
    name: "read",
    arguments: { path: "a.ts" },
  });
});

test("tool result keeps its tool call identity", () => {
  const source = {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    content: [{ type: "text", text: "original output" }],
    isError: false,
    timestamp: 4,
  };

  const pairs = piToOpenAI([source as never]);
  assert.deepEqual(pairs[0].openai, {
    role: "tool",
    content: "original output",
    tool_call_id: "call_1",
  });

  const result = openAIToPi(
    [{ role: "tool", content: "short output", tool_call_id: "call_1" }],
    pairs,
  );

  assert.ok(result);
  const message = result[0] as any;
  assert.equal(message.role, "toolResult");
  assert.equal(message.toolCallId, "call_1");
  assert.equal(message.toolName, "read");
  assert.deepEqual(message.content, [{ type: "text", text: "short output" }]);
});

test("a different message count is rejected", () => {
  const pairs = piToOpenAI([{ role: "user", content: "hello", timestamp: 1 } as never]);
  assert.equal(openAIToPi([], pairs), null);
});

test("a role mismatch is rejected", () => {
  const pairs = piToOpenAI([{ role: "user", content: "hello", timestamp: 1 } as never]);
  assert.equal(openAIToPi([{ role: "assistant", content: "hi" }], pairs), null);
});

test("system messages are left untouched", () => {
  const source = {
    role: "system",
    content: "You are a helpful assistant.",
    timestamp: 1,
  };
  const pairs = piToOpenAI([source as never]);
  const result = openAIToPi([{ role: "system", content: "changed" }], pairs);

  assert.ok(result);
  assert.equal(result[0], source);
});
