/**
 * ExecutionRouter — per-agent 角色路由
 *
 * 职责：
 *   - 将 agent 的角色配置（chat/utility/embed 等）解析为执行所需的完整参数
 *   - 输入：role 名称 + agentConfig
 *   - 输出：{ modelId, providerId, api, apiKey, baseUrl }
 *   - 完全不参与模型注册逻辑（这是路由层，不是管理层）
 *
 * 角色路由配置存储格式（preferences.json / config.yaml）：
 *   models.chat           → "provider/model" 或裸 modelId（向后兼容）
 *   models.utility        → 同上
 *   models.utility_large  → 同上
 *   models.embed          → 同上
 *   models.summarizer     → 同上
 *   models.compiler       → 同上
 *
 * 设计来源：Hana 自己的三通道 API 概念（两个参考项目都没有）
 */

import { t } from "../server/i18n.js";

function isLocalBaseUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(String(url || ""));
}

// 角色名称 → preferences 字段名（SHARED_MODEL_KEYS 兼容）
const ROLE_TO_PREF_KEY = {
  utility: "utility_model",
  utility_large: "utility_large_model",
  summarizer: "summarizer_model",
  compiler: "compiler_model",
};

export class ExecutionRouter {
  /**
   * @param {import('./model-catalog.js').ModelCatalog} catalog
   * @param {import('./auth-store.js').AuthStore} authStore
   */
  constructor(catalog, authStore) {
    this._catalog = catalog;
    this._authStore = authStore;
  }

  /**
   * 解析角色 → 完整执行参数
   *
   * @param {string} roleOrRef
   *   角色名（"chat"/"utility"/"utility_large"/"embed"/"summarizer"/"compiler"）
   *   或直接是模型引用（"provider/model" 或裸 modelId）
   * @param {object} agentConfig - agent config 对象（来自 config.yaml）
   * @param {object} [sharedModels] - 全局共享角色模型（来自 preferences）
   * @param {object} [utilApiOverride] - utility API 覆盖（来自 preferences）
   * @returns {{ modelId: string, providerId: string, api: string, apiKey: string, baseUrl: string }}
   * @throws 找不到模型或凭证时抛出
   */
  resolve(roleOrRef, agentConfig, sharedModels, utilApiOverride) {
    const modelRef = this._resolveRef(roleOrRef, agentConfig, sharedModels);
    if (!modelRef) {
      throw new Error(t("error.noUtilityModel") + ` (role: ${roleOrRef})`);
    }

    const entry = this._catalog.resolve(modelRef);
    if (!entry) {
      throw new Error(t("error.modelNotFound", { id: modelRef }));
    }

    // utility API 覆盖：只在 utility/utility_large 角色时生效
    const isUtilityRole = roleOrRef === "utility" || roleOrRef === "utility_large";
    if (isUtilityRole && utilApiOverride?.api_key) {
      // 校验 provider 一致性（与原 ModelManager.resolveUtilityConfig 行为一致）
      if (utilApiOverride.provider && utilApiOverride.provider !== entry.providerId) {
        throw new Error(t("error.utilityApiProviderMismatch", { model: modelRef }));
      }
      return {
        modelId: entry.modelId,
        providerId: entry.providerId,
        api: entry.api,
        apiKey: utilApiOverride.api_key,
        baseUrl: utilApiOverride.base_url || entry.baseUrl,
      };
    }

    const cred = this._authStore.get(entry.providerId, agentConfig);
    if (!cred) {
      throw new Error(t("error.providerMissingCreds", { provider: entry.providerId }));
    }
    if (!cred.api) {
      throw new Error(t("error.providerMissingApi", { provider: entry.providerId }));
    }
    if (!cred.baseUrl || (!cred.apiKey && !isLocalBaseUrl(cred.baseUrl))) {
      throw new Error(t("error.providerMissingCreds", { provider: entry.providerId }));
    }

    return {
      modelId: entry.modelId,
      providerId: entry.providerId,
      api: cred.api,
      apiKey: cred.apiKey,
      baseUrl: cred.baseUrl,
    };
  }

