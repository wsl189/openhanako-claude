import { afterEach, describe, expect, it, vi } from "vitest";
import { callProviderText } from "./provider-client.js";

const ORIGINAL_FETCH = globalThis.fetch;

function mockJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

describe("callProviderText(openai-responses)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("uses final assistant message instead of output_text reasoning", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({
      output_text: "用户说的第一句话是“你好”，这是中文。根据规则，我需要先分析…",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "分析中" }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "打招呼" }],
        },
      ],
    }));

    const out = await callProviderText({
      api: "openai-responses",
      api_key: "test-key",
      base_url: "https://example.com/v1",
      model: "test-model",
      messages: [{ role: "user", content: "你好" }],
      max_tokens: 50,
    });

    expect(out).toBe("打招呼");
  });

  it("drops reasoning-like chunks inside assistant content", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "reasoning", text: "先分析一下" },
            { type: "output_text", text: "最终标题" },
          ],
        },
      ],
    }));

    const out = await callProviderText({
      api: "openai-responses",
      api_key: "test-key",
      base_url: "https://example.com/v1",
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 50,
    });

    expect(out).toBe("最终标题");
  });

  it("retries with larger token budget when response is reasoning-only and max-token stopped", async () => {
    globalThis.fetch = vi.fn()
      .mockImplementationOnce(async () => mockJsonResponse({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] }],
      }))
      .mockImplementationOnce(async () => mockJsonResponse({
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "最终回复" }],
        }],
      }));

    const out = await callProviderText({
      api: "openai-responses",
      api_key: "test-key",
      base_url: "https://example.com/v1",
      model: "test-model",
      messages: [{ role: "user", content: "你好" }],
      max_tokens: 50,
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(out).toBe("最终回复");

    const secondBody = JSON.parse(globalThis.fetch.mock.calls[1][1].body);
    expect(secondBody.max_output_tokens).toBeGreaterThan(50);
  });
});

describe("callProviderText(anthropic-messages)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("uses /v1/messages for Anthropic-compatible base URLs", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({
      content: [{ type: "text", text: "ok" }],
    }));

    const out = await callProviderText({
      api: "anthropic-messages",
      api_key: "test-key",
      base_url: "https://api.minimaxi.com/anthropic",
      model: "MiniMax-test",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    });

    expect(out).toBe("ok");
    expect(globalThis.fetch.mock.calls[0][0]).toBe("https://api.minimaxi.com/anthropic/v1/messages");
  });
});
