import { describe, expect, it } from "vitest";
import { compactAssistantSnapshotContent, compactSdkMessage } from "./chat.js";

describe("chat stream compaction", () => {
  it("keeps long assistant snapshot text intact for live rendering", () => {
    const longText = "长回复".repeat(5000);

    const compacted = compactAssistantSnapshotContent([
      { type: "text", text: longText },
    ]);

    expect(compacted).toEqual([{ type: "text", text: longText }]);
    expect(compacted[0].text.length).toBeGreaterThan(12_000);
  });

  it("keeps long assistant sdk_message text intact for live rendering", () => {
    const longText = "assistant output ".repeat(1000);

    const compacted = compactSdkMessage({
      role: "assistant",
      messageId: "msg-long",
      content: [{ type: "text", text: longText }],
    });

    expect(compacted).toMatchObject({
      role: "assistant",
      messageId: "msg-long",
      content: [{ type: "text", text: longText }],
    });
    expect(compacted.content[0].text.length).toBeGreaterThan(12_000);
  });

  it("keeps setup_settings nested args for live tool detail rendering", () => {
    const compacted = compactAssistantSnapshotContent([
      {
        type: "tool_use",
        id: "call_setup_1",
        name: "mcp__hanako__setup_settings",
        input: {
          tutorial: "{\"agent\":{\"action\":\"create\",\"name\":\"kimi\"}}",
          agent: { action: "create", name: "kimi", id: "kimi" },
          mcp: { name: "playwright", type: "stdio", command: "npx" },
          memory: { action: "clear", agent_id: "hanako" },
          dry_run: false,
        },
      },
    ]);

    expect(compacted).toEqual([
      {
        type: "tool_use",
        id: "call_setup_1",
        name: "mcp__hanako__setup_settings",
        input: {
          tutorial: "{\"agent\":{\"action\":\"create\",\"name\":\"kimi\"}}",
          agent: { action: "create", name: "kimi", id: "kimi" },
          mcp: { name: "playwright", type: "stdio", command: "npx" },
          memory: { action: "clear", agent_id: "hanako" },
          dry_run: false,
        },
      },
    ]);
  });
});
