import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import voiceRoute from "./voice.js";

function createEngine(overrides = {}) {
  return {
    getSharedModels: () => ({ voice_transcribe: "siliconflow/TeleAI/TeleSpeechASR" }),
    resolveModelWithCredentials: () => ({
      model: "TeleAI/TeleSpeechASR",
      provider: "siliconflow",
      api: "openai-completions",
      api_key: "test-key",
      base_url: "https://example.com/v1",
    }),
    resolveProviderCredentials: () => ({
      api: "openai-completions",
      api_key: "test-key",
      base_url: "https://example.com/v1",
    }),
    providerRegistry: { getAll: () => new Map() },
    currentModel: null,
    ...overrides,
  };
}

describe("/api/voice/test", () => {
  /** @type {import('fastify').FastifyInstance[]} */
  const apps = [];

  afterEach(async () => {
    while (apps.length) {
      const app = apps.pop();
      await app.close();
    }
    vi.restoreAllMocks();
  });

  it("resolves provider/model refs to bare provider model ids before probing", async () => {
    const engine = createEngine();
    const fetchMock = vi.fn(async (_url, options) => {
      const form = options?.body;
      const model = form?.get?.("model");
      expect(model).toBe("TeleAI/TeleSpeechASR");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ text: "ok" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = Fastify();
    apps.push(app);
    await app.register(voiceRoute, { engine });

    const res = await app.inject({
      method: "POST",
      url: "/api/voice/test",
      payload: { model: "siliconflow/TeleAI/TeleSpeechASR" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      provider: "siliconflow",
      model: "TeleAI/TeleSpeechASR",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
