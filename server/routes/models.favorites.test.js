import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import modelsRoute from "./models.js";

function createEngine(overrides = {}) {
  return {
    _models: { modelCatalog: null },
    readFavorites: () => [],
    availableModels: [],
    currentModel: null,
    currentSessionPath: null,
    agentsDir: "/tmp/hanako-test/agents",
    getSessionByPath: () => null,
    setModel: async () => {},
    authStorage: { get: () => null, getApiKey: async () => "" },
    _resolveProviderCredentials: () => ({ api_key: "", base_url: "", api: "" }),
    ...overrides,
  };
}

describe("/api/models/favorites", () => {
  /** @type {import('fastify').FastifyInstance[]} */
  const apps = [];

  afterEach(async () => {
    while (apps.length) {
      const app = apps.pop();
      await app.close();
    }
  });

  it("returns canonical provider/model refs and filters unavailable favorites", async () => {
    const engine = createEngine({
      readFavorites: () => ["openai/gpt-4.1", "missing-model", "minimax/MiniMax-M2.7"],
      availableModels: [
        { id: "gpt-4.1", name: "GPT-4.1", provider: "openai", reasoning: true },
        { id: "MiniMax-M2.7", name: "MiniMax M2.7", provider: "minimax", reasoning: true },
      ],
      currentModel: { id: "gpt-4.1", name: "GPT-4.1", provider: "openai", reasoning: true },
    });

    const app = Fastify();
    apps.push(app);
    await app.register(modelsRoute, { engine });

    const res = await app.inject({ method: "GET", url: "/api/models/favorites" });
    expect(res.statusCode).toBe(200);
    const data = res.json();

    expect(data.models.map((m) => m.id)).toEqual(["openai/gpt-4.1", "minimax/MiniMax-M2.7"]);
    expect(data.models[0].isCurrent).toBe(true);
    expect(data.current).toBe("openai/gpt-4.1");
  });

  it("prepends current model when not in favorites", async () => {
    const engine = createEngine({
      readFavorites: () => ["minimax/MiniMax-M2.7"],
      availableModels: [
        { id: "gpt-4.1", name: "GPT-4.1", provider: "openai", reasoning: true },
        { id: "MiniMax-M2.7", name: "MiniMax M2.7", provider: "minimax", reasoning: true },
      ],
      currentModel: { id: "gpt-4.1", name: "GPT-4.1", provider: "openai", reasoning: true },
    });

    const app = Fastify();
    apps.push(app);
    await app.register(modelsRoute, { engine });

    const res = await app.inject({ method: "GET", url: "/api/models/favorites" });
    expect(res.statusCode).toBe(200);
    const data = res.json();

    expect(data.models[0].id).toBe("openai/gpt-4.1");
    expect(data.models[0].isCurrent).toBe(true);
    expect(data.current).toBe("openai/gpt-4.1");
  });

  it("switches model globally even when sessionPath is provided", async () => {
    let switchedTo = null;
    const engine = createEngine({
      currentModel: { id: "MiniMax-M2.7", name: "MiniMax M2.7", provider: "minimax", reasoning: true },
      setModel: async (modelId) => {
        switchedTo = modelId;
        engine.currentModel = { id: "gpt-4.1", name: "GPT-4.1", provider: "openai", reasoning: true };
      },
    });

    const app = Fastify();
    apps.push(app);
    await app.register(modelsRoute, { engine });

    const res = await app.inject({
      method: "POST",
      url: "/api/models/set",
      payload: { modelId: "openai/gpt-4.1", sessionPath: "/tmp/another-session" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(switchedTo).toBe("openai/gpt-4.1");
    expect(data.ok).toBe(true);
    expect(data.modelRef).toBe("openai/gpt-4.1");
  });

  it("resolves provider/model refs in health checks", async () => {
    const engine = createEngine({
      availableModels: [
        { id: "minimax-m2.5:free", name: "MiniMax M2.5 Free", provider: "minimax", api: "openai-completions" },
      ],
      _resolveProviderCredentials: () => ({
        api_key: "test-key",
        base_url: "https://openrouter.ai/api/v1",
        api: "openai-completions",
      }),
    });

    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200 });

    const app = Fastify();
    apps.push(app);
    await app.register(modelsRoute, { engine });

    const res = await app.inject({
      method: "POST",
      url: "/api/models/health",
      payload: { modelId: "minimax/minimax-m2.5:free" },
    });

    global.fetch = originalFetch;

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: 200, provider: "minimax" });
  });
});
