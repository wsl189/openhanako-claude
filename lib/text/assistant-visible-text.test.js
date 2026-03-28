import { describe, expect, it } from "vitest";
import { sanitizeAssistantVisibleText } from "./assistant-visible-text.js";

describe("sanitizeAssistantVisibleText", () => {
  it("keeps reply content but removes reply wrappers", () => {
    const raw = "<reply>\n直接给用户的回复\n</reply>";
    expect(sanitizeAssistantVisibleText(raw)).toBe("直接给用户的回复");
  });

  it("extracts malformed reply content before wrapper close", () => {
    const raw = "<reply>\n宏观政策分析师：回应首席争议点\n沉思过后直接进入正题，不废话。\n</final>\nPremise:\n- ...";
    expect(sanitizeAssistantVisibleText(raw)).toBe("宏观政策分析师：回应首席争议点\n沉思过后直接进入正题，不废话。");
  });

  it("prefers the last <final> content when present", () => {
    const raw = "前文\n<final>第一版</final>\n<final>最终版</final>";
    expect(sanitizeAssistantVisibleText(raw)).toBe("最终版");
  });

  it("preserves introspection tags and content", () => {
    const raw = "<mood>\nVibe: 稳住节奏\n</mood>\n这是正文。";
    expect(sanitizeAssistantVisibleText(raw)).toBe(raw);
  });
});
