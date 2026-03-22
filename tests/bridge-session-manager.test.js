import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-coding-agent", () => {
  const create = vi.fn((_cwd, sessionDir) => ({
    getSessionFile: () => `${sessionDir}/bridge-test.jsonl`,
  }));
  const open = vi.fn((_filePath, sessionDir) => ({
    getSessionFile: () => `${sessionDir}/bridge-test.jsonl`,
  }));

  const createAgentSession = vi.fn(async ({ sessionManager }) => {
    let listeners = [];
    const session = {
      isStreaming: false,
      sessionManager,
      subscribe(cb) {
        listeners.push(cb);
        return () => {
          listeners = listeners.filter(fn => fn !== cb);
        };
      },
      async prompt() {
        for (const cb of listeners) {
          cb({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "hello" },
          });
        }
      },
      async abort() {},
      steer() {},
    };
    return { session };
  });

  return {
    createAgentSession,
    SessionManager: { create, open },
    SettingsManager: { inMemory: vi.fn(() => ({})) },
  };
});

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({
    log() {},
    error() {},
    warn() {},
  }),
}));

import { BridgeSessionManager } from "../core/bridge-session-manager.js";

const tempDirs = [];

function makeAgent(baseDir, id) {
  const sessionDir = path.join(baseDir, id, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  return {
    agentName: id,
    sessionDir,
    yuanPrompt: "yuan",
    publicIshiki: "public-ishiki",
    config: { models: { chat: "chat-model" } },
  };
}

function makeModelManager() {
  return {
    availableModels: [{ id: "chat-model", contextWindow: 200000 }],
    authStorage: {},
    modelRegistry: {},
    resolveThinkingLevel: () => "none",
  };
}

describe("BridgeSessionManager", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to current agent when getAgentById throws", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-session-"));
    tempDirs.push(tempRoot);

    const currentAgent = makeAgent(tempRoot, "current");
    const getAgentById = vi.fn(() => {
      throw new Error("boom");
    });

    const manager = new BridgeSessionManager({
      getAgent: () => currentAgent,
      getAgentById,
      getModelManager: () => makeModelManager(),
      getResourceLoader: () => ({}),
      getPreferences: () => ({}),
      buildTools: () => ({ tools: [], customTools: [] }),
      getHomeCwd: () => tempRoot,
    });

    await expect(
      manager.executeExternalMessage(
        "hi",
        "tg_group_1",
        { name: "u" },
        { guest: true, agentId: "broken-id" },
      ),
    ).resolves.toBe("hello");

    expect(getAgentById).toHaveBeenCalledWith("broken-id");

    const indexPath = path.join(currentAgent.sessionDir, "bridge", "bridge-sessions.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    expect(index.tg_group_1?.file).toBe("guests/bridge-test.jsonl");
  });
});
