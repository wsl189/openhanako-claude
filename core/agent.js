/**
 * Agent — 一个助手实例
 *
 * 拥有自己的身份、人格、记忆、工具和 prompt 拼装逻辑。
 * Engine 持有一个 Agent，未来可以持有多个。
 */
import fs from "fs";
import path from "path";
import { loadConfig, saveConfig } from "../lib/memory/config-loader.js";
import { FactStore } from "../lib/memory/fact-store.js";
import { SessionSummaryManager } from "../lib/memory/session-summary.js";
import { createMemoryTicker } from "../lib/memory/memory-ticker.js";
import { createMemorySearchTool } from "../lib/memory/memory-search.js";
import { createTodoTool } from "../lib/tools/todo.js";
import { createDeskManager } from "../lib/desk/desk-manager.js";
import { CronStore } from "../lib/desk/cron-store.js";
import { createCronTool } from "../lib/tools/cron-tool.js";
import { createWebFetchTool } from "../lib/tools/web-fetch.js";
import { createPresentFilesTool } from "../lib/tools/output-file-tool.js";
import { createArtifactTool } from "../lib/tools/artifact-tool.js";
import { createChannelTool } from "../lib/tools/channel-tool.js";
import { createAskAgentTool } from "../lib/tools/ask-agent-tool.js";
import { createDmTool } from "../lib/tools/dm-tool.js";
import { createBrowserTool } from "../lib/tools/browser-tool.js";
import { createPinnedMemoryTools } from "../lib/tools/pinned-memory.js";
import { createExperienceTools } from "../lib/tools/experience.js";
import { createNotifyTool } from "../lib/tools/notify-tool.js";
import { createUpdateSettingsTool } from "../lib/tools/update-settings-tool.js";
import { createDelegateTool } from "../lib/tools/delegate-tool.js";
import { createDescribeImagesTool } from "../lib/tools/describe-images-tool.js";
import { createGenerateImagesTool } from "../lib/tools/generate-images-tool.js";
import { READ_ONLY_BUILTIN_TOOLS } from "./config-coordinator.js";
import { formatSkillsForPrompt } from "@mariozechner/pi-coding-agent";
import { runCompatChecks } from "../lib/compat/index.js";
import { t } from "../server/i18n.js";

export class Agent {
  /**
   * @param {object} opts
   * @param {string} opts.agentDir   - 这个助手的数据目录（ishiki, config, memory, avatars）
   * @param {string} opts.productDir - 产品模板目录（ishiki.example.md, identity 模板等）
   * @param {string} opts.userDir    - 用户数据目录（user.md, 用户头像）—— 跨助手共享
   */
  constructor({ agentDir, productDir, userDir, channelsDir, agentsDir }) {
    this.agentDir = agentDir;
    this.productDir = productDir;
    this.userDir = userDir;
    this.channelsDir = channelsDir || null;
    this.agentsDir = agentsDir || null;

    // 路径
    this.configPath = path.join(agentDir, "config.yaml");
    this.factsDbPath = path.join(agentDir, "memory", "facts.db");
    this.memoryMdPath = path.join(agentDir, "memory", "memory.md");
    this.todayMdPath    = path.join(agentDir, "memory", "today.md");
    this.weekMdPath     = path.join(agentDir, "memory", "week.md");
    this.longtermMdPath = path.join(agentDir, "memory", "longterm.md");
    this.factsMdPath    = path.join(agentDir, "memory", "facts.md");
    this.summariesDir = path.join(agentDir, "memory", "summaries");
    this.sessionDir = path.join(agentDir, "sessions");
    this.deskDir = path.join(agentDir, "desk");

    // 身份（init 后从 config 填充）
    this.userName = "User";
    this.agentName = "Hanako";

    // 运行时状态
    this._config = null;
    this._factStore = null;
    this._summaryManager = null;
    this._memoryTicker = null;
    this._memorySearchTool = null;
    this._webFetchTool = null;
    this._todoTool = null;
    this._pinnedMemoryTools = [];
    this._experienceTools = [];
    this._memoryMasterEnabled = true;   // agent 级别总开关（config.yaml memory.enabled）
    this._memorySessionEnabled = true;  // per-session 开关（WelcomeScreen toggle）
    this._enabledSkills = [];
    this._systemPrompt = "";

    // Desk 系统（与 memory 完全独立）
    this._deskManager = null;
    this._cronStore = null;
    this._cronTool = null;
    this._presentFilesTool = null;
    this._artifactTool = null;
    this._channelTool = null;
    this._browserTool = null;
    this._notifyTool = null;
    this._describeImagesTool = null;
    this._generateImagesTool = null;
  }

  // ════════════════════════════
  //  生命周期
  // ════════════════════════════

