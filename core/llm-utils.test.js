import { describe, expect, it } from "vitest";
import { normalizeActivitySummary, summarizeTitle } from "./llm-utils.js";

describe("normalizeActivitySummary", () => {
  it("falls back to canonical all-clear when summary leaks meta analysis", () => {
    const raw = `让我分析这个巡检上下文：
1. 这是一个自动触发的心跳巡检
2. 根据规则我要先分析再总结`;
    const out = normalizeActivitySummary(raw, {
      assistantText: "工作空间一切正常，无异常事项。继续待命。",
      toolCalls: [],
      isZh: true,
    });
    expect(out).toBe("巡检完毕，一切正常");
  });

  it("falls back to tool summary when meta analysis appears but tools were called", () => {
    const raw = "根据规则，我先分析上下文后再说明。";
    const out = normalizeActivitySummary(raw, {
      assistantText: "已发送通知",
      toolCalls: ["notify"],
      isZh: true,
    });
    expect(out).toBe("执行了 notify");
  });

  it("keeps concise action summary output", () => {
    const raw = "检查工作空间并整理了待办事项。";
    const out = normalizeActivitySummary(raw, {
      assistantText: "已完成待办整理",
      toolCalls: [],
      isZh: true,
    });
    expect(out).toBe(raw);
  });

  it("normalizes english all-clear phrasing", () => {
    const out = normalizeActivitySummary("Everything is normal, no action needed.", {
      assistantText: "",
      toolCalls: [],
      isZh: false,
    });
    expect(out).toBe("Patrol complete, all clear");
  });
});

describe("summarizeTitle", () => {
  it("returns null when utility config is unavailable", async () => {
    const out = await summarizeTitle({}, "你好", "你好。");
    expect(out).toBeNull();
  });
});
