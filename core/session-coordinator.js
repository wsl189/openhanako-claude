/**
 * SessionCoordinator — Session 生命周期管理
 *
 * 从 Engine 提取，负责 session 的创建/切换/关闭/列表、
 * isolated 执行、session 标题、activity session 提升。
 * 不持有 engine 引用，通过构造器注入依赖。
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { createModuleLogger } from "../lib/debug-log.js";
import { BrowserManager } from "../lib/browser/browser-manager.js";
import { sanitizeAssistantVisibleText } from "../lib/text/assistant-visible-text.js";
import { t, getLocale } from "../server/i18n.js";
import { buildCompactionSettings } from "./compaction-settings.js";
import { applyRuntimeModelOverrides } from "./model-runtime-overrides.js";

const log = createModuleLogger("session");

/** 巡检/定时任务默认工具白名单 */
export const PATROL_TOOLS_DEFAULT = [
  "search_memory", "pin_memory", "unpin_memory",
  "recall_experience", "record_experience",
  "web_fetch",
  "todo", "cron", "notify",
  "present_files", "message_agent", "channel",
];

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && block?.text)
    .map((block) => block.text)
    .join("");
}

function extractLastAssistantText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const lastAssistant = [...list].reverse().find((msg) => msg?.role === "assistant");
  return extractTextFromContent(lastAssistant?.content);
}

function getSteerPrefix() {
  const isZh = getLocale().startsWith("zh");
  return isZh ? "（插话）\n" : "(Interjection)\n";
}
const MAX_CACHED_SESSIONS = 20;

export class SessionCoordinator {
  /**
   * @param {object} deps
   * @param {string} deps.agentsDir
   * @param {() => object} deps.getAgent - 当前焦点 agent
   * @param {() => string} deps.getActiveAgentId
   * @param {() => import('./model-manager.js').ModelManager} deps.getModels
   * @param {() => object} deps.getResourceLoader
   * @param {() => import('./skill-manager.js').SkillManager} deps.getSkills
   * @param {(cwd, customTools?, opts?) => object} deps.buildTools
   * @param {(event, sp) => void} deps.emitEvent
   * @param {() => string|null} deps.getHomeCwd
   * @param {(path) => string|null} deps.agentIdFromSessionPath
   * @param {(id) => Promise} deps.switchAgentOnly - 仅切换 agent 指针
   * @param {() => object} deps.getConfig
   * @param {() => Map} deps.getAgents
   * @param {(agentId) => object} deps.getActivityStore
   * @param {(agentId) => object|null} deps.getAgentById
   * @param {() => object} deps.listAgents - 列出所有 agent
   */
  constructor(deps) {
    this._d = deps;
    this._session = null;
    this._sessionStarted = false;
    this._sessions = new Map();
    this._headlessRefCount = 0;
    this._titlesCache = new Map(); // sessionDir → { titles, ts }
  }

  static _TITLES_TTL = 60_000; // 60 秒

  get session() { return this._session; }
  get sessionStarted() { return this._sessionStarted; }
  get sessions() { return this._sessions; }

  get currentSessionPath() {
    return this._session?.sessionManager?.getSessionFile?.() ?? null;
  }

  /**
   * 在发起每轮对话前刷新一次 system prompt，并同步 AgentSession 的 _baseSystemPrompt 缓存。
   * 这样可确保诸如“当前时间”等动态信息在每轮都更新。
   */
  _refreshSessionPrompt(agent, session, reason = "prompt") {
    if (!agent || !session) return;
    agent.refreshSystemPrompt?.();
    if (session?.setActiveToolsByName && session?.getActiveToolNames) {
      try {
        session.setActiveToolsByName(session.getActiveToolNames());
      } catch (err) {
        log.warn(`${reason} prompt rebuild failed: ${err.message}`);
      }
    }
  }

  // ── Session 创建 / 切换 ──