  /**
   * 初始化助手：加载配置、编译记忆、创建工具
   * @param {(msg: string) => void} [log]
   * @param {object} [sharedModels] - 全局共享模型配置（由 engine 传入）
   * @param {(bareId: string, agentConfig: object) => object} [resolveModel] - 统一模型解析回调
   */
  async init(log = () => {}, sharedModels = {}, resolveModel = null) {
    // 0. 兼容性检查（目录、数据库、配置文件）
    await runCompatChecks({
      agentDir: this.agentDir,
      hanakoHome: path.dirname(path.dirname(this.agentDir)),
      log,
    });

    // 1. 加载配置
    log(`  [agent] 1. loadConfig...`);
    this._config = loadConfig(this.configPath);
    // 工作模块改版后默认开启巡检与 cron 免确认；历史配置里的 false 在启动时自动迁回 true。
    const heartbeatWasDisabled = this._config?.desk?.heartbeat_enabled === false;
    const cronAutoApproveWasDisabled = this._config?.desk?.cron_auto_approve === false;
    if (heartbeatWasDisabled || cronAutoApproveWasDisabled) {
      saveConfig(this.configPath, {
        desk: {
          heartbeat_enabled: true,
          cron_auto_approve: true,
        },
      });
      this._config = loadConfig(this.configPath);
    }
    log(`  [agent] 1. loadConfig 完成`);

    // 2. 身份 + 记忆总开关
    this.userName = this._resolveUserName();
    this.agentName = this._config.agent?.name || "Hanako";
    this._memoryMasterEnabled = this._config.memory?.enabled !== false;

    // 3. 初始化各模块
    log(`  [agent] 3. 模块初始化完成`);

    // 4. 记忆 v2：FactStore + SessionSummaryManager + ticker
    log(`  [agent] 4. FactStore...`);
    fs.mkdirSync(path.join(this.agentDir, "memory", "summaries"), { recursive: true });
    this._factStore = new FactStore(this.factsDbPath);
    this._summaryManager = new SessionSummaryManager(this.summariesDir);

    // v1 → v2 迁移：仅当迁移标记不存在且旧 memories.db 存在时执行一次
    const oldMemoriesPath = path.join(this.agentDir, "memory", "memories.db");
    const migrationDone = path.join(this.agentDir, "memory", ".v2-migrated");
    if (!fs.existsSync(migrationDone) && fs.existsSync(oldMemoriesPath)) {
      try {
        log(`  [agent] 4. v1→v2 迁移: 发现旧 memories.db，开始迁移...`);
        const Database = (await import("better-sqlite3")).default;
        const oldDb = new Database(oldMemoriesPath, { readonly: true });
        const rows = oldDb.prepare("SELECT content, tags, date, created_at FROM memories").all();
        oldDb.close();

        if (rows.length > 0) {
          const facts = rows.map(row => ({
            fact: row.content,
            tags: (() => { try { return JSON.parse(row.tags); } catch { return []; } })(),
            time: row.date ? row.date + "T00:00" : null,
            session_id: "v1-migration",
          }));
          this._factStore.addBatch(facts);
          log(`  [agent] 4. v1→v2 迁移完成: ${facts.length} 条记忆已迁入 facts.db`);
        }
        // 写迁移标记，防止重复迁移
        fs.writeFileSync(migrationDone, new Date().toISOString());
      } catch (err) {
        console.error(`[agent] v1→v2 迁移失败（不影响启动）: ${err.message}`);
        // 迁移失败也写标记，避免每次启动重试
        try { fs.writeFileSync(migrationDone, `failed: ${err.message}`); } catch {}
      }
    }

    log(`  [agent] 4. FactStore + SummaryManager 完成`);

    // utility 模型（允许为空，首次安装时用户尚未配置）
    this._utilityModel = sharedModels.utility || null;
    this._memoryModel = sharedModels.utility_large || sharedModels.utility || null;

    // 预解析记忆模型凭证（统一解析层）
    this._resolvedMemoryModel = null;
    if (this._memoryModel && resolveModel) {
      try {
        this._resolvedMemoryModel = resolveModel(this._memoryModel, this._config);
      } catch (err) {
        console.warn(`[agent] 记忆模型解析失败，记忆系统将不启动: ${err.message}`);
      }
    }

    if (this._resolvedMemoryModel) {
      log(`  [agent] 4. memoryTicker...`);
      this._memoryTicker = createMemoryTicker({
        summaryManager: this._summaryManager,
        configPath: this.configPath,
        factStore: this._factStore,
        getResolvedMemoryModel: () => this._resolvedMemoryModel,
        getMemoryMasterEnabled: () => this._memoryMasterEnabled,
        isSessionMemoryEnabled: (sessionPath) => this.isSessionMemoryEnabledFor(sessionPath),
        onCompiled: () => {
          this._systemPrompt = this.buildSystemPrompt();
          console.log(`[${this.agentName}] 记忆编译完成，system prompt 已刷新`);
        },
        sessionDir: this.sessionDir,
        memoryMdPath: this.memoryMdPath,
        todayMdPath: this.todayMdPath,
        weekMdPath: this.weekMdPath,
        longtermMdPath: this.longtermMdPath,
        factsMdPath: this.factsMdPath,
        experienceDir: path.join(this.agentDir, "experience"),
        experienceIndexPath: path.join(this.agentDir, "experience.md"),
      });
      log(`  [agent] 4. memoryTicker 创建完成`);

      // 5. 后台跑首次 tick（不阻塞启动，memory.md 已有上次编译结果）
      log(`  [agent] 5. 后台 tick...`);
      this._memoryTicker.tick().then(() => {
        log(`✿ 记忆整理完成`);
      }).catch((err) => {
        console.error(`[记忆] 启动 tick 出错：${err.message}`);
      });

      // 6. 启动定时调度
      this._memoryTicker.start();
    } else {
      console.warn(`[agent] ⚠ 未配置 utility 模型，记忆系统暂不可用（用户可在设置中配置后重启）`);
    }

    // 7. 创建工具（记忆 + 通用）
    log(`  [agent] 7. 创建工具...`);
    this._memorySearchTool = createMemorySearchTool(this._factStore);
    this._webFetchTool = createWebFetchTool();
    this._todoTool = createTodoTool();
    this._pinnedMemoryTools = createPinnedMemoryTools(this.agentDir);
    this._experienceTools = createExperienceTools(this.agentDir);

    // 8. Desk 系统（与 memory 完全独立）
    log(`  [agent] 8. Desk 系统...`);
    this._deskManager = createDeskManager(this.deskDir);
    this._deskManager.ensureDir();
    this._cronStore = new CronStore(
      path.join(this.deskDir, "cron-jobs.json"),
      path.join(this.deskDir, "cron-runs"),
    );
    this._cronTool = createCronTool(this._cronStore, {
      getAutoApprove: () => this._config?.desk?.cron_auto_approve !== false,
      confirmStore: this._engine?.confirmStore,
      emitEvent: (event) => this._engine?._emitEvent(event, this._engine?._sessionCoord?.currentSessionPath),
      getSessionPath: () => this._engine?._sessionCoord?.currentSessionPath,
    });
    this._presentFilesTool = createPresentFilesTool();
    this._artifactTool = createArtifactTool();
    this._browserTool = createBrowserTool();
    this._notifyTool = createNotifyTool({
      onNotify: (title, body, opts) => this._notifyHandler?.(title, body, opts),
    });

    // 10. 设置修改工具
    this._updateSettingsTool = createUpdateSettingsTool({
      getEngine: () => this._engine,
      getConfirmStore: () => this._engine?.confirmStore,
      getSessionPath: () => this._engine?._sessionCoord?.currentSessionPath,
      emitEvent: (event) => this._engine?._emitEvent(event, this._engine?._sessionCoord?.currentSessionPath),
    });

    this._describeImagesTool = createDescribeImagesTool({
      getSessionImages: (sessionPath) => this._engine?.getSessionPendingImages?.(sessionPath) || [],
      getCurrentSessionPath: () => this._engine?.currentSessionPath || null,
      getLatestSessionImages: () => this._engine?.getLatestSessionPendingImages?.() || [],
      getSessionMessages: (sessionPath) => this._engine?.getMessages?.(sessionPath) || [],
      resolveVisionModel: () => {
        if (!this._engine) throw new Error(t("error.imageToolNoModel"));
        const shared = this._engine.getSharedModels?.() || {};
        const modelRef =
          shared.image_understanding ||
          shared.utility ||
          this._config?.models?.utility ||
          this._config?.models?.chat;
        if (!modelRef) throw new Error(t("error.imageToolNoModel"));
        return this._engine.resolveModelWithCredentials(modelRef, this._config);
      },
    });

    this._generateImagesTool = createGenerateImagesTool({
      getSessionImages: (sessionPath) => this._engine?.getSessionPendingImages?.(sessionPath) || [],
      getCurrentSessionPath: () => this._engine?.currentSessionPath || null,
      getLatestSessionImages: () => this._engine?.getLatestSessionPendingImages?.() || [],
      getSessionMessages: (sessionPath) => this._engine?.getMessages?.(sessionPath) || [],
      resolveImageGenerationModel: () => {
        if (!this._engine) throw new Error(t("error.providerMissingCreds", { provider: "minimax/modelscope" }));
        const isLocal = (url) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(String(url || ""));
        const readProvider = (providerName) => {
          const creds = this._engine.resolveProviderCredentials?.(providerName, this._config) || {};
          const baseUrl = String(creds.base_url || "").trim();
          const apiKey = String(creds.api_key || "").trim();
          if (!baseUrl) return null;
          if (!apiKey && !isLocal(baseUrl)) return null;
          return {
            provider: providerName,
            api: creds.api || "openai-completions",
            api_key: apiKey,
            base_url: baseUrl,
            model: providerName === "modelscope" ? "Qwen/Qwen-Image-2512" : "image-01",
          };
        };

        // 优先走 MiniMax（支持 API Key / OAuth），并内置 ModelScope 兜底模型
        const minimax = readProvider("minimax") || readProvider("minimax-oauth");
        const modelscope = readProvider("modelscope");
        if (minimax) {
          return {
            ...minimax,
            fallback: modelscope
              ? { ...modelscope, model: "Qwen/Qwen-Image-2512" }
              : null,
          };
        }
        if (modelscope) return { ...modelscope, model: "Qwen/Qwen-Image-2512" };

        throw new Error(t("error.providerMissingCreds", { provider: "minimax/modelscope" }));
      },
    });

    // 9. 频道工具 + 私信工具（需要 channelsDir 和 agentsDir）
    if (this.channelsDir && this.agentsDir) {
      const agentId = path.basename(this.agentDir);
      const listAgents = () => {
        try {
          return fs.readdirSync(this.agentsDir, { withFileTypes: true })
            .filter(e => e.isDirectory() && fs.existsSync(path.join(this.agentsDir, e.name, "config.yaml")))
            .map(e => {
              try {
                const raw = fs.readFileSync(path.join(this.agentsDir, e.name, "config.yaml"), "utf-8");
                const nameMatch = raw.match(/^\s*name:\s*(.+)$/m);
                return { id: e.name, name: nameMatch?.[1]?.trim() || e.name };
              } catch { return { id: e.name, name: e.name }; }
            });
        } catch { return []; }
      };

      this._channelTool = createChannelTool({
        channelsDir: this.channelsDir,
        agentsDir: this.agentsDir,
        agentId,
        listAgents,
        onPost: (channelName, senderId, content) => {
          this._channelPostHandler?.(channelName, senderId, content);
        },
      });

      this._askAgentTool = createAskAgentTool({
        agentId,
        listAgents,
        engine: this._engine,
      });

      this._dmTool = createDmTool({
        agentId,
        agentsDir: path.dirname(this.agentDir),
        listAgents,
        onDmSent: (fromId, toId) => this._dmSentHandler?.(fromId, toId),
      });
    }

    // 10. delegate 工具（sub-agent 委派）
    this._delegateTool = createDelegateTool({
      executeIsolated: (prompt, opts) => {
        if (!this._engine) throw new Error("delegate 调用失败：engine 未初始化");
        return this._engine.executeIsolated(prompt, opts);
      },
      resolveUtilityModel: () => this._memoryModel || this._utilityModel || null,
      readOnlyBuiltinTools: READ_ONLY_BUILTIN_TOOLS,
    });

    // 12. 组装 system prompt
    log(`  [agent] 9. buildSystemPrompt...`);
    this._systemPrompt = this.buildSystemPrompt();
    log(`  [agent] init 全部完成`);
  }

