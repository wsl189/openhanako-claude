import { describe, it, expect, vi } from "vitest";
import { ConfigCoordinator } from "./config-coordinator.js";

function buildCoordinator(initialPrefs = {}) {
  const prefs = { ...initialPrefs };
  const savePreferences = vi.fn((next) => {
    Object.assign(prefs, next);
  });

  const coord = new ConfigCoordinator({
    getPrefs: () => ({
      getPreferences: () => prefs,
      savePreferences,
    }),
    getAgent: () => ({ config: {}, configPath: "" }),
    getAgents: () => new Map(),
    getModels: () => ({
      syncModelsAndRefresh: vi.fn(async () => ({})),
      availableModels: [],
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
});

