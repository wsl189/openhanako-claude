import { describe, expect, it } from "vitest";
import { normalizeActivitySummary, normalizeTitle, summarizeTitle } from "./llm-utils.js";

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

describe("normalizeTitle", () => {
  it("strips think tags and keeps the actual title line", () => {
    const raw = "<think>先分析一下用户需求</think>\n修复标题泄露";
    expect(normalizeTitle(raw, true)).toBe("修复标题泄露");
  });

  it("prefers explicit title label over meta lines", () => {
    const raw = "让我先分析这段对话\n标题：修复标题泄露";
    expect(normalizeTitle(raw, true)).toBe("修复标题泄露");
  });

  it("extracts english title from labeled output", () => {
    const raw = "Let me reason about it first.\nTitle: Fix session title leak";
    expect(normalizeTitle(raw, false)).toBe("Fix session title leak");
  });

  it("skips weak generic label line", () => {
    const raw = "规则要求：";
    expect(normalizeTitle(raw, true)).toBe("");
  });

  it("strips chinese label prefix and keeps concrete topic", () => {
    const raw = "主题：打招呼/开启对话";
    expect(normalizeTitle(raw, true)).toBe("打招呼/开启对话");
  });

  it("prefers final output line when model returns process + final", () => {
    const raw = "先分析对话上下文\n最终输出：修复标题泄露";
    expect(normalizeTitle(raw, true)).toBe("修复标题泄露");
  });

  it("extracts title from final_title tag", () => {
    const raw = "<think>analyze</think><final_title>Fix title leak</final_title>";
    expect(normalizeTitle(raw, false)).toBe("Fix title leak");
  });

  it("rejects meta sentence like conversation description", () => {
    const raw = "对话内容是用户请求修复标题生成问题";
    expect(normalizeTitle(raw, true)).toBe("");
  });

  it("rejects english meta opener like according", () => {
    const raw = "According to the conversation, the user says hello.";
    expect(normalizeTitle(raw, false)).toBe("");
  });

  it("rejects rule-echo instruction lines", () => {
    const raw = "不要加引号、句号等标点";
    expect(normalizeTitle(raw, true)).toBe("");
  });
});

describe("summarizeTitle", () => {
  it("returns null when utility config is unavailable", async () => {
    const out = await summarizeTitle({}, "你好", "你好。");
    expect(out).toBeNull();
  });
});
