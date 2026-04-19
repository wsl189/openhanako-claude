/**
 * ConfigCoordinator — 运行时配置管理
 *
 * 从 Engine 提取，负责模型/utility 配置读写、
 * updateConfig 联动、Plan Mode、记忆开关、Provider 迁移。
 * 不持有 engine 引用，通过构造器注入依赖。
 */
import fs from "fs";
import path from "path";
import os from "os";
import YAML from "js-yaml";
import { createModuleLogger } from "../lib/debug-log.js";
import {
  clearConfigCache,
  loadGlobalProviders,
  loadModelsRegistry,
  resolveApiKeyFromAuth,
} from "../lib/memory/config-loader.js";
import { t } from "../server/i18n.js";
import { applyRuntimeModelOverrides } from "./model-runtime-overrides.js";

const log = createModuleLogger("config");

/** 只读内建工具白名单（delegate 等场景） */
export const READ_ONLY_BUILTIN_TOOLS = ["read", "grep", "find", "ls"];

/** 全局共享模型字段 → preferences key 映射 */
export const SHARED_MODEL_KEYS = [
  ["utility",        "utility_model"],
  ["utility_large",  "utility_large_model"],
  ["image_understanding", "image_understanding_model"],
  ["summarizer",     "summarizer_model"],
  ["compiler",       "compiler_model"],
];

function normalizeFavoriteRef(raw) {
  if (typeof raw === "string") return raw.trim();
  if (!raw || typeof raw !== "object") return "";

  const rawId = raw.id ?? raw.modelId ?? raw.model ?? raw.name ?? "";
  const rawProvider = raw.provider ?? raw.providerId ?? raw.vendor ?? "";
  const id = String(rawId || "").trim();
  const provider = String(rawProvider || "").trim();
  if (!id) return "";

  return provider && !id.includes("/") ? `${provider}/${id}` : id;
}

