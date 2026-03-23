/**
 * BridgeSessionManager — Bridge（外部平台）session 管理
 *
 * 负责 bridge session 索引读写、外部消息执行、消息注入。
 * 从 Engine 提取，Engine 通过 manager 访问 bridge 功能。
 */
import fs from "fs";
import path from "path";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { debugLog } from "../lib/debug-log.js";
import { t, getLocale } from "../server/i18n.js";

function getSteerPrefix() {
  const isZh = getLocale().startsWith("zh");
  return isZh ? "（插话，无需 MOOD）\n" : "(Interjection, no MOOD needed)\n";
}

export class BridgeSessionManager {
  /**
   * @param {object} deps - 注入依赖（不持有 engine 引用）
   * @param {() => object} deps.getAgent - 返回当前 agent（需 sessionDir, yuanPrompt）
   * @param {(id: string) => object|null} deps.getAgentById - 按 ID 获取 agent
   * @param {(agent: object) => object} [deps.getSkillsForAgent] - 获取指定 agent 的 skills
   * @param {() => import('./model-manager.js').ModelManager} deps.getModelManager
   * @param {() => object} deps.getResourceLoader
   * @param {() => object} deps.getPreferences
   * @param {(cwd: string, customTools?, opts?) => {tools: any[], customTools: any[]}} deps.buildTools
   * @param {() => string} deps.getHomeCwd
   */
  constructor(deps) {
    this._deps = deps;
    this._activeSessions = new Map();
  }

  /** 活跃 bridge sessions（供 bridge-manager abort 用） */
  get activeSessions() { return this._activeSessions; }

  /** 指定 bridge session 是否正在 streaming */
  isSessionStreaming(sessionKey) {
    return this._activeSessions.get(sessionKey)?.isStreaming ?? false;
  }

  /** abort 指定 bridge session（如果正在 streaming） */
  async abortSession(sessionKey) {
    const session = this._activeSessions.get(sessionKey);
    if (!session?.isStreaming) return false;
    await session.abort();
    return true;
  }

  /** bridge 索引文件路径 */
  _indexPath(agent) {
    const a = agent || this._deps.getAgent();
    return path.join(a.sessionDir, "bridge", "bridge-sessions.json");
  }

  /**
   * 启动时 sanity check：扫描 bridge-index，清理孤儿条目
   * （有 file 引用但 JSONL 文件已不存在的）
   */
  reconcile() {
    const index = this.readIndex();
    const bridgeDir = path.join(this._deps.getAgent().sessionDir, "bridge");
    let cleaned = 0;

    for (const [sessionKey, raw] of Object.entries(index)) {
      const entry = typeof raw === "string" ? { file: raw } : raw;
      if (!entry.file) continue;
      const fp = path.join(bridgeDir, entry.file);
      if (!fs.existsSync(fp)) {
        // 保留元数据（name/avatarUrl/userId），只删 file 引用
        delete entry.file;
        index[sessionKey] = entry;
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.writeIndex(index);
      console.log(`[bridge-session] reconcile: 清理 ${cleaned} 个孤儿 session 引用`);
      debugLog()?.log("bridge", `reconcile: cleaned ${cleaned} orphan session refs`);
    }
  }

  /** 读取 bridge session 索引 */
  readIndex(agent) {
    try {
      return JSON.parse(fs.readFileSync(this._indexPath(agent), "utf-8"));
    } catch { return {}; }
  }

  /** 写入 bridge session 索引 */
  writeIndex(index, agent) {
    const dir = path.dirname(this._indexPath(agent));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this._indexPath(agent), JSON.stringify(index, null, 2) + "\n", "utf-8");
  }

  /**
   * 解析本次消息应使用的 agent：
   * - 优先使用 opts.agentId
   * - getAgentById 不可用/异常时回退当前 agent，避免外部会话直接失败
   */
  _resolveAgent(agentId) {
    const fallback = this._deps.getAgent();
    if (!agentId || !this._deps.getAgentById) return fallback;
    try {
      return this._deps.getAgentById(agentId) || fallback;
    } catch (err) {
      debugLog()?.error("bridge-session", `getAgentById failed (${agentId}): ${err.message}`);
      return fallback;
    }
  }

