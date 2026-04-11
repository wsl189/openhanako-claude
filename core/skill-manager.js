/**
 * SkillManager — Skill 加载与 per-agent 注入
 *
 * - 全局技能仓库：.hanako/skills（用于“可添加技能”列表）
 * - Agent 私有技能：agents/<id>/skills（用于 system prompt 注入）
 */
import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import { scanSkillsInPaths } from "./skill-loader.js";

export class SkillManager {
  /**
   * @param {object} opts
   * @param {string} opts.skillsDir - 全局 skills 目录
   * @param {string} [opts.agentsDir] - agents 根目录（用于监听与扫描 agent 私有 skills）
   */
  constructor({ skillsDir, agentsDir }) {
    this.skillsDir = skillsDir;
    this.agentsDir = agentsDir || null;
    this._skillsDirReal = null;
    this._catalogSkills = [];
    this._agentSkillsById = new Map();
    this._hiddenSkills = new Set();
    this._watcher = null;
    this._reloadTimer = null;
    this._reloadDeps = null; // { resourceLoader, agents, onReloaded }
  }

  /** 全局技能仓库（用于“可添加技能”） */
  get allSkills() { return this._catalogSkills; }

  /**
   * 首次加载：
   * - 全局仓库来自 resourceLoader（过滤到 .hanako/skills）
   * - agent 私有技能来自 agents/<id>/skills 扫描
   */
  init(resourceLoader, agents, hiddenSkills) {
    this._hiddenSkills = hiddenSkills;
    this._rebuildIndexes(resourceLoader, agents);
  }

  /** 将 agent 私有 skills 同步到 agent 的 system prompt */
  syncAgentSkills(agent) {
    const skills = this._getAgentSkills(agent);
    agent.setEnabledSkills(skills);
  }

  /**
   * 返回技能列表（供 API 使用）：
   * - 基础列表来自全局仓库
   * - enabled 由 agent 私有目录是否存在同名 skill 决定
   * - 若 agent 有“仅本地 skill”（不在全局仓库），也会附加返回（enabled=true）
   */
  getAllSkills(agent) {
    const result = [];
    const catalogNames = new Set();
    const agentSkills = this._getAgentSkills(agent);
    const enabledNames = new Set(agentSkills.map((s) => s.name));
    const agentSkillByName = new Map(agentSkills.map((s) => [s.name, s]));

    for (const s of this._catalogSkills) {
      catalogNames.add(s.name);
      // 同名技能若在 agent 私有目录存在，则详情优先展示 agent 版本，
      // 避免预览时读到全局仓库中的旧内容。
      const agentVersion = agentSkillByName.get(s.name);
      const detailSkill = agentVersion || s;
      result.push({
        name: s.name,
        description: detailSkill.description ?? s.description,
        filePath: detailSkill.filePath ?? s.filePath,
        baseDir: detailSkill.baseDir ?? s.baseDir,
        source: s.source,
        hidden: !!s._hidden,
        enabled: enabledNames.has(s.name),
        readonly: !!s._readonly,
      });
    }

    for (const s of agentSkills) {
      if (catalogNames.has(s.name)) continue;
      result.push({
        name: s.name,
        description: s.description,
        filePath: s.filePath,
        baseDir: s.baseDir,
        source: s.source || "agent",
        hidden: !!s._hidden,
        enabled: true,
        readonly: !!s._readonly,
      });
    }

    return result;
  }

  /** 查询全局仓库技能（按 name） */
  getCatalogSkillByName(name) {
    return this._catalogSkills.find((s) => s.name === name) || null;
  }

  /** 按 agent 返回提示词可用 skills（严格来自 agent 私有 skills 目录） */
  getSkillsForAgent(targetAgent) {
    const skills = this._getAgentSkills(targetAgent);
    return {
      skills,
      diagnostics: [],
    };
  }

  /**
   * 重新加载 skills（安装/删除后调用）
   * @param {object} resourceLoader
   * @param {Map} agents
   */
  async reload(resourceLoader, agents) {
    // 暂时恢复原始 getSkills 以便 reload() 正确扫描全局仓库
    delete resourceLoader.getSkills;
    await resourceLoader.reload();
    this._rebuildIndexes(resourceLoader, agents);
  }

