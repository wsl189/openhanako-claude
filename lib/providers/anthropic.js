/**
 * Anthropic provider plugin (API key)
 */

/** @type {import('../provider-registry.js').ProviderPlugin} */
export const anthropicPlugin = {
  id: "anthropic",
  displayName: "Anthropic",
  authType: "api-key",
  defaultBaseUrl: "https://api.anthropic.com",
  defaultApi: "anthropic-messages",
  builtinModels: [
    "claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-3-5-20241022",
  ],
  capabilities: {
    vision: true,
    functionCall: true,
    streaming: true,
    reasoning: true,
    quirks: [],
  },
};
