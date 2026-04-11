import { describe, expect, it } from "vitest";
import {
  sanitizeAssistantVisibleText,
  stripSdkDiagnosticLines,
  stripRawToolCallMarkup,
} from "./assistant-visible-text.js";

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

  it("removes SDK diagnostic lines from visible text", () => {
    const raw = "⚠ [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null\n\n正常正文";
    expect(sanitizeAssistantVisibleText(raw)).toBe("正常正文");
  });

  it("keeps non-diagnostic content when stripping SDK diagnostic lines", () => {
    const raw = "⚠ [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null\n正常正文";
    expect(stripSdkDiagnosticLines(raw)).toBe("正常正文");
  });

  it("removes raw text-style tool call markup", () => {
    const raw = '先测第一层。<assistant to=Glob>{"pattern":"README*"}</assistant>';
    expect(stripRawToolCallMarkup(raw).trim()).toBe("先测第一层。");
    expect(sanitizeAssistantVisibleText(raw)).toBe("先测第一层。");
  });

  it("removes [TOOL_CALL] markup blocks", () => {
    const raw = '先看一下。\n[TOOL_CALL]\n{tool => "Glob", args => {"pattern":"*"}}\n[/TOOL_CALL]\n完成。';
    expect(stripRawToolCallMarkup(raw).trim()).toBe("先看一下。\n完成。");
    expect(sanitizeAssistantVisibleText(raw)).toBe("先看一下。\n完成。");
  });

  it("removes minimax XML tool call markup blocks", () => {
    const raw = '开始。\n<minimax:tool_call><invoke name=“Glob”><parameter name=“pattern”>/Users/tc/Desktop/*</parameter></invoke></minimax:tool_call>\n结束。';
    expect(stripRawToolCallMarkup(raw).trim()).toBe("开始。\n结束。");
    expect(sanitizeAssistantVisibleText(raw)).toBe("开始。\n结束。");
  });

  it("removes function_calls invoke/parameter markup blocks", () => {
    const raw = "开始。\n<function_calls><invoke name=\"Bash\"><parameter name=\"command\">ls -la</parameter></invoke></function_calls>\n结束。";
    expect(stripRawToolCallMarkup(raw).trim()).toBe("开始。\n结束。");
    expect(sanitizeAssistantVisibleText(raw)).toBe("开始。\n结束。");
  });

  it("keeps trailing plain text when function_calls parameter tag is malformed", () => {
    const raw = "开始。\n<function_calls><invoke name=\"Bash\"><parameter name=\"command\">ls -la\n我继续说明：目录是存在的。";
    expect(stripRawToolCallMarkup(raw).trim()).toBe("开始。\nls -la\n我继续说明：目录是存在的。");
  });
});
