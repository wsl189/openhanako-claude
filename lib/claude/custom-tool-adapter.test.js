import { describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  tool: vi.fn((name, description, inputSchema, handler) => ({
    name,
    description,
    inputSchema,
    handler,
  })),
  createSdkMcpServer: vi.fn((config) => config),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: sdkMocks.tool,
  createSdkMcpServer: sdkMocks.createSdkMcpServer,
}));

import { adaptCustomTool } from "./custom-tool-adapter.js";

describe("adaptCustomTool content normalization", () => {
  it("converts legacy anthropic image blocks into MCP image content", async () => {
    const onToolEnd = vi.fn();
    const toolDef = {
      name: "generate_images",
      description: "Generate image",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => ({
        content: [{
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "ZmFrZS1pbWFnZQ==",
          },
        }],
        details: { imageCount: 1 },
      })),
    };

    const adapted = adaptCustomTool(toolDef, { onToolEnd });
    const result = await adapted.handler({}, {});

    expect(result.content).toEqual([{
      type: "image",
      data: "ZmFrZS1pbWFnZQ==",
      mimeType: "image/png",
    }]);
    expect(onToolEnd).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      content: [{
        type: "image",
        data: "ZmFrZS1pbWFnZQ==",
        mimeType: "image/png",
      }],
    }));
  });

  it("normalizes non-standard blocks into text blocks to avoid schema failure", async () => {
    const toolDef = {
      name: "dummy_tool",
      description: "dummy",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => ({
        content: [{ foo: "bar" }],
      })),
    };

    const adapted = adaptCustomTool(toolDef);
    const result = await adapted.handler({}, {});

    expect(result.content).toEqual([{ type: "text", text: "{\"foo\":\"bar\"}" }]);
  });
});
