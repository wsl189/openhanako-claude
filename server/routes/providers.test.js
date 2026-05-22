import { describe, expect, it } from "vitest";
import {
  buildAnthropicMessagesEndpoint,
  buildOllamaTagsEndpoint,
  isAnthropicProbeAuthenticated,
} from "./providers.js";

describe("provider test helpers", () => {
  it("builds Anthropic Messages endpoints with the same /v1/messages shape used at runtime", () => {
    expect(buildAnthropicMessagesEndpoint("https://api.anthropic.com"))
      .toBe("https://api.anthropic.com/v1/messages");
    expect(buildAnthropicMessagesEndpoint("https://api.anthropic.com/v1"))
      .toBe("https://api.anthropic.com/v1/messages");
    expect(buildAnthropicMessagesEndpoint("https://api.minimaxi.com/anthropic"))
      .toBe("https://api.minimaxi.com/anthropic/v1/messages");
    expect(buildAnthropicMessagesEndpoint("https://api.minimaxi.com/anthropic/v1/messages"))
      .toBe("https://api.minimaxi.com/anthropic/v1/messages");
  });

  it("does not treat wrong Anthropic endpoints as authenticated", () => {
    expect(isAnthropicProbeAuthenticated(404, "Not Found")).toBe(false);
    expect(isAnthropicProbeAuthenticated(405, "Method Not Allowed")).toBe(false);
    expect(isAnthropicProbeAuthenticated(500, "Internal Server Error")).toBe(false);
  });

  it("distinguishes auth failures from validation/model probe failures", () => {
    expect(isAnthropicProbeAuthenticated(401, "invalid api key")).toBe(false);
    expect(isAnthropicProbeAuthenticated(400, "invalid api key")).toBe(false);
    expect(isAnthropicProbeAuthenticated(400, "model: test does not exist")).toBe(true);
    expect(isAnthropicProbeAuthenticated(422, "max_tokens is required")).toBe(true);
    expect(isAnthropicProbeAuthenticated(404, "model test not found")).toBe(true);
  });

  it("builds Ollama tags endpoints from both root and /v1 base URLs", () => {
    expect(buildOllamaTagsEndpoint("http://localhost:11434"))
      .toBe("http://localhost:11434/api/tags");
    expect(buildOllamaTagsEndpoint("http://localhost:11434/v1"))
      .toBe("http://localhost:11434/api/tags");
    expect(buildOllamaTagsEndpoint("http://127.0.0.1:11434/v1/"))
      .toBe("http://127.0.0.1:11434/api/tags");
  });
});
