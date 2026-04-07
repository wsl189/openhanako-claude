/**
 * HanaEngine — Hanako 的核心引擎（Thin Facade）
 *
 * 持有所有 Manager，对外暴露统一 API。
 * 具体逻辑委托给：
 *   - AgentManager       — agent CRUD / init / switch
 *   - SessionCoordinator — session 生命周期 / listing
 *   - ConfigCoordinator  — 配置读写 / 模型 / utility
 *   - ChannelManager     — 频道 CRUD / 成员管理
 *   - BridgeSessionManager — 外部平台 session
 *   - ModelManager        — 模型注册 / 发现
 *   - PreferencesManager  — 全局偏好
 *   - SkillManager        — 技能注册 / 同步
 */
import fs from "fs";
import path from "path";
import {
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";

import { PreferencesManager } from "./preferences-manager.js";
import { ModelManager } from "./model-manager.js";
import { SkillManager } from "./skill-manager.js";
import { BridgeSessionManager } from "./bridge-session-manager.js";
import { AgentManager } from "./agent-manager.js";
import { SessionCoordinator } from "./session-coordinator.js";
import { ConfigCoordinator, SHARED_MODEL_KEYS } from "./config-coordinator.js";
import { ChannelManager } from "./channel-manager.js";
import {
  summarizeTitle as _summarizeTitle,
  translateSkillNames as _translateSkillNames,
  summarizeActivity as _summarizeActivity,
  summarizeActivityQuick as _summarizeActivityQuick,
} from "./llm-utils.js";
import { debugLog } from "../lib/debug-log.js";
import { createSandboxedTools } from "../lib/sandbox/index.js";
import { t } from "../server/i18n.js";

const REQUIRED_BUILTIN_TOOLS = ["read", "grep", "find", "ls"];
const OPTIONAL_BUILTIN_TOOLS = ["write", "edit", "bash"];
const ALL_BUILTIN_TOOL_NAMES = [...REQUIRED_BUILTIN_TOOLS, ...OPTIONAL_BUILTIN_TOOLS];
const PATH_RULE_ACCESS = new Set(["read_only", "read_write"]);

function uniqStrings(list = []) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const s = String(item || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export class HanaEngine {
  /**
   * @param {object} dirs
   * @param {string} dirs.hanakoHome
   * @param {string} dirs.productDir
   * @param {string} [dirs.agentId]
   */
  constructor({ hanakoHome, productDir, agentId }) {
    this.hanakoHome = hanakoHome;
    this.productDir = productDir;
    this.agentsDir = path.join(hanakoHome, "agents");
    this.userDir = path.join(hanakoHome, "user");
    this.channelsDir = path.join(hanakoHome, "channels");
    fs.mkdirSync(this.channelsDir, { recursive: true });

    // ── Core managers ──
    this._prefs = new PreferencesManager({ userDir: this.userDir, agentsDir: this.agentsDir });
    this._models = new ModelManager({ hanakoHome });

    // 确定启动时焦点 agent（优先：显式参数 > 上次使用 > 默认首个）
    const persistedAgentId = this._prefs.getLastAgentId?.() || "";
    const persistedConfigPath = persistedAgentId
      ? path.join(this.agentsDir, persistedAgentId, "config.yaml")
      : "";
    const hasPersistedAgent = !!(persistedConfigPath && fs.existsSync(persistedConfigPath));
    const startId = agentId || (hasPersistedAgent ? persistedAgentId : this._prefs.findFirstAgent());
    if (!startId) throw new Error(t("error.noAgentsFound"));

    // ── Channel Manager ──
    this._channels = new ChannelManager({
      channelsDir: this.channelsDir,
      agentsDir: this.agentsDir,
      userDir: this.userDir,
      getHub: () => this._hub,
    });

    // ── Agent Manager ──
    this._agentMgr = new AgentManager({
      agentsDir: this.agentsDir,
      productDir: this.productDir,
      userDir: this.userDir,
      channelsDir: this.channelsDir,
      getPrefs: () => this._prefs,
      getModels: () => this._models,
      getHub: () => this._hub,
      getSkills: () => this._skills,
      resolveUtilityConfig: () => this.resolveUtilityConfig(),
      getSharedModels: () => this._configCoord.getSharedModels(),
      getChannelManager: () => this._channels,
      getSessionCoordinator: () => this._sessionCoord,
      getEngine: () => this,
      getResourceLoader: () => this._resourceLoader,
    });

    // ── Session Coordinator ──
    this._sessionCoord = new SessionCoordinator({
      agentsDir: this.agentsDir,
      getAgent: () => this.agent,
      getActiveAgentId: () => this.currentAgentId,
      getModels: () => this._models,
      getResourceLoader: () => this._resourceLoader,
      getSkills: () => this._skills,
      buildTools: (cwd, ct, opts) => this.buildTools(cwd, ct, opts),
      emitEvent: (e, sp) => this._emitEvent(e, sp),
      getHomeCwd: () => this.homeCwd,
      agentIdFromSessionPath: (p) => this.agentIdFromSessionPath(p),
      switchAgentOnly: (id) => this._agentMgr.switchAgentOnly(id),
      getConfig: () => this.config,
      getPrefs: () => this._prefs,
      getAgents: () => this._agentMgr.agents,
      getActivityStore: (id) => this.getActivityStore(id),
      getAgentById: (id) => this._agentMgr.getAgent(id),
      listAgents: () => this.listAgents(),
    });

    // ── Config Coordinator ──
    this._configCoord = new ConfigCoordinator({
      hanakoHome,
      agentsDir: this.agentsDir,
      getAgent: () => this.agent,
      getAgents: () => this._agentMgr.agents,
      getModels: () => this._models,
      getPrefs: () => this._prefs,
      getSkills: () => this._skills,
      getSession: () => this._sessionCoord.session,
      getSessions: () => this._sessionCoord.sessions,
      getHub: () => this._hub,
      emitEvent: (e, sp) => this._emitEvent(e, sp),
      emitDevLog: (t, l) => this.emitDevLog(t, l),
      getCurrentModel: () => this.currentModel?.name,
      refreshCurrentSessionTools: () => this._sessionCoord.refreshCurrentSessionTools(),
    });

    // ── Bridge Session Manager ──
    this._bridge = new BridgeSessionManager({
      getAgent: () => this.agent,
      getAgentById: (id) => this._agentMgr.getAgent(id),
      getSkillsForAgent: (agent) => this._skills.getSkillsForAgent(agent),
      getModelManager: () => this._models,
      getResourceLoader: () => this._resourceLoader,
      getPreferences: () => this._readPreferences(),
      buildTools: (cwd, customTools, opts) => this.buildTools(cwd, customTools, opts),
      getHomeCwd: () => this.homeCwd,
      setSessionPendingImages: (sessionPath, images) => this.setSessionPendingImages(sessionPath, images),
      clearSessionPendingImages: (sessionPath) => this.clearSessionPendingImages(sessionPath),
    });

    // Pi SDK resources（init 时填充）
    this._resourceLoader = null;

    // 事件系统
    this._listeners = new Set();
    this._eventBus = null;

    // DevTools 日志
    this._devLogs = [];
    this._devLogsMax = 200;
    this._pendingImagesBySession = new Map();

    // 设置起始 agentId
    this._agentMgr.activeAgentId = startId;
  }

  // ════════════════════════════
  //  Agent 代理（→ AgentManager）
  // ════════════════════════════

  get agent() { return this._agentMgr.agent; }
  getAgent(agentId) { return this._agentMgr.getAgent(agentId); }
  get currentAgentId() { return this._agentMgr.activeAgentId; }
  get confirmStore() { return this._confirmStore; }

  // 向后兼容 getter
  get agentDir() { return this.agent?.agentDir || path.join(this.agentsDir, this.currentAgentId); }
  get baseDir() { return this.agentDir; }
  get activityDir() { return path.join(this.agentDir, "activity"); }
  get activityStore() { return this.getActivityStore(this.currentAgentId); }
  getActivityStore(agentId) { return this._agentMgr.getActivityStore(agentId); }

  get agents() { return this._agentMgr.agents; }
  listAgents() { return this._agentMgr.listAgents(); }
  invalidateAgentListCache() { this._agentMgr.invalidateAgentListCache(); }
  async createAgent(opts) { return this._agentMgr.createAgent(opts); }
  async switchAgent(agentId) { return this._agentMgr.switchAgent(agentId); }
  async deleteAgent(agentId) { return this._agentMgr.deleteAgent(agentId); }
  agentIdFromSessionPath(p) { return this._agentMgr.agentIdFromSessionPath(p); }
  async createSessionForAgent(agentId, cwd, mem) { return this._agentMgr.createSessionForAgent(agentId, cwd, mem); }

  // 向后兼容：agent 属性代理
  get agentName() { return this.agent.agentName; }
  set agentName(v) { this.agent.agentName = v; }
  get userName() { return this.getUserName() || this.agent?.userName || "User"; }
  set userName(v) { this.setUserName(v); }
  get configPath() { return this.agent.configPath; }
  get sessionDir() { return this.agent.sessionDir; }
  get factsDbPath() { return this.agent.factsDbPath; }
  get memoryMdPath() { return this.agent.memoryMdPath; }

  // ════════════════════════════
  //  Session 代理（→ SessionCoordinator）
  // ════════════════════════════

  get session() { return this._sessionCoord.session; }
  get messages() { return this._sessionCoord.session?.messages ?? []; }
  get isStreaming() { return this._sessionCoord.session?.isStreaming ?? false; }
  get currentSessionPath() { return this._sessionCoord.currentSessionPath; }
  get cwd() { return this._sessionCoord.session?.sessionManager?.getCwd?.() ?? process.cwd(); }
  get deskCwd() { return this._sessionCoord.session?.sessionManager?.getCwd?.() || this.homeCwd || null; }

  async createSession(mgr, cwd, mem) { return this._sessionCoord.createSession(mgr, cwd, mem); }
  async switchSession(p) { return this._sessionCoord.switchSession(p); }
  /** @deprecated Phase 2: 使用 promptSession(path, text, opts) */
  async prompt(text, opts) { return this._sessionCoord.prompt(text, opts); }
  /** @deprecated Phase 2: 使用 abortSession(path) */
  async abort() { return this._sessionCoord.abort(); }
  /** @deprecated Phase 2: 使用 steerSession(path, text) */
  steer(text) { return this._sessionCoord.steer(text); }

  // ── Path 感知 API（Phase 2） ──
  async promptSession(p, text, opts) { return this._sessionCoord.promptSession(p, text, opts); }
  steerSession(p, text) { return this._sessionCoord.steerSession(p, text); }
  async abortSession(p) { return this._sessionCoord.abortSession(p); }
  get focusSessionPath() { return this._sessionCoord.currentSessionPath; }
  getMessages(p) { return this._sessionCoord.getSessionByPath(p)?.messages ?? []; }

  async abortAllStreaming() { return this._sessionCoord.abortAllStreaming(); }
  isBridgeSessionStreaming(key) { return this._bridge?.isSessionStreaming(key) ?? false; }
  async abortBridgeSession(key) { return this._bridge?.abortSession(key) ?? false; }
  async resetBridgeSession(key, opts) { return this._bridge?.resetSession(key, opts) ?? false; }
  steerBridgeSession(key, text) { return this._bridge?.steerSession(key, text) ?? false; }
  async closeSession(p) { return this._sessionCoord.closeSession(p); }
  getSessionByPath(p) { return this._sessionCoord.getSessionByPath(p); }
  isSessionStreaming(p) { return this._sessionCoord.isSessionStreaming(p); }
  async abortSessionByPath(p) { return this._sessionCoord.abortSessionByPath(p); }
  async listSessions() { return this._sessionCoord.listSessions(); }
  async saveSessionTitle(p, t) { return this._sessionCoord.saveSessionTitle(p, t); }
  createSessionContext() { return this._sessionCoord.createSessionContext(); }
  promoteActivitySession(f) { return this._sessionCoord.promoteActivitySession(f); }
  async executeIsolated(prompt, opts) { return this._sessionCoord.executeIsolated(prompt, opts); }

  // ════════════════════════════
  //  Config 代理（→ ConfigCoordinator）
  // ════════════════════════════

  get config() { return this.agent.config; }
  get factStore() { return this.agent.factStore; }
  get currentModel() { return this._sessionCoord.session?.model ?? this._models.currentModel; }
  get availableModels() { return this._models.availableModels; }
  get memoryEnabled() { return this.agent.memoryEnabled; }
  get homeCwd() { return this._configCoord.getHomeFolder(this.currentAgentId) || null; }
  get authStorage() { return this._models.authStorage; }
  get modelRegistry() { return this._models.modelRegistry; }
  get providerRegistry() { return this._models.providerRegistry; }
  get preferences() { return this._prefs; }

  /** 刷新可用模型列表（含 OAuth 自定义模型注入） */
  async refreshModels() { return this._models.refreshAvailable(); }

  getHomeFolder(agentId = null) { return this._configCoord.getHomeFolder(agentId || this.currentAgentId); }
  setHomeFolder(f, agentId = null) { return this._configCoord.setHomeFolder(f, agentId || this.currentAgentId); }
  getSharedModels() { return this._configCoord.getSharedModels(); }
  setSharedModels(p) { return this._configCoord.setSharedModels(p); }
  getUtilityApi() { return this._configCoord.getUtilityApi(); }
  setUtilityApi(p) { return this._configCoord.setUtilityApi(p); }
  resolveUtilityConfig() { return this._configCoord.resolveUtilityConfig(); }
  resolveModelWithCredentials(modelRef, agentConfig) {
    return this._models.resolveModelWithCredentials(modelRef, agentConfig || this.agent?.config);
  }
  resolveProviderCredentials(provider, agentConfig) {
    return this._models.resolveProviderCredentials(provider, agentConfig || this.agent?.config);
  }
  readFavorites() { return this._configCoord.readFavorites(); }
  async saveFavorites(f) { return this._configCoord.saveFavorites(f); }
  readAgentOrder() { return this._configCoord.readAgentOrder(); }
  saveAgentOrder(o) { return this._configCoord.saveAgentOrder(o); }
  async syncModelsAndRefresh(f) { return this._configCoord.syncModelsAndRefresh(f); }
  async setModel(id) { return this._configCoord.setModel(id); }
  getThinkingLevel() { return this._configCoord.getThinkingLevel(); }
  setThinkingLevel(l) { return this._configCoord.setThinkingLevel(l); }
  getChannelMemoryEnabled() { return this._prefs.getChannelMemoryEnabled(); }
  setChannelMemoryEnabled(v) { return this._prefs.setChannelMemoryEnabled(v); }
  getUserName() { return this._configCoord.getUserName(); }
  setUserName(name) { return this._configCoord.setUserName(name); }
  getSandbox(agentId = null) {
    return this.getAgentPermissionConfig(agentId).sandbox.mode !== "full-access";
  }
  setSandbox(v, agentId = null) {
    const target = agentId ? this.getAgent(agentId) : this.agent;
    if (!target) return;
    const mode = v === false ? "full-access" : "standard";
    target.updateConfig({ sandbox: { ...(target.config?.sandbox || {}), mode } });
  }
  getLearnSkills() { return this._prefs.getLearnSkills(); }
  setLearnSkills(p) { this._prefs.setLearnSkills(p); }
  getLocale() { return this._prefs.getLocale(); }
  setLocale(l) { this._prefs.setLocale(l); }
  getTimezone() { return this._prefs.getTimezone(); }
  setTimezone(tz) { this._prefs.setTimezone(tz); }
  setMemoryEnabled(v) { return this._configCoord.setMemoryEnabled(v); }
  setMemoryMasterEnabled(id, v) { return this._configCoord.setMemoryMasterEnabled(id, v); }
  persistMemoryEnabled() { return this._configCoord.persistMemoryEnabled(); }
  async updateConfig(p) { return this._configCoord.updateConfig(p); }

  getPreferences() { return this._readPreferences(); }
  savePreferences(p) { return this._writePreferences(p); }

  setSessionPendingImages(sessionPath, images = []) {
    if (!sessionPath) return;
    const normalized = (Array.isArray(images) ? images : [])
      .map((img) => ({
        data: String(img?.data || ""),
        mimeType: String(img?.mimeType || "image/png"),
      }))
      .filter((img) => img.data);
    if (normalized.length === 0) {
      this._pendingImagesBySession.delete(sessionPath);
      return;
    }
    this._pendingImagesBySession.set(sessionPath, normalized);
  }

  getSessionPendingImages(sessionPath) {
    if (!sessionPath) return [];
    return this._pendingImagesBySession.get(sessionPath) || [];
  }

  getLatestSessionPendingImages() {
    if (!this._pendingImagesBySession.size) return [];
    const values = Array.from(this._pendingImagesBySession.values());
    return values[values.length - 1] || [];
  }

  clearSessionPendingImages(sessionPath) {
    if (!sessionPath) return;
    this._pendingImagesBySession.delete(sessionPath);
  }

  // ════════════════════════════
  //  Channel 代理（→ ChannelManager）
  // ════════════════════════════

  deleteChannelByName(n) { return this._channels.deleteChannelByName(n); }
  async triggerChannelTriage(n, o) { return this._channels.triggerChannelTriage(n, o); }

  // ════════════════════════════
  //  Bridge 代理（→ BridgeSessionManager）
  // ════════════════════════════

  getBridgeIndex(agentId = null) {
    const ag = agentId ? this.getAgent(agentId) : null;
    return this._bridge.readIndex(ag || undefined);
  }
  saveBridgeIndex(i, agentId = null) {
    const ag = agentId ? this.getAgent(agentId) : null;
    return this._bridge.writeIndex(i, ag || undefined);
  }
  async executeExternalMessage(p, sk, m, o) { return this._bridge.executeExternalMessage(p, sk, m, o); }
  injectBridgeMessage(sk, t) { return this._bridge.injectMessage(sk, t); }

  // ════════════════════════════
  //  Skills（→ SkillManager）
  // ════════════════════════════

  _syncAgentSkills() { this._skills.syncAgentSkills(this.agent); }
  _syncAllAgentSkills() { for (const ag of this._agentMgr.agents.values()) this._skills.syncAgentSkills(ag); }
  getAllSkills(agentId) {
    const ag = agentId ? this._agentMgr.getAgent(agentId) : null;
    return this._skills.getAllSkills(ag || null);
  }
  _getSkillsForAgent(ag) { return this._skills.getSkillsForAgent(ag); }
  get skillsDir() { return this._skills.skillsDir; }
  get userSkillsDir() { return this._skills.skillsDir; }
  get learnedSkillsDir() { return path.join(this.agent.agentDir, "learned-skills"); }
  get modelsJsonPath() { return this._models.modelsJsonPath; }
  get authJsonPath() { return this._models.authJsonPath; }

  async reloadSkills() {
    await this._skills.reload(this._resourceLoader, this._agentMgr.agents);
    this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
    this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);
    this._syncAllAgentSkills();
  }

  // ════════════════════════════
  //  Model 代理
  // ════════════════════════════

  _resolveThinkingLevel(l) { return this._models.resolveThinkingLevel(l); }
  _resolveExecutionModel(r) { return this._models.resolveExecutionModel(r); }
  _resolveProviderCredentials(p) { return this._models.resolveProviderCredentials(p, this.agent.config); }
  _inferModelProvider(id) { return this._models.inferModelProvider(id); }
  async refreshAvailableModels() { return this._models.refreshAvailable(); }

  static SHARED_MODEL_KEYS = SHARED_MODEL_KEYS;
  static REQUIRED_BUILTIN_TOOLS = REQUIRED_BUILTIN_TOOLS;
  static OPTIONAL_BUILTIN_TOOLS = OPTIONAL_BUILTIN_TOOLS;

  // ════════════════════════════
  //  生命周期
  // ════════════════════════════

  async init(log = () => {}) {
    const startupTimer = Date.now();

    // 0. Provider 迁移
    this._configCoord.migrateProvidersToGlobal(log);

    // 1. Pi SDK + ModelCatalog（必须在 agent init 之前，agent 需要解析记忆模型）
    log(`[init] 1/5 Pi SDK 初始化...`);
    this._models.init();
    this._models.setPreferences(this._prefs);
    await this._models.modelCatalog.build();
    log(`[init] 1/5 AuthStorage + ModelRegistry + Catalog 就绪`);

    // 2. 初始化所有 agent
    log(`[init] 2/5 初始化所有 agent...`);
    await this._agentMgr.initAllAgents(log, this._agentMgr.activeAgentId);
    const persistedUserName = this._prefs.getUserName?.() || "";
    if (!persistedUserName) {
      const fallbackUserName = String(this.agent?.config?.user?.name || "").trim();
      if (fallbackUserName) {
        this.setUserName(fallbackUserName);
      }
    }
    log(`[init] 2/5 ${this._agentMgr.agents.size} 个 agent 已就绪`);

    // 3. ResourceLoader + Skills
    log(`[init] 3/5 ResourceLoader 初始化...`);
    const t_rl = Date.now();
    const skillsDir = path.join(this.hanakoHome, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    this._skills = new SkillManager({ skillsDir, agentsDir: this.agentsDir });
    this._resourceLoader = new DefaultResourceLoader({
      systemPromptOverride: () => this.agent.systemPrompt,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: [skillsDir],
    });
    await this._resourceLoader.reload();

    const HIDDEN_SKILLS = new Set(["canvas-design", "skill-creator", "skills-translate-temp"]);
    this._skills.init(this._resourceLoader, this._agentMgr.agents, HIDDEN_SKILLS);
    log(`[init] 3/5 ResourceLoader 完成 (${Date.now() - t_rl}ms, ${this._skills.allSkills.length} skills)`);

    this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
    this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);

    // 4. 模型发现
    log(`[init] 4/5 发现可用模型...`);
    try { await this.syncModelsAndRefresh(); } catch {}
    await this._models.refreshAvailable();
    this._configCoord.normalizeUtilityApiPreferences(log);
    const availableModels = this._models.availableModels;
    log(`[init] 4/5 找到 ${availableModels.length} 个模型: ${availableModels.map(m => `${m.provider}/${m.id}`).join(", ")}`);
    if (availableModels.length === 0) {
      console.warn("[engine] ⚠ 未找到可用模型，请在设置中配置 API key");
      this._models.defaultModel = null;
    } else {
      const preferredId = this.agent.config.models?.chat;
      if (!preferredId) {
        console.warn("[engine] ⚠ 未配置 models.chat，defaultModel 为 null");
        this._models.defaultModel = null;
      } else {
        const model = availableModels.find(m => m.id === preferredId);
        if (!model) {
          console.error(`[engine] ⚠ 配置的模型 "${preferredId}" 不在可用列表中，defaultModel 为 null`);
          this._models.defaultModel = null;
        } else {
          this._models.defaultModel = model;
          log(`✿ 使用模型: ${model.name} (${model.provider})`);
        }
      }
    }

    // 5. 一次性迁移 favorites
    const prefs = this._readPreferences();
    if (!prefs.favorites) {
      const agentFavs = this.agent.config.models?.favorites;
      if (agentFavs?.length) {
        prefs.favorites = agentFavs;
        this._writePreferences(prefs);
        log(`✿ 已迁移 ${agentFavs.length} 个收藏模型到全局配置`);
      }
    }

    // 6. Sync skills + watch skillsDir
    this._syncAllAgentSkills();
    this._skills.watch(this._resourceLoader, this._agentMgr.agents, () => {
      this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
      this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);
      this._syncAllAgentSkills();
    });

    // 7. Bridge 孤儿清理
    try { this._bridge.reconcile(); } catch {}

    // 8. 沙盒日志（per-agent）
    const sandboxMode = this.getAgentPermissionConfig().sandbox.mode;
    log(`✿ 沙盒模式: ${sandboxMode}`);

    const totalTime = ((Date.now() - startupTimer) / 1000).toFixed(1);
    log(`✿ 初始化完成（${totalTime}s）`);
  }

  async dispose() {
    this._skills.unwatch();
    await this._agentMgr.disposeAll(this._sessionCoord.session);
    await this._sessionCoord.cleanupSession();
  }

  // ════════════════════════════
  //  工具构建
  // ════════════════════════════

  _resolveAgentForToolBuild(opts = {}) {
    if (opts.agentId) {
      const ag = this.getAgent(opts.agentId);
      if (ag) return ag;
    }
    if (opts.agentDir) {
      const matched = [...this.agents.values()].find(ag => ag?.agentDir === opts.agentDir);
      if (matched) return matched;
    }
    return this.agent;
  }

  _legacySandboxMode() {
    return this._readPreferences().sandbox === false ? "full-access" : "standard";
  }

  _normalizePathRules(rawRules) {
    if (!Array.isArray(rawRules)) return [];
    const out = [];
    for (const item of rawRules) {
      const p = String(item?.path || "").trim();
      const access = String(item?.access || "").trim();
      if (!p || !path.isAbsolute(p)) continue;
      if (!PATH_RULE_ACCESS.has(access)) continue;
      out.push({ path: p, access });
    }
    return out;
  }

  getToolCatalog(agentId = null) {
    const ag = agentId ? this.getAgent(agentId) : this.agent;
    const customNames = uniqStrings(
      (ag?.getAllCustomTools?.() || [])
        .map(t => t?.name)
        .filter(Boolean),
    );
    return {
      builtin_required: [...REQUIRED_BUILTIN_TOOLS],
      builtin_optional: [...OPTIONAL_BUILTIN_TOOLS],
      custom: customNames,
    };
  }

  getAgentPermissionConfig(agentId = null) {
    const ag = agentId ? this.getAgent(agentId) : this.agent;
    const catalog = this.getToolCatalog(agentId);
    const legacyMode = this._legacySandboxMode();
    const configuredMode = ag?.config?.sandbox?.mode;
    const mode = configuredMode === "full-access" || configuredMode === "standard" || configuredMode === "balanced"
      ? configuredMode
      : legacyMode;
    const pathRules = this._normalizePathRules(ag?.config?.sandbox?.path_rules);

    const hasBuiltinConfig = Array.isArray(ag?.config?.tools?.builtin_enabled);
    const configuredBuiltin = uniqStrings(ag?.config?.tools?.builtin_enabled || []);
    const builtin_enabled = hasBuiltinConfig
      ? uniqStrings([...configuredBuiltin, ...REQUIRED_BUILTIN_TOOLS])
          .filter(n => ALL_BUILTIN_TOOL_NAMES.includes(n))
      : uniqStrings([...REQUIRED_BUILTIN_TOOLS, ...OPTIONAL_BUILTIN_TOOLS]);

    const hasCustomConfig = Array.isArray(ag?.config?.tools?.custom_enabled);
    const configuredCustom = uniqStrings(ag?.config?.tools?.custom_enabled || []);
    const custom_enabled = hasCustomConfig
      ? configuredCustom.filter(n => catalog.custom.includes(n))
      : [...catalog.custom];

    return {
      sandbox: { mode, path_rules: pathRules },
      tools: { builtin_enabled, custom_enabled },
      tool_catalog: catalog,
    };
  }

  buildTools(cwd, customTools, opts = {}) {
    const targetAgent = this._resolveAgentForToolBuild(opts);
    const ct = customTools || targetAgent.tools;
    const effectiveAgentDir = opts.agentDir || targetAgent.agentDir;
    const effectiveWorkspace = opts.workspace !== undefined
      ? opts.workspace
      : this._configCoord.getHomeFolder(path.basename(effectiveAgentDir));
    const profile = this.getAgentPermissionConfig(path.basename(effectiveAgentDir));
    const effectiveMode = opts.mode || profile.sandbox.mode;

    const built = createSandboxedTools(cwd, ct, {
      agentDir: effectiveAgentDir,
      workspace: effectiveWorkspace,
      hanakoHome: this.hanakoHome,
      mode: effectiveMode,
      pathRules: profile.sandbox.path_rules,
    });

    const requiredSet = new Set(REQUIRED_BUILTIN_TOOLS);
    const builtinSet = new Set(profile.tools.builtin_enabled);
    const customSet = new Set(profile.tools.custom_enabled);

    return {
      tools: built.tools.filter(t => requiredSet.has(t.name) || builtinSet.has(t.name)),
      customTools: built.customTools.filter(t => customSet.has(t.name)),
    };
  }

  // ════════════════════════════
  //  事件系统
  // ════════════════════════════

  setEventBus(bus) {
    for (const fn of this._listeners) bus.subscribe(fn);
    this._listeners.clear();
    this._eventBus = bus;
  }

  subscribe(listener) {
    if (this._eventBus) return this._eventBus.subscribe(listener);
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emitEvent(event, sessionPath) {
    if (this._eventBus) {
      this._eventBus.emit(event, sessionPath);
    } else {
      for (const fn of this._listeners) {
        try { fn(event, sessionPath); } catch {}
      }
    }
  }

  emitDevLog(text, level = "info") {
    const entry = { text, level, ts: Date.now() };
    this._devLogs.push(entry);
    if (this._devLogs.length > this._devLogsMax) {
      this._devLogs.shift();
    }
    const dl = debugLog();
    if (dl) {
      if (level === "error") dl.error("engine", text);
      else dl.log("engine", text);
    }
    this._emitEvent({ type: "devlog", text, level }, null);
  }

  getDevLogs() {
    return this._devLogs;
  }

  // ════════════════════════════
  //  日记 / 工具调用
  // ════════════════════════════

  async writeDiary() {
    const currentPath = this.currentSessionPath;
    if (currentPath && this.agent.memoryTicker) {
      await this.agent.memoryTicker.flushSession(currentPath);
    }
    const { writeDiary } = await import("../lib/diary/diary-writer.js");
    const diaryModelId = this.agent.config.models?.chat || this.agent.memoryModel;
    const resolvedModel = this._models.resolveModelWithCredentials(diaryModelId, this.agent.config);
    return writeDiary({
      summaryManager: this.agent.summaryManager,
      resolvedModel,
      agentPersonality: this.agent.personality,
      memory: (() => {
        try { return fs.readFileSync(this.agent.memoryMdPath, "utf-8"); } catch { return ""; }
      })(),
      userName: this.agent.userName,
      agentName: this.agent.agentName,
      cwd: this.homeCwd || process.cwd(),
      currentSessionPath: currentPath || null,
      activityStore: this.activityStore,
    });
  }

  async summarizeTitle(ut, at) {
    let utilConfig;
    try {
      utilConfig = this.resolveUtilityConfig();
    } catch {
      try {
        const shared = this.getSharedModels?.() || {};
        const utilityRef = shared.utility || this.config?.models?.utility;
        if (!utilityRef) return null;
        const resolved = this.resolveModelWithCredentials(utilityRef, this.agent?.config);
        utilConfig = {
          utility: resolved.model,
          api_key: resolved.api_key,
          base_url: resolved.base_url,
          api: resolved.api,
        };
      } catch {
        return null;
      }
    }
    return _summarizeTitle(utilConfig, ut, at);
  }

  async translateSkillNames(names, lang) {
    return _translateSkillNames(this.resolveUtilityConfig(), names, lang);
  }

  async summarizeActivity(sp) {
    return _summarizeActivity(this.resolveUtilityConfig(), sp, (msg) => this.emitDevLog(msg));
  }

  async summarizeActivityQuick(activityId) {
    let entry = null, foundAgentId = null;
    for (const [agId] of this._agentMgr.agents) {
      const store = this.getActivityStore(agId);
      const e = store?.get(activityId);
      if (e) { entry = e; foundAgentId = agId; break; }
    }
    if (!entry?.sessionFile) return null;
    const sessionPath = path.join(this.agentsDir, foundAgentId, "activity", entry.sessionFile);
    return _summarizeActivityQuick(this.resolveUtilityConfig(), sessionPath);
  }

  // ════════════════════════════
  //  Desk 辅助
  // ════════════════════════════

  listDeskFiles() {
    try {
      const dir = this.homeCwd;
      if (!dir || !fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith("."))
        .map(e => {
          const fp = path.join(dir, e.name);
          let mtime = 0;
          try { mtime = fs.statSync(fp).mtimeMs; } catch {}
          return { name: e.name, isDir: e.isDirectory(), mtime };
        });
    } catch {
      return [];
    }
  }

  // ════════════════════════════
  //  Preferences 代理
  // ════════════════════════════

  _readPreferences() { return this._prefs.getPreferences(); }
  _writePreferences(prefs) { return this._prefs.savePreferences(prefs); }

  // ════════════════════════════
  //  巡检工具白名单（向后兼容静态引用）
  // ════════════════════════════

  static PATROL_TOOLS_DEFAULT = [
    "search_memory", "pin_memory", "unpin_memory",
    "recall_experience", "record_experience",
    "web_fetch",
    "todo", "cron", "notify",
    "present_files", "message_agent", "channel",
  ];
}
