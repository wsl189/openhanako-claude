import { describe, expect, it } from "vitest";
import { sanitizeAssistantVisibleText } from "./assistant-visible-text.js";

describe("sanitizeAssistantVisibleText", () => {
  it("strips standard mood blocks", () => {
    const raw = "<mood>\nVibe: ...\n</mood>\n\n这是正文。";
    expect(sanitizeAssistantVisibleText(raw)).toBe("这是正文。");
  });

  it("strips non-standard reflect tags with attributes and trailing spaces", () => {
    const raw = '<reflect mode="deep">\nPremise:\n- ...\n</reflect   >\n结论';
    expect(sanitizeAssistantVisibleText(raw)).toBe("结论");
  });

  it("keeps reply content but removes reply wrappers and stray closing tags", () => {
    const raw = "<reply>\n直接给用户的回复\n</reply>\n</reflect>";
    expect(sanitizeAssistantVisibleText(raw)).toBe("直接给用户的回复");
  });

  it("extracts malformed reply content before stray reflect close", () => {
    const raw = "<reply>\n宏观政策分析师：回应首席争议点\n沉思过后直接进入正题，不废话。\n</reflect>\nPremise:\n- ...";
    expect(sanitizeAssistantVisibleText(raw)).toBe("宏观政策分析师：回应首席争议点\n沉思过后直接进入正题，不废话。");
  });

  it("prefers the last <final> content when present", () => {
    const raw = "前文\n<final>第一版</final>\n<final>最终版</final>";
    expect(sanitizeAssistantVisibleText(raw)).toBe("最终版");
  });

  it("drops dangling unclosed mood tail", () => {
    const raw = "可见内容\n<mood>\nVibe: ...";
    expect(sanitizeAssistantVisibleText(raw)).toBe("可见内容");
  });

  it("does not strip bare mood scaffold text without tags", () => {
    const raw = [
      "Vibe: Ready to contribute.",
      "Sparks:",
      "- 宏观政策分析师介绍自己+贡献",
      "- 协调其他成员自我介绍",
      "Reflections:",
      "- 我需要介绍宏观政策分析师的专长",
      "Will:",
      "- 以宏观政策分析师身份介绍自己",
    ].join("\n");
    expect(sanitizeAssistantVisibleText(raw)).toBe(raw);
  });

  it("does not strip bare mood scaffold prefix without tags", () => {
    const raw = [
      "Vibe: Ready to contribute.",
      "Sparks:",
      "- ...",
      "Will:",
      "- ...",
      "",
      "@首席分析师，我先从宏观政策层面给出三点结论：",
      "1. ...",
    ].join("\n");
    expect(sanitizeAssistantVisibleText(raw)).toBe(raw);
  });

  it("does not strip ordinary analytical text that only uses one heading", () => {
    const raw = "Premise: 当前市场波动主要来自供应预期变化。";
    expect(sanitizeAssistantVisibleText(raw)).toBe(raw);
  });

  it("does not strip normal sentence containing the word vibe", () => {
    const raw = "我对这个方案的 vibe 是积极的，但还需要补两组数据。";
    expect(sanitizeAssistantVisibleText(raw)).toBe(raw);
  });

  it("does not strip heading text without tags", () => {
    const raw = [
      "Vibe: 稳住节奏",
      "Sparks: 先补证据链",
      "这是正文，不是内省模板。",
    ].join("\n");
    expect(sanitizeAssistantVisibleText(raw)).toBe(raw);
  });
});