  /**
   * 优雅关闭：停止记忆调度，等待 tick 完成后关闭 DB
   */
  async dispose() {
    await this._memoryTicker?.stop();
    this._factStore?.close();
  }

  /**
   * 非阻塞关闭：立即停止定时器，后台等 tick 完成后关闭 DB
   * 用于跨 agent 切换时不阻塞 UI（各 agent 的 DB 独立，不冲突）
   */
  disposeInBackground() {
    this._disposing = true;
    const ticker = this._memoryTicker;
    const factStore = this._factStore;

    const cleanup = () => {
      this._memoryTicker = null;
      this._factStore = null;
      this._disposing = false;
      factStore?.close();
    };

    if (ticker) {
      ticker.stop().then(cleanup).catch(cleanup);
    } else {
      cleanup();
    }
  }

  // ════════════════════════════
  //  状态访问
  // ════════════════════════════

  get config() { return this._config; }
  get factStore() { return this._factStore; }
  get systemPrompt() { return this._systemPrompt; }
  /** 综合记忆状态：master && session 都开启才为 true */
  get memoryEnabled() { return this._memoryMasterEnabled && this._memorySessionEnabled; }
  /** agent 级别总开关 */
  get memoryMasterEnabled() { return this._memoryMasterEnabled; }
  /** per-session 级别（持久化、API 返回用，不受 master 影响） */
  get sessionMemoryEnabled() { return this._memorySessionEnabled; }
  get publicIshiki() { return this._readPublicIshiki(); }
  get utilityModel() { return this._utilityModel; }
  get memoryModel() { return this._memoryModel; }
  get resolvedMemoryModel() { return this._resolvedMemoryModel; }
  get summaryManager() { return this._summaryManager; }
  get memoryTicker() { return this._memoryTicker; }
  getAllCustomTools() {
    return [
      this._memorySearchTool,
      ...this._pinnedMemoryTools,
      ...this._experienceTools,
      this._webFetchTool,
      this._todoTool,
      this._cronTool,
      this._presentFilesTool,
      this._artifactTool,
      this._channelTool,
      this._askAgentTool,
      this._dmTool,
      this._browserTool,
      this._describeImagesTool,
      this._generateImagesTool,
      this._notifyTool,
      this._updateSettingsTool,
      this._delegateTool,
    ].filter(Boolean);
  }
  get tools() {
    const memTools = this.memoryEnabled ? [
      this._memorySearchTool,
      ...this._pinnedMemoryTools,
      ...this._experienceTools,
    ] : [];
    return [
      ...memTools,
      this._webFetchTool,
      this._todoTool,
      this._cronTool,
      this._presentFilesTool,
      this._artifactTool,
      this._channelTool,
      this._askAgentTool,
      this._dmTool,
      this._browserTool,
      this._describeImagesTool,
      this._generateImagesTool,
      this._notifyTool,
      this._updateSettingsTool,
      this._delegateTool,
    ].filter(Boolean);
  }

