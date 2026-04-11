import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./provider-adapters.js", () => {
  const buildStreamRequest = vi.fn(() => ({
    url: "https://example.invalid/chat/completions",
    headers: { authorization: "Bearer test" },
    body: "{}",
  }));
  return {
    createProviderAdapter: vi.fn(() => ({ buildStreamRequest })),
    streamSSE: vi.fn(),
  };
});

import { streamSSE } from "./provider-adapters.js";
import { ProviderSessionRuntime } from "./provider-session-runtime.js";

describe("ProviderSessionRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps final reply text even when SSE callback does not emit chunk deltas", async () => {
    vi.mocked(streamSSE)
      .mockImplementationOnce(async ({ onEvent }) => {
        onEvent?.({ type: "done", stopReason: "tool_use" });
        return {
          content: '[TOOL_CALL]{tool => "Glob", args => {"pattern":"*","path":"/tmp"}}[/TOOL_CALL]',
          reasoning: "",
          toolCalls: [{ id: "tool-1", name: "Glob", arguments: { pattern: "*", path: "/tmp" } }],
          stopReason: "tool_use",
        };
      })
      .mockImplementationOnce(async ({ onEvent }) => {
        onEvent?.({ type: "done", stopReason: "end_turn" });
        return {
          content: "桌面里有 3 个文件。",
          reasoning: "",
          toolCalls: [],
          stopReason: "end_turn",
        };
      });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-provider-runtime-"));
    const sessionPath = path.join(tempDir, "demo.session.json");

    const runtime = new ProviderSessionRuntime({
      sessionId: "session-test",
      cwd: tempDir,
      sessionPath,
      resolvedModel: {
        api: "openai-completions",
        base_url: "https://example.invalid",
        api_key: "test",
        model: "demo-model",
      },
      systemPrompt: "You are a test agent.",
      tools: [{
        name: "Glob",
        description: "Find files by glob.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string" },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
        execute: async () => ({
          content: [{ type: "text", text: "a.txt\nb.txt\nc.txt" }],
          details: { count: 3 },
        }),
      }],
    });

    const events = [];
    const unsub = runtime.subscribe((event) => events.push(event));
    await runtime.prompt("看看桌面有哪些文件");
    unsub();
    await runtime.close();

    const snapshot = events.find((event) => event?.type === "assistant_snapshot");
    expect(snapshot).toBeTruthy();
    expect(snapshot.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("桌面里有 3 个文件。") }),
      ]),
    );
  });

  it("forces a no-tools settle pass when tool round ends without visible reply", async () => {
    vi.mocked(streamSSE)
      .mockImplementationOnce(async ({ onEvent }) => {
        onEvent?.({ type: "done", stopReason: "tool_use" });
        return {
          content: '[TOOL_CALL]{tool => "Glob", args => {"pattern":"*","path":"/tmp"}}[/TOOL_CALL]',
          reasoning: "",
          toolCalls: [{ id: "tool-9", name: "Glob", arguments: { pattern: "*", path: "/tmp" } }],
          stopReason: "tool_use",
        };
      })
      .mockImplementationOnce(async ({ onEvent }) => {
        onEvent?.({ type: "done", stopReason: "tool_use" });
        return {
          content: "",
          reasoning: "",
          toolCalls: [],
          stopReason: "tool_use",
        };
      })
      .mockImplementationOnce(async ({ onEvent }) => {
        onEvent?.({ type: "done", stopReason: "end_turn" });
        return {
          content: "找到了：a.txt、b.txt。",
          reasoning: "",
          toolCalls: [],
          stopReason: "end_turn",
        };
      });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-provider-runtime-settle-"));
    const sessionPath = path.join(tempDir, "demo2.session.json");

    const runtime = new ProviderSessionRuntime({
      sessionId: "session-test-2",
      cwd: tempDir,
      sessionPath,
      resolvedModel: {
        api: "openai-completions",
        base_url: "https://example.invalid",
        api_key: "test",
        model: "demo-model",
      },
      systemPrompt: "You are a test agent.",
      tools: [{
        name: "Glob",
        description: "Find files by glob.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string" },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
        execute: async () => ({
          content: [{ type: "text", text: "a.txt\nb.txt" }],
          details: { count: 2 },
        }),
      }],
    });

    const events = [];
    const unsub = runtime.subscribe((event) => events.push(event));
    await runtime.prompt("看看桌面有哪些文件");
    unsub();
    await runtime.close();

    expect(streamSSE).toHaveBeenCalledTimes(3);
    const snapshot = events.find((event) => event?.type === "assistant_snapshot");
    expect(snapshot).toBeTruthy();
    expect(snapshot.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("找到了：a.txt、b.txt。") }),
      ]),
    );
  });

  it("executes minimax XML fallback tool call and returns final streamed reply", async () => {
    vi.mocked(streamSSE)
      .mockImplementationOnce(async ({ onEvent }) => {
        onEvent?.({ type: "done", stopReason: "end_turn" });
        return {
          content: `
<minimax:tool_call>
  <invoke name=“Glob”>
    <invoke name=“Glob”>
      <parameter name=“pattern”>/Users/tc/Desktop/*</parameter>
    </invoke>
  </invoke>
</minimax:tool_call>
`,
          reasoning: "",
          toolCalls: [],
          stopReason: "end_turn",
        };
      })
      .mockImplementationOnce(async ({ onEvent }) => {
        onEvent?.({ type: "done", stopReason: "end_turn" });
        return {
          content: "桌面文件：a.txt、b.txt。",
          reasoning: "",
          toolCalls: [],
          stopReason: "end_turn",
        };
      });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-provider-runtime-minimax-"));
    const sessionPath = path.join(tempDir, "demo3.session.json");

    const runtime = new ProviderSessionRuntime({
      sessionId: "session-test-3",
      cwd: tempDir,
      sessionPath,
      resolvedModel: {
        api: "openai-completions",
        base_url: "https://example.invalid",
        api_key: "test",
        model: "demo-model",
      },
      systemPrompt: "You are a test agent.",
      tools: [{
        name: "Glob",
        description: "Find files by glob.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string" },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
        execute: async () => ({
          content: [{ type: "text", text: "a.txt\nb.txt" }],
          details: { count: 2 },
        }),
      }],
    });

    const events = [];
    const unsub = runtime.subscribe((event) => events.push(event));
    await runtime.prompt("帮我看下桌面有哪些文件");
    unsub();
    await runtime.close();

    expect(streamSSE).toHaveBeenCalledTimes(2);
    const started = events.find((event) => event?.type === "tool_start");
    expect(started).toBeTruthy();
    expect(started).toMatchObject({
      name: "Glob",
      args: {
        pattern: "*",
        path: "/Users/tc/Desktop",
      },
    });

    const snapshot = events.find((event) => event?.type === "assistant_snapshot");
    expect(snapshot).toBeTruthy();
    expect(snapshot.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("桌面文件：a.txt、b.txt。") }),
      ]),
    );
  });

  it("executes function_calls fallback tool call and strips markup in final snapshot", async () => {
    vi.mocked(streamSSE)
      .mockImplementationOnce(async ({ onEvent }) => {
        onEvent?.({ type: "done", stopReason: "end_turn" });
        return {
          content: `
<function_calls>
  <invoke name="Bash">
    <parameter name="command">ls /Users/tc/Desktop</parameter>
  </invoke>
</function_calls>
`,
          reasoning: "",
          toolCalls: [],
          stopReason: "end_turn",
        };
      })
      .mockImplementationOnce(async ({ onEvent }) => {
        onEvent?.({ type: "done", stopReason: "end_turn" });
        return {
          content: "确认存在 desktop 目录。",
          reasoning: "",
          toolCalls: [],
          stopReason: "end_turn",
        };
      });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-provider-runtime-function-calls-"));
    const sessionPath = path.join(tempDir, "demo4.session.json");

    const runtime = new ProviderSessionRuntime({
      sessionId: "session-test-4",
      cwd: tempDir,
      sessionPath,
      resolvedModel: {
        api: "openai-completions",
        base_url: "https://example.invalid",
        api_key: "test",
        model: "demo-model",
      },
      systemPrompt: "You are a test agent.",
      tools: [{
        name: "Bash",
        description: "Run shell commands.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
          additionalProperties: false,
        },
        execute: async () => ({
          content: [{ type: "text", text: "exists" }],
          details: {},
        }),
      }],
    });

    const events = [];
    const unsub = runtime.subscribe((event) => events.push(event));
    await runtime.prompt("帮我检查 desktop 目录");
    unsub();
    await runtime.close();

    expect(streamSSE).toHaveBeenCalledTimes(2);
    const started = events.find((event) => event?.type === "tool_start");
    expect(started).toBeTruthy();
    expect(started).toMatchObject({
      name: "Bash",
      args: {
        command: "ls /Users/tc/Desktop",
      },
    });

    const snapshot = events.find((event) => event?.type === "assistant_snapshot");
    expect(snapshot).toBeTruthy();
    const snapshotText = (snapshot?.content || [])
      .filter((block) => block?.type === "text")
      .map((block) => String(block.text || ""))
      .join("\n");
    expect(snapshotText).toContain("确认存在 desktop 目录。");
    expect(snapshotText).not.toContain("<function_calls>");
    expect(snapshotText).not.toContain("<invoke");
    expect(snapshotText).not.toContain("<parameter");
  });

  it("synthesizes a final reply from tool results when provider never returns post-tool text", async () => {
    vi.mocked(streamSSE)
      .mockImplementationOnce(async ({ onEvent }) => {
        onEvent?.({ type: "done", stopReason: "end_turn" });
        return {
          content: '<assistant to=Glob>{"pattern":"*","path":"/tmp"}</assistant>',
          reasoning: "",
          toolCalls: [],
          stopReason: "end_turn",
        };
      })
      .mockImplementationOnce(async ({ onEvent }) => {
        onEvent?.({ type: "done", stopReason: "end_turn" });
        return {
          content: "",
          reasoning: "",
          toolCalls: [],
          stopReason: "end_turn",
        };
      });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-provider-runtime-fallback-"));
    const sessionPath = path.join(tempDir, "demo4.session.json");

    const runtime = new ProviderSessionRuntime({
      sessionId: "session-test-4",
      cwd: tempDir,
      sessionPath,
      resolvedModel: {
        api: "openai-completions",
        base_url: "https://example.invalid",
        api_key: "test",
        model: "demo-model",
      },
      systemPrompt: "You are a test agent.",
      tools: [{
        name: "Glob",
        description: "Find files by glob.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string" },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
        execute: async () => ({
          content: [{ type: "text", text: "a.txt\nb.txt" }],
          details: { count: 2 },
        }),
      }],
    });

    const events = [];
    const unsub = runtime.subscribe((event) => events.push(event));
    await runtime.prompt("看看有哪些文件");
    unsub();
    await runtime.close();

    const snapshot = events.find((event) => event?.type === "assistant_snapshot");
    expect(snapshot).toBeTruthy();
    expect(snapshot.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("a.txt\nb.txt") }),
      ]),
    );
  });

  it("emits a fallback visible reply when tool markup appears but no executable call can be parsed", async () => {
    vi.mocked(streamSSE)
      .mockImplementationOnce(async ({ onEvent }) => {
        onEvent?.({ type: "done", stopReason: "end_turn" });
        return {
          content: `
<function_calls>
  <invoke name="Bash">
  </invoke>
</function_calls>
`,
          reasoning: "",
          toolCalls: [],
          stopReason: "end_turn",
        };
      });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-provider-runtime-empty-tool-markup-"));
    const sessionPath = path.join(tempDir, "demo6.session.json");

    const runtime = new ProviderSessionRuntime({
      sessionId: "session-test-6",
      cwd: tempDir,
      sessionPath,
      resolvedModel: {
        api: "openai-completions",
        base_url: "https://example.invalid",
        api_key: "test",
        model: "demo-model",
      },
      systemPrompt: "You are a test agent.",
      tools: [{
        name: "Bash",
        description: "Run shell commands.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
          additionalProperties: false,
        },
        execute: async () => ({
          content: [{ type: "text", text: "exists" }],
          details: {},
        }),
      }],
    });

    const events = [];
    const unsub = runtime.subscribe((event) => events.push(event));
    await runtime.prompt("帮我检查一下桌面");
    unsub();
    await runtime.close();

    expect(streamSSE).toHaveBeenCalledTimes(1);
    const started = events.find((event) => event?.type === "tool_start");
    expect(started).toBeFalsy();

    const snapshot = events.find((event) => event?.type === "assistant_snapshot");
    expect(snapshot).toBeTruthy();
    const snapshotText = (snapshot?.content || [])
      .filter((block) => block?.type === "text")
      .map((block) => String(block.text || ""))
      .join("\n");
    expect(snapshotText).toContain("工具调用已触发，但未拿到可展示的最终回复。请重试一次。");
  });

  it("tracks context usage and persists compaction for provider runtime sessions", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-provider-runtime-compact-"));
    const sessionPath = path.join(tempDir, "demo7.session.json");

    const runtime = new ProviderSessionRuntime({
      sessionId: "session-test-7",
      cwd: tempDir,
      sessionPath,
      resolvedModel: {
        api: "openai-completions",
        base_url: "https://example.invalid",
        api_key: "test",
        model: "demo-model",
        contextWindow: 1_000,
      },
      systemPrompt: "You are a test agent.",
      tools: [],
    });

    for (let i = 0; i < 18; i += 1) {
      runtime._appendMessage({
        role: "user",
        content: [{ type: "text", text: `用户问题 ${i}: ${"A".repeat(160)}` }],
      });
      runtime._appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `助手回答 ${i}: ${"B".repeat(180)}` }],
      });
    }

    const before = await runtime.refreshContextUsage();
    expect(before.contextWindow).toBe(1_000);
    expect(before.tokens).toBeGreaterThan(0);

    await runtime.compact();
    const after = runtime.getContextUsage();
    expect(after.tokens).toBeLessThan(before.tokens);

    await runtime.close();

    const reloaded = new ProviderSessionRuntime({
      sessionId: "session-test-7-reloaded",
      cwd: tempDir,
      sessionPath,
      resolvedModel: {
        api: "openai-completions",
        base_url: "https://example.invalid",
        api_key: "test",
        model: "demo-model",
        contextWindow: 1_000,
      },
      systemPrompt: "You are a test agent.",
      tools: [],
    });

    const firstContent = JSON.stringify(reloaded.messages?.[0]?.content || "");
    expect(firstContent).toContain("[[hanako:provider-compacted]]");
    expect(reloaded.getContextUsage().tokens).toBeLessThan(before.tokens);
    await reloaded.close();
  });
});
