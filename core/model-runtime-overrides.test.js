import { describe, it, expect } from "vitest";
import {
  applyClaudeMaxOutputTokensEnv,
  applyRuntimeModelOverrides,
  resolveClaudeSdkModelId,
} from "./model-runtime-overrides.js";

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
    expect(out.maxOutputTokensOverride).toBe(200000);
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

describe("applyClaudeMaxOutputTokensEnv", () => {
  it("maps explicit runtime max output override to Claude Code env", () => {
    expect(applyClaudeMaxOutputTokensEnv(
      { OTHER: "ok" },
      { id: "gpt-5.4", maxOutputTokensOverride: 131072 },
    )).toEqual({
      OTHER: "ok",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "131072",
    });
  });

  it("clears stale Claude Code max output env without an explicit override", () => {
    expect(applyClaudeMaxOutputTokensEnv(
      { OTHER: "ok", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "65536" },
      { id: "gpt-5.4", maxTokens: 128000 },
    )).toEqual({
      OTHER: "ok",
    });
  });
});

describe("resolveClaudeSdkModelId", () => {
  it("adds the 1M suffix when runtime context is one million", () => {
    expect(resolveClaudeSdkModelId("deepseek-v4-pro", { contextWindow: 1_048_576 }))
      .toBe("deepseek-v4-pro[1m]");
    expect(resolveClaudeSdkModelId("custom-model", { contextWindow: 1_000_000 }))
      .toBe("custom-model[1m]");
  });

  it("does not add the suffix below one million context", () => {
    expect(resolveClaudeSdkModelId("deepseek-v4-pro", { contextWindow: 200_000 }))
      .toBe("deepseek-v4-pro");
  });

  it("does not duplicate the suffix", () => {
    expect(resolveClaudeSdkModelId("deepseek-v4-pro[1m]", { contextWindow: 1_048_576 }))
      .toBe("deepseek-v4-pro[1m]");
  });

  it("applies the suffix to any 1M model id", () => {
    expect(resolveClaudeSdkModelId("deepseek-chat", { contextWindow: 1_000_000 }))
      .toBe("deepseek-chat[1m]");
    expect(resolveClaudeSdkModelId("claude-sonnet-4-6", { contextWindow: 1_000_000 }))
      .toBe("claude-sonnet-4-6[1m]");
  });
});
