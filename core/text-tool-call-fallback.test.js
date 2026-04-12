import { describe, expect, it } from "vitest";
import { extractTextToolCalls } from "./text-tool-call-fallback.js";

describe("extractTextToolCalls", () => {
  it("extracts assistant-to markup and cleans the visible text", () => {
    const raw = '先测第一层。<assistant to=Glob>{"pattern":"README*","path":"/tmp/demo"}</assistant>';
    const parsed = extractTextToolCalls(raw, ["Glob", "Read"]);

    expect(parsed.toolCalls).toEqual([
      {
        id: "text_tc_6",
        name: "Glob",
        arguments: { pattern: "README*", path: "/tmp/demo" },
      },
    ]);
    expect(parsed.cleanedText).toBe("先测第一层。");
  });

  it("normalizes common alias names to available tools", () => {
    const raw = '<assistant to="read_file">{"file_path":"README.md"}</assistant>';
    const parsed = extractTextToolCalls(raw, ["Read", "Glob"]);

    expect(parsed.toolCalls).toEqual([
      {
        id: "text_tc_0",
        name: "Read",
        arguments: { file_path: "README.md" },
      },
    ]);
    expect(parsed.cleanedText).toBe("");
  });

  it("extracts [TOOL_CALL] pseudo-markup and converts args", () => {
    const raw = `
[TOOL_CALL]
{tool => "Glob", args => {
- patterns ["*"]
- baseDir "/Users/tc/Desktop"
- recursive false
}}
[/TOOL_CALL]
`;
    const parsed = extractTextToolCalls(raw, ["Glob", "Read"]);

    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]).toMatchObject({
      name: "Glob",
      arguments: {
        pattern: "*",
        path: "/Users/tc/Desktop",
      },
    });
    expect(parsed.cleanedText).toBe("");
  });

  it("extracts minimax XML tool call markup with smart quotes and normalizes glob args", () => {
    const raw = `
<minimax:tool_call>
  <invoke name=“Glob”>
    <invoke name=“Glob”>
      <parameter name=“pattern”>/Users/tc/Desktop/*</parameter>
    </invoke>
  </invoke>
</minimax:tool_call>
`;
    const parsed = extractTextToolCalls(raw, ["Glob", "Read"]);

    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]).toMatchObject({
      name: "Glob",
      arguments: {
        pattern: "*",
        path: "/Users/tc/Desktop",
      },
    });
    expect(parsed.cleanedText).toBe("");
  });

  it("extracts malformed minimax invoke tags and supports multiple tool calls in one block", () => {
    const raw = `
我来查看一下桌面有哪些文件。
<minimax:tool_call>
</workspace>
</invoke name=“Glob”>
<parameter name=“pattern”>/Users/tc/Desktop/**/*</parameter>
</invoke>
<invoke name=“Bash”>
<parameter name=“command”>ls -la /Users/tc/Desktop/</parameter>
</invoke>
</minimax:tool_call>
`;
    const parsed = extractTextToolCalls(raw, ["Glob", "Bash", "Read"]);

    expect(parsed.toolCalls).toHaveLength(2);
    expect(parsed.toolCalls[0]).toMatchObject({
      name: "Glob",
      arguments: {
        path: "/Users/tc/Desktop",
        pattern: "**/*",
      },
    });
    expect(parsed.toolCalls[1]).toMatchObject({
      name: "Bash",
      arguments: {
        command: "ls -la /Users/tc/Desktop/",
      },
    });
    expect(parsed.cleanedText).toBe("我来查看一下桌面有哪些文件。");
  });

  it("extracts loose minimax invoke markup even without minimax wrapper", () => {
    const raw = `
先帮你看下。
</invoke name=“Glob”>
<parameter name=“pattern”>/Users/tc/Desktop/*</parameter>
</invoke>
`;
    const parsed = extractTextToolCalls(raw, ["Glob", "Read"]);

    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]).toMatchObject({
      name: "Glob",
      arguments: {
        path: "/Users/tc/Desktop",
        pattern: "*",
      },
    });
    expect(parsed.cleanedText).toBe("先帮你看下。");
  });

  it("extracts function_calls invoke markup and removes wrapper from visible text", () => {
    const raw = `
我确认一下。
<function_calls>
  <invoke name="Bash">
    <parameter name="command">ls /Users/tc/Desktop</parameter>
  </invoke>
</function_calls>
`;
    const parsed = extractTextToolCalls(raw, ["Bash", "Glob"]);

    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]).toMatchObject({
      name: "Bash",
      arguments: {
        command: "ls /Users/tc/Desktop",
      },
    });
    expect(parsed.cleanedText).toBe("我确认一下。");
  });

  it("extracts malformed function_calls parameter without closing tags", () => {
    const raw = `
我先检查一下。
<function_calls>
  <invoke name="Bash">
    <parameter name="command">ls /Users/tc/Desktop
`;
    const parsed = extractTextToolCalls(raw, ["Bash", "Glob"]);

    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]).toMatchObject({
      name: "Bash",
      arguments: {
        command: "ls /Users/tc/Desktop",
      },
    });
    expect(parsed.cleanedText).toContain("我先检查一下。");
  });
});
