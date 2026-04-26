import { describe, expect, it } from "vitest";
import { createMemorySearchTool } from "./memory-search.js";

describe("search_memory output", () => {
  it("includes timeliness and validity metadata", async () => {
    const tool = createMemorySearchTool({
      size: 1,
      searchFullText: () => [{
        id: 1,
        fact: "用户持有徐工机械",
        tags: ["股票", "持仓"],
        time: "2026-04-01T10:00:00.000Z",
        timeliness: "stateful",
        valid_to: "2026-04-10T10:00:00.000Z",
      }],
      searchByTags: () => [],
    });

    const result = await tool.execute("tool-call-1", { query: "股票持仓" });
    const text = result.content[0].text;

    expect(text).toContain("[stateful]");
    expect(text).toContain("recorded: 2026-04-01T10:00:00.000Z");
    expect(text).toContain("valid_to: 2026-04-10T10:00:00.000Z");
  });
});
