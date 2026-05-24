import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = [];
const tempDirs = [];

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

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
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

  it("uses evidence as rolling-summary input during normal promoted flow", async () => {
    const { createMemoryTicker } = await import("./memory-ticker.js");
    const rollingSummary = vi.fn(async () => "");
    const logDiagnostic = vi.fn();
    const listEvidenceBySession = vi.fn(() => ([
      {
        id: "e1",
        sourceType: "user_message",
        content: "用户：请先确认需求",
        createdAt: "2026-05-22T10:00:00.000Z",
        updatedAt: "2026-05-22T10:00:00.000Z",
      },
      {
        id: "e2",
        sourceType: "assistant_message",
        content: "助手：先给你结论",
        createdAt: "2026-05-22T10:00:01.000Z",
        updatedAt: "2026-05-22T10:00:01.000Z",
      },
    ]));
    const upsertEpisode = vi.fn(() => ({ id: "episode_1" }));
    const ticker = createMemoryTicker({
      summaryManager: {
        getSummary: () => ({ summary: "summary-anchor" }),
        rollingSummary,
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
      memoryService: {
        listEvidenceBySession,
        upsertEpisode,
        logDiagnostic,
        setSummaryProjection: vi.fn(),
      },
      getMemoryMasterEnabled: () => true,
    });

    await ticker.notifyPromoted("/tmp/normal.session.json");

    expect(rollingSummary).toHaveBeenCalledTimes(1);
    const [, messages] = rollingSummary.mock.calls[0];
    expect(messages).toEqual([
      { role: "user", content: "用户：请先确认需求", timestamp: "2026-05-22T10:00:00.000Z" },
      { role: "assistant", content: "助手：先给你结论", timestamp: "2026-05-22T10:00:01.000Z" },
    ]);
    expect(upsertEpisode).toHaveBeenCalledTimes(1);
    expect(logDiagnostic).not.toHaveBeenCalledWith(
      "rolling_summary_transcript_recovery",
      expect.anything(),
    );
  });

  it("allows transcript fallback only during startup recovery", async () => {
    const { createMemoryTicker } = await import("./memory-ticker.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-ticker-recovery-"));
    tempDirs.push(root);
    const sessionPath = path.join(root, "recoverable.jsonl");
    fs.writeFileSync(
      sessionPath,
      [
        JSON.stringify({ type: "message", timestamp: "2026-05-22T11:00:00.000Z", message: { role: "user", content: "请记住这个约束" } }),
        JSON.stringify({ type: "message", timestamp: "2026-05-22T11:00:01.000Z", message: { role: "assistant", content: "好的，我会按这个约束执行" } }),
      ].join("\n"),
      "utf-8",
    );

    const rollingSummary = vi.fn(async () => "");
    const logDiagnostic = vi.fn();
    const ticker = createMemoryTicker({
      summaryManager: {
        getSummary: () => null,
        rollingSummary,
      },
      configPath: "/tmp/config.yaml",
      factStore: {},
      getResolvedMemoryModel: () => ({ model: "mock", api: "mock", api_key: "", base_url: "mock" }),
      sessionDir: root,
      memoryMdPath: "/tmp/memory.md",
      todayMdPath: "/tmp/today.md",
      weekMdPath: "/tmp/week.md",
      longtermMdPath: "/tmp/longterm.md",
      factsMdPath: "/tmp/facts.md",
      memoryService: {
        listEvidenceBySession: vi.fn(() => []),
        upsertEpisode: vi.fn(),
        logDiagnostic,
        setSummaryProjection: vi.fn(),
      },
      getMemoryMasterEnabled: () => true,
    });

    await ticker.tick();

    expect(rollingSummary).toHaveBeenCalled();
    expect(logDiagnostic).toHaveBeenCalledWith(
      "rolling_summary_transcript_recovery",
      expect.objectContaining({
        reason: "startup_recovery",
      }),
    );
  });
});