  // Desk 系统访问
  get deskManager() { return this._deskManager; }
  get cronStore() { return this._cronStore; }

  _resolveUserName() {
    const globalName = String(this._engine?.getUserName?.() || "").trim();
    if (globalName) return globalName;
    const localName = String(this._config?.user?.name || "").trim();
    if (localName) return localName;
    const isZh = String(this._config?.locale || "").startsWith("zh");
    return isZh ? "用户" : "User";
  }

  // ════════════════════════════
  //  记忆开关
  // ════════════════════════════

  /** 设置 per-session 记忆开关（持久化由 engine 负责） */
  setMemoryEnabled(val) {
    this._memorySessionEnabled = !!val;
    this._systemPrompt = this.buildSystemPrompt();
  }

  /** 查询指定 session 的持久化记忆开关，缺省视为开启 */
  isSessionMemoryEnabledFor(sessionPath) {
    if (!sessionPath) return this._memorySessionEnabled;
    try {
      const metaPath = path.join(this.sessionDir, "session-meta.json");
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      return meta[path.basename(sessionPath)]?.memoryEnabled !== false;
    } catch {
      return true;
    }
  }

  /** 设置 agent 级别记忆总开关（同时重载 config 以获取 disabledSince/reenableAt） */
  setMemoryMasterEnabled(val) {
    this._memoryMasterEnabled = !!val;
    this._config = loadConfig(this.configPath);
    this._systemPrompt = this.buildSystemPrompt();
  }

