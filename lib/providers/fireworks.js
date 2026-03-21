/**
 * Fireworks AI provider plugin
 *
 * 文档：https://docs.fireworks.ai
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const fireworksPlugin = {
  id: "fireworks",
  displayName: "Fireworks AI",
  authType: "api-key",
  defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
  defaultApi: "openai-completions",
  builtinModels: [
    "accounts/fireworks/models/llama-v3p3-70b-instruct",
    "accounts/fireworks/models/deepseek-r1",
  ],
  capabilities: {
    vision: true,
    functionCall: true,
    streaming: true,
    reasoning: true,
    quirks: [],
  },
};
