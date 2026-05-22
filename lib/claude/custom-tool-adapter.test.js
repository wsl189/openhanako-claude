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
    expect(result.structuredContent).toBeUndefined();
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
    expect(result.structuredContent).toBeUndefined();
  });

  it("includes structuredContent only when explicitly enabled", async () => {
    const toolDef = {
      name: "dummy_tool",
      description: "dummy",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => ({
        content: [{ type: "text", text: "ok" }],
        details: { foo: "bar" },
      })),
    };

    const adaptedDefault = adaptCustomTool(toolDef);
    const defaultResult = await adaptedDefault.handler({}, {});
    expect(defaultResult.structuredContent).toBeUndefined();

    const adaptedWithStructured = adaptCustomTool(toolDef, { includeStructuredContent: true });
    const structuredResult = await adaptedWithStructured.handler({}, {});
    expect(structuredResult.structuredContent).toEqual({ details: { foo: "bar" } });
  });

  it("keeps TypeBox Record map fields (mcp.env) when validating tool args", async () => {
    let receivedArgs = null;
    const toolDef = {
      name: "setup_settings",
      description: "setup",
      parameters: {
        type: "object",
        properties: {
          mcp: {
            type: "object",
            properties: {
              name: { type: "string" },
              env: {
                type: "object",
                patternProperties: {
                  "^(.*)$": { type: "string" },
                },
              },
            },
          },
        },
      },
      execute: vi.fn(async (_toolCallId, args) => {
        receivedArgs = args;
        return { content: [{ type: "text", text: "ok" }] };
      }),
    };

    const adapted = adaptCustomTool(toolDef);
    await adapted.handler({
      mcp: {
        name: "MiniMax",
        env: {
          MINIMAX_API_KEY: "k",
          MINIMAX_API_HOST: "https://api.minimaxi.com",
        },
      },
    }, {});

    expect(receivedArgs?.mcp?.env).toEqual({
      MINIMAX_API_KEY: "k",
      MINIMAX_API_HOST: "https://api.minimaxi.com",
    });
  });
});