  /** 设置当前启用的 skill 列表（由 engine._syncAgentSkills 调用） */
  setEnabledSkills(skills) {
    this._enabledSkills = skills || [];
    this._systemPrompt = this.buildSystemPrompt();
  }

  /** 强制重建 system prompt（例如会话 cwd 变化后） */
  refreshSystemPrompt() {
    this._systemPrompt = this.buildSystemPrompt();
    return this._systemPrompt;
  }

  // ════════════════════════════
  //  配置更新
  // ════════════════════════════

  /**
   * 更新配置（写入 config.yaml 并刷新受影响的模块）
   * @param {object} partial - 要合并的配置片段
   */
  updateConfig(partial) {
    // 写入磁盘 + 重新加载
    saveConfig(this.configPath, partial);
    this._config = loadConfig(this.configPath);

    // 更新身份（无条件回填，确保外部改动后的 refresh 也能生效）
    this.agentName = this._config.agent?.name || "Hanako";
    this.userName = this._resolveUserName();

    // yuan 切换只需更新 config，buildSystemPrompt 会实时读模板
    if (partial.agent?.yuan) {
      console.log(`[agent] yuan type switched to: ${partial.agent.yuan}`);
    }

    // 记忆总开关
    if (partial.memory && "enabled" in partial.memory) {
      this._memoryMasterEnabled = this._config.memory?.enabled !== false;
    }

    // 重建 system prompt
    this._systemPrompt = this.buildSystemPrompt();
  }

  // ════════════════════════════
  //  System Prompt 组装
  // ════════════════════════════