  /**
   * 解析 bridge 会话应使用的模型：
   * - 优先 agent.config.models.chat
   * - 未配置或不可用时回退全局默认模型
   */
  _resolveBridgeModel(mm, agent) {
    const preferredId = agent?.config?.models?.chat || "";

    if (!preferredId) {
      if (mm.defaultModel) {
        debugLog()?.log("bridge-session", `agent "${agent?.agentName || agent?.id || "unknown"}" 无 chat 模型，回退默认模型 ${mm.defaultModel.id}`);
        return mm.defaultModel;
      }
      throw new Error(t("error.bridgeAgentNoChatModel", { name: agent.agentName }));
    }

    const preferred = mm.availableModels.find((m) => m.id === preferredId);
    if (preferred) return preferred;

    if (mm.defaultModel) {
      debugLog()?.log("bridge-session", `agent "${agent?.agentName || agent?.id || "unknown"}" 模型 "${preferredId}" 不可用，回退默认模型 ${mm.defaultModel.id}`);
      return mm.defaultModel;
    }

    throw new Error(t("error.bridgeAgentModelNotAvailable", { name: agent.agentName, model: preferredId }));
  }

  /**
   * 执行外部平台消息：找到或创建持久 session，prompt 并捕获回复文本
   * @param {string} prompt - 格式化后的用户消息
   * @param {string} sessionKey - 会话标识（如 tg_dm_12345）
   * @param {object} [meta] - 元数据（name, avatarUrl, userId）
   * @param {object} [opts] - { guest: boolean, onDelta? }
   * @returns {Promise<string|null>} agent 的回复文本
   */
  async executeExternalMessage(prompt, sessionKey, meta, opts = {}) {
    // 优先用调用方传入的 agentId，避免 debounce 窗口内切 agent 导致路由到错误 agent
    const agent = this._resolveAgent(opts.agentId);
    const mm = this._deps.getModelManager();
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const subDir = opts.guest ? "guests" : "owner";
    const sessionDir = path.join(bridgeDir, subDir);
    fs.mkdirSync(sessionDir, { recursive: true });

    // 查找已有 session（兼容旧格式字符串和新格式对象）
    const index = this.readIndex(agent);
    const raw = index[sessionKey];
    const existingFile = typeof raw === "string" ? raw : raw?.file || null;
    const existingPath = existingFile ? path.join(bridgeDir, existingFile) : null;

    try {
      let mgr;
      if (existingPath) {
        try {
          mgr = SessionManager.open(existingPath, sessionDir);
        } catch {
          mgr = null;
        }
      }
      const homeCwd = this._deps.getHomeCwd() || process.cwd();
      if (!mgr) {
        mgr = SessionManager.create(homeCwd, sessionDir);
      }

      // Bridge 媒体协议：让模型通过 MEDIA:<url|file://|绝对路径> 返回媒体项。
      const mediaInstruction = "当你需要发送媒体文件（图片、视频、音频、文件）时，在回复中单独一行写 MEDIA:<url>，例如：\nMEDIA:https://example.com/photo.jpg\n不要把 MEDIA: 写在代码块里。一行一个。";

      // 外部会话统一走完整 agent 能力（记忆 + 工具）
      const prefs = this._deps.getPreferences();
      const bridgeCwd = homeCwd;
      const { tools: bridgeTools, customTools: bridgeCustomTools } = this._deps.buildTools(
        bridgeCwd,
        agent.tools,
        { agentDir: agent.agentDir, workspace: homeCwd },
      );

      const model = this._resolveBridgeModel(mm, agent);

      const baseRL = this._deps.getResourceLoader();
      const rl = Object.create(baseRL, {
        getSystemPrompt: {
          value: () => `${agent.systemPrompt}\n\n${mediaInstruction}`,
        },
      });
      if (this._deps.getSkillsForAgent) {
        Object.defineProperty(rl, "getSkills", {
          value: () => this._deps.getSkillsForAgent(agent),
        });
      }

      const sessionOpts = {
        model,
        thinkingLevel: mm.resolveThinkingLevel(prefs?.thinking_level || "auto"),
        resourceLoader: rl,
        tools: bridgeTools,
        customTools: bridgeCustomTools,
        settingsManager: this._createSettings(model),
      };

      const { session } = await createAgentSession({
        cwd: homeCwd,
        sessionManager: mgr,
        authStorage: mm.authStorage,
        modelRegistry: mm.modelRegistry,
        ...sessionOpts,
      });

      this._activeSessions.set(sessionKey, session);

      // 捕获文本输出
      let capturedText = "";
      const unsub = session.subscribe((event) => {
        if (event.type === "message_update") {
          const sub = event.assistantMessageEvent;
          if (sub?.type === "text_delta") {
            const delta = sub.delta || "";
            capturedText += delta;
            try { opts.onDelta?.(delta, capturedText); } catch {}
          }
        }
      });

      try {
        const promptOpts = opts.images?.length ? { images: opts.images } : undefined;
        await session.prompt(prompt, promptOpts);
      } finally {
        unsub?.();
        this._activeSessions.delete(sessionKey);
      }

      // 更新索引 + 元数据
      const sessionPath = session.sessionManager?.getSessionFile?.();
      if (sessionPath) {
        const fileName = `${subDir}/${path.basename(sessionPath)}`;
        if (!existingFile) {
          index[sessionKey] = { file: fileName, ...(meta || {}) };
        } else if (meta) {
          const entry = typeof index[sessionKey] === "string"
            ? { file: index[sessionKey] }
            : index[sessionKey];
          Object.assign(entry, meta);
          index[sessionKey] = entry;
        }
        this.writeIndex(index, agent);
      }

      return capturedText.trim() || null;
    } catch (err) {
      console.error(`[bridge-session] external message failed (${sessionKey}):`, err.message);
      return null;
    }
  }