  /**
   * 向后兼容的 resolveUtilityConfig 接口
   * 现有 6 处消费方（hub/channel-router, install-skill, llm-utils 等）都调这个
   * 返回结构与原 ModelManager.resolveUtilityConfig() 完全一致
   *
   * @param {object} agentConfig
   * @param {{ utility?: string, utility_large?: string, summarizer?: string, compiler?: string }} sharedModels
   * @param {{ provider?: string, api_key?: string, base_url?: string }} utilApiOverride
   */
  resolveUtilityConfig(agentConfig, sharedModels, utilApiOverride) {
    const cfg = agentConfig || {};
    const utilityModelRef = sharedModels?.utility || cfg.models?.utility;
    const largeModelRef = sharedModels?.utility_large || cfg.models?.utility_large;

    if (!utilityModelRef) throw new Error(t("error.noUtilityModel"));
    if (!largeModelRef) throw new Error(t("error.noUtilityLargeModel"));

    const utilEntry = this._catalog.resolve(utilityModelRef);
    if (!utilEntry) throw new Error(t("error.modelNotFound", { id: utilityModelRef }));

    const largeEntry = this._catalog.resolve(largeModelRef);
    if (!largeEntry) throw new Error(t("error.modelNotFound", { id: largeModelRef }));

    // utility 凭证
    let apiKey, baseUrl, api;
    if (utilApiOverride?.provider || utilApiOverride?.api_key || utilApiOverride?.base_url) {
      // 校验 provider 一致性（与原 ModelManager.resolveUtilityConfig 行为一致）
      if (utilApiOverride.provider && utilApiOverride.provider !== utilEntry.providerId) {
        throw new Error(t("error.utilityApiProviderMismatch", { model: utilityModelRef }));
      }
      // utility API 覆盖（用户指定了独立的 utility api endpoint）
      const provCred = this._authStore.get(utilEntry.providerId, cfg);
      api = provCred?.api || utilEntry.api;
      apiKey = utilApiOverride.api_key || "";
      baseUrl = utilApiOverride.base_url || "";
      if (!api) throw new Error(t("error.providerMissingApi", { provider: utilEntry.providerId }));
      if (!baseUrl || (!apiKey && !isLocalBaseUrl(baseUrl))) {
        throw new Error(t("error.utilityApiMissingCreds", { provider: utilEntry.providerId }));
      }
    } else {
      const cred = this._authStore.get(utilEntry.providerId, cfg);
      if (!cred?.api) throw new Error(t("error.providerMissingApi", { provider: utilEntry.providerId }));
      if (!cred.baseUrl || (!cred.apiKey && !isLocalBaseUrl(cred.baseUrl))) {
        throw new Error(t("error.providerMissingCreds", { provider: utilEntry.providerId }));
      }
      apiKey = cred.apiKey;
      baseUrl = cred.baseUrl;
      api = cred.api;
    }

    // utility_large 凭证（provider 相同则复用）
    let large_api_key = apiKey, large_base_url = baseUrl, large_api = api;
    if (largeEntry.providerId !== utilEntry.providerId) {
      const largeCred = this._authStore.get(largeEntry.providerId, cfg);
      if (!largeCred?.api) throw new Error(t("error.providerMissingApi", { provider: largeEntry.providerId }));
      if (!largeCred.baseUrl || (!largeCred.apiKey && !isLocalBaseUrl(largeCred.baseUrl))) {
        throw new Error(t("error.providerMissingCreds", { provider: largeEntry.providerId }));
      }
      large_api_key = largeCred.apiKey;
      large_base_url = largeCred.baseUrl;
      large_api = largeCred.api;
    }

    return {
      utility: utilEntry.modelId,
      utility_large: largeEntry.modelId,
      api_key: apiKey,
      base_url: baseUrl,
      api,
      large_api_key,
      large_base_url,
      large_api,
    };
  }

  /**
   * 将角色名或模型引用解析为实际模型 ref 字符串
   * @private
   */
  _resolveRef(roleOrRef, agentConfig, sharedModels) {
    const cfg = agentConfig || {};

    // 内置角色名的查找顺序：sharedModels → agentConfig.models
    switch (roleOrRef) {
      case "chat":
        return cfg.models?.chat || null;
      case "utility":
        return sharedModels?.utility || cfg.models?.utility || null;
      case "utility_large":
        return sharedModels?.utility_large || cfg.models?.utility_large || null;
      case "summarizer":
        return sharedModels?.summarizer || cfg.models?.summarizer || null;
      case "compiler":
        return sharedModels?.compiler || cfg.models?.compiler || null;
      case "embed":
        return cfg.embedding_api?.model || null;
      default:
        // 不是内置角色名，当作模型引用直接用
        return roleOrRef;
    }
  }
}
