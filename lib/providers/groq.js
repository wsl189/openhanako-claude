/**
 * Groq provider plugin
 *
 * 超低延迟推理，支持 Llama、Mixtral 等开源模型。
 * 文档：https://console.groq.com/docs
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const groqPlugin = {
  id: "groq",
  displayName: "Groq",
  authType: "api-key",
  defaultBaseUrl: "https://api.groq.com/openai/v1",
  defaultApi: "openai-completions",
  builtinModels: [
    "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768",
  ],
  capabilities: {
    vision: true,
    functionCall: true,
    streaming: true,
    reasoning: false,
    quirks: [],
  },
};
