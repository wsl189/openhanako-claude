import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildSessionMetadataMock,
  createSessionMetadataMock,
  readSessionMetadataMock,
  writeSessionMetadataMock,
  buildClaudeRuntimeConfigMock,
  runtimeCtorMock,
} = vi.hoisted(() => ({
  buildSessionMetadataMock: vi.fn(),
  createSessionMetadataMock: vi.fn(),
  readSessionMetadataMock: vi.fn(),
  writeSessionMetadataMock: vi.fn(),
  buildClaudeRuntimeConfigMock: vi.fn(),
  runtimeCtorMock: vi.fn(),
}));

vi.mock("../core/claude-session-store.js", () => ({
  buildSessionMetadata: buildSessionMetadataMock,
  createSessionMetadata: createSessionMetadataMock,
  readSessionMetadata: readSessionMetadataMock,
  writeSessionMetadata: writeSessionMetadataMock,
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

import { isPersistentAgentSessionBusy, runAgentSession } from "./agent-executor.js";

describe("runAgentSession with Claude runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createSessionMetadataMock.mockReturnValue({
      sessionPath: "/tmp/fake.session.json",
      metadata: { sessionId: "s1" },
    });
    buildSessionMetadataMock.mockImplementation((data) => ({
      version: 1,
      kind: "claude-agent-session",
      ...data,
    }));
    readSessionMetadataMock.mockImplementation((sessionPath) => ({
      sessionId: "persisted-session",
      cwd: "/workspace",
      agentId: "alpha",
      sessionPath,
    }));
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

  it("resumes a persistent named session instead of creating a temp session", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-exec-test-"));
    const agentDir = path.join(tempRoot, "alpha");
    const channelSessionDir = path.join(agentDir, "sessions", "channel");
    const channelSessionPath = path.join(channelSessionDir, "ch_team.session.json");
    fs.mkdirSync(channelSessionDir, { recursive: true });
    fs.writeFileSync(channelSessionPath, "{}", "utf-8");

    const fakeRuntime = {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => true),
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      sessionManager: {
        getSessionFile: () => channelSessionPath,
        getSessionId: () => "persisted-session",
        getCwd: () => "/workspace",
      },
      _emit: vi.fn(),
    };
    runtimeCtorMock.mockImplementation((opts) => {
      expect(opts.sessionPath).toBe(channelSessionPath);
      expect(opts.sessionId).toBe("persisted-session");
      expect(opts.resumeSessionId).toBe("persisted-session");
      return fakeRuntime;
    });

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
      await runAgentSession(
        "alpha",
        [{ text: "hello", capture: true }],
        {
          engine,
          sessionSuffix: "channel",
          persistentSessionName: "ch_team",
        },
      );

      expect(createSessionMetadataMock).not.toHaveBeenCalled();
      expect(writeSessionMetadataMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("serializes concurrent calls to the same persistent named session", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-exec-test-"));
    const agentDir = path.join(tempRoot, "alpha");
    fs.mkdirSync(agentDir, { recursive: true });

    let releaseFirstPrompt;
    let created = 0;
    const promptOrder = [];
    runtimeCtorMock.mockImplementation(() => {
      created += 1;
      const index = created;
      return {
        start: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        abort: vi.fn(async () => true),
        prompt: vi.fn(async () => {
          promptOrder.push(index);
          if (index === 1) {
            await new Promise((resolve) => {
              releaseFirstPrompt = resolve;
            });
          }
        }),
        subscribe: vi.fn(() => () => {}),
        sessionManager: {
          getSessionFile: () => path.join(agentDir, "sessions", "channel", "ch_team.session.json"),
          getSessionId: () => `session-${index}`,
          getCwd: () => "/workspace",
        },
        _emit: vi.fn(),
      };
    });

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
      const opts = {
        engine,
        sessionSuffix: "channel",
        persistentSessionName: "ch_team",
      };
      const first = runAgentSession("alpha", [{ text: "first", capture: true }], opts);
      await vi.waitFor(() => expect(runtimeCtorMock).toHaveBeenCalledTimes(1));
      expect(isPersistentAgentSessionBusy("alpha", opts)).toBe(true);

      const second = runAgentSession("alpha", [{ text: "second", capture: true }], opts);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(runtimeCtorMock).toHaveBeenCalledTimes(1);

      releaseFirstPrompt();
      await Promise.all([first, second]);

      expect(promptOrder).toEqual([1, 2]);
      expect(runtimeCtorMock).toHaveBeenCalledTimes(2);
      expect(isPersistentAgentSessionBusy("alpha", opts)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
