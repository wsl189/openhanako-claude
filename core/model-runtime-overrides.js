/**
 * 运行时模型覆盖工具：
 * 将 agent.config.models.overrides 中的 context/maxOutput 映射到
 * 运行时模型字段 contextWindow/maxTokens。
 */

export const CLAUDE_MAX_OUTPUT_TOKENS_ENV = "CLAUDE_CODE_MAX_OUTPUT_TOKENS";

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * 基于 overrides 返回“用于运行时”的模型对象（不修改原对象）。
 * 支持 override 字段：
 * - context / contextWindow -> model.contextWindow
 * - maxOutput / maxTokens   -> model.maxTokens
 */
export function applyRuntimeModelOverrides(model, overrides) {
  if (!model || typeof model !== "object") return model;
  if (!overrides || typeof overrides !== "object") return model;

  const ov = model.id ? overrides[model.id] : null;
  if (!ov || typeof ov !== "object") return model;

  const nextContextWindow = toPositiveInt(ov.context ?? ov.contextWindow);
  const nextMaxTokens = toPositiveInt(ov.maxOutput ?? ov.maxTokens);

  let patched = model;

  if (nextContextWindow && nextContextWindow !== model.contextWindow) {
    patched = { ...patched, contextWindow: nextContextWindow };
  }

  if (nextMaxTokens && (
    nextMaxTokens !== model.maxTokens
    || nextMaxTokens !== model.maxOutputTokensOverride
  )) {
    patched = patched === model ? { ...patched } : patched;
    patched.maxTokens = nextMaxTokens;
    patched.maxOutputTokensOverride = nextMaxTokens;
  }

  return patched;
}

export function applyClaudeMaxOutputTokensEnv(env = {}, model = null) {
  const nextEnv = { ...(env || {}) };
  const maxOutput = toPositiveInt(model?.maxOutputTokensOverride);
  if (maxOutput) {
    nextEnv[CLAUDE_MAX_OUTPUT_TOKENS_ENV] = String(maxOutput);
  } else {
    delete nextEnv[CLAUDE_MAX_OUTPUT_TOKENS_ENV];
  }
  return nextEnv;
}

function hasOneMillionContext(model) {
  const contextWindow = toPositiveInt(model?.contextWindow ?? model?.context);
  return contextWindow != null && contextWindow >= 1_000_000;
}

/**
 * Claude Agent SDK uses the model id to decide its context-window policy.
 * Some Anthropic-compatible providers expose a 1M variant through the "[1m]"
 * model suffix. Hanako keeps the user's configured model id unchanged for
 * display/metadata and only applies the suffix at the SDK boundary.
 */
export function resolveClaudeSdkModelId(modelId, runtimeModel = null) {
  const raw = String(modelId || "").trim();
  if (!raw) return raw;
  if (/\[1m\]$/i.test(raw)) return raw;
  if (!hasOneMillionContext(runtimeModel)) return raw;
  return `${raw}[1m]`;
}
