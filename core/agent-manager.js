/**
 * AgentManager — 多 Agent 生命周期管理
 *
 * 从 Engine 提取，负责 agent 的扫描/初始化/创建/切换/删除。
 * 不持有 engine 引用，通过构造器注入依赖。
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import YAML from "js-yaml";
import { Agent } from "./agent.js";
import { createModuleLogger } from "../lib/debug-log.js";
import { clearConfigCache } from "../lib/memory/config-loader.js";
import { t } from "../server/i18n.js";
import { ActivityStore } from "../lib/desk/activity-store.js";
import { normalizeModelRef } from "./model-ref.js";
import {
  generateAgentId as _generateAgentId,
} from "./llm-utils.js";

const log = createModuleLogger("agent-mgr");

export class AgentManager {
  /**
   * @param {object} deps
   * @param {string} deps.agentsDir
   * @param {string} deps.productDir
   * @param {string} deps.userDir
   * @param {string} deps.channelsDir
   * @param {() => import('./preferences-manager.js').PreferencesManager} deps.getPrefs
   * @param {() => import('./model-manager.js').ModelManager} deps.getModels
   * @param {() => object|null} deps.getHub
   * @param {() => import('./skill-manager.js').SkillManager} deps.getSkills
   * @param {() => object} deps.resolveUtilityConfig
   * @param {() => object} deps.getSharedModels
   * @param {() => import('./channel-manager.js').ChannelManager} deps.getChannelManager
   * @param {() => import('./session-coordinator.js').SessionCoordinator} deps.getSessionCoordinator
   */
  constructor(deps) {
    this._d = deps;
    this._agents = new Map();
    this._activeAgentId = null;
    this._switching = false;
    this._activityStores = new Map();
    this._agentListCache = null;       // { raw: [{id,name,yuan,identity}], ts: number }
  }

  /** 清除 listAgents 缓存（agent 增删改时调用） */
  invalidateAgentListCache() { this._agentListCache = null; }

  get agents() { return this._agents; }
  get activeAgentId() { return this._activeAgentId; }
  set activeAgentId(id) {
    this._activeAgentId = id;
    try {
      this._d.getPrefs?.()?.setLastAgentId?.(id);
    } catch {}
  }
  get switching() { return this._switching; }

  /** 当前焦点 agent */
  get agent() { return this._agents.get(this._activeAgentId); }

  /** 按 ID 获取 agent */
  getAgent(agentId) { return this._agents.get(agentId) || null; }

  // ── Activity Store（per-agent 懒缓存） ──

  get activityStores() { return this._activityStores; }

  getActivityStore(agentId) {
    let store = this._activityStores.get(agentId);
    if (!store) {
      const agDir = path.join(this._d.agentsDir, agentId);
      store = new ActivityStore(
        path.join(agDir, "desk", "activities.json"),
        path.join(agDir, "activity"),
      );
      this._activityStores.set(agentId, store);
    }
    return store;
  }

  // ── Init ──

  async initAllAgents(log, startId) {
    this.activeAgentId = startId;

    const sharedModels = this._d.getSharedModels();
    const resolveModel = (bareId, agentConfig) =>
      this._d.getModels().resolveModelWithCredentials(bareId, agentConfig);

    const entries = this._scanAgentDirs();
    const initOne = async (agentId) => {
      const agentDir = path.join(this._d.agentsDir, agentId);
      const ag = this._createAgentInstance(agentDir);
      await ag.init(
        agentId === this._activeAgentId ? log : () => {},
        sharedModels,
        resolveModel,
      );
      this._agents.set(agentId, ag);
    };

    // 焦点 agent 先初始化
    await initOne(this._activeAgentId);

    // 其余并行
    const others = entries.map(e => e.name).filter(id => id !== this._activeAgentId);
    if (others.length) {
      const results = await Promise.allSettled(others.map(id => initOne(id)));
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "rejected") {
          log.error(`agent "${others[i]}" init 失败: ${results[i].reason?.message}`);
        }
      }
    }
    log(`[init] ${this._agents.size} 个 agent 初始化完成`);
  }

  // ── List ──

  static AGENT_LIST_TTL = 30_000; // 30 秒

  listAgents() {
    const now = Date.now();
    if (!this._agentListCache || now - this._agentListCache.ts > AgentManager.AGENT_LIST_TTL) {
      this._agentListCache = { raw: this._scanAgentList(), ts: now };
    }

    const prefs = this._d.getPrefs();
    const order = prefs.getPreferences()?.agentOrder || [];

    const agents = this._agentListCache.raw.map(a => ({
      ...a,
      isCurrent: a.id === this._activeAgentId,
    }));

    if (order.length) {
      agents.sort((a, b) => {
        const ia = order.indexOf(a.id);
        const ib = order.indexOf(b.id);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      });
    }
    return agents;
  }

  /** 扫盘读取所有 agent 元数据（I/O 密集，由缓存保护） */
  _scanAgentList() {
    const entries = fs.readdirSync(this._d.agentsDir, { withFileTypes: true });
    const agents = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const configPath = path.join(this._d.agentsDir, entry.name, "config.yaml");
      if (!fs.existsSync(configPath)) continue;
      try {
        const cfg = YAML.load(fs.readFileSync(configPath, "utf-8"));
        let identity = "";
        try {
          const idMd = fs.readFileSync(path.join(this._d.agentsDir, entry.name, "identity.md"), "utf-8");
          const lines = idMd.split("\n").filter(l => l.trim() && !l.startsWith("#"));
          identity = lines[0]?.trim() || "";
        } catch {}
        const avatarDir = path.join(this._d.agentsDir, entry.name, "avatars");
        let hasAvatar = false;
        try {
          const avatarFiles = fs.readdirSync(avatarDir);
          hasAvatar = avatarFiles.some(f => /\.(png|jpe?g|gif|webp)$/i.test(f));
        } catch {}
        agents.push({
          id: entry.name,
          name: cfg.agent?.name || entry.name,
          yuan: cfg.agent?.yuan || "hanako",
          identity,
          hasAvatar,
        });
      } catch {}
    }
    return agents;
  }

  // ── Create ──

  async createAgent({ name, id, yuan }) {
    if (!name?.trim()) throw new Error(t("error.agentNameEmpty"));
    const safeNameInput = name.trim();

    // 显示名去重：创建时不允许与现有助手重名（忽略大小写与首尾空格）
    const normalizedNewName = safeNameInput.toLowerCase();
    const duplicated = this._scanAgentList().find((a) =>
      String(a?.name || "").trim().toLowerCase() === normalizedNewName
    );
    if (duplicated) {
      const err = new Error(t("error.agentNameExists", { name: safeNameInput }));
      err.code = "AGENT_NAME_EXISTS";
      throw err;
    }

    const agentId = id?.trim() || await this._generateAgentId(safeNameInput);
    if (/[\/\\]|\.\./.test(agentId)) throw new Error(t("error.agentIdInvalid"));
    const agentDir = path.join(this._d.agentsDir, agentId);

    if (fs.existsSync(agentDir)) {
      const err = new Error(t("error.agentAlreadyExists", { id: agentId }));
      err.code = "AGENT_ID_EXISTS";
      throw err;
    }

    // 创建最小 agent 根目录；会话、头像、活动、书桌等运行期目录按需创建。
    fs.mkdirSync(agentDir, { recursive: true });

    // 从模板复制 config.yaml
    const templateConfig = fs.readFileSync(path.join(this._d.productDir, "config.example.yaml"), "utf-8");
    const currentAgent = this.agent;
    const userName = currentAgent?.userName || "";
    const safeName = safeNameInput.replace(/"/g, '\\"');
    const VALID_YUAN = ["hanako", "butter", "ming"];
    const yuanType = VALID_YUAN.includes(yuan) ? yuan : "hanako";
    let config = templateConfig.replace(/name: Hanako/, `name: "${safeName}"`);
    config = config.replace(/yuan: hanako/, `yuan: ${yuanType}`);
    if (userName) {
      config = config.replace(/user:\s*\n\s+name:\s*""/, `user:\n  name: "${userName}"`);
    }
    // 继承主 agent 的模型配置
    const primaryChat = normalizeModelRef(currentAgent?.config?.models?.chat)
      || this._d.getModels().defaultModel?.id
      || "";
    if (primaryChat) {
      config = config.replace(/chat: ""/, `chat: "${primaryChat}"`);
    }
    // 新建助手默认开启所有自定义工具（写入显式白名单，避免 UI 显示为全关）
    const defaultCustomEnabled = [...new Set(
      (currentAgent?.getAllCustomTools?.() || [])
        .map((tool) => String(tool?.name || "").trim())
        .filter(Boolean),
    )].sort();
    if (defaultCustomEnabled.length > 0) {
      const serialized = defaultCustomEnabled
        .map((name) => `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
        .join(", ");
      config = config.replace(
        /(^\s*custom_enabled:\s*)\[[^\]]*\].*$/m,
        `$1[${serialized}]`,
      );
    }

    // Sandbox is globally disabled, so new agents should not carry per-agent
    // sandbox mode/path config. Keep Claude permission strategy permissive.
    try {
      const parsed = YAML.load(config) || {};
      delete parsed.sandbox;
      const claude = (parsed.claude && typeof parsed.claude === "object")
        ? parsed.claude
        : {};
      parsed.claude = {
        ...claude,
        permission_strategy: "auto_allow",
      };
      config = YAML.dump(parsed, { lineWidth: -1, noRefs: true });
    } catch (err) {
      log.warn(`createAgent: failed to normalize sandbox/claude defaults (${err?.message || err})`);
    }

    fs.writeFileSync(path.join(agentDir, "config.yaml"), config, "utf-8");

    // identity.md（按 yuan 选择模板，缺失时回退 identity.example.md）
    const isZh = String(currentAgent?.config?.locale || "").startsWith("zh");
    const langDir = isZh ? "" : "en/";
    const readText = (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return ""; } };
    const identityTmpl = readText(path.join(this._d.productDir, "identity-templates", `${langDir}${yuanType}.md`))
      || readText(path.join(this._d.productDir, "identity-templates", `${yuanType}.md`))
      || readText(path.join(this._d.productDir, "identity.example.md"));
    if (identityTmpl) {
      const filled = identityTmpl
        .replace(/\{\{agentName\}\}/g, safeNameInput)
        .replace(/\{\{userName\}\}/g, currentAgent?.userName || t("error.fallbackUserName"))
        .replace(/\{\{agentId\}\}/g, agentId);
      fs.writeFileSync(path.join(agentDir, "identity.md"), filled, "utf-8");
    }

    // ishiki.md（按 yuan 选择模板，缺失时回退 ishiki.example.md）
    const ishikiTmpl = readText(path.join(this._d.productDir, "ishiki-templates", `${langDir}${yuanType}.md`))
      || readText(path.join(this._d.productDir, "ishiki-templates", `${yuanType}.md`))
      || readText(path.join(this._d.productDir, "ishiki.example.md"));
    if (ishikiTmpl) {
      const filled = ishikiTmpl
        .replace(/\{\{agentName\}\}/g, safeNameInput)
        .replace(/\{\{userName\}\}/g, currentAgent?.userName || t("error.fallbackUserName"))
        .replace(/\{\{agentId\}\}/g, agentId);
      fs.writeFileSync(path.join(agentDir, "ishiki.md"), filled, "utf-8");
    }

    // 频道系统
    this._d.getChannelManager().setupChannelsForNewAgent(agentId);

    // 初始化并加入长驻 Map
    const ag = this._createAgentInstance(agentDir);
    const resolveModel = (bareId, agentConfig) =>
      this._d.getModels().resolveModelWithCredentials(bareId, agentConfig);
    try {
      await ag.init(() => {}, this._d.getSharedModels(), resolveModel);
    } catch (err) {
      // init 失败：回滚已创建的目录，防止孤儿残留
      try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch {}
      throw err;
    }
    this._agents.set(agentId, ag);

    // 启动 cron
    const hub = this._d.getHub();
    hub?.scheduler?.startAgentCron(agentId);

    // 注入 DM 回调
    const dmRouter = hub?.dmRouter;
    if (dmRouter) {
      ag._dmSentHandler = (fromId, toId) => dmRouter.handleNewDm(fromId, toId);
    }
    hub?.channelRouter?.setupPostHandler?.();

    this.invalidateAgentListCache();
    log.log(`创建助手: ${safeNameInput} (${agentId})`);
    return { id: agentId, name: safeNameInput };
  }

  // ── Switch ──

  async switchAgentOnly(agentId) {
    if (this._switching) throw new Error(t("error.agentSwitching"));
    if (!this._agents.has(agentId)) {
      throw new Error(t("error.agentNotFound", { id: agentId }));
    }
    this._switching = true;
    const prevAgentId = this._activeAgentId;
    log.log(`switching agent to ${agentId}`);
    try {
      const hub = this._d.getHub();
      await hub?.pauseForAgentSwitch();
      // Phase 1: 不再杀 session，只切 agent 指针
      clearConfigCache();
      this.activeAgentId = agentId;

      const preferredRef = normalizeModelRef(this.agent.config.models?.chat);
      const models = this._d.getModels();
      if (preferredRef) {
        const model = models.findAvailableModel(preferredRef);
        if (!model) {
          throw new Error(t("error.agentModelNotAvailable", { id: agentId, model: preferredRef }));
        }
        models.defaultModel = model;
      }
      // 未配 models.chat 的 agent 继承当前 defaultModel
      const effectiveModel = preferredRef || models.defaultModel?.id || "inherited";
      log.log(`agent switched to ${this.agent.agentName} (${agentId}), model=${effectiveModel}`);
    } catch (err) {
      this.activeAgentId = prevAgentId;
      try { this._d.getHub()?.resumeAfterAgentSwitch(); } catch {}
      throw err;
    } finally {
      this._switching = false;
    }
  }

  async switchAgent(agentId) {
    await this.switchAgentOnly(agentId);
    const hub = this._d.getHub();
    hub?.resumeAfterAgentSwitch();
    this._d.getSkills().syncAgentSkills(this.agent);
    await this._d.getSessionCoordinator().createSession();
    log.log(`已切换到助手: ${this.agent.agentName} (${agentId})`);
  }

  async createSessionForAgent(agentId, cwd, memoryEnabled = true) {
    if (agentId && agentId !== this._activeAgentId) {
      await this.switchAgentOnly(agentId);
    }
    return this._d.getSessionCoordinator().createSession(null, cwd, memoryEnabled);
  }

  // ── Delete ──

  async deleteAgent(agentId) {
    const allIds = [...this._agents.keys()];
    const remainingIds = allIds.filter((id) => id !== agentId);
    if (remainingIds.length === 0) {
      const err = new Error(t("error.agentDeleteLast"));
      err.code = "AGENT_DELETE_LAST";
      throw err;
    }

    const agentDir = path.join(this._d.agentsDir, agentId);
    if (!fs.existsSync(agentDir)) {
      throw new Error(t("error.agentNotExists", { id: agentId }));
    }

    // 允许删除当前激活助手：先自动切到其他助手，确保运行态有效。
    if (agentId === this._activeAgentId) {
      const fallbackId = remainingIds[0];
      await this.switchAgentOnly(fallbackId);
      const hub = this._d.getHub();
      hub?.resumeAfterAgentSwitch();
      this._d.getSkills().syncAgentSkills(this.agent);
      await this._d.getSessionCoordinator().createSession();
    }

    const ag = this._agents.get(agentId);
    if (ag) {
      this._agents.delete(agentId);
      this._activityStores.delete(agentId);
      await this._d.getHub()?.scheduler?.removeAgentCron(agentId);
      await ag.dispose();
    }

    // 频道清理
    try {
      this._d.getChannelManager().cleanupAgentFromChannels(agentId);
    } catch (err) {
      log.error(`频道清理失败 (${agentId}): ${err.message}`);
    }

    await fsp.rm(agentDir, { recursive: true, force: true });

    const prefs = this._d.getPrefs();
    const order = prefs.getPreferences()?.agentOrder || [];
    const newOrder = order.filter(id => id !== agentId);
    if (newOrder.length !== order.length) {
      const p = prefs.getPreferences();
      p.agentOrder = newOrder;
      prefs.savePreferences(p);
    }

    this.invalidateAgentListCache();
    log.log(`已删除助手: ${agentId}`);
  }

  // ── Utility ──

  agentIdFromSessionPath(sessionPath) {
    const rel = path.relative(this._d.agentsDir, sessionPath);
    if (rel.startsWith("..")) return null;
    return rel.split(path.sep)[0] || null;
  }

  // ── Dispose ──

  async disposeAll(session) {
    // final 滚动摘要
    const sp = session?.sessionManager?.getSessionFile?.();
    if (sp) {
      await Promise.race([
        this.agent?._memoryTicker?.notifySessionEnd(sp) ?? Promise.resolve(),
        new Promise(r => setTimeout(r, 4000)),
      ]);
    }
    await Promise.allSettled(
      [...this._agents.values()].map(ag => ag.dispose()),
    );
    this._agents.clear();
  }

  // ── Internal ──

  _scanAgentDirs() {
    try {
      return fs.readdirSync(this._d.agentsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && fs.existsSync(path.join(this._d.agentsDir, e.name, "config.yaml")));
    } catch { return []; }
  }

  _createAgentInstance(agentDir) {
    const ag = new Agent({
      agentDir,
      productDir: this._d.productDir,
      userDir: this._d.userDir,
      channelsDir: this._d.channelsDir,
      agentsDir: this._d.agentsDir,
    });
    ag._engine = this._d.getEngine?.() || null;
    ag._onInstallCallback = async (skillName) => {
      const skills = this._d.getSkills();
      // install_skill 工具会写入 learned-skills，这里同步复制到当前 agent 的 skills 目录，
      // 让 SDK Skill discovery 与 /skill 读取都走 agent 私有 skills。
      const learnedDir = path.join(this.agent.agentDir, "learned-skills", skillName);
      const agentSkillsDir = path.join(this.agent.agentDir, "skills", skillName);
      if (fs.existsSync(learnedDir) && !fs.existsSync(path.join(agentSkillsDir, "SKILL.md"))) {
        fs.mkdirSync(path.dirname(agentSkillsDir), { recursive: true });
        fs.cpSync(learnedDir, agentSkillsDir, { recursive: true });
      }
      await skills.reload(this._d.getResourceLoader?.(), this._agents);
      const enabled = new Set(this.agent.config?.skills?.enabled || []);
      enabled.add(skillName);
      // updateConfig 通过 engine 层面调用
      this.agent.updateConfig({ skills: { enabled: [...enabled] } });
      skills.syncAgentSkills(this.agent);
    };
    ag._notifyHandler = (title, body, opts = {}) =>
      this._d.getHub()?.notify?.({
        title,
        body,
        target: opts?.target || "auto",
        agentId: path.basename(ag.agentDir || ""),
        source: "notify_tool",
      });
    return ag;
  }

  async _generateAgentId(name) {
    return _generateAgentId(null, name, this._d.agentsDir);
  }
}
