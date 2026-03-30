import { describe, it, expect } from "vitest";
import { applyRuntimeModelOverrides } from "./model-runtime-overrides.js";

describe("applyRuntimeModelOverrides", () => {
  it("returns original model when no override exists", () => {
    const model = { id: "gpt-5.4", contextWindow: 272000, maxTokens: 128000 };
    const out = applyRuntimeModelOverrides(model, {});
    expect(out).toBe(model);
  });

  it("maps context/maxOutput override to runtime fields", () => {
    const model = { id: "gpt-5.4", contextWindow: 272000, maxTokens: 128000 };
    const overrides = {
      "gpt-5.4": { context: 1048576, maxOutput: 200000 },
    };
    const out = applyRuntimeModelOverrides(model, overrides);
    expect(out).not.toBe(model);
    expect(out.contextWindow).toBe(1048576);
    expect(out.maxTokens).toBe(200000);
  });

  it("ignores invalid override values", () => {
    const model = { id: "gpt-5.4", contextWindow: 272000, maxTokens: 128000 };
    const overrides = {
      "gpt-5.4": { context: "abc", maxOutput: -1 },
    };
    const out = applyRuntimeModelOverrides(model, overrides);
    expect(out).toBe(model);
  });
});

