/**
 * OpenAI provider plugin
 */

/** @type {import('../provider-registry.js').ProviderPlugin} */
export const openaiPlugin = {
  id: "openai",
  displayName: "OpenAI",
  authType: "api-key",
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultApi: "openai-completions",
  builtinModels: [
    "gpt-4o", "gpt-4o-mini", "o4-mini", "o3", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
  ],
  capabilities: {
    vision: true,
    functionCall: true,
    streaming: true,
    reasoning: true,
    quirks: [],
  },
};
