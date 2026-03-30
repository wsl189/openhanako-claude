/**
 * 运行时模型覆盖工具：
 * 将 agent.config.models.overrides 中的 context/maxOutput 映射到
 * Pi SDK 运行时模型字段 contextWindow/maxTokens。
 */

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

  if (nextMaxTokens && nextMaxTokens !== model.maxTokens) {
    patched = patched === model ? { ...patched } : patched;
    patched.maxTokens = nextMaxTokens;
  }

  return patched;
}