  /**
   * 监听 skills 变化，自动 reload（debounce 1s）
   * @param {object} resourceLoader
   * @param {Map} agents
   * @param {() => void} onReloaded - reload 完成后的回调（用于 syncAllAgentSkills 等）
   */
  watch(resourceLoader, agents, onReloaded) {
    this._reloadDeps = { resourceLoader, agents, onReloaded };
    if (this._watcher) return;

    const watchPaths = this._buildWatchPaths();
    if (watchPaths.length === 0) return;

    try {
      this._watcher = chokidar.watch(watchPaths, {
        ignoreInitial: true,
        ignored: (watchedPath) => this._shouldIgnoreWatchPath(watchedPath),
        persistent: true,
      });
      this._watcher.on("all", (_event, changedPath) => {
        if (!this._isWatchedSkillPath(changedPath)) return;
        if (this._reloadTimer) clearTimeout(this._reloadTimer);
        this._reloadTimer = setTimeout(() => this._autoReload(), 1000);
      });
      this._watcher.on("error", (err) => {
        console.error("[skill-manager] watcher error:", err.message);
      });
    } catch (err) {
      console.error("[skill-manager] failed to create watcher:", err.message);
    }
  }

  async _autoReload() {
    const deps = this._reloadDeps;
    if (!deps) return;
    try {
      await this.reload(deps.resourceLoader, deps.agents);
      deps.onReloaded?.();
    } catch (err) {
      console.warn("[skill-manager] auto-reload failed:", err.message);
    }
  }

  /** 停止文件监听 */
  unwatch() {
    if (this._watcher) { this._watcher.close(); this._watcher = null; }
    if (this._reloadTimer) { clearTimeout(this._reloadTimer); this._reloadTimer = null; }
    this._reloadDeps = null;
  }

  _rebuildIndexes(resourceLoader, agents) {
    this._catalogSkills = this._collectManagedSkills(resourceLoader.getSkills().skills || []);
    for (const s of this._catalogSkills) {
      s._hidden = this._hiddenSkills.has(s.name) && !!s._readonly;
    }
    this._agentSkillsById = this._scanAllAgentSkills(agents);
  }

  _scanAllAgentSkills(agents) {
    const result = new Map();
    if (!agents?.entries) return result;

    for (const [agentId, agent] of agents.entries()) {
      const skillsDir = path.join(agent.agentDir, "skills");
      let loadedSkills = [];
      try {
        loadedSkills = scanSkillsInPaths([skillsDir]);
      } catch {
        loadedSkills = [];
      }

      for (const s of loadedSkills) {
        s._hidden = this._hiddenSkills.has(s.name) && !!s._readonly;
      }
      result.set(agentId, loadedSkills);
    }

    return result;
  }

  _getAgentSkills(agent) {
    if (!agent?.agentDir) return [];
    const agentId = path.basename(agent.agentDir);
    return this._agentSkillsById.get(agentId) || [];
  }

  _collectManagedSkills(skills) {
    return skills.filter((s) => this._isSkillInManagedDir(s));
  }

  _resolveSkillBaseDir(skill) {
    if (skill?.baseDir) return skill.baseDir;
    if (skill?.filePath) return path.dirname(skill.filePath);
    return null;
  }

  _isSkillInManagedDir(skill) {
    const baseDir = this._resolveSkillBaseDir(skill);
    if (!baseDir) return false;
    try {
      if (!this._skillsDirReal) {
        this._skillsDirReal = fs.realpathSync(this.skillsDir);
      }
      const realBase = fs.realpathSync(baseDir);
      return realBase === this._skillsDirReal || realBase.startsWith(this._skillsDirReal + path.sep);
    } catch {
      return false;
    }
  }

  _shouldIgnoreWatchPath(watchedPath) {
    const p = String(watchedPath || "");
    const base = path.basename(p);
    // 注意：不能按完整路径匹配 "/."，否则会误伤 ~/.hanako/ 下的正常目录监听。
    return base.startsWith(".") || /[~#]$/.test(base);
  }

  _buildWatchPaths() {
    const out = [];
    if (this.skillsDir) {
      out.push(this.skillsDir);
    }
    if (this.agentsDir) {
      // 不依赖 glob（在某些 chokidar 版本/平台上不稳定），
      // 直接监听 agentsDir，再通过 _isWatchedSkillPath 过滤到 skills 子树。
      out.push(this.agentsDir);
    }
    return out;
  }

  _isWatchedSkillPath(watchedPath) {
    const abs = path.resolve(String(watchedPath || ""));
    if (!abs) return false;

    if (this.skillsDir) {
      const relSkills = path.relative(this.skillsDir, abs);
      if (relSkills === "" || (!relSkills.startsWith("..") && !path.isAbsolute(relSkills))) {
        return true;
      }
    }

    if (this.agentsDir) {
      const relAgents = path.relative(this.agentsDir, abs);
      if (relAgents === "" || relAgents.startsWith("..") || path.isAbsolute(relAgents)) {
        return false;
      }
      const parts = relAgents.split(path.sep).filter(Boolean);
      // agents/<agentId>/skills[/...]
      if (parts.length >= 2 && parts[1] === "skills") {
        return true;
      }
    }

    return false;
  }
}
