import { describe, expect, it } from "vitest";
import { ModelManager } from "./model-manager.js";

describe("ModelManager.setModel", () => {
  it("supports provider/model refs when switching from favorites", () => {
    const mm = new ModelManager({ hanakoHome: "/tmp/hanako-test" });
    mm._availableModels = [
      { id: "same-model", name: "A Same", provider: "provider-a" },
      { id: "same-model", name: "B Same", provider: "provider-b" },
    ];
    mm.modelCatalog = {
      resolve(ref) {
        if (ref === "provider-b/same-model") {
          return {
            key: "provider-b/same-model",
            modelId: "same-model",
            providerId: "provider-b",
            displayName: "B Same",
            baseUrl: "https://example.com",
            api: "anthropic-messages",
            input: ["text"],
            contextWindow: 128_000,
          };
        }
        return null;
      },
      toSdkEntry(entry) {
        return {
          id: entry.modelId,
          name: entry.displayName,
          provider: entry.providerId,
          baseUrl: entry.baseUrl,
          api: entry.api,
          input: entry.input,
          contextWindow: entry.contextWindow,
        };
      },
    };

    const model = mm.setModel("provider-b/same-model");

    expect(model.provider).toBe("provider-b");
    expect(mm.currentModel?.provider).toBe("provider-b");
  });

  it("prefers canonical provider/model refs when a slashful raw id overlaps", () => {
    const mm = new ModelManager({ hanakoHome: "/tmp/hanako-test" });
    mm._availableModels = [
      { id: "minimax/minimax-m2.5:free", name: "OpenRouter MiniMax", provider: "openrouter" },
      { id: "minimax-m2.5:free", name: "MiniMax Free", provider: "minimax" },
    ];
    mm.modelCatalog = {
      resolve(ref) {
        if (ref === "openrouter/minimax/minimax-m2.5:free") {
          return {
            key: "openrouter/minimax/minimax-m2.5:free",
            modelId: "minimax/minimax-m2.5:free",
            providerId: "openrouter",
            displayName: "OpenRouter MiniMax",
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-completions",
            input: ["text"],
            contextWindow: 128_000,
          };
        }
        if (ref === "minimax/minimax-m2.5:free") {
          return {
            key: "minimax/minimax-m2.5:free",
            modelId: "minimax-m2.5:free",
            providerId: "minimax",
            displayName: "MiniMax Free",
            baseUrl: "https://api.minimaxi.com/v1",
            api: "openai-completions",
            input: ["text"],
            contextWindow: 128_000,
          };
        }
        return null;
      },
      toSdkEntry(entry) {
        return {
          id: entry.modelId,
          name: entry.displayName,
          provider: entry.providerId,
          baseUrl: entry.baseUrl,
          api: entry.api,
          input: entry.input,
          contextWindow: entry.contextWindow,
        };
      },
    };

    const openrouterModel = mm.findAvailableModel("openrouter/minimax/minimax-m2.5:free");
    const minimaxModel = mm.findAvailableModel("minimax/minimax-m2.5:free");

    expect(openrouterModel?.provider).toBe("openrouter");
    expect(openrouterModel?.id).toBe("minimax/minimax-m2.5:free");
    expect(minimaxModel?.provider).toBe("minimax");
    expect(minimaxModel?.id).toBe("minimax-m2.5:free");
  });

  it("accepts legacy object refs ({id, provider})", () => {
    const mm = new ModelManager({ hanakoHome: "/tmp/hanako-test" });
    mm._availableModels = [
      { id: "MiniMax-M2.7", name: "MiniMax M2.7", provider: "minimax" },
    ];

    const model = mm.setModel({ id: "MiniMax-M2.7", provider: "minimax" });

    expect(model.id).toBe("MiniMax-M2.7");
    expect(model.provider).toBe("minimax");
  });
});