  async createSession(sessionMgr, cwd, memoryEnabled = true) {
    const t0 = Date.now();
    const effectiveCwd = cwd || this._d.getHomeCwd() || process.cwd();
    const agent = this._d.getAgent();
    const models = this._d.getModels();
    log.log(`createSession cwd=${effectiveCwd} (传入: ${cwd || "未指定"})`);

    if (!models.currentModel) {
      throw new Error(t("error.noAvailableModel"));
    }

    if (!sessionMgr) {
      sessionMgr = SessionManager.create(effectiveCwd, agent.sessionDir);
    }

    // 必须在 createAgentSession 前切换 session 级记忆状态，
    // 否则首轮 prompt 会沿用上一个 session 的 system prompt。
    const creatingAgent = agent;
    creatingAgent.setMemoryEnabled(memoryEnabled);

    const { tools: sessionTools, customTools: sessionCustomTools } = this._d.buildTools(effectiveCwd, null, { workspace: this._d.getHomeCwd() });
    // pi-coding-agent 当前版本在 createAgentSession() 内会重建内置工具，
    // 仅使用 tools 的“名字”而忽略传入实例。把沙盒后的 builtin 同名注入 customTools，
    // 确保运行时真正执行的是我们包装后的工具实现。
    const sessionRuntimeTools = [...sessionCustomTools, ...sessionTools];
    const runtimeModel = this._applyRuntimeModelOverrides(models.currentModel);
    const { session } = await createAgentSession({
      cwd: effectiveCwd,
      sessionManager: sessionMgr,
      settingsManager: this._createSettings(runtimeModel),
      authStorage: models.authStorage,
      modelRegistry: models.modelRegistry,
      model: runtimeModel,
      thinkingLevel: models.resolveThinkingLevel(this._d.getPrefs().getThinkingLevel()),
      resourceLoader: this._d.getResourceLoader(),
      tools: sessionTools,
      customTools: sessionRuntimeTools,
    });
    const elapsed = Date.now() - t0;
    log.log(`session created (${elapsed}ms), model=${runtimeModel?.name || "?"}`);
    this._session = session;
    this._sessionStarted = false;
    // 会话切到新 cwd 后，立即重建 system prompt，避免 cwd 文案滞后。
    // 同时刷新会话缓存，确保动态信息（如当前时间）可生效。
    this._refreshSessionPrompt(creatingAgent, session, "createSession");

    // 事件转发
    const sessionPath = session.sessionManager?.getSessionFile?.();
    const unsub = session.subscribe((event) => {
      this._d.emitEvent(event, sessionPath);
    });

    // 存入 map（SessionEntry）
    const mapKey = sessionPath || `_anon_${Date.now()}`;
    const old = this._sessions.get(mapKey);
    if (old) old.unsub();
    this._sessions.set(mapKey, {
      session,
      agentId: this._d.getActiveAgentId(),
      memoryEnabled,
      lastTouchedAt: Date.now(),
      unsub,
    });

    // LRU 淘汰：按 lastTouchedAt 排序，跳过 streaming 和焦点 session
    if (this._sessions.size > MAX_CACHED_SESSIONS) {
      const candidates = [...this._sessions.entries()]
        .filter(([key, e]) => key !== mapKey && !e.session.isStreaming)
        .sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt);
      for (const [key, entry] of candidates) {
        entry.unsub();
        this._sessions.delete(key);
        if (this._sessions.size <= MAX_CACHED_SESSIONS) break;
      }
    }

