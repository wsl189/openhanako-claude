import { describe, expect, it } from "vitest";
import { createMemorySearchTool } from "./memory-search.js";

describe("search_memory output", () => {
  it("includes timeliness and validity metadata", async () => {
    const tool = createMemorySearchTool({
      factStore: { size: 1 },
      searchIndex: () => [{
        id: 1,
        fact: "用户持有徐工机械",
        tags: ["股票", "持仓"],
        time: "2026-04-01T10:00:00.000Z",
        timeliness: "stateful",
        valid_to: "2026-04-10T10:00:00.000Z",
      }],
    });

    const result = await tool.execute("tool-call-1", { query: "股票持仓" });
    const text = result.content[0].text;

    expect(text).toContain("[stateful]");
    expect(text).toContain("recorded: 2026-04-01T10:00:00.000Z");
    expect(text).toContain("valid_to: 2026-04-10T10:00:00.000Z");
  });

  it("formats playbook and episode results from routed search", async () => {
    const tool = createMemorySearchTool({
      factStore: { size: 0 },
      searchMemories: () => ([
        {
          itemType: "playbook",
          preview: "[Memory] 修复状态召回",
          truthTime: "2026-05-20T10:00:00.000Z",
        },
        {
          itemType: "episode",
          preview: "用户确认继续长期持有。",
          tags: ["投资", "决策"],
          truthTime: "2026-05-20T10:05:00.000Z",
        },
      ]),
    });

    const result = await tool.execute("tool-call-2", {
      query: "状态召回",
      intent: "playbook",
      layers: "playbooks",
    });
    const text = result.content[0].text;
    expect(text).toContain("[playbook]");
    expect(text).toContain("[episode]");
  });

  it("forces channel scope when called from channel execution context", async () => {
    let captured = null;
    const tool = createMemorySearchTool({
      factStore: { size: 1 },
      searchMemories: (params) => {
        captured = params;
        return [{
          itemType: "fact",
          fact: "频道决定由 Alice 负责 API 重构",
          tags: ["API", "分工"],
          time: "2026-05-20T10:00:00.000Z",
          timeliness: "persistent",
        }];
      },
    });

    const result = await tool.execute(
      "tool-call-3",
      { query: "负责人是谁", scope: "profile" },
      null,
      null,
      { executionMode: "channel", memoryScope: "channel", channelName: "team" },
    );

    expect(captured?.scope).toBe("channel");
    expect(result.details).toMatchObject({
      scope: "channel",
      scopeLocked: true,
    });
  });
});
