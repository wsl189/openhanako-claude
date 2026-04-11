import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createSessionMetadataMock,
  buildClaudeRuntimeConfigMock,
  runtimeCtorMock,
} = vi.hoisted(() => ({
  createSessionMetadataMock: vi.fn(),
  buildClaudeRuntimeConfigMock: vi.fn(),
  runtimeCtorMock: vi.fn(),
}));

vi.mock("../core/claude-session-store.js", () => ({
  createSessionMetadata: createSessionMetadataMock,
}));

vi.mock("../core/claude-runtime-config.js", () => ({
  buildClaudeRuntimeConfig: buildClaudeRuntimeConfigMock,
}));

vi.mock("../core/claude-session-runtime.js", () => ({
  ClaudeSessionRuntime: class {
    constructor(opts) {
      return runtimeCtorMock(opts);
    }
  },
}));

vi.mock("../core/model-runtime-overrides.js", () => ({
  applyRuntimeModelOverrides: (model) => model,
}));

import { runAgentSession } from "./agent-executor.js";

describe("runAgentSession with Claude runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createSessionMetadataMock.mockReturnValue({
      sessionPath: "/tmp/fake.session.json",
      metadata: { sessionId: "s1" },
    });
    buildClaudeRuntimeConfigMock.mockReturnValue({
      options: {
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: "append",
        },
      },
    });
  });

  it("captures final assistant snapshot instead of intermediate deltas", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-exec-test-"));
    const agentDir = path.join(tempRoot, "alpha");
    fs.mkdirSync(agentDir, { recursive: true });

    let onEvent = null;
    const fakeRuntime = {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => true),
      prompt: vi.fn(async () => {
        onEvent?.({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "让我先获取数据。" },
          },
        });
        onEvent?.({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "最终结论：今天建议观望。" }],
          },
        });
        onEvent?.({
          type: "result",
          result: "最终结论：今天建议观望。",
        });
      }),
      subscribe: vi.fn((cb) => {
        onEvent = cb;
        return () => {};
      }),
      sessionManager: {
        getSessionFile: () => "/tmp/fake.session.json",
        getSessionId: () => "s1",
        getCwd: () => "/workspace",
      },
      _emit: vi.fn(),
    };
    runtimeCtorMock.mockImplementation(() => fakeRuntime);

    const agent = {
      agentDir,
      tools: [],
      personality: "personality",
      systemPrompt: "system",
      buildSystemAppendPrompt: () => "hanako append",
      config: {
        locale: "zh-CN",
        desk: { home_folder: "/workspace" },
        models: { overrides: null },
      },
      refreshSystemPrompt: vi.fn(),
    };
    const engine = {
      getAgent: vi.fn(() => agent),
      getHomeFolder: vi.fn(() => "/workspace"),
      createSessionContext: vi.fn(() => ({
        resolveModel: vi.fn(() => ({ id: "test-model", contextWindow: 200_000 })),
      })),
      getAgentPermissionConfig: vi.fn(() => ({
        sandbox: { mode: "standard", path_rules: [] },
        tools: { builtin_enabled: ["read", "grep"], custom_enabled: [] },
      })),
      setSessionPendingImages: vi.fn(),
      clearSessionPendingImages: vi.fn(),
    };

    try {
      const text = await runAgentSession(
        "alpha",
        [{ text: "hello", capture: true }],
        { engine },
      );
      expect(text).toBe("最终结论：今天建议观望。");
      expect(createSessionMetadataMock).toHaveBeenCalledTimes(1);
      expect(buildClaudeRuntimeConfigMock).toHaveBeenCalledTimes(1);
      expect(fakeRuntime.start).toHaveBeenCalledTimes(1);
      expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
