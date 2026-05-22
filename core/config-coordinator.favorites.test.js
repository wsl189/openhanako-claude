import { describe, it, expect, vi } from "vitest";
import { ConfigCoordinator } from "./config-coordinator.js";

function buildCoordinator(initialPrefs = {}) {
  const prefs = { ...initialPrefs };
  const savePreferences = vi.fn((next) => {
    Object.assign(prefs, next);
  });
  const availableModels = initialPrefs.availableModels || [];

  const coord = new ConfigCoordinator({
    getPrefs: () => ({
      getPreferences: () => prefs,
      savePreferences,
    }),
    getAgent: () => ({ config: {}, configPath: "" }),
    getAgents: () => new Map(),
    getModels: () => ({
      syncModelsAndRefresh: vi.fn(async () => ({})),
      availableModels,
      findAvailableModel: vi.fn((modelRef) => {
        const ref = String(modelRef || "").trim();
        return availableModels.find((model) =>
          model.id === ref || `${model.provider}/${model.id}` === ref
        ) || null;
      }),
    }),
    getSkills: () => ({}),
    getSession: () => null,
    getHub: () => null,
    emitEvent: () => {},
    emitDevLog: () => {},
    getCurrentModel: () => null,
    refreshCurrentSessionTools: async () => ({ reloaded: false }),
  });

  return { coord, prefs, savePreferences };
}

describe("ConfigCoordinator favorites normalization", () => {
  it("migrates legacy object favorites when reading", () => {
    const { coord, prefs, savePreferences } = buildCoordinator({
      favorites: [
        { id: "gpt-4.1", provider: "openai" },
        "openai/gpt-4.1",
        { modelId: "gpt-5.4", providerId: "openai" },
        { id: "  " },
        null,
      ],
    });

    const favorites = coord.readFavorites();

    expect(favorites).toEqual(["openai/gpt-4.1", "openai/gpt-5.4"]);
    expect(prefs.favorites).toEqual(["openai/gpt-4.1", "openai/gpt-5.4"]);
    expect(savePreferences).toHaveBeenCalledTimes(1);
  });

  it("normalizes favorites before saving and syncing", async () => {
    const { coord, prefs } = buildCoordinator({ favorites: [] });
    const syncSpy = vi.fn(async () => ({}));
    coord.syncModelsAndRefresh = syncSpy;

    await coord.saveFavorites([
      { id: "MiniMax-M2.7", provider: "minimax" },
      " openai/gpt-4.1 ",
      { model: "gpt-4.1", provider: "openai" },
    ]);

    expect(prefs.favorites).toEqual(["minimax/MiniMax-M2.7", "openai/gpt-4.1"]);
    expect(syncSpy).toHaveBeenCalledWith(["minimax/MiniMax-M2.7", "openai/gpt-4.1"]);
  });

  it("canonicalizes legacy bare favorite ids when the provider is unambiguous", () => {
    const { coord, prefs, savePreferences } = buildCoordinator({
      favorites: ["qwen3.6:35b-256k", "deepseek-v4-pro"],
      availableModels: [
        { id: "qwen3.6:35b-256k", provider: "ollama" },
        { id: "deepseek-v4-pro", provider: "deepseek" },
      ],
    });

    const favorites = coord.readFavorites();

    expect(favorites).toEqual(["ollama/qwen3.6:35b-256k", "deepseek/deepseek-v4-pro"]);
    expect(prefs.favorites).toEqual(["ollama/qwen3.6:35b-256k", "deepseek/deepseek-v4-pro"]);
    expect(savePreferences).toHaveBeenCalledTimes(1);
  });
});

describe("ConfigCoordinator model overrides", () => {
  it("reapplies runtime model overrides to the active session", async () => {
    const session = {
      model: { id: "deepseek-v4-pro", provider: "deepseek", contextWindow: 200000, maxTokens: 8192 },
      setModel: vi.fn(async () => {}),
    };
    const models = {
      currentModel: session.model,
      defaultModel: session.model,
      availableModels: [session.model],
    };
    const agent = {
      config: {
        models: {
          chat: "deepseek/deepseek-v4-pro",
          overrides: {},
        },
      },
      updateConfig: vi.fn((partial) => {
        agent.config = {
          ...agent.config,
          ...partial,
          models: {
            ...(agent.config.models || {}),
            ...(partial.models || {}),
          },
        };
      }),
    };
    const coord = new ConfigCoordinator({
      getPrefs: () => ({ getPreferences: () => ({}), savePreferences: vi.fn() }),
      getAgent: () => agent,
      getAgents: () => new Map(),
      getModels: () => models,
      getSkills: () => ({}),
      getSession: () => session,
      getHub: () => null,
      emitEvent: () => {},
      emitDevLog: () => {},
      getCurrentModel: () => null,
      refreshCurrentSessionTools: async () => ({ reloaded: false }),
    });

    await coord.updateConfig({
      models: {
        overrides: {
          "deepseek-v4-pro": { context: 1048576, maxOutput: 32768 },
        },
      },
    });

    expect(session.setModel).toHaveBeenCalledWith({
      id: "deepseek-v4-pro",
      provider: "deepseek",
      contextWindow: 1048576,
      maxTokens: 32768,
      maxOutputTokensOverride: 32768,
    });
    expect(models.currentModel.contextWindow).toBe(1048576);
    expect(models.defaultModel.maxTokens).toBe(32768);
  });
});

describe("ConfigCoordinator hot reload", () => {
  it("refreshes current session tools when MCP config changes", async () => {
    const refreshSpy = vi.fn(async () => ({ reloaded: true, sessionPath: "/tmp/session.json" }));
    const agent = {
      config: {},
      updateConfig: vi.fn((partial) => {
        agent.config = {
          ...agent.config,
          ...partial,
          mcp: {
            ...(agent.config.mcp || {}),
            ...(partial.mcp || {}),
          },
        };
      }),
    };
    const coord = new ConfigCoordinator({
      getPrefs: () => ({ getPreferences: () => ({}), savePreferences: vi.fn(), setThinkingLevel: vi.fn() }),
      getAgent: () => agent,
      getAgents: () => new Map(),
      getModels: () => ({
        availableModels: [],
      }),
      getSkills: () => ({}),
      getSession: () => null,
      getHub: () => null,
      emitEvent: () => {},
      emitDevLog: () => {},
      getCurrentModel: () => null,
      refreshCurrentSessionTools: refreshSpy,
    });

    await coord.updateConfig({
      mcp: { disabled_servers: ["context7"] },
    });

    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});