function normalizeFavoriteRefs(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const ref = normalizeFavoriteRef(value);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

export class ConfigCoordinator {
  /**
   * @param {object} deps
   * @param {string} deps.hanakoHome
   * @param {string} deps.agentsDir
   * @param {() => object} deps.getAgent - 当前焦点 agent
   * @param {() => Map} deps.getAgents - 所有 agent Map
   * @param {() => import('./model-manager.js').ModelManager} deps.getModels
   * @param {() => import('./preferences-manager.js').PreferencesManager} deps.getPrefs
   * @param {() => import('./skill-manager.js').SkillManager} deps.getSkills
   * @param {() => object|null} deps.getSession - 当前 session
   * @param {() => Map|null} [deps.getSessions] - 已缓存 session Map
   * @param {() => object|null} deps.getHub
   * @param {(event, sp) => void} deps.emitEvent
   * @param {(text, level?) => void} deps.emitDevLog
   * @param {() => string|null} deps.getCurrentModel - currentModel name
   * @param {() => Promise<{ reloaded: boolean, reason?: string, sessionPath?: string }>} [deps.refreshCurrentSessionTools]
   */
  constructor(deps) {
    this._d = deps;
  }

  // ── Home Folder ──

  getHomeFolder(agentId = null) {
    const agent = agentId
      ? this._d.getAgents?.()?.get?.(agentId)
      : this._d.getAgent?.();
    const configured = agent?.config?.desk?.home_folder;
    if (configured && fs.existsSync(configured)) return configured;

    // 兼容历史全局配置（将逐步迁移到 per-agent）
    const legacy = this._prefs().home_folder;
    if (legacy && fs.existsSync(legacy)) return legacy;

    // 配置的文件夹已被删除 → fallback 到桌面
    return path.join(os.homedir(), "Desktop");
  }

  setHomeFolder(folder, agentId = null) {
    const normalized = String(folder || "").trim();
    const targetAgent = agentId
      ? this._d.getAgents?.()?.get?.(agentId)
      : this._d.getAgent?.();

    if (targetAgent?.updateConfig) {
      targetAgent.updateConfig({ desk: { home_folder: normalized } });
      log.log(`setHomeFolder(${targetAgent.agentName || targetAgent.agentId || "active"}): ${normalized || "(cleared)"}`);
      return;
    }

    // fallback：直接写对应 agent config（通常不会走到这里）
    const targetId = agentId || path.basename(this._d.getAgent?.()?.agentDir || "");
    if (!targetId) return;
    const configPath = path.join(this._d.agentsDir, targetId, "config.yaml");
    try {
      const raw = YAML.load(fs.readFileSync(configPath, "utf-8")) || {};
      raw.desk = raw.desk || {};
      raw.desk.home_folder = normalized;
      fs.writeFileSync(configPath, YAML.dump(raw, { lineWidth: 120 }), "utf-8");
      log.log(`setHomeFolder(${targetId}) [fallback]: ${normalized || "(cleared)"}`);
    } catch (err) {
      log.warn(`setHomeFolder(${targetId}) fallback failed: ${err.message}`);
    }
  }

  // ── Shared Models ──

  getSharedModels() {
    const prefs = this._prefs();
    const result = {};
    for (const [field, prefKey] of SHARED_MODEL_KEYS) {
      result[field] = prefs[prefKey] || null;
    }
    if (result.utility) {
      result.utility_large = result.utility;
    }
    return result;
  }

  setSharedModels(partial) {
    const normalized = { ...partial };
    if (normalized.utility !== undefined && normalized.utility_large === undefined) {
      normalized.utility_large = normalized.utility;
    }
    if (normalized.utility_large !== undefined && normalized.utility === undefined) {
      normalized.utility = normalized.utility_large;
    }

    const prefs = this._prefs();
    const changed = [];
    for (const [field, prefKey] of SHARED_MODEL_KEYS) {
      if (normalized[field] !== undefined) {
        if (normalized[field] !== null && normalized[field] !== "") prefs[prefKey] = normalized[field];
        else delete prefs[prefKey];
        changed.push(`${field}=${normalized[field] || "(cleared)"}`);
      }
    }
    this._savePrefs(prefs);
    if (changed.length) {
      const fresh = this.getSharedModels();
      const agent = this._d.getAgent();
      agent._utilityModel = fresh.utility || null;
      agent._memoryModel = fresh.utility_large || fresh.utility || null;
      log.log(`setSharedModels: ${changed.join(", ")}`);
    }
  }

  // ── Utility API ──

  getUtilityApi() {
    const prefs = this._prefs();
    return {
      provider: prefs.utility_api_provider || null,
      base_url: prefs.utility_api_base_url || null,
      api_key: prefs.utility_api_key || null,
    };
  }

  setUtilityApi(partial) {
    const prefs = this._prefs();
    for (const [key, prefKey] of [
      ["provider", "utility_api_provider"],
      ["base_url", "utility_api_base_url"],
      ["api_key", "utility_api_key"],
    ]) {
      if (partial[key] !== undefined) {
        if (partial[key]) prefs[prefKey] = partial[key];
        else delete prefs[prefKey];
      }
    }
    this._savePrefs(prefs);
    log.log(`setUtilityApi: provider=${partial.provider || "-"}, base_url=${partial.base_url || "-"}`);
  }

  resolveUtilityConfig() {
    const models = this._d.getModels();
    return models.resolveUtilityConfig(
      this._d.getAgent().config,
      this.getSharedModels(),
      this.getUtilityApi(),
    );
  }

  // ── Favorites ──

  readFavorites() {
    const prefs = this._prefs();
    const normalized = normalizeFavoriteRefs(prefs.favorites);
    const prev = Array.isArray(prefs.favorites) ? prefs.favorites : [];
    const changed = prev.length !== normalized.length
      || prev.some((value, index) => normalizeFavoriteRef(value) !== normalized[index]);
    if (changed) {
      prefs.favorites = normalized;
      this._savePrefs(prefs);
      log.log(`readFavorites: migrated legacy favorites (${prev.length} -> ${normalized.length})`);
    }
    return normalized;
  }

  async saveFavorites(favorites) {
    const normalized = normalizeFavoriteRefs(favorites);
    const prefs = this._prefs();
    prefs.favorites = normalized;
    this._savePrefs(prefs);
    log.log(`saveFavorites: ${normalized.length} items`);

    try {
      await this.syncModelsAndRefresh(normalized);
    } catch (err) {
      console.error("[config] favorites sync failed:", err.message);
    }
  }

  // ── Agent Order ──

  readAgentOrder() {
    return this._prefs().agentOrder || [];
  }

  saveAgentOrder(order) {
    const prefs = this._prefs();
    prefs.agentOrder = order;
    this._savePrefs(prefs);
  }

  // ── Model / Thinking ──

  async syncModelsAndRefresh(favorites) {
    const models = this._d.getModels();
    const agent = this._d.getAgent();
    const synced = await models.syncModelsAndRefresh(agent.configPath, {
      favorites: favorites || this.readFavorites(),
      sharedModels: this.getSharedModels(),
    });
    // provider / favorites 刷新后，回填 agent 配置里的 chat 模型到运行时
    // 避免首次配置时出现“模型已写入 config，但当前会话仍持有旧/空模型对象”。
    const chatModelId = agent?.config?.models?.chat;
    if (chatModelId) {
      const chatModel = models.availableModels.find(m => m.id === chatModelId);
      if (chatModel) {
        models.defaultModel = chatModel;
        models.currentModel = chatModel;
        const session = this._d.getSession();
        if (session) {
          await session.setModel(
            applyRuntimeModelOverrides(chatModel, agent?.config?.models?.overrides),
          );
          session.setThinkingLevel(models.resolveThinkingLevel(this.getThinkingLevel()));
        }
      }
    }
    this.normalizeUtilityApiPreferences();
    return synced;
  }

  async setModel(modelId) {
    const models = this._d.getModels();
    const model = models.setModel(modelId);
    const session = this._d.getSession();
    if (session) {
      if (session.isStreaming || session.isCompacting) {
        throw new Error(t("error.modelSwitchBusy"));
      }
      const currentSessionModelId = String(
        (typeof session.model === "string" ? session.model : session.model?.id) || "",
      ).trim();
      if (currentSessionModelId === String(model.id || "").trim()) {
        return;
      }
      await session.setModel(
        applyRuntimeModelOverrides(model, this._d.getAgent?.()?.config?.models?.overrides),
      );
      if (typeof this._d.refreshCurrentSessionTools === "function") {
        try {
          await this._d.refreshCurrentSessionTools();
        } catch (err) {
          log.warn(`refresh current session tools after model switch failed: ${err.message}`);
        }
      }
    }
  }

  setThinkingLevel(level) {
    // 持久化到全局 preference（跨 session 常驻）
    this._d.getPrefs().setThinkingLevel(level);
    const session = this._d.getSession();
    if (session) {
      session.setThinkingLevel(this._d.getModels().resolveThinkingLevel(level));
    }
  }

  /** 从 preference 读取用户设定的 thinking level */
  getThinkingLevel() {
    return this._d.getPrefs().getThinkingLevel();
  }

  // ── Global User Name ──

  getUserName() {
    const prefsName = this._d.getPrefs().getUserName?.() || "";
    if (prefsName) return prefsName;
    const agentName = this._d.getAgent?.()?.config?.user?.name || "";
    return String(agentName || "").trim();
  }

  setUserName(name) {
    const normalized = String(name || "").trim();
    this._d.getPrefs().setUserName?.(normalized);

    const activeAgent = this._d.getAgent?.();
    const isZh = String(activeAgent?.config?.locale || this._d.getPrefs().getLocale?.() || "").startsWith("zh");
    const effectiveName = normalized || (isZh ? "用户" : "User");

    const agents = this._d.getAgents?.();
    if (agents?.values) {
      for (const ag of agents.values()) {
        if (!ag) continue;
        ag.userName = effectiveName;
        ag.refreshSystemPrompt?.();
      }
    }

    // AgentSession 会缓存 _baseSystemPrompt；需显式重建避免旧用户名残留。
    const refreshed = new Set();
    const sessions = this._d.getSessions?.();
    if (sessions?.values) {
      for (const entry of sessions.values()) {
        const session = entry?.session;
        if (!session?.setActiveToolsByName || !session?.getActiveToolNames) continue;
        if (refreshed.has(session)) continue;
        try {
          session.setActiveToolsByName(session.getActiveToolNames());
          refreshed.add(session);
        } catch (err) {
          log.warn(`refresh session prompt after user name update failed: ${err.message}`);
        }
      }
    }
  }

  // ── Memory ──

  setMemoryEnabled(val) {
    this._d.getAgent().setMemoryEnabled(val);
    this.persistMemoryEnabled();
  }

  setMemoryMasterEnabled(agentId, val) {
    const ag = this._d.getAgents().get(agentId);
    if (ag) ag.setMemoryMasterEnabled(val);
  }

  persistMemoryEnabled() {
    const session = this._d.getSession();
    const sessPath = session?.sessionManager?.getSessionFile?.();
    if (!sessPath) return;
    const agent = this._d.getAgent();
    const metaPath = path.join(agent.sessionDir, "session-meta.json");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch {}
        const sessKey = path.basename(sessPath);
        meta[sessKey] = { ...(meta[sessKey] || {}), memoryEnabled: agent.sessionMemoryEnabled };
        fs.writeFileSync(metaPath + ".tmp", JSON.stringify(meta, null, 2) + "\n");
        fs.renameSync(metaPath + ".tmp", metaPath);
        return;
      } catch (err) {
        if (attempt === 0) continue;
        console.error("[config] persistMemoryEnabled failed:", err.message);
      }
    }
  }

  // ── updateConfig ──

  async updateConfig(partial) {
    const keys = Object.keys(partial);
    if (keys.length) log.log(`updateConfig: keys=[${keys.join(",")}]`);
    const deskHomeFolderChanged =
      partial?.desk !== undefined
      && partial.desk !== null
      && typeof partial.desk === "object"
      && Object.prototype.hasOwnProperty.call(partial.desk, "home_folder");
    const chatModelChanged =
      partial?.models !== undefined
      && partial.models !== null
      && typeof partial.models === "object"
      && Object.prototype.hasOwnProperty.call(partial.models, "chat");
    const shouldRefreshSessionTools =
      partial.sandbox !== undefined
      || partial.tools !== undefined
      || deskHomeFolderChanged
      || chatModelChanged;

    const agent = this._d.getAgent();
    const models = this._d.getModels();

    // agent 负责：写磁盘、刷新身份、刷新模块、重建 prompt
    agent.updateConfig(partial);

    // 切换聊天模型：不需要 sync，模型早已注册
    if (partial.models?.chat) {
      const newModel = models.availableModels.find(m => m.id === partial.models.chat);
      if (newModel) {
        models.defaultModel = newModel;
        models.currentModel = newModel;
        log.log(`default model switched to: ${newModel.name || newModel.id}`);
        const session = this._d.getSession();
        if (session) {
          await session.setModel(
            applyRuntimeModelOverrides(newModel, agent?.config?.models?.overrides),
          );
          session.setThinkingLevel(
            models.resolveThinkingLevel(this.getThinkingLevel())
          );
        }
      }
    }

    if (partial.skills) {
      this._d.getSkills().syncAgentSkills(agent);
      // AgentSession 内部会缓存 _baseSystemPrompt。仅更新 agent.systemPrompt 不足以让
      // 会话立即生效，需要显式触发重建。
      const refreshed = new Set();
      const refreshPrompt = (session, reason = "skills update") => {
        if (!session?.setActiveToolsByName || !session?.getActiveToolNames) return;
        if (refreshed.has(session)) return;
        try {
          session.setActiveToolsByName(session.getActiveToolNames());
          refreshed.add(session);
        } catch (err) {
          log.warn(`refresh session prompt after ${reason} failed: ${err.message}`);
        }
      };

      // 先刷新当前焦点会话
      const session = this._d.getSession?.();
      refreshPrompt(session);

      // 再刷新当前 agent 的其余缓存会话，避免跨会话发送时读到旧 prompt
      const activeAgentId = path.basename(agent.agentDir || "");
      const sessions = this._d.getSessions?.();
      if (sessions?.values) {
        for (const entry of sessions.values()) {
          if (entry?.agentId !== activeAgentId) continue;
          refreshPrompt(entry.session, "skills update (cached session)");
        }
      }
    }

    if (shouldRefreshSessionTools && typeof this._d.refreshCurrentSessionTools === "function") {
      try {
        const refreshed = await this._d.refreshCurrentSessionTools();
        if (refreshed?.reloaded) {
          log.log(`current session tools refreshed: ${refreshed.sessionPath || "(unknown)"}`);
        } else if (refreshed?.reason && refreshed.reason !== "no-active-session") {
          const msg = `current session tools refresh skipped: ${refreshed.reason}`;
          if (refreshed.reason === "streaming") log.warn(msg);
          else log.log(msg);
        }
      } catch (err) {
        log.warn(`refresh current session tools failed: ${err.message}`);
      }
    }

    if (partial.desk) {
      const scheduler = this._d.getHub()?.scheduler;
      if ("heartbeat_interval" in partial.desk && scheduler) {
        // 间隔变更：需要完整重建 heartbeat（INTERVAL 在创建时固化）
        this._d.emitDevLog(`[heartbeat] 巡检间隔已更新: ${partial.desk.heartbeat_interval} 分钟`);
        await scheduler.reloadHeartbeat();
      } else if ("heartbeat_enabled" in partial.desk) {
        const hb = scheduler?.heartbeat;
        if (hb) {
          if (partial.desk.heartbeat_enabled === false) {
            this._d.emitDevLog("[heartbeat] 巡检已关闭");
            await hb.stop();
          } else {
            this._d.emitDevLog("[heartbeat] 巡检已开启");
            hb.start();
          }
        }
      }
    }
  }

  // ── Provider Migration ──

  migrateProvidersToGlobal(log = () => {}) {
    const YAML_LOAD = (p) => { try { return YAML.load(fs.readFileSync(p, "utf-8")) || {}; } catch { return {}; } };
    const agentsDir = this._d.agentsDir;
    const hanakoHome = this._d.hanakoHome;
    const registryMigrationMarker = path.join(hanakoHome, ".providers-registry-migrated");

    let entries;
    try {
      entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    } catch { return; }

    const agentsToMigrate = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const configPath = path.join(agentsDir, entry.name, "config.yaml");
      if (!fs.existsSync(configPath)) continue;
      const raw = YAML_LOAD(configPath);
      if (!raw.providers || Object.keys(raw.providers).length === 0) {
        const hasInlineApi = raw.api?.api_key && raw.api.api_key.length > 0;
        const hasInlineEmbed = raw.embedding_api?.api_key && raw.embedding_api.api_key.length > 0;
        const hasInlineUtil = raw.utility_api?.api_key && raw.utility_api.api_key.length > 0;
        if (!hasInlineApi && !hasInlineEmbed && !hasInlineUtil) continue;
      }
      agentsToMigrate.push({ id: entry.name, configPath, raw });
    }

    const globalData = loadGlobalProviders();
    const globalProviders = globalData.providers || {};
    let globalChanged = false;
    let registryBackfilled = false;

    const registry = loadModelsRegistry();
    for (const [name, data] of Object.entries(registry.providers || {})) {
      const provider = globalProviders[name] || (globalProviders[name] = {});
      const existingAuthKey = resolveApiKeyFromAuth(name);

      if (data?.baseUrl && !provider.base_url) {
        provider.base_url = data.baseUrl;
        globalChanged = true;
        registryBackfilled = true;
      }
      if (data?.api && !provider.api) {
        provider.api = data.api;
        globalChanged = true;
        registryBackfilled = true;
      }
      if (Array.isArray(data?.models) && data.models.length > 0) {
        const existing = new Set(provider.models || []);
        const before = existing.size;
        for (const model of data.models) {
          const id = typeof model === "string" ? model : model?.id;
          if (id) existing.add(id);
        }
        if (existing.size > before) {
          provider.models = [...existing];
          globalChanged = true;
          registryBackfilled = true;
        }
      }
      if (data?.apiKey && !provider.api_key && !existingAuthKey) {
        provider.api_key = data.apiKey;
        globalChanged = true;
        registryBackfilled = true;
      }
    }

    for (const { id, configPath, raw } of agentsToMigrate) {
      let configChanged = false;

      if (raw.providers) {
        for (const [name, data] of Object.entries(raw.providers)) {
          if (!globalProviders[name]) {
            globalProviders[name] = structuredClone(data);
            globalChanged = true;
          } else {
            if (data.api_key && !globalProviders[name].api_key) {
              globalProviders[name].api_key = data.api_key;
              globalChanged = true;
            }
            if (data.base_url && !globalProviders[name].base_url) {
              globalProviders[name].base_url = data.base_url;
              globalChanged = true;
            }
            if (data.models?.length) {
              const existing = new Set(globalProviders[name].models || []);
              const before = existing.size;
              for (const m of data.models) existing.add(m);
              if (existing.size > before) {
                globalProviders[name].models = [...existing];
                globalChanged = true;
              }
            }
          }
        }
        delete raw.providers;
        configChanged = true;
      }

      for (const block of [raw.api, raw.embedding_api, raw.utility_api]) {
        if (!block) continue;
        if (block.api_key) {
          const provName = typeof block.provider === "string" ? block.provider.trim() : "";
          if (!provName) {
            log.warn("skip inline API migration: missing explicit provider");
            continue;
          }
          if (!globalProviders[provName]) globalProviders[provName] = {};
          if (!globalProviders[provName].api_key) {
            globalProviders[provName].api_key = block.api_key;
            globalChanged = true;
          }
          if (block.base_url && !globalProviders[provName].base_url) {
            globalProviders[provName].base_url = block.base_url;
            globalChanged = true;
          }
          delete block.api_key;
          delete block.base_url;
          configChanged = true;
        }
      }

      if (configChanged) {
        const header = "# Hanako 系统配置\n# 由设置页面管理，手动编辑也可以\n\n";
        const yamlStr = header + YAML.dump(raw, {
          indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"", forceQuotes: false,
        });
        const tmpPath = configPath + ".tmp";
        fs.writeFileSync(tmpPath, yamlStr, "utf-8");
        fs.renameSync(tmpPath, configPath);
        log(`  [migration] ${id}: providers 块已移除，内联凭证已清空`);
      }
    }

    if (globalChanged) {
      const providersPath = path.join(hanakoHome, "providers.yaml");
      const header = "# Hanako 供应商配置（全局，跨 agent 共享）\n# 由设置页面管理\n\n";
      const yamlStr = header + YAML.dump({ providers: globalProviders }, {
        indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"", forceQuotes: false,
      });
      const tmpPath = providersPath + ".tmp";
      fs.writeFileSync(tmpPath, yamlStr, "utf-8");
      fs.renameSync(tmpPath, providersPath);
      log(`  [migration] 全局 providers.yaml 已创建/更新`);
    }

    if (!fs.existsSync(registryMigrationMarker)) {
      fs.writeFileSync(
        registryMigrationMarker,
        `${new Date().toISOString()}\n`,
        "utf-8",
      );
      if (registryBackfilled) {
        log("  [migration] models.json 中缺失的 provider 注册信息已补入 providers.yaml");
      }
    }

    clearConfigCache();
  }

  normalizeUtilityApiPreferences(logFn = null) {
    const prefs = this._prefs();
    const hasOverride =
      !!prefs.utility_api_provider ||
      !!prefs.utility_api_base_url ||
      !!prefs.utility_api_key;
    if (!hasOverride) return false;

    const shared = this.getSharedModels();
    const utilityModelId = shared.utility || this._d.getAgent()?.config?.models?.utility || "";
    const utilityEntry = utilityModelId
      ? this._d.getModels().availableModels.find((m) => m.id === utilityModelId)
      : null;

    let reason = "";
    if (!prefs.utility_api_provider || !prefs.utility_api_base_url || !prefs.utility_api_key) {
      reason = "override incomplete";
    } else if (!utilityEntry?.provider) {
      reason = "utility model unavailable";
    } else if (prefs.utility_api_provider !== utilityEntry.provider) {
      reason = `provider mismatch (${prefs.utility_api_provider} != ${utilityEntry.provider})`;
    }

    if (!reason) return false;

    delete prefs.utility_api_provider;
    delete prefs.utility_api_base_url;
    delete prefs.utility_api_key;
    this._savePrefs(prefs);
    const logger = logFn || log.log.bind(log);
    logger(`[config] cleared invalid utility_api override: ${reason}`);
    return true;
  }

  // ── helpers ──

  _prefs() { return this._d.getPrefs().getPreferences(); }
  _savePrefs(prefs) { return this._d.getPrefs().savePreferences(prefs); }
}
