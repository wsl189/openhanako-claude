import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSessionMock,
  sessionManagerCreateMock,
  settingsInMemoryMock,
} = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
  settingsInMemoryMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: createAgentSessionMock,
  SessionManager: {
    create: sessionManagerCreateMock,
  },
  SettingsManager: {
    inMemory: settingsInMemoryMock,
  },
}));

import { runAgentSession } from "./agent-executor.js";

describe("runAgentSession sandboxed builtin tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionManagerCreateMock.mockReturnValue({ id: "temp-session-manager" });
    settingsInMemoryMock.mockReturnValue({ id: "settings" });
  });

  it("injects wrapped builtin tools into customTools to avoid SDK default override", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-exec-test-"));
    const agentDir = path.join(tempRoot, "alpha");
    fs.mkdirSync(agentDir, { recursive: true });

    const wrappedBuiltin = { name: "bash", execute: vi.fn() };
    const wrappedCustom = { name: "custom_tool", execute: vi.fn() };
    const fakeSession = {
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      sessionManager: {
        getSessionFile: () => null,
      },
    };
    createAgentSessionMock.mockResolvedValue({ session: fakeSession });

    const agent = {
      agentDir,
      tools: [{ name: "bash", execute: vi.fn() }],
      personality: "personality",
      systemPrompt: "system",
      config: { desk: { home_folder: "/workspace" } },
    };
    const ctx = {
      resourceLoader: {},
      authStorage: { id: "auth" },
      modelRegistry: { id: "registry" },
      buildTools: vi.fn(() => ({
        tools: [wrappedBuiltin],
        customTools: [wrappedCustom],
      })),
      resolveModel: vi.fn(() => ({ id: "test-model", contextWindow: 200_000 })),
      getSkillsForAgent: vi.fn(() => []),
    };
    const engine = {
      getAgent: vi.fn(() => agent),
      createSessionContext: vi.fn(() => ctx),
      getHomeFolder: vi.fn(() => "/workspace"),
      setSessionPendingImages: vi.fn(),
      clearSessionPendingImages: vi.fn(),
    };

    try {
      await runAgentSession(
        "alpha",
        [{ text: "hello", capture: false }],
        { engine },
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    const createArgs = createAgentSessionMock.mock.calls[0][0];
    expect(createArgs.tools).toEqual([wrappedBuiltin]);
    expect(createArgs.customTools).toEqual([wrappedCustom, wrappedBuiltin]);
  });
});
