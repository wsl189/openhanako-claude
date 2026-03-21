/**
 * Together AI provider plugin
 *
 * 文档：https://docs.together.ai
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const togetherPlugin = {
  id: "together",
  displayName: "Together AI",
  authType: "api-key",
  defaultBaseUrl: "https://api.together.xyz/v1",
  defaultApi: "openai-completions",
  builtinModels: [
    "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    "deepseek-ai/DeepSeek-R1",
  ],
  capabilities: {
    vision: true,
    functionCall: true,
    streaming: true,
    reasoning: true,
    quirks: [],
  },
};
