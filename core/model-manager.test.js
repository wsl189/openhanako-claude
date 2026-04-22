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
