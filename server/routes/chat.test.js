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
});
