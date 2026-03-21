/**
 * AuthStore — per-provider 凭证存储
 *
 * 职责：
 *   - 统一管理所有 provider 的凭证（API key / OAuth token）
 *   - 按 providerId 索引，无自动 fallback
 *   - 不负责 OAuth 登录流程（由 Pi SDK AuthStorage 负责）
 *   - 读凭证时调用方必须明确指定 providerId
 *
 * 凭证优先级（加载时）：
 *   1. providers.yaml（api_key / base_url 覆盖）
 *   2. auth.json（OAuth token / Pi SDK 格式 API key）
 *   3. per-agent config.yaml providers 块（向后兼容，传入时用）
 *
 * 设计来源：Cherry Studio 的 OAuth/API 分离方式 + 去掉自动 fallback
 */

import fs from "fs";
import path from "path";
import YAML from "js-yaml";

// ── helpers ───────────────────────────────────────────────────────────────────

function isLocalBaseUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(String(url || ""));
}

/** 从 auth.json entry 提取 API key（兼容多种格式） */
function extractApiKey(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  if (typeof entry?.apiKey === "string") return entry.apiKey;
  if (typeof entry?.access === "string") return entry.access;
  if (typeof entry?.token === "string") return entry.token;
  return "";
}

/** 从 auth.json entry 解析 OAuth 凭证 */
function extractOAuthCredentials(entry) {
  if (!entry || entry.type !== "oauth") return null;
  const api_key = entry.access || entry.apiKey || entry.token || "";
  const base_url = entry.resourceUrl || "";
  let api = "";
  if (base_url) {
    api = base_url.includes("/anthropic") ? "anthropic-messages" : "openai-completions";
  }
  return { api_key, base_url, api };
}

// ── AuthStore ─────────────────────────────────────────────────────────────────

export class AuthStore {
  /**
   * @param {string} hanakoHome
   * @param {import('./provider-registry.js').ProviderRegistry} providerRegistry
   */
  constructor(hanakoHome, providerRegistry) {
    this._hanakoHome = hanakoHome;
    this._registry = providerRegistry;
    /** @type {Map<string, { apiKey: string, baseUrl: string, api: string, source: string }>} */
    this._creds = new Map();
    /** @type {Map<string, string>} authJsonKey → providerId 反向索引 */
    this._authKeyToId = new Map();
  }

  /** 从 _hanakoHome 直接读 providers.yaml */
  _loadProvidersYaml() {
    const ymlPath = path.join(this._hanakoHome, "providers.yaml");
    try {
      const raw = YAML.load(fs.readFileSync(ymlPath, "utf-8")) || {};
      return raw.providers || {};
    } catch {
      return {};
    }
  }

  /** 从 _hanakoHome 直接读 auth.json */
  _loadAuthJson() {
    const jsonPath = path.join(this._hanakoHome, "auth.json");
    try {
      return JSON.parse(fs.readFileSync(jsonPath, "utf-8")) || {};
    } catch {
      return {};
    }
  }

  load() {
    this._creds.clear();
    this._authKeyToId.clear();
    const userProviders = this._loadProvidersYaml();
    const authJson = this._loadAuthJson();

    // 处理 providers.yaml 中的所有 provider
    for (const [id, p] of Object.entries(userProviders)) {
      if (!p.api_key && !p.base_url) continue;
      const providerEntry = this._registry.get(id);
      this._creds.set(id, {
        apiKey: p.api_key || "",
        baseUrl: p.base_url || providerEntry?.baseUrl || "",
        api: p.api || providerEntry?.api || "openai-completions",
        source: "providers-yaml",
      });
    }

    // 处理 auth.json 中的 OAuth provider
    const oauthProviderIds = this._registry.getOAuthProviderIds();
    for (const providerId of oauthProviderIds) {
      if (this._creds.has(providerId)) continue; // providers.yaml 已配置，不覆盖
      const authKey = this._registry.getAuthJsonKey(providerId);
      const providerEntry = this._registry.get(providerId);

      // 建立 authJsonKey → providerId 反向索引（如 minimax → minimax-oauth）
      if (authKey !== providerId) {
        this._authKeyToId.set(authKey, providerId);
      }

      const authEntry = authJson[authKey];

      // 尝试 OAuth 凭证
      const oauth = extractOAuthCredentials(authEntry);
      if (oauth?.api_key) {
        const cred = {
          apiKey: oauth.api_key,
          baseUrl: oauth.base_url || providerEntry?.baseUrl || "",
          api: oauth.api || providerEntry?.api || "openai-completions",
          source: "auth-json",
        };
        this._creds.set(providerId, cred);
        // 同时在 authJsonKey 下存一份别名，让 get("minimax") 也能命中
        if (authKey !== providerId && !this._creds.has(authKey)) {
          this._creds.set(authKey, cred);
        }
        continue;
      }

      // 退回到 API key 格式
      const apiKey = extractApiKey(authEntry);
      if (apiKey) {
        const cred = {
          apiKey,
          baseUrl: providerEntry?.baseUrl || "",
          api: providerEntry?.api || "openai-completions",
          source: "auth-json",
        };
        this._creds.set(providerId, cred);
        if (authKey !== providerId && !this._creds.has(authKey)) {
          this._creds.set(authKey, cred);
        }
      }
    }
  }

  /**
   * 获取指定 provider 的凭证
   * 不做自动 fallback——找不到就返回 null
   * @param {string} providerId
   * @param {object} [agentConfig] - per-agent config（向后兼容，可选）
   * @returns {{ apiKey: string, baseUrl: string, api: string }|null}
   */
  get(providerId, agentConfig) {
    // 先查内存（直接命中 providerId 或 authJsonKey 别名）
    if (this._creds.has(providerId)) {
      return this._creds.get(providerId);
    }

    // 反向查找：authJsonKey → providerId（如 "minimax" → "minimax-oauth"）
    const mappedId = this._authKeyToId.get(providerId);
    if (mappedId && this._creds.has(mappedId)) {
      return this._creds.get(mappedId);
    }

    // per-agent config 向后兼容（不存入内存，每次现查）
    if (agentConfig) {
      const provBlock = agentConfig.providers?.[providerId];
      if (provBlock?.api_key || provBlock?.base_url) {
        const providerEntry = this._registry.get(providerId);
        return {
          apiKey: provBlock.api_key || "",
          baseUrl: provBlock.base_url || providerEntry?.baseUrl || "",
          api: provBlock.api || providerEntry?.api || "openai-completions",
          source: "agent-config",
        };
      }
    }

    return null;
  }

  /**
   * 检查指定 provider 是否有完整可用的凭证
   * @param {string} providerId
   * @param {object} [agentConfig]
   * @returns {boolean}
   */
  has(providerId, agentConfig) {
    const cred = this.get(providerId, agentConfig);
    if (!cred) return false;
    if (!cred.baseUrl) return false;
    if (!cred.apiKey && !isLocalBaseUrl(cred.baseUrl)) return false;
    return true;
  }

  /**
   * 使内存缓存失效，下次调用 get() 前需重新 load()
   */
  invalidate() {
    this._creds.clear();
    this._authKeyToId.clear();
  }
}
