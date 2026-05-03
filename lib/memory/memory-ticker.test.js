import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = [];

vi.mock("./compile.js", () => ({
  compileToday: vi.fn(async () => { calls.push("compileToday"); return "compiled"; }),
  compileWeek: vi.fn(async () => { calls.push("compileWeek"); return "compiled"; }),
  compileLongterm: vi.fn(async () => { calls.push("compileLongterm"); return "compiled"; }),
  compileFacts: vi.fn(async () => { calls.push("compileFacts"); return "compiled"; }),
  assemble: vi.fn(() => { calls.push("assemble"); }),
}));

vi.mock("./deep-memory.js", () => ({
  processDirtySessions: vi.fn(async () => {
    calls.push("deepMemory");
    return { processed: 1, factsAdded: 1 };
  }),
}));

describe("memory ticker daily pipeline", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("writes deep-memory facts before compiling facts.md and assembling memory.md", async () => {
    const { createMemoryTicker } = await import("./memory-ticker.js");
    const ticker = createMemoryTicker({
      summaryManager: {
        getSummary: () => null,
        rollingSummary: async () => "",
      },
      configPath: "/tmp/config.yaml",
      factStore: {},
      getResolvedMemoryModel: () => ({ model: "mock", api: "mock", api_key: "", base_url: "mock" }),
      sessionDir: "/tmp/hanako-empty-sessions",
      memoryMdPath: "/tmp/memory.md",
      todayMdPath: "/tmp/today.md",
      weekMdPath: "/tmp/week.md",
      longtermMdPath: "/tmp/longterm.md",
      factsMdPath: "/tmp/facts.md",
      getMemoryMasterEnabled: () => true,
    });

    await ticker.tick();

    const deepIndex = calls.indexOf("deepMemory");
    const factsIndex = calls.indexOf("compileFacts");
    const firstAssembleIndex = calls.indexOf("assemble");

    expect(deepIndex).toBeGreaterThan(-1);
    expect(factsIndex).toBeGreaterThan(deepIndex);
    expect(firstAssembleIndex).toBeGreaterThan(factsIndex);
  });
});