  /** 返回纯人格 prompt（identity + ishiki），不含记忆、用户档案等 */
  get personality() {
    const isZh = String(this._config.locale || "").startsWith("zh");
    const agentId = path.basename(this.agentDir);
    const defaultUserName = isZh ? "用户" : "User";
    const normalizedUserName = String(this.userName || "").trim();
    const hasExplicitUserName = !!normalizedUserName
      && (isZh ? normalizedUserName !== defaultUserName : normalizedUserName.toLowerCase() !== defaultUserName.toLowerCase());
    const fill = (text) => text
      .replace(/\{\{userName\}\}/g, this.userName)
      .replace(/\{\{agentName\}\}/g, this.agentName)
      .replace(/\{\{agentId\}\}/g, agentId);
    const readFile = (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return ""; } };
    const langDir = isZh ? "" : "en/";
    const yuanType = this._config?.agent?.yuan || "hanako";
    const identityMd = readFile(path.join(this.agentDir, "identity.md"))
      || readFile(path.join(this.productDir, "identity-templates", `${langDir}${yuanType}.md`))
      || readFile(path.join(this.productDir, "identity-templates", `${yuanType}.md`))
      || readFile(path.join(this.productDir, "identity.example.md"));
    const ishikiMd = readFile(path.join(this.agentDir, "ishiki.md"))
      || readFile(path.join(this.productDir, "ishiki-templates", `${langDir}${yuanType}.md`))
      || readFile(path.join(this.productDir, "ishiki-templates", `${yuanType}.md`))
      || readFile(path.join(this.productDir, "ishiki.example.md"));
    const identityAnchor = isZh
      ? [
          "# 身份锚点",
          `- 你的名字是「${this.agentName}」(agentId: ${agentId})。`,
          `- 当前与你对话的人类用户名字是「${this.userName}」。`,
          `- 当用户问“你是谁 / 你叫什么”时，直接回答“我叫${this.agentName}”。`,
          hasExplicitUserName
            ? `- 当用户问“我是谁 / 我叫什么”时，直接回答“你是${this.userName}”。`
            : `- 当用户问“我是谁 / 我叫什么”时，先说明暂未获得名字，再请用户告诉你希望怎么称呼。`,
          "- 除非用户明确要求你改名，否则不要自称为其他名字。",
        ].join("\n")
      : [
          "# Identity Anchor",
          `- Your name is "${this.agentName}" (agentId: ${agentId}).`,
          `- The human user currently talking to you is "${this.userName}".`,
          `- If asked who you are / what your name is, answer: "My name is ${this.agentName}."`,
          hasExplicitUserName
            ? `- If the user asks "Who am I / What's my name?", answer: "You are ${this.userName}."`
            : `- If the user asks "Who am I / What's my name?", say their name is not set yet and ask how they want to be addressed.`,
          "- Do not claim any other name unless the user explicitly asks you to rename yourself.",
        ].join("\n");
    return identityAnchor + "\n\n" + fill(identityMd) + "\n\n" + fill(ishikiMd);
  }

  /** 读取对外意识（public-ishiki.md），guest 会话使用 */
  _readPublicIshiki() {
    const readFile = (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return ""; } };
    const fill = (text) => text
      .replace(/\{\{userName\}\}/g, this.userName)
      .replace(/\{\{agentName\}\}/g, this.agentName)
      .replace(/\{\{agentId\}\}/g, path.basename(this.agentDir));
    const yuanType = this._config?.agent?.yuan || "hanako";
    const isZh = String(this._config.locale || "").startsWith("zh");
    const langDir = isZh ? "" : "en/";
    const raw = readFile(path.join(this.agentDir, "public-ishiki.md"))
      || readFile(path.join(this.productDir, "public-ishiki-templates", `${langDir}${yuanType}.md`))
      || readFile(path.join(this.productDir, "public-ishiki-templates", `${yuanType}.md`))
      || "";
    return fill(raw);
  }

  /** 组装 system prompt */
  buildSystemPrompt() {
    const isZh = String(this._config.locale || "").startsWith("zh");
    const agentId = path.basename(this.agentDir || "");

    const toolProfile = this._engine?.getAgentPermissionConfig?.(agentId) || null;
    const runtimeCustomNames = new Set((this.tools || []).map((tool) => tool?.name).filter(Boolean));
    const enabledBuiltin = Array.isArray(toolProfile?.tools?.builtin_enabled)
      ? toolProfile.tools.builtin_enabled
      : ["read", "grep", "find", "ls", "write", "edit", "bash"];
    const enabledCustom = Array.isArray(toolProfile?.tools?.custom_enabled)
      ? toolProfile.tools.custom_enabled.filter((name) => runtimeCustomNames.has(name))
      : [...runtimeCustomNames];
    const builtinRequired = Array.isArray(toolProfile?.tool_catalog?.builtin_required)
      ? toolProfile.tool_catalog.builtin_required
      : ["read", "grep", "find", "ls"];
    const builtinOptional = Array.isArray(toolProfile?.tool_catalog?.builtin_optional)
      ? toolProfile.tool_catalog.builtin_optional
      : ["write", "edit", "bash"];
    const hasTool = (name) => enabledBuiltin.includes(name) || enabledCustom.includes(name);

    const readFile = (filePath) => {
      try { return fs.readFileSync(filePath, "utf-8"); } catch { return ""; }
    };

    // identity + ishiki（复用 personality getter）
    const ishiki = this.personality;

    // 可选文件
    const userMd = readFile(path.join(this.userDir, "user.md"));
    const pinnedMd = readFile(path.join(this.agentDir, "pinned.md"));
    const memory = readFile(this.memoryMdPath);

    // 构建 section 分隔格式的 prompt
    const section = (title, content) => ["", "---", "", title, "", content];

    const parts = [
      isZh
        ? "你运行在 OpenHanako 平台上，由 liliMozi 开发。项目主页：https://github.com/liliMozi/openhanako"
        : "You are running on the OpenHanako platform, developed by liliMozi. Project page: https://github.com/liliMozi/openhanako",
      ishiki,
      ...section(
        isZh ? "# 用户档案" : "# User Profile",
        isZh
          ? `当前用户名称（来自设置）：${this.userName}\n以下是用户的自我描述，由用户手动维护。\n\n${userMd}`
          : `Current user name (from settings): ${this.userName}\nThe following is the user's self-description, manually maintained by the user.\n\n${userMd}`
      ),
    ];
    // 记忆整体开关：master && session 都开启才注入记忆相关 prompt
    if (this.memoryEnabled) {
      const memoryRule = isZh ? [
        "",
        "## 记忆使用规则",
        "",
        "记忆和用户档案是你内化的背景知识。你和" + this.userName + "是认识很久的人，这些事你本来就知道。你对" + this.userName + "的了解应该像空气一样，在场但不可见。记忆的存在感应该是零，它的作用应该是满的。",
        "",
        "- **只有当" + this.userName + "提到了相关内容，记忆才参与进来。** " + this.userName + "没有提起的话题，你不要主动从记忆里翻出来讲。不要因为记忆里有某条信息就觉得\"我应该提一下\"。记忆参与的方式是无声的：影响你的角度、语气、判断，但不出现在文字里。",
        "- **永远不要让" + this.userName + "感觉到\"记忆\"这个东西的存在。** 禁止使用\"我记得\"\"你之前说过\"\"根据记忆\"这类表述。除非" + this.userName + "主动问\"你还记得 xxx 吗\"。",
        "- **记忆可能过时，当前对话永远优先。** 信息冲突时以对话为准，不要用旧记忆纠正" + this.userName + "。",
      ].join("\n") : [
        "",
        "## Memory Rules",
        "",
        "Memories and the user profile are internalized background knowledge. You and " + this.userName + " have known each other for a long time — you already know these things. Your knowledge of " + this.userName + " should be like air: present but invisible. Memory's presence should be zero; its effect should be full.",
        "",
        "- **Memory only participates when " + this.userName + " brings up something related.** If " + this.userName + " hasn't touched on a topic, don't pull it from memory. Don't think \"I should mention this\" just because it's in your memory. When memory does participate, it's silent: shaping your angle, tone, and judgment, but never appearing in the text itself.",
        "- **Never let " + this.userName + " sense that \"memory\" exists as a thing.** Never use phrases like \"I remember,\" \"you mentioned before,\" or \"based on my memory.\" The only exception is when " + this.userName + " explicitly asks \"do you remember xxx.\"",
        "- **Memory can be outdated; the current conversation always takes priority.** When information conflicts, go with the conversation. Don't use old memories to correct " + this.userName + ".",
      ].join("\n");

      if (pinnedMd.trim()) {
        parts.push(...section(
          isZh ? "# 置顶记忆" : "# Pinned Memories",
          isZh
            ? "用户主动要求你记住的内容，始终保留。你可以读写这些记忆。\n" + memoryRule + "\n\n" + pinnedMd
            : "Content the user explicitly asked you to remember. Always retained. You can read and write these memories.\n" + memoryRule + "\n\n" + pinnedMd
        ));
      }
      const trimmedMemory = memory.trim();
      if (trimmedMemory && trimmedMemory !== "（暂无记忆）" && trimmedMemory !== "(No memory yet)") {
        parts.push(...section(
          isZh ? "# 记忆" : "# Memory",
          isZh
            ? memoryRule.trimStart() + "\n\n以下这些是从过往对话积累的记忆。\n\n" + memory
            : memoryRule.trimStart() + "\n\nThe following are memories accumulated from past conversations.\n\n" + memory
        ));
      }
    }

    // Skills 注入：仅注入当前 Agent 已启用的技能（available_skills）
    if (this._enabledSkills?.length > 0) {
      parts.push(formatSkillsForPrompt(this._enabledSkills));
    }

    const optionalEnabled = builtinOptional.filter((name) => enabledBuiltin.includes(name));
    parts.push(
      isZh
        ? "\n## 可用工具\n\n" +
          `内置工具（必开）：${builtinRequired.join(", ")}\n` +
          `内置工具（已开启）：${optionalEnabled.length ? optionalEnabled.join(", ") : "无"}\n` +
          `自定义工具（已开启）：${enabledCustom.length ? enabledCustom.join(", ") : "无"}\n\n` +
          "如果工具不在以上清单中，视为不可用，不要尝试调用。"
        : "\n## Available Tools\n\n" +
          `Built-in required: ${builtinRequired.join(", ")}\n` +
          `Built-in enabled: ${optionalEnabled.length ? optionalEnabled.join(", ") : "none"}\n` +
          `Custom enabled: ${enabledCustom.length ? enabledCustom.join(", ") : "none"}\n\n` +
          "If a tool is not listed above, treat it as unavailable and do not call it."
    );

    // 设置工具路由
    parts.push(hasTool("update_settings")
      ? (isZh
          ? "\n## 设置修改\n\n" +
            "用户提到修改设置而未指明具体软件时，默认指本应用的设置。\n" +
            "用户要求修改偏好设置（包括但不限于：外观主题、语言地区、模型选择、安全权限、记忆功能、个人信息、工作目录）时，使用 update_settings 工具。不要搜索网页，不要编辑配置文件。意图明确时直接 apply，不确定时先 search。"
          : "\n## Settings Changes\n\n" +
            "When the user mentions changing settings without specifying a particular application, assume they mean this application.\n" +
            "When the user asks to change preferences (including but not limited to: appearance/theme, language/region, model selection, security/permissions, memory, personal info, working directory), use the update_settings tool. Do not search the web or edit config files. When intent is clear, apply directly; when unsure, search first.")
      : (isZh
          ? "\n## 设置修改\n\nupdate_settings 工具当前不可用。你不能声称已修改应用设置；需要明确告知用户该限制，并给出手动操作步骤。"
          : "\n## Settings Changes\n\nThe update_settings tool is currently unavailable. Do not claim settings were changed; clearly explain this limit and provide manual steps.")
    );

    const hasSearchTool = hasTool("web_search") || hasTool("web_fetch");
    if (!hasSearchTool && hasTool("browser")) {
      parts.push(isZh
        ? "如果当前没有可用的搜索工具，且需要联网检索信息，请直接使用 browser 工具操作浏览器完成搜索。"
        : "If no search tool is available and web lookup is needed, use the browser tool directly to search in a browser.");
    } else if (!hasSearchTool && !hasTool("browser")) {
      parts.push(isZh
        ? "当前无可用联网检索工具（search/browser）；需要联网信息时请明确说明能力受限。"
        : "No web lookup tools are available (search/browser). If internet data is required, clearly state this limitation.");
    }

    if (hasTool("describe_images")) {
      parts.push(isZh
        ? "当用户给出图片文件的绝对路径（或 file:// URI）并要求识别/描述时，优先调用 describe_images，并通过 image_paths 或 image_path 传入路径。该工具会自动读取图片文件并转换为 base64 后进行理解。"
        : "When the user provides absolute image file paths (or file:// URIs) and asks for recognition/description, call describe_images first and pass paths via image_paths or image_path. The tool will read image files and convert them to base64 for vision understanding.");
    }

    if (hasTool("generate_images")) {
      parts.push(isZh
        ? "当用户要求生成图片（文生图或图生图）时，优先调用 generate_images 工具，不要凭空声称“已生成”。图生图可使用当前会话里用户上传的图片作为参考。调用 generate_images 后不要再重复调用 present_files 展示同一图片，除非用户明确要求展示文件卡片/链接。"
        : "When the user asks to generate images (text-to-image or image-to-image), use the generate_images tool. Do not claim an image was generated without calling it. For image-to-image, use user-uploaded images in the current session as references. After calling generate_images, do not call present_files again for the same images unless the user explicitly asks for file cards/links.");
    }

    // 工作区提示（注入默认工作区 + 当前 cwd）
    const defaultWorkspace = this._engine?.getHomeFolder?.(agentId) || this._config?.desk?.home_folder || "";
    const cwdPath = this._engine?.cwd || "";
    parts.push(isZh
      ? `\n## 工作区\n\n` +
        `用户所说的「书桌」「工作空间」指的是你的工作目录（workspace/cwd），不是系统桌面（~/Desktop）。` +
        (defaultWorkspace ? `\n默认工作区：${defaultWorkspace}` : "") +
        (cwdPath ? `\n当前执行目录（cwd）：${cwdPath}` : "")
      : `\n## Workspace\n\n` +
        `When the user says "desk" (书桌) or "workspace", they mean your working directory (workspace/cwd), NOT the system Desktop (~/Desktop).` +
        (defaultWorkspace ? `\nDefault workspace: ${defaultWorkspace}` : "") +
        (cwdPath ? `\nCurrent execution directory (cwd): ${cwdPath}` : "")
    );

    // 日期时间
    const now = new Date();
    const dateTime = now.toLocaleString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    });
    parts.push(`\nCurrent date and time: ${dateTime}`);
    parts.push(isZh
      ? "你的一天从凌晨 4:00 开始。4:00 之前的对话属于前一天。"
      : "Your day starts at 4:00 AM. Conversations before 4:00 AM belong to the previous day.");

    return parts.join("\n");
  }
}