    return session;
  }

  _readSessionMemoryEnabled(sessionPath, agent = this._d.getAgent()) {
    try {
      const metaPath = path.join(agent.sessionDir, "session-meta.json");
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const sessKey = path.basename(sessionPath);
      return meta[sessKey]?.memoryEnabled !== false;
    } catch (err) {
      if (err.code !== "ENOENT") {
        log.warn(`session-meta.json 读取失败: ${err.message}`);
      }
      return true;
    }
  }

  async refreshCurrentSessionTools() {
    const sessionPath = this.currentSessionPath;
    if (!sessionPath) return { reloaded: false, reason: "no-active-session" };

    const currentEntry = this._sessions.get(sessionPath);
    const currentSession = currentEntry?.session || this._session;
    if (!currentSession) return { reloaded: false, reason: "session-not-cached" };
    if (currentSession.isStreaming) return { reloaded: false, reason: "streaming" };

    const targetAgentId = this._d.agentIdFromSessionPath(sessionPath);
    if (targetAgentId && targetAgentId !== this._d.getActiveAgentId()) {
      await this._d.switchAgentOnly(targetAgentId);
      this._d.getSkills()?.syncAgentSkills?.(this._d.getAgent());
    }

    const agent = this._d.getAgentById(targetAgentId) || this._d.getAgent();
    const sessionMgr = SessionManager.open(sessionPath, agent.sessionDir);
    const cwd = sessionMgr.getCwd?.() || undefined;
    const memoryEnabled = this._readSessionMemoryEnabled(sessionPath, agent);
    const wasStarted = this._sessionStarted;

    await this.createSession(sessionMgr, cwd, memoryEnabled);
    this._sessionStarted = wasStarted;
    return { reloaded: true, sessionPath };
  }

  async switchSession(sessionPath) {
    const targetAgentId = this._d.agentIdFromSessionPath(sessionPath);
    if (targetAgentId && targetAgentId !== this._d.getActiveAgentId()) {
      // Phase 1: 跨 agent 切换只切指针，不清旧 session
      await this._d.switchAgentOnly(targetAgentId);
      this._d.getSkills()?.syncAgentSkills?.(this._d.getAgent());
    }

    // 从 session-meta.json 恢复记忆开关
    const memoryEnabled = this._readSessionMemoryEnabled(sessionPath, this._d.getAgent());

    // 如果已在 map 中，切指针
    const existing = this._sessions.get(sessionPath);
    if (existing) {
      if (this._session && this._session !== existing.session) {
        const oldSp = this._session.sessionManager?.getSessionFile?.();
        if (oldSp) {
          const oldEntry = this._sessions.get(oldSp);
          const oldAgent = oldEntry ? this._d.getAgentById(oldEntry.agentId) : this._d.getAgent();
          await oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch(() => {});
        }
      }
      this._session = existing.session;
      existing.lastTouchedAt = Date.now();
      const targetAgent = this._d.getAgentById(existing.agentId) || this._d.getAgent();
      targetAgent.setMemoryEnabled(memoryEnabled);
      // 命中缓存会话时也要刷新，确保 prompt 中 cwd 与动态时间等信息与当前会话一致
      this._refreshSessionPrompt(targetAgent, existing.session, "switchSession");
      return existing.session;
    }

    // 不在 map 中，先 flush 当前再新建
    if (this._session) {
      const oldSp = this._session.sessionManager?.getSessionFile?.();
      if (oldSp) {
        const oldEntry = this._sessions.get(oldSp);
        const oldAgent = oldEntry ? this._d.getAgentById(oldEntry.agentId) : this._d.getAgent();
        await oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch(() => {});
      }
    }
    const sessionMgr = SessionManager.open(sessionPath, this._d.getAgent().sessionDir);
    const cwd = sessionMgr.getCwd?.() || undefined;
    return this.createSession(sessionMgr, cwd, memoryEnabled);
  }

  async prompt(text, opts) {
    if (!this._session) throw new Error(t("error.noActiveSessionPrompt"));
    this._sessionStarted = true;
    const sp = this._session.sessionManager?.getSessionFile?.();
    let promptAgent = this._d.getAgent();
    if (sp) {
      const entry = this._sessions.get(sp);
      if (entry) entry.lastTouchedAt = Date.now();
      promptAgent = entry ? (this._d.getAgentById(entry.agentId) || promptAgent) : promptAgent;
    }
    this._refreshSessionPrompt(promptAgent, this._session, "prompt");
    const promptOpts = opts?.images?.length ? { images: opts.images } : undefined;
    await this._session.prompt(text, promptOpts);
    if (sp) {
      const entry = this._sessions.get(sp);
      const agent = entry ? this._d.getAgentById(entry.agentId) : this._d.getAgent();
      agent?._memoryTicker?.notifyTurn(sp);
    }
  }

  async abort() {
    if (this._session?.isStreaming) {
      await this._session.abort();
    }
  }

  steer(text) {
    if (!this._session?.isStreaming) return false;
    const sp = this._session.sessionManager?.getSessionFile?.();
    if (sp) {
      const entry = this._sessions.get(sp);
      if (entry) entry.lastTouchedAt = Date.now();
    }
    this._session.steer(getSteerPrefix() + text);
    return true;
  }

  // ── Path 感知 API（Phase 2） ──

  async promptSession(sessionPath, text, opts) {
    const entry = this._sessions.get(sessionPath);
    if (!entry) throw new Error(t("error.sessionNotInCache", { path: sessionPath }));
    entry.lastTouchedAt = Date.now();
    if (sessionPath === this.currentSessionPath) this._sessionStarted = true;
    const promptAgent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
    this._refreshSessionPrompt(promptAgent, entry.session, "promptSession");
    const promptOpts = opts?.images?.length ? { images: opts.images } : undefined;
    await entry.session.prompt(text, promptOpts);
    promptAgent?._memoryTicker?.notifyTurn(sessionPath);
  }

  steerSession(sessionPath, text) {
    const entry = this._sessions.get(sessionPath);
    if (!entry?.session.isStreaming) return false;
    entry.lastTouchedAt = Date.now();
    entry.session.steer(getSteerPrefix() + text);
    return true;
  }

  async abortSession(sessionPath) {
    const entry = this._sessions.get(sessionPath);
    if (!entry?.session.isStreaming) return false;
    await entry.session.abort();
    return true;
  }

  /** 中断所有正在 streaming 的 session */
  async abortAllStreaming() {
    const tasks = [];
    for (const [sp, entry] of this._sessions) {
      if (entry.session.isStreaming) {
        tasks.push(entry.session.abort().catch(() => {}));
      }
    }
    await Promise.all(tasks);
    return tasks.length;
  }

  // ── Session 关闭 ──

  async closeSession(sessionPath) {
    const entry = this._sessions.get(sessionPath);
    if (entry) {
      if (entry.session.isStreaming) {
        try { await entry.session.abort(); } catch {}
      }
      entry.unsub();
      this._sessions.delete(sessionPath);
    }
    if (sessionPath === this.currentSessionPath) {
      this._session = null;
    }
  }

  async closeAllSessions() {
    for (const [sp, entry] of this._sessions) {
      const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
      agent?._memoryTicker?.notifySessionEnd(sp).catch(() => {});
      if (entry.session.isStreaming) {
        try { await entry.session.abort(); } catch {}
      }
      entry.unsub();
    }
    this._sessions.clear();
    this._session = null;
  }

  async cleanupSession() {
    await this.closeAllSessions();
    log.log("sessions cleaned up");
  }

  // ── Session 查询 ──

  getSessionByPath(sessionPath) {
    return this._sessions.get(sessionPath)?.session ?? null;
  }

  isSessionStreaming(sessionPath) {
    return !!this.getSessionByPath(sessionPath)?.isStreaming;
  }

  async abortSessionByPath(sessionPath) {
    const session = this.getSessionByPath(sessionPath);
    if (!session?.isStreaming) return false;
    await session.abort();
    return true;
  }

  async listSessions() {
    const allSessions = [];
    const agents = this._d.listAgents();

    for (const agent of agents) {
      const sessionDir = path.join(this._d.agentsDir, agent.id, "sessions");
      if (!fs.existsSync(sessionDir)) continue;
      try {
        const sessions = await SessionManager.list(process.cwd(), sessionDir);
        const titles = await this._loadSessionTitlesFor(sessionDir);
        for (const s of sessions) {
          const rawTitle = titles[s.path];
          const cleanStoredTitle = typeof rawTitle === "string" ? rawTitle.trim() : "";
          if (cleanStoredTitle) {
            s.title = cleanStoredTitle;
          } else if (typeof s.title === "string" && s.title.trim()) {
            s.title = s.title.trim();
          } else {
            s.title = null;
          }
          s.agentId = agent.id;
          s.agentName = agent.name;
          allSessions.push(s);
        }
      } catch {}
    }

    const currentPath = this.currentSessionPath;
    const activeAgentId = this._d.getActiveAgentId();
    if (currentPath && this._sessionStarted && !allSessions.find(s => s.path === currentPath)) {
      allSessions.unshift({
        path: currentPath,
        title: null,
        firstMessage: "",
        modified: new Date(),
        messageCount: 0,
        cwd: this._session?.sessionManager?.getCwd?.() || "",
        agentId: activeAgentId,
        agentName: this._d.getAgent().agentName,
      });
    }

    allSessions.sort((a, b) => b.modified - a.modified);
    return allSessions;
  }

  async saveSessionTitle(sessionPath, title) {
    const agentId = this._d.agentIdFromSessionPath(sessionPath);
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : this._d.getAgent().sessionDir;
    const titlePath = path.join(sessionDir, "session-titles.json");
    const titles = await this._loadSessionTitlesFor(sessionDir);
    titles[sessionPath] = title;
    await fsp.writeFile(titlePath, JSON.stringify(titles, null, 2), "utf-8");
    // 更新缓存
    this._titlesCache.set(sessionDir, { titles: { ...titles }, ts: Date.now() });
  }

  async _loadSessionTitlesFor(sessionDir) {
    const cached = this._titlesCache.get(sessionDir);
    if (cached && Date.now() - cached.ts < SessionCoordinator._TITLES_TTL) {
      return { ...cached.titles };
    }
    try {
      const raw = await fsp.readFile(path.join(sessionDir, "session-titles.json"), "utf-8");
      const titles = JSON.parse(raw);
      this._titlesCache.set(sessionDir, { titles, ts: Date.now() });
      return { ...titles };
    } catch {
      this._titlesCache.set(sessionDir, { titles: {}, ts: Date.now() });
      return {};
    }
  }

  // ── Session Context ──

  createSessionContext() {
    const models = this._d.getModels();
    const skills = this._d.getSkills();
    return {
      authStorage:    models.authStorage,
      modelRegistry:  models.modelRegistry,
      resourceLoader: this._d.getResourceLoader(),
      allSkills:      skills.allSkills,
      getSkillsForAgent: (ag) => skills.getSkillsForAgent(ag),
      buildTools:     (cwd, customTools, opts) => this._d.buildTools(cwd, customTools, opts),
      resolveModel:   (agentConfig) => {
        let id = agentConfig?.models?.chat;
        // 非 active agent 可能没有配 models.chat（模板默认为空），回退到全局默认模型
        if (!id) {
          if (models.defaultModel) {
            log.log(`[resolveModel] agentConfig 未指定 models.chat，回退到默认模型 ${models.defaultModel.id}`);
            return models.defaultModel;
          }
          log.error(`[resolveModel] agentConfig 未指定 models.chat，也没有默认模型`);
          throw new Error(t("error.resolveModelNoChatModel"));
        }
        const found = models.availableModels.find(m => m.id === id);
        if (!found) {
          // 模型 ID 在可用列表中找不到，尝试回退到默认模型
          if (models.defaultModel) {
            log.log(`[resolveModel] 模型 "${id}" 不在可用列表中，回退到默认模型 ${models.defaultModel.id}`);
            return models.defaultModel;
          }
          const available = models.availableModels.map(m => `${m.provider}/${m.id}`).join(", ");
          const hasAuth = models.modelRegistry
            ? `hasAuth("${models.inferModelProvider?.(id) || "?"}")=unknown`
            : "no registry";
          log.error(`[resolveModel] 找不到模型 "${id}"。availableModels=[${available}]。${hasAuth}`);
          throw new Error(t("error.resolveModelNotAvailable", { id }));
        }
        return found;
      },
    };
  }

  promoteActivitySession(activitySessionFile) {
    const agent = this._d.getAgent();
    const oldPath = path.join(agent.agentDir, "activity", activitySessionFile);
    if (!fs.existsSync(oldPath)) return null;

    const newPath = path.join(agent.sessionDir, activitySessionFile);
    try {
      fs.renameSync(oldPath, newPath);
      agent._memoryTicker?.notifyPromoted(newPath);
      log.log(`promoted activity session: ${activitySessionFile}`);
      return newPath;
    } catch (err) {
      log.error(`promoteActivitySession failed: ${err.message}`);
      return null;
    }
  }

  // ── Isolated Execution ──

  async executeIsolated(prompt, opts = {}) {
    const targetAgent = opts.agentId ? this._d.getAgentById(opts.agentId) : this._d.getAgent();
    if (!targetAgent) throw new Error(t("error.agentNotInitialized", { id: opts.agentId }));

    // abort signal：提前中止检查
    if (opts.signal?.aborted) {
      return { sessionPath: null, replyText: "", error: "aborted" };
    }

    const bm = BrowserManager.instance();
    const wasBrowserRunning = bm.isRunning;
    this._headlessRefCount++;
    if (this._headlessRefCount === 1) bm.setHeadless(true);
    let tempSessionMgr;
    const cleanupTempSession = () => {
      const sp = tempSessionMgr?.getSessionFile?.();
      if (sp) {
        try { fs.unlinkSync(sp); } catch {}
      }
    };
    try {
      const sessionDir = opts.persist || targetAgent.sessionDir;
      fs.mkdirSync(sessionDir, { recursive: true });

      const agentWorkspace = targetAgent?.config?.desk?.home_folder;
      const execCwd = opts.cwd || agentWorkspace || this._d.getHomeCwd() || process.cwd();
      const models = this._d.getModels();
      const agentPreferredModel = targetAgent.config?.models?.chat;
      const modelId = opts.model ? null : agentPreferredModel;
      let resolvedModel = opts.model;
      if (!resolvedModel) {
        if (modelId) {
          resolvedModel = models.availableModels.find(m => m.id === modelId);
        }
        if (!resolvedModel) {
          // agent 未配 models.chat 或配置的模型不在可用列表：fallback 到当前默认模型
          resolvedModel = models.defaultModel;
        }
        if (!resolvedModel) {
          log.error(`[executeIsolated] agent "${targetAgent.agentName}" 未指定 models.chat，也没有可用的默认模型`);
          throw new Error(t("error.executeIsolatedNoModel", { name: targetAgent.agentName }));
        }
        if (modelId && resolvedModel.id !== modelId) {
          log.log(`[executeIsolated] 模型 "${modelId}" 不可用，fallback → ${resolvedModel.id}`);
        }
      }
      const execModel = this._applyRuntimeModelOverrides(
        models.resolveExecutionModel(resolvedModel),
        targetAgent?.config?.models?.overrides,
      );
      tempSessionMgr = SessionManager.create(execCwd, sessionDir);
      const { tools: allBuiltinTools, customTools: allCustomTools } = this._d.buildTools(
        execCwd,
        targetAgent.tools,
        { agentDir: targetAgent.agentDir, workspace: agentWorkspace || this._d.getHomeCwd() },
      );

      const patrolAllowed = opts.toolFilter
        || targetAgent.config?.desk?.patrol_tools
        || PATROL_TOOLS_DEFAULT;
      const allowSet = new Set(patrolAllowed);
      const actCustomTools = allCustomTools.filter(t => allowSet.has(t.name));

      // builtin tools 过滤：传入 builtinFilter 时只保留白名单内的 builtin 工具
      const actTools = opts.builtinFilter
        ? allBuiltinTools.filter(t => opts.builtinFilter.includes(t.name))
        : allBuiltinTools;
      // 同 createSession：强制用沙盒包装后的 builtin 覆盖 SDK 默认内置工具。
      const actRuntimeTools = [...actCustomTools, ...actTools];

      const agent = this._d.getAgent();
      const skills = this._d.getSkills();
      const resourceLoader = this._d.getResourceLoader();
      const execResourceLoader = (targetAgent === agent)
        ? resourceLoader
        : Object.create(resourceLoader, {
            getSystemPrompt: { value: () => targetAgent.systemPrompt },
            getSkills: { value: () => skills.getSkillsForAgent(targetAgent) },
          });

      const { session } = await createAgentSession({
        cwd: execCwd,
        sessionManager: tempSessionMgr,
        settingsManager: this._createSettings(execModel, targetAgent?.config?.models?.overrides),
        authStorage: models.authStorage,
        modelRegistry: models.modelRegistry,
        model: execModel,
        thinkingLevel: models.resolveThinkingLevel(this._d.getPrefs().getThinkingLevel()),
        resourceLoader: execResourceLoader,
        tools: actTools,
        customTools: actRuntimeTools,
      });

      let replyText = "";
      const unsub = session.subscribe((event) => {
        if (event.type === "message_update") {
          const sub = event.assistantMessageEvent;
          if (sub?.type === "text_delta") {
            replyText += sub.delta || "";
          }
        }
      });

      // abort signal：监听中止，转发到子 session
      const abortHandler = () => session.abort();
      opts.signal?.addEventListener("abort", abortHandler, { once: true });

      // 二次检查：覆盖初始化期间 signal 已变 aborted 的竞争窗口
      if (opts.signal?.aborted) {
        opts.signal.removeEventListener("abort", abortHandler);
        unsub?.();
        cleanupTempSession();
        return { sessionPath: null, replyText: "", error: "aborted" };
      }

      try {
        await session.prompt(prompt);
      } finally {
        opts.signal?.removeEventListener("abort", abortHandler);
        unsub?.();
      }

      // 回填保护：某些 provider 可能不发 text_delta，
      // 但最终 assistant 消息已写入 session。
      if (!replyText.trim()) {
        const fallbackText = extractLastAssistantText(session?.messages).trim();
        if (fallbackText) {
          replyText = fallbackText;
          log.log("[executeIsolated] recovered final assistant text from session messages");
        }
      }
      replyText = sanitizeAssistantVisibleText(replyText);

      const sessionPath = session.sessionManager?.getSessionFile?.() || null;

      if (!opts.persist && sessionPath) {
        try { fs.unlinkSync(sessionPath); } catch {}
        return { sessionPath: null, replyText, error: null };
      }

      return { sessionPath, replyText, error: null };
    } catch (err) {
      log.error(`isolated execution failed: ${err.message}`);
      // 清理失败的临时 session 文件
      if (!opts.persist && tempSessionMgr) {
        cleanupTempSession();
      }
      return { sessionPath: null, replyText: "", error: err.message };
    } finally {
      this._headlessRefCount = Math.max(0, this._headlessRefCount - 1);
      if (this._headlessRefCount === 0) bm.setHeadless(false);
      const browserNowRunning = bm.isRunning;
      if (browserNowRunning !== wasBrowserRunning) {
        this._d.emitEvent({ type: "browser_bg_status", running: browserNowRunning, url: bm.currentUrl }, null);
      }
    }
  }

  _applyRuntimeModelOverrides(model, overrides = null) {
    const activeOverrides = overrides || this._d.getAgent?.()?.config?.models?.overrides;
    return applyRuntimeModelOverrides(model, activeOverrides);
  }

  /** 创建 session 专用 settings（控制 compaction + max_completion_tokens） */
  _createSettings(model, overrides = null) {
    const runtimeModel = this._applyRuntimeModelOverrides(model, overrides);
    const contextWindow = runtimeModel?.contextWindow || 200_000;
    return SettingsManager.inMemory({
      compaction: buildCompactionSettings(contextWindow),
    });
  }
}
