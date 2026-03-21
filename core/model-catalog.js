/**
 * ModelCatalog — 启动时预聚合的模型目录
 *
 * 职责：
 *   - 维护 Map<"provider/model", ModelEntry> 内存目录
 *   - 启动时从 models.json（Pi SDK）+ ProviderRegistry 一次性聚合
 *   - 提供 provider/model 双段 key 的唯一真相来源
 *   - models.json 的写入仍由 sync-favorites.js 负责（不变）
 *
 * 设计来源：OpenClaw 的 pre-aggregate catalog 模式
 */

import fs from "fs";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);
const _knownModels = _require("../lib/known-models.json");

// ── Types (JSDoc) ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} ModelEntry
 * @property {string} key            - "providerId/modelId"，全局唯一键
 * @property {string} providerId     - provider 的 id（如 "dashscope", "minimax-oauth"）
 * @property {string} modelId        - 原始 model ID（不含 provider 前缀，发给 API 用这个）
 * @property {string} displayName    - UI 展示名称
 * @property {string} baseUrl        - 生效的 base URL
 * @property {string} api            - API 协议类型
 * @property {string[]} input        - 支持的输入类型
 * @property {number} contextWindow  - context window token 数
 * @property {number} [maxTokens]    - 最大输出 token 数
 * @property {boolean} [reasoning]   - 是否为思维链模型
 * @property {object} [_sdkEntry]    - 原始 Pi SDK model 对象（向后兼容用）
 */

// ── helpers ───────────────────────────────────────────────────────────────────

function humanizeName(id) {
  let name = id.replace(/-(\d{6})$/, "");
  name = name.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  name = name.replace(/(\d) (\d)/g, "$1.$2");
  return name;
}

function makeKey(providerId, modelId) {
  return `${providerId}/${modelId}`;
}

/** 从 known-models.json 补充模型元数据 */
function enrichFromKnown(modelId) {
  const known = _knownModels[modelId];
  return {
    displayName: known?.name || humanizeName(modelId),
    contextWindow: known?.context || 128_000,
    maxTokens: known?.maxOutput || undefined,
  };
}

// ── ModelCatalog ─────────────────────────────────────────────────────────────

export class ModelCatalog {
  /**
   * @param {import('./provider-registry.js').ProviderRegistry} providerRegistry
   * @param {string} modelsJsonPath - models.json 路径（Pi SDK 维护）
   */
  constructor(providerRegistry, modelsJsonPath) {
    this._registry = providerRegistry;
    this._modelsJsonPath = modelsJsonPath;
    /** @type {Map<string, ModelEntry>} "provider/model" → ModelEntry */
    this._catalog = new Map();
  }

  /**
   * 从 models.json + ProviderRegistry 完整构建目录
   * 启动时调用一次
   */
  async build() {
    this._catalog.clear();
    this._buildFromModelsJson();
    this._buildFromRegistry();
  }

  /**
   * 增量刷新（sync-favorites.js 更新 models.json 后调用）
   */
  async refresh() {
    await this.build();
  }

  /**
   * 读取 models.json，按 provider/model 建立 catalog
   * @private
   */
  _buildFromModelsJson() {
    let modelsJson = { providers: {} };
    try {
      modelsJson = JSON.parse(fs.readFileSync(this._modelsJsonPath, "utf-8"));
      if (!modelsJson.providers) modelsJson.providers = {};
    } catch {
      // models.json 不存在或损坏，catalog 为空
    }

    for (const [providerId, providerData] of Object.entries(modelsJson.providers)) {
      const providerEntry = this._registry.get(providerId);
      const baseUrl = providerData.baseUrl || providerEntry?.baseUrl || "";
      const api = providerData.api || providerEntry?.api || "openai-completions";
      const models = providerData.models || [];

      for (const modelDef of models) {
        // models.json 里每个 model 是一个对象
        const modelId = typeof modelDef === "string" ? modelDef : modelDef.id;
        if (!modelId) continue;

        const key = makeKey(providerId, modelId);
        const knownMeta = enrichFromKnown(modelId);

        /** @type {ModelEntry} */
        const entry = {
          key,
          providerId,
          modelId,
          displayName: modelDef.name || knownMeta.displayName,
          baseUrl,
          api,
          input: modelDef.input || ["text", "image"],
          contextWindow: modelDef.contextWindow || knownMeta.contextWindow,
          reasoning: modelDef.reasoning || false,
          _sdkEntry: modelDef,
        };
        if (modelDef.maxTokens || knownMeta.maxTokens) {
          entry.maxTokens = modelDef.maxTokens || knownMeta.maxTokens;
        }

        this._catalog.set(key, entry);
      }
    }
  }

