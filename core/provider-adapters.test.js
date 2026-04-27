import { describe, expect, it } from "vitest";
import { AnthropicAdapter, OpenAIAdapter, streamSSE } from "./provider-adapters.js";

function createSseResponse(events = []) {
  const encoder = new TextEncoder();
  const payload = events
    .map((event) => `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`)
    .join("");

  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

describe("provider-adapters streamSSE", () => {
  it("parses legacy function_call stream as tool_use", async () => {
    const adapter = new OpenAIAdapter();
    const fetchFn = async () => createSseResponse([
      { choices: [{ delta: { reasoning_content: "先查一下文件。" } }] },
      { choices: [{ delta: { function_call: { name: "Glob" } } }] },
      { choices: [{ delta: { function_call: { arguments: "{\"pattern\":\"*\"" } } }] },
      { choices: [{ delta: { function_call: { arguments: ",\"path\":\"/tmp\"}" } } }] },
      { choices: [{ finish_reason: "function_call" }] },
      "[DONE]",
    ]);

    const result = await streamSSE({
      request: { url: "https://example.invalid", headers: {}, body: "{}" },
      adapter,
      fetchFn,
    });

    expect(result.stopReason).toBe("tool_use");
    expect(result.reasoning).toContain("先查一下文件");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      name: "Glob",
      arguments: { pattern: "*", path: "/tmp" },
    });
  });

  it("does not reset args when tool_call_start repeats", async () => {
    const adapter = new OpenAIAdapter();
    const fetchFn = async () => createSseResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "Glob" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"pattern\":\"*\"" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "Glob" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ",\"path\":\"/tmp\"}" } }] } }] },
      { choices: [{ finish_reason: "tool_calls" }] },
      "[DONE]",
    ]);

    const result = await streamSSE({
      request: { url: "https://example.invalid", headers: {}, body: "{}" },
      adapter,
      fetchFn,
    });

    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      name: "Glob",
      arguments: { pattern: "*", path: "/tmp" },
    });
  });
});

describe("AnthropicAdapter", () => {
  it("builds /v1/messages endpoints for Anthropic-compatible base URLs", () => {
    const adapter = new AnthropicAdapter();

    expect(adapter.buildStreamRequest({
      baseUrl: "https://api.anthropic.com",
      apiKey: "test-key",
      modelId: "claude-test",
      userMessage: "hi",
    }).url).toBe("https://api.anthropic.com/v1/messages");

    expect(adapter.buildStreamRequest({
      baseUrl: "https://api.minimaxi.com/anthropic",
      apiKey: "test-key",
      modelId: "MiniMax-test",
      userMessage: "hi",
    }).url).toBe("https://api.minimaxi.com/anthropic/v1/messages");
  });
});