  /**
   * 向正在 streaming 的 bridge session 注入 steer 消息
   * @param {string} sessionKey
   * @param {string} text
   * @returns {boolean} 是否成功注入
   */
  steerSession(sessionKey, text) {
    const session = this._activeSessions.get(sessionKey);
    if (!session?.isStreaming) return false;
    session.steer(getSteerPrefix() + text);
    return true;
  }

  /**
   * 往指定 bridge session 追加一条 assistant 消息（不触发 LLM）
   * @param {string} sessionKey - bridge session 标识
   * @param {string} text - 要追加的 assistant 消息文本
   * @returns {boolean}
   */
  injectMessage(sessionKey, text) {
    try {
      const index = this.readIndex();
      const raw = index[sessionKey];
      const existingFile = typeof raw === "string" ? raw : raw?.file || null;
      if (!existingFile) {
        console.warn(`[bridge-session] injectMessage: sessionKey "${sessionKey}" 不存在`);
        return false;
      }

      const bridgeDir = path.join(this._deps.getAgent().sessionDir, "bridge");
      const sessionPath = path.join(bridgeDir, existingFile);
      if (!fs.existsSync(sessionPath)) {
        console.warn(`[bridge-session] injectMessage: session 文件不存在: ${sessionPath}`);
        return false;
      }

      const mgr = SessionManager.open(sessionPath, path.dirname(sessionPath));
      mgr.appendMessage({
        role: "assistant",
        content: [{ type: "text", text }],
      });

      debugLog()?.log("bridge-session", `injected message to ${sessionKey} (${text.length} chars)`);
      return true;
    } catch (err) {
      console.error(`[bridge-session] injectMessage failed: ${err.message}`);
      return false;
    }
  }

  /** 创建 bridge 专用 settings：100k token 触发压缩 */
  _createSettings(model) {
    // 用户手动设置的 context 覆盖优先
    const overrides = this._deps.getAgent?.()?.config?.models?.overrides;
    const ov = model?.id && overrides?.[model.id];
    const contextWindow = ov?.context || model?.contextWindow || 200_000;
    return SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: Math.max(contextWindow - 100_000, 16384),
        keepRecentTokens: 20_000,
      },
    });
  }
}