  /**
   * 从 ProviderRegistry 的 builtinModels 声明构建 catalog 条目
   * models.json 中已有的条目优先（不覆盖）
   * @private
   */
  _buildFromRegistry() {
    const all = this._registry.getAll();
    for (const [providerId, provEntry] of all) {
      const builtins = provEntry.builtinModels;
      if (!builtins || builtins.length === 0) continue;

      for (const modelId of builtins) {
        const key = makeKey(providerId, modelId);
        if (this._catalog.has(key)) continue; // models.json 优先
        const knownMeta = enrichFromKnown(modelId);
        this._catalog.set(key, {
          key,
          providerId,
          modelId,
          displayName: knownMeta.displayName,
          baseUrl: provEntry.baseUrl || "",
          api: provEntry.api || "openai-completions",
          input: ["text", "image"],
          contextWindow: knownMeta.contextWindow,
          maxTokens: knownMeta.maxTokens,
          reasoning: false,
        });
      }
    }
  }

  /**
   * 注入 OAuth provider 的自定义模型（从 preferences 读取）
   * 在 build/refresh 之后调用
   * @param {{ [providerId: string]: string[] }} oauthCustomModels
   */
  injectOAuthCustomModels(oauthCustomModels) {
    for (const [providerId, modelIds] of Object.entries(oauthCustomModels || {})) {
      if (!Array.isArray(modelIds) || modelIds.length === 0) continue;
      const providerEntry = this._registry.get(providerId);
      const baseUrl = providerEntry?.baseUrl || "";
      const api = providerEntry?.api || "openai-completions";

      for (const modelId of modelIds) {
        const key = makeKey(providerId, modelId);
        if (this._catalog.has(key)) continue; // 不覆盖已有条目
        const knownMeta = enrichFromKnown(modelId);
        this._catalog.set(key, {
          key,
          providerId,
          modelId,
          displayName: knownMeta.displayName,
          baseUrl,
          api,
          input: ["text", "image"],
          contextWindow: knownMeta.contextWindow,
          reasoning: false,
        });
      }
    }
  }

  /**
   * 按 "provider/model" key 查找
   * @param {string} key
   * @returns {ModelEntry|null}
   */
  get(key) {
    return this._catalog.get(key) || null;
  }

  /**
   * 按裸 model ID 查找（向后兼容）
   * 存在多个 provider 提供同名模型时，返回第一个并打印警告
   * @param {string} modelId
   * @returns {ModelEntry|null}
   */
  getByModelId(modelId) {
    const matches = [];
    for (const entry of this._catalog.values()) {
      if (entry.modelId === modelId) matches.push(entry);
    }
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      console.warn(
        `[ModelCatalog] 模型 ID "${modelId}" 在多个 provider 中存在：` +
        matches.map(e => e.key).join(", ") +
        `。返回第一个（${matches[0].key}）。建议改用完整 "provider/model" 格式。`
      );
    }
    return matches[0];
  }

  /**
   * 解析模型引用为 ModelEntry
   * 支持三种输入：
   *   1. "provider/model" key（精确查找）
   *   2. 裸 model ID（向后兼容，有歧义时 warn）
   *   3. 已经是 ModelEntry 对象
   * @param {string|ModelEntry} ref
   * @returns {ModelEntry|null}
   */
  resolve(ref) {
    if (!ref) return null;
    if (typeof ref === "object" && ref.key) return ref;
    if (typeof ref !== "string") return null;
    const str = ref.trim();
    if (!str) return null;

    // 尝试作为完整 key 查找（含斜杠但不是 openrouter 风格的多段路径）
    if (str.includes("/")) {
      const entry = this._catalog.get(str);
      if (entry) return entry;
    }

    // 退回到裸 model ID 查找
    return this.getByModelId(str);
  }

  /**
   * 列出所有 ModelEntry
   * @returns {ModelEntry[]}
   */
  list() {
    return [...this._catalog.values()];
  }

  /**
   * 列出某个 provider 的所有模型
   * @param {string} providerId
   * @returns {ModelEntry[]}
   */
  listByProvider(providerId) {
    return [...this._catalog.values()].filter(e => e.providerId === providerId);
  }

  /**
   * 当前 catalog 中模型的数量
   */
  get size() {
    return this._catalog.size;
  }

  /**
   * 将 ModelEntry 转换为 Pi SDK 期望的格式
   * 主要用于 session.setModel() 等需要传原始 SDK entry 的地方
   * @param {ModelEntry} entry
   * @returns {object} Pi SDK ModelEntry 格式
   */
  toSdkEntry(entry) {
    // 始终构建完整的 SDK shape，不走 _sdkEntry 捷径
    // 因为 _sdkEntry 可能是 models.json 的原始 model 对象，缺少 provider/baseUrl/api
    return {
      id: entry.modelId,
      name: entry.displayName,
      provider: entry.providerId,
      baseUrl: entry.baseUrl,
      api: entry.api,
      input: entry.input || ["text"],
      contextWindow: entry.contextWindow || 128_000,
      maxTokens: entry.maxTokens,
      reasoning: entry.reasoning || false,
    };
  }
}
