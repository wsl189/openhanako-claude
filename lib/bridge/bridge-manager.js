/**
 * bridge-manager.js — 外部平台接入管理器
 *
 * 统一管理 Telegram / 飞书等外部消息平台的生命周期。
 * 每个平台一个 adapter，共享 engine 的 _executeExternalMessage()。
 */

import fs from "fs";
import os from "os";
import path from "path";
import { debugLog } from "../debug-log.js";
import { createTelegramAdapter } from "./telegram-adapter.js";
import { createFeishuAdapter } from "./feishu-adapter.js";
import { createQQAdapter } from "./qq-adapter.js";
import { downloadMedia, bufferToBase64, detectMime, splitMediaFromOutput, formatSize, setMediaLocalRoots } from "./media-utils.js";
import {
  parseSessionKey,
  parsePlatformKey,
  buildPlatformKey,
  buildSessionKey,
  normalizeBridgeBots,
} from "./session-key.js";

// ── Adapter Registry ─────────────────────────────────────
// 每个平台注册：create 工厂、凭证提取。
// 新增平台只需在此注册 + 提供 adapter 文件。
const ADAPTER_REGISTRY = {
  telegram: {
    create: (creds, onMessage, hooks) => createTelegramAdapter({ token: creds.token, onMessage, onStatus: hooks?.onStatus }),
    getCredentials: (cfg) => cfg?.enabled && cfg?.token ? { token: cfg.token } : null,
  },
  feishu: {
    create: (creds, onMessage, hooks) => createFeishuAdapter({ appId: creds.appId, appSecret: creds.appSecret, onMessage, onStatus: hooks?.onStatus }),
    getCredentials: (cfg) => cfg?.enabled && cfg?.appId && cfg?.appSecret ? { appId: cfg.appId, appSecret: cfg.appSecret } : null,
  },
  qq: {
    create: (creds, onMessage, hooks) => createQQAdapter({
      appID: creds.appID, appSecret: creds.appSecret, onMessage,
      dmGuildMap: creds.dmGuildMap,
      onDmGuildDiscovered: hooks?.onQqDmGuild,
      onStatus: hooks?.onStatus,
    }),
    getCredentials: (cfg) => {
      const secret = cfg?.appSecret || cfg?.token; // 兼容旧版 token 字段
      return cfg?.enabled && cfg?.appID && secret
        ? { appID: cfg.appID, appSecret: secret, dmGuildMap: cfg.dmGuildMap }
        : null;
    },
  },
};

/* ── StreamCleaner ─────────────────────────────────────────
 * 增量剥离 <mood>, <pulse>, <reflect>, <tool_code> 标签。
 * 两态状态机（NORMAL / IN_TAG），支持标签跨 delta。
 */
const STRIP_TAGS = ["mood", "pulse", "reflect", "tool_code", "replying"];
const MEDIA_CUT_RE = /^(.*?\.(?:png|jpe?g|gif|webp|bmp|svg|pdf|mp4|mov|mkv|avi|mp3|wav|ogg|m4a|opus|amr|silk|zip|rar|7z|docx?|xlsx?|pptx?|txt|md|json))(?=\s|$)/i;

function extractMediaSourceFromLine(line) {
  const m = /^MEDIA:\s*(.+?)\s*$/.exec(String(line || "").trim());
  if (!m) return null;
  let source = m[1].trim();
  if (!source) return "";

  if (source.startsWith("<") && source.endsWith(">")) {
    source = source.slice(1, -1).trim();
  } else {
    const qm = /^(['"])([\s\S]*?)\1$/.exec(source);
    if (qm) source = qm[2].trim();
  }

  // 容错：同一行里混入描述文本时，尽量截到文件扩展名
  if ((source.startsWith("/") || source.startsWith("file://") || source.startsWith("http://") || source.startsWith("https://")) && !/\.(?:png|jpe?g|gif|webp|bmp|svg|pdf|mp4|mov|mkv|avi|mp3|wav|ogg|m4a|opus|amr|silk|zip|rar|7z|docx?|xlsx?|pptx?|txt|md|json)$/i.test(source)) {
    const cut = source.match(MEDIA_CUT_RE);
    if (cut?.[1]) source = cut[1].trim();
  }

  return source;
}

class StreamCleaner {
  constructor() {
    this._buf = "";
    this._inTag = false;
    this._tagName = null;
    this.cleaned = "";
    /** 流式过程中提取到的媒体 URL */
    this.extractedMedia = [];
    this._inCodeFence = false;
    /** 媒体拦截的行缓冲（处理 delta 分片边界） */
    this._lineBuf = "";
  }

  /** 喂入 delta，返回可发送的干净文本增量（可能为空） */
  feed(delta) {
    this._buf += delta;
    let out = "";

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this._inTag) {
        const close = `</${this._tagName}>`;
        const ci = this._buf.indexOf(close);
        if (ci === -1) break; // 等待更多数据
        this._buf = this._buf.slice(ci + close.length).replace(/^\s*/, "");
        this._inTag = false;
        this._tagName = null;
      } else {
        // 寻找最近的开标签
        let best = null;
        let bestIdx = Infinity;
        for (const tag of STRIP_TAGS) {
          const open = `<${tag}>`;
          const idx = this._buf.indexOf(open);
          if (idx !== -1 && idx < bestIdx) { bestIdx = idx; best = tag; }
        }

        if (best) {
          out += this._buf.slice(0, bestIdx);
          this._buf = this._buf.slice(bestIdx + `<${best}>`.length);
          this._inTag = true;
          this._tagName = best;
        } else {
          // 保留可能的不完整开标签（如 "<moo"）
          let hold = 0;
          for (const tag of STRIP_TAGS) {
            const open = `<${tag}>`;
            for (let len = 1; len < open.length; len++) {
              if (this._buf.endsWith(open.slice(0, len)) && len > hold) hold = len;
            }
          }
          out += this._buf.slice(0, this._buf.length - hold);
          this._buf = this._buf.slice(this._buf.length - hold);
          break;
        }
      }
    }

    // ── 媒体拦截：从 out 中剥离 MEDIA: 和 ![](url) ──
    out = this._interceptMedia(out);

    this.cleaned += out;
    return out;
  }

  /**
   * 从文本增量中拦截媒体标记，返回剥离后的干净文本。
   * 使用行缓冲处理 delta 分片边界（如 "MED" + "IA:https://..."）。
   * 只有遇到换行时才处理完整行，未完成的行 hold 在 _lineBuf 中。
   */
  _interceptMedia(text) {
    if (!text) return text;

    // 把新文本追加到行缓冲
    this._lineBuf += text;

    // 按换行拆分：最后一段如果没有换行，留在 _lineBuf 等下一个 delta
    const parts = this._lineBuf.split("\n");
    this._lineBuf = parts.pop(); // 最后一段（可能不完整）留着

    const cleaned = [];
    for (const line of parts) {
      const processed = this._processLine(line);
      if (processed !== null) cleaned.push(processed);
    }

    return cleaned.length ? cleaned.join("\n") + "\n" : "";
  }

  /** 处理一行完整文本，返回 null 表示该行被媒体拦截移除 */
  _processLine(line) {
    const trimmed = line.trim();
    // 追踪 code fence 状态
    if (trimmed.startsWith("```")) {
      this._inCodeFence = !this._inCodeFence;
      return line;
    }
    if (this._inCodeFence) return line;

    // MEDIA:<source> 指令行（支持 URL 和本地路径）
    const source = extractMediaSourceFromLine(trimmed);
    if (source !== null) {
      // 接受 http(s) URL、file:// URI、绝对路径
      const isHttp = source.startsWith("http://") || source.startsWith("https://");
      const isFile = source.startsWith("file://") || source.startsWith("/");
      if (isHttp || isFile) {
        this.extractedMedia.push(source);
      }
      return null; // 无论是否有效都从输出中移除（不泄漏路径）
    }

    // ![alt](url) — 整行是图片标记时拦截
    const imgMatch = /^!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)\s*$/.exec(trimmed);
    if (imgMatch) {
      this.extractedMedia.push(imgMatch[1]);
      return null;
    }

    return line;
  }

  /** 流结束时 flush 行缓冲中剩余的不完整行 */
  flushLineBuf() {
    if (!this._lineBuf) return "";
    const line = this._lineBuf;
    this._lineBuf = "";
    const processed = this._processLine(line);
    return processed !== null ? processed : "";
  }
}

/* ── BlockChunker ─────────────────────────────────────────
 * 将流式文本按行拆成多条消息（block streaming）。
 *
 * 规则：换行即分块，但 markdown 结构内不拆。
 *   普通行 + \n → flush 为一条气泡
 *   列表 / 代码围栏 / 表格 / 引用 → 积累为一整块
 *   标题（# ）→ 开启「节模式」，节内所有内容攒成一个气泡，
 *              下一个标题触发 flush 并开启新节
 *   结构块结束后恢复逐行发送
 */
class BlockChunker {
  /**
   * @param {object} opts
   * @param {(text: string) => Promise<void>} opts.onFlush  发送一条消息
   * @param {number} [opts.maxChars=2000]  安全上限：无换行时强制 flush
   */
  constructor({ onFlush, maxChars = 2000 }) {
    this._onFlush = onFlush;
    this._maxChars = maxChars;
    this._buf = "";
    this._flushing = Promise.resolve();
    this._inCodeFence = false;
    this._structured = false;
    this._inSection = false;
    this._currentLine = "";
  }

  /** 喂入清理后的文本增量 */
  feed(text) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      this._buf += ch;
      this._currentLine += ch;
      if (ch === '\n') {
        this._onLineEnd(this._currentLine);
        this._currentLine = "";
      }
    }
    // 安全：无换行的超长文本强制 flush
    if (this._buf.length >= this._maxChars && !this._inCodeFence) {
      this._flushBuf();
    }
  }

  /** 流结束：flush 剩余 buffer */
  async finish() {
    await this._flushing;
    const rest = this._buf.trim();
    if (rest) {
      await this._onFlush(rest);
      this._buf = "";
    }
    this._currentLine = "";
  }

  _onLineEnd(line) {
    const stripped = line.replace(/\n$/, '');
    const trimmed = stripped.trim();
    const isEmpty = trimmed === '';

    // ── 代码围栏 ──
    if (trimmed.startsWith('```')) {
      if (this._inCodeFence) {
        // 关闭围栏：flush 整个代码块（含 ``` 行）
        this._inCodeFence = false;
        this._flushBuf();
      } else {
        // 打开围栏：先 flush 围栏前的内容
        this._inCodeFence = true;
        const cutAt = this._buf.length - line.length;
        if (cutAt > 0) this._flushAt(cutAt);
      }
      return;
    }
    if (this._inCodeFence) return;

    // ── 标题：开启/切换节 ──
    const isHeading = /^#{1,6} /.test(trimmed);
    if (isHeading) {
      // flush 标题前的内容（上一节 / 普通行 / 结构块）
      const cutAt = this._buf.length - line.length;
      if (cutAt > 0) this._flushAt(cutAt);
      this._inSection = true;
      this._sectionHasContent = false;
      this._structured = false;
      return;
    }

    // ── 节内：积累，有内容后遇段落空行才 flush ──
    if (this._inSection) {
      if (!isEmpty) this._sectionHasContent = true;
      if (isEmpty && this._sectionHasContent && this._buf.slice(0, -1).endsWith('\n')) {
        this._flushBuf();
        this._inSection = false;
      }
      return;
    }

    // ── 结构化内容（列表 / 表格 / 引用）──
    const isList = /^[ \t]*[-*+] /.test(stripped) || /^[ \t]*\d+[.)]\s/.test(stripped);
    const isTable = /^[ \t]*\|.*\|/.test(stripped);
    const isBlockquote = /^[ \t]*>/.test(stripped);
    const isStructured = isList || isTable || isBlockquote;

    if (isStructured) {
      this._structured = true;
      return;
    }
    if (this._structured && isEmpty) return; // 结构块内空行

    if (this._structured) {
      // 结构块结束：flush 结构内容，当前行留在 buf
      this._structured = false;
      const cutAt = this._buf.length - line.length;
      if (cutAt > 0) this._flushAt(cutAt);
      // fall through：当前行按普通行处理
    }

    // ── 普通行：非空则 flush ──
    if (!isEmpty && this._buf.trim()) {
      this._flushBuf();
    }
  }

  /** flush 整个 buf */
  _flushBuf() {
    const content = this._buf.trim();
    this._buf = "";
    if (content) {
      this._flushing = this._flushing.then(() => this._onFlush(content));
    }
  }

  /** flush buf 前 cutAt 个字符，保留剩余 */
  _flushAt(cutAt) {
    const content = this._buf.slice(0, cutAt).trim();
    this._buf = this._buf.slice(cutAt);
    if (content) {
      this._flushing = this._flushing.then(() => this._onFlush(content));
    }
  }
}

/** 生成紧凑时间标记：[MM-DD HH:mm] */
function timeTag(ts = Date.now()) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `[${mm}-${dd} ${hh}:${mi}]`;
}

export class BridgeManager {
  /**
   * @param {object} opts
   * @param {import('../../core/engine.js').HanaEngine} opts.engine
   * @param {import('../../hub/index.js').Hub} opts.hub
   */
  constructor({ engine, hub }) {
    this.engine = engine;
    this._hub = hub;
    /** @type {Map<string, { adapter, status: string, error?: string }>} */
    this._platforms = new Map();
    /** per-sessionKey 消息缓冲（debounce + abort） */
    this._pending = new Map();
    /** per-sessionKey 处理锁（防止 debounce 触发和 abort 重发并发） */
    this._processing = new Set();
    /** 最近消息环形缓冲（最多 200 条） */
    this._messageLog = [];
    this._messageLogMax = 200;

    // 初始化媒体本地路径白名单（对标 OpenClaw mediaLocalRoots，对齐 fs.js getAllowedRoots）
    const roots = [];
    if (engine.hanakoHome) roots.push(engine.hanakoHome);
    const homeFolder = typeof engine.getHomeFolder === "function" ? engine.getHomeFolder() : null;
    if (homeFolder) roots.push(homeFolder);
    if (engine.homeCwd) roots.push(engine.homeCwd);
    if (engine.cwd) roots.push(engine.cwd);
    if (engine.deskCwd) roots.push(engine.deskCwd);
    const deskHome = engine.agent?.deskManager?.homePath;
    if (deskHome) roots.push(deskHome);
    const userHome = os.homedir();
    if (userHome) {
      roots.push(path.join(userHome, "Documents"));
      roots.push(path.join(userHome, "Desktop"));
      roots.push(path.join(userHome, "Downloads"));
      roots.push(path.join(userHome, "Pictures"));
    }
    roots.push(os.tmpdir());
    setMediaLocalRoots(roots);
    /** block streaming 模式（默认开，多气泡发送） */
    this.blockStreaming = true;
  }

  /** 读取 preferences 中的 bridge 配置，自动启动已启用的平台 */
  autoStart() {
    const prefs = this.engine.getPreferences();
    const bridge = prefs.bridge || {};

    // 多 bot 平台
    for (const platform of ["telegram", "feishu", "qq"]) {
      this.startPlatformFromConfig(platform, bridge[platform] || {});
    }
  }

  _resolvePlatformAgentId(platform, cfg) {
    return cfg?.agentId || null;
  }

  _resolveBotAgentId(bot) {
    return bot?.agentId || null;
  }

  /**
   * 从 preferences 配置启动平台（route 层用，不需要知道凭证结构）
   * @param {string} platform
   * @param {object} cfg - prefs.bridge[platform] 的完整配置
   */
  startPlatformFromConfig(platform, cfg) {
    const spec = ADAPTER_REGISTRY[platform];
    if (!spec) return;

    // 多 bot：先停同平台全部，再按 bots 启动
    if (platform === "telegram" || platform === "feishu" || platform === "qq") {
      this.stopPlatform(platform);
      const bots = normalizeBridgeBots(platform, cfg);
      for (const bot of bots) {
        const creds = spec.getCredentials({ ...bot, enabled: bot.enabled !== false });
        if (!creds) continue;
        this.startPlatform(platform, creds, {
          botId: bot.id || null,
          agentId: this._resolveBotAgentId(bot),
          label: bot.name || null,
        });
      }
      return;
    }
  }

  /**
   * 启动指定平台（支持多 bot）
   * @param {string} platform
   * @param {object} credentials
   * @param {object} [opts]
   * @param {string|null} [opts.botId]
   * @param {string|null} [opts.agentId]
   * @param {string|null} [opts.label]
   */
  startPlatform(platform, credentials, opts = {}) {
    const platformKey = buildPlatformKey(platform, opts.botId || null);
    this.stopPlatform(platformKey);

    const spec = ADAPTER_REGISTRY[platform];
    if (!spec) throw new Error(`Unknown platform: ${platform}`);

    try {
      const onMessage = (msg) => this._handleMessage(platformKey, msg);
      const hooks = {
        onEvent: (evt) => this._hub.eventBus.emit(evt, null),
        onQqDmGuild: (userId, guildId) => this._persistQqDmGuild(userId, guildId, platformKey),
        onStatus: (status, error) => {
          const entry = this._platforms.get(platformKey);
          if (entry) { entry.status = status; entry.error = error || null; }
          this._emitStatus(platform, status, error, opts.botId || null);
        },
      };
      const adapter = spec.create(credentials, onMessage, hooks);

      this._platforms.set(platformKey, {
        adapter,
        status: "connected",
        error: null,
        platform,
        platformKey,
        botId: opts.botId || null,
        agentId: opts.agentId || null,
        label: opts.label || null,
      });
      console.log(`[bridge] ${platformKey} 已启动`);
      debugLog()?.log("bridge", `${platformKey} started`);

      this._emitStatus(platform, "connected", null, opts.botId || null);
    } catch (err) {
      console.error(`[bridge] ${platformKey} 启动失败:`, err.message);
      debugLog()?.error("bridge", `${platformKey} start failed: ${err.message}`);
      this._platforms.set(platformKey, {
        adapter: null,
        status: "error",
        error: err.message,
        platform,
        platformKey,
        botId: opts.botId || null,
        agentId: opts.agentId || null,
        label: opts.label || null,
      });
      this._emitStatus(platform, "error", err.message, opts.botId || null);
    }
  }

  /** 持久化 QQ userId→guildId 映射到 preferences（debounced） */
  _persistQqDmGuild(userId, guildId, platformKey = "qq") {
    try {
      const prefs = this.engine.getPreferences();
      if (!prefs.bridge) prefs.bridge = {};
      const qqCfg = prefs.bridge.qq || {};
      const { botId } = parsePlatformKey(platformKey);

      if (botId && Array.isArray(qqCfg.bots)) {
        const idx = qqCfg.bots.findIndex((b) => b?.id === botId);
        if (idx >= 0) {
          const bot = { ...qqCfg.bots[idx] };
          const map = { ...(bot.dmGuildMap || {}) };
          if (map[userId] === guildId) return;
          map[userId] = guildId;
          bot.dmGuildMap = map;
          qqCfg.bots[idx] = bot;
          prefs.bridge.qq = qqCfg;
        }
      } else {
        const map = { ...(qqCfg.dmGuildMap || {}) };
        if (map[userId] === guildId) return;
        map[userId] = guildId;
        qqCfg.dmGuildMap = map;
        prefs.bridge.qq = qqCfg;
      }

      // debounce: 合并短时间内的多次映射发现，避免每条私信都同步写盘
      if (!this._qqDmGuildFlushTimer) {
        this._qqDmGuildFlushTimer = setTimeout(() => {
          this._qqDmGuildFlushTimer = null;
          try { this.engine.savePreferences(this.engine.getPreferences()); }
          catch (e) { console.error("[bridge] flush QQ dmGuildMap failed:", e.message); }
        }, 5_000);
      }
    } catch (err) {
      console.error("[bridge] persist QQ dmGuildMap failed:", err.message);
    }
  }

  _stopPlatformKey(platformKey) {
    const entry = this._platforms.get(platformKey);
    if (!entry) return;
    try {
      entry.adapter?.stop();
    } catch {}
    this._platforms.delete(platformKey);
    console.log(`[bridge] ${platformKey} 已停止`);
    debugLog()?.log("bridge", `${platformKey} stopped`);
    this._emitStatus(entry.platform || platformKey, "disconnected", null, entry.botId || null);
  }

  /** 停止指定平台（支持 base platform 或 platformKey） */
  stopPlatform(platformOrKey) {
    if (this._platforms.has(platformOrKey)) {
      this._stopPlatformKey(platformOrKey);
      return;
    }
    const keys = [...this._platforms.entries()]
      .filter(([, entry]) => entry?.platform === platformOrKey)
      .map(([k]) => k);
    for (const k of keys) this._stopPlatformKey(k);
  }

  /** 停止所有平台 */
  stopAll() {
    const keys = [...this._platforms.keys()];
    for (const key of keys) this._stopPlatformKey(key);
    if (this._qqDmGuildFlushTimer) {
      clearTimeout(this._qqDmGuildFlushTimer);
      this._qqDmGuildFlushTimer = null;
      try { this.engine.savePreferences(this.engine.getPreferences()); }
      catch {}
    }
  }

  /** 获取所有平台状态（key 为 platformKey） */
  getStatus() {
    const result = {};
    for (const [platformKey, entry] of this._platforms) {
      result[platformKey] = {
        status: entry.status,
        error: entry.error || null,
        platform: entry.platform,
        botId: entry.botId || null,
      };
    }
    return result;
  }

  /**
   * 核心：收到外部消息
   *
   * 群聊：直接发送，不 debounce 不 abort（轻量 guest 快速回复）
   * 私聊：debounce 聚合 → 如正在处理则 abort → 合并发送
   */
  async _handleMessage(platformKey, msg) {
    const { sessionKey: rawSessionKey, senderName, avatarUrl, userId, isGroup, chatId, attachments } = msg;
    const text = typeof msg.text === "string" ? msg.text : "";
    const entry = this._platforms.get(platformKey);
    if (!entry?.adapter) return;
    const platform = entry.platform || platformKey;
    const agentId = entry.agentId || this.engine.currentAgentId;
    const sessionKey = buildSessionKey(platformKey, rawSessionKey);

    const hasAttachments = attachments?.length > 0;
    debugLog()?.log("bridge", `← ${platformKey} ${isGroup ? "group" : "dm"} (${text.length} chars${hasAttachments ? `, ${attachments.length} attachment(s)` : ""})`);

    // 广播收到的消息
    this._pushMessage({
      platform, direction: "in", sessionKey,
      sender: senderName || "用户", text: text || (hasAttachments ? `[${attachments.length} 个附件]` : ""),
      isGroup, ts: Date.now(),
    });

    const command = text.trim();

    // ── /stop 命令：abort 当前生成，不触发新回复 ──
    if (/^\/(stop|abort)$/i.test(command)) {
      this.engine.abortBridgeSession(sessionKey).catch(() => {});
      debugLog()?.log("bridge", `abort ${platform} active session: /stop command`);
      const pending = this._pending.get(sessionKey);
      if (pending?.timer) clearTimeout(pending.timer);
      this._pending.delete(sessionKey);
      return;
    }

    // ── /new 命令：重置上下文（兼容 /reset）──
    if (/^\/(new|reset)$/i.test(command)) {
      await this.engine.abortBridgeSession(sessionKey).catch(() => {});
      const pending = this._pending.get(sessionKey);
      if (pending?.timer) clearTimeout(pending.timer);
      this._pending.delete(sessionKey);

      const ok = await this.engine.resetBridgeSession(sessionKey, { agentId }).catch(() => false);
      if (ok) {
        debugLog()?.log("bridge", `reset ${platformKey} session by command: ${command}`);
        try {
          await entry.adapter.sendReply(chatId, "已开启新对话。");
          this._pushMessage({
            platform, direction: "out", sessionKey,
            sender: this.engine.agentName, text: "已开启新对话。",
            isGroup, ts: Date.now(),
          });
        } catch {}
      }
      return;
    }

    // ── 群聊：快速路径，不 debounce 不 abort ──
    if (isGroup) {
      const line = senderName ? `${senderName}: ${text}` : text;
      const meta = { name: senderName, avatarUrl, userId };
      await this._flushGroupMessage(platformKey, chatId, sessionKey, line, meta, attachments);
      return;
    }

    // ── 私聊：debounce + abort ──
    const line = senderName ? `${senderName}: ${text}` : text;

    let pending = this._pending.get(sessionKey);
    if (!pending) {
      pending = { lines: [], attachments: [], platform, platformKey, chatId, senderName, avatarUrl, userId, isGroup, agentId };
      this._pending.set(sessionKey, pending);
    }
    pending.lines.push(line);
    if (hasAttachments) pending.attachments.push(...attachments);
    Object.assign(pending, { platform, platformKey, chatId, senderName, avatarUrl, userId, isGroup, agentId });

    const isActive = this.engine.isBridgeSessionStreaming(sessionKey);

    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this._flushPending(sessionKey), isActive ? 1000 : 2000);
  }

  /**
   * 解析附件：图片 → base64（给 LLM），其他 → 文本描述
   * @returns {{ images: Array, textNotes: string }}
   */
  async _resolveAttachments(platformKey, attachments) {
    const images = [];
    const notes = [];
    if (!attachments?.length) return { images, textNotes: "" };

    const entry = this._platforms.get(platformKey);
    const adapter = entry?.adapter;

    for (const att of attachments) {
      try {
        if (att.type === "image") {
          let buffer;
          if (att.url) {
            buffer = await downloadMedia(att.url);
          } else if (att.platformRef && adapter?.downloadImage) {
            buffer = await adapter.downloadImage(att.platformRef);
          }
          if (buffer) {
            const mime = detectMime(buffer, att.mimeType || "image/jpeg");
            images.push({ type: "image", data: bufferToBase64(buffer), mimeType: mime });
          }
        } else if (att.type === "audio") {
          const dur = att.duration ? ` ${Math.round(att.duration)}秒` : "";
          notes.push(`[收到语音${dur}]`);
        } else if (att.type === "video") {
          notes.push(`[收到视频: ${att.filename || "video"}]`);
        } else {
          const size = att.size ? ` (${formatSize(att.size)})` : "";
          notes.push(`[收到文件: ${att.filename || "file"}${size}]`);
        }
      } catch (err) {
        debugLog()?.warn("bridge", `附件解析失败: ${err.message}`);
        notes.push(`[附件加载失败: ${att.filename || att.type}]`);
      }
    }
    return { images, textNotes: notes.join("\n") };
  }

  async _flushGroupMessage(platformKey, chatId, sessionKey, line, meta, attachments) {
    const entry = this._platforms.get(platformKey);
    if (!entry?.adapter) return;
    const platform = entry.platform || platformKey;
    const agentId = entry.agentId || this.engine.currentAgentId;

    debugLog()?.log("bridge", `flush ${platformKey} group message (${line.length} chars)`);

    // 解析附件
    const { images, textNotes } = await this._resolveAttachments(platformKey, attachments);
    const prompt = textNotes ? `${line}\n${textNotes}` : line;

    const tagged = `${timeTag()} ${prompt}`;
    try {
      const reply = await this._hub.send(tagged, {
        sessionKey,
        agentId,
        role: "guest",
        meta,
        isGroup: true,
        images: images.length ? images : undefined,
      });

      if (reply && entry?.adapter) {
        const cleaned = this._cleanReplyForPlatform(reply);
        // batch 模式：提取媒体
        const { text: textOnly, mediaUrls, mediaErrors = [] } = splitMediaFromOutput(cleaned);
        if (mediaErrors.length) {
          debugLog()?.warn("bridge", `media parse warning (${platformKey}): ${mediaErrors.join(" | ")}`);
        }
        const replyText = [textOnly.trim(), ...mediaErrors].filter(Boolean).join("\n");
        if (replyText) await entry.adapter.sendReply(chatId, replyText);
        for (const url of mediaUrls) {
          try {
            await this._sendMediaItem(entry.adapter, chatId, url, { userId: meta?.userId, isGroup: true });
          } catch (err) {
            debugLog()?.warn("bridge", `media send failed, fallback to text (${platformKey}): ${err.message}`);
            await entry.adapter.sendReply(chatId, this._buildMediaFallbackText(url, err));
          }
        }
        debugLog()?.log("bridge", `→ ${platform} group reply (${cleaned.length} chars)`);
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender: this.engine.agentName, text: cleaned,
          isGroup: true, ts: Date.now(),
        });
      }
    } catch (err) {
      if (!err.message?.includes("aborted")) {
        console.error(`[bridge] ${platform} 群聊消息处理失败:`, err.message);
        debugLog()?.error("bridge", `${platform} group message failed: ${err.message}`);
      }
    }
  }

  /**
   * debounce 到期：合并缓冲消息并发送给 LLM
   */
  async _flushPending(sessionKey) {
    const pending = this._pending.get(sessionKey);
    if (!pending || pending.lines.length === 0) return;

    // 防止并发触发
    if (this._processing.has(sessionKey)) return;

    // 取出所有缓冲消息和附件
    const lines = pending.lines.splice(0);
    const pendingAttachments = pending.attachments?.splice(0) || [];
    const { platform, platformKey, chatId, senderName, avatarUrl, userId, isGroup, agentId } = pending;
    this._pending.delete(sessionKey);

    // 解析附件
    const { images, textNotes } = await this._resolveAttachments(platformKey, pendingAttachments);
    const prompt = textNotes ? `${lines.join("\n")}\n${textNotes}` : lines.join("\n");
    const merged = `${timeTag()} ${prompt}`;
    const meta = { name: senderName, avatarUrl, userId };

    // 如果 agent 正在 streaming，用 steer 注入而不是新建 prompt
    // 但如果有图片附件，不走 steer（Pi SDK 不支持往 streaming 中追加图片），等当前回复结束后正常处理
    if (!images.length && this.engine.steerBridgeSession(sessionKey, merged)) {
      debugLog()?.log("bridge", `steer ${platformKey} dm (${lines.length} msg(s))`);
      return;
    }

    this._processing.add(sessionKey);

    debugLog()?.log("bridge", `flush ${platformKey} dm (${lines.length} msg(s), ${merged.length} chars${images.length ? `, ${images.length} image(s)` : ""})`);

    const entry = this._platforms.get(platformKey);
    const adapter = entry?.adapter;

    // ── 平台回复默认仅发送最终结果（不流式外发中间过程）──
    // 目标：避免思考过程/中间草稿被提前发到外部 IM。
    const canStream = false;
    const useBlockStream = canStream && this.blockStreaming;
    const useDraft = canStream && !this.blockStreaming && !!adapter?.sendDraft;

    let cleaner = null;
    let chunker = null;
    let blockSentAny = false;
    let lastDraftTs = 0;
    let draftFailed = false;
    const THROTTLE = 500;

    // block streaming: 多气泡发送
    if (useBlockStream) {
      cleaner = new StreamCleaner();
      chunker = new BlockChunker({
        onFlush: async (text) => {
          blockSentAny = true;
          await adapter.sendBlockReply(chatId, text);
        },
      });
    }

    const onDelta = canStream ? (_delta) => {
      if (useBlockStream) {
        const inc = cleaner.feed(_delta);
        if (inc) chunker.feed(inc);
      } else if (useDraft) {
        if (draftFailed) return;
        if (!cleaner) cleaner = new StreamCleaner();
        cleaner.feed(_delta);
        const now = Date.now();
        if (now - lastDraftTs < THROTTLE) return;
        if (!cleaner.cleaned.trim()) return;
        lastDraftTs = now;
        adapter.sendDraft(chatId, cleaner.cleaned).catch(() => { draftFailed = true; });
      }
    } : undefined;

    try {
      const reply = await this._hub.send(merged, {
        sessionKey,
        agentId,
        role: "guest",
        meta,
        isGroup: false,
        onDelta,
        images: images.length ? images : undefined,
      });

      if (reply && adapter) {
        const cleaned = this._cleanReplyForPlatform(reply);
        let allMediaUrls = [];

        // flush StreamCleaner 行缓冲中剩余的不完整行
        if (cleaner) {
          const tail = cleaner.flushLineBuf();
          if (tail) cleaner.cleaned += tail;
        }

        if (useBlockStream && chunker) {
          await chunker.finish();
          allMediaUrls = cleaner?.extractedMedia || [];
          if (!blockSentAny) {
            const textOnly = (cleaner?.cleaned || cleaned).trim();
            if (textOnly) await adapter.sendReply(chatId, textOnly);
          }
        } else if (useDraft && cleaner) {
          // draft 模式：用 cleaner.cleaned（已剥离媒体标记）发送最终文本
          allMediaUrls = cleaner.extractedMedia || [];
          const textOnly = cleaner.cleaned.trim();
          if (textOnly) {
            try { await adapter.sendDraft(chatId, textOnly); }
            catch { await adapter.sendReply(chatId, textOnly); }
          }
        } else {
          // batch 模式：提取媒体
          const { text: textOnly, mediaUrls, mediaErrors = [] } = splitMediaFromOutput(cleaned);
          if (mediaErrors.length) {
            debugLog()?.warn("bridge", `media parse warning (${platformKey}): ${mediaErrors.join(" | ")}`);
          }
          allMediaUrls = mediaUrls;
          const replyText = [textOnly.trim(), ...mediaErrors].filter(Boolean).join("\n");
          if (replyText) await adapter.sendReply(chatId, replyText);
        }

        // 统一发送所有提取到的媒体
        for (const url of allMediaUrls) {
          try {
            await this._sendMediaItem(adapter, chatId, url, { userId, isGroup });
          } catch (err) {
            debugLog()?.warn("bridge", `media send failed, fallback to text (${platformKey}): ${err.message}`);
            await adapter.sendReply(chatId, this._buildMediaFallbackText(url, err));
          }
        }

        debugLog()?.log("bridge", `→ ${platform} reply (${cleaned.length} chars, mode: ${useBlockStream ? "block" : useDraft ? "draft" : "batch"}${allMediaUrls.length ? `, ${allMediaUrls.length} media` : ""})`);
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender: this.engine.agentName, text: cleaned,
          isGroup, ts: Date.now(),
        });
      }
    } catch (err) {
      if (!err.message?.includes("aborted")) {
        console.error(`[bridge] ${platform} 消息处理失败:`, err.message);
        debugLog()?.error("bridge", `${platform} message handling failed: ${err.message}`);
      }
    } finally {
      this._processing.delete(sessionKey);
    }

    // 处理期间可能又有新消息进来了，检查并重新 flush
    const newPending = this._pending.get(sessionKey);
    if (newPending && newPending.lines.length > 0) {
      if (newPending.timer) clearTimeout(newPending.timer);
      newPending.timer = setTimeout(() => this._flushPending(sessionKey), 500);
    }
  }

  /**
   * 发送单个媒体项（URL 或本地路径）到平台
   * 本地路径走 sendMediaBuffer，URL 走 sendMedia
   */
  async _sendMediaItem(adapter, chatId, source, ctx = {}) {
    const userId = ctx?.userId ? String(ctx.userId) : undefined;
    const isLocal = source.startsWith("/") || source.startsWith("file://");
    if (isLocal && adapter.sendMediaBuffer) {
      const buffer = await downloadMedia(source); // downloadMedia 已有路径安全校验
      const mime = detectMime(buffer, "application/octet-stream");
      const filename = path.basename(source.startsWith("file://") ? source.replace(/^file:\/\//, "") : source);
      await adapter.sendMediaBuffer(chatId, buffer, { mime, filename, userId });
    } else if (adapter.sendMedia) {
      await adapter.sendMedia(chatId, source, { userId });
    } else {
      await adapter.sendReply(chatId, source);
    }
  }

  _buildMediaFallbackText(source, err) {
    const msg = String(err?.message || "");
    const low = msg.toLowerCase();

    if (low.includes("413") || low.includes("too large") || low.includes("request entity too large")) {
      return "文件发送失败：文件过大，平台拒绝上传。请换小文件或压缩后重试。";
    }
    if (low.includes("path outside allowed roots") || low.includes("file not found")) {
      return "文件发送失败：本地路径不可访问或文件不存在。请提供绝对路径并确认文件仍在。";
    }
    if (low.includes("qq") && low.includes("file_type=4")) {
      return "文件发送失败：QQ 当前会话类型不支持普通文件。可改发图片/视频或下载链接。";
    }

    if (typeof source === "string" && /^https?:\/\//i.test(source)) return source;
    const name = typeof source === "string" ? path.basename(source) : "文件";
    return `文件发送失败：${name}。请稍后重试或换一种发送方式。`;
  }

  /**
   * 清理发给外部平台的回复：
   * - 去除 MOOD 代码块
   * - 去除 <tool_code> 标签
   * - 去除 pulse / reflect 区块
   */
  _cleanReplyForPlatform(text) {
    let cleaned = String(text || "");

    // 若模型显式给出 <final>，只发送 final；否则退化到 <replying>。
    const finalMatches = [...cleaned.matchAll(/<final>\s*([\s\S]*?)\s*<\/final>/gi)];
    if (finalMatches.length) {
      cleaned = finalMatches[finalMatches.length - 1][1];
    } else {
      const replyingMatches = [...cleaned.matchAll(/<replying>\s*([\s\S]*?)\s*<\/replying>/gi)];
      if (replyingMatches.length) {
        cleaned = replyingMatches[replyingMatches.length - 1][1];
      }
    }

    // 丢弃所有中间思考块（而不是仅去标签保留内容）
    cleaned = cleaned.replace(/```(?:mood|pulse|reflect|think|analysis|commentary|summary)[\s\S]*?```\n*/gi, "");
    cleaned = cleaned.replace(/<(?:mood|pulse|reflect|think|analysis|commentary|summary)>[\s\S]*?<\/(?:mood|pulse|reflect|think|analysis|commentary|summary)>\s*/gi, "");
    cleaned = cleaned.replace(/<xing\s+title=["\u201C\u201D][^"\u201C\u201D]*["\u201C\u201D]>[\s\S]*?<\/xing>\s*/gi, "");
    cleaned = cleaned.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/gi, "");

    // final/replying 只保留内容，移除可能残留的包裹标签
    cleaned = cleaned.replace(/<\/?(?:final|replying)\s*>/gi, "");
    return cleaned.trim();
  }


  /**
   * 主动发送消息给最近私聊对象（不需要用户先发消息）
   * 用于心跳/cron 升级到 IM 的场景。
   *
   * @param {string} text - 要发送的文本（会自动 clean mood/pulse 标签）
   * @returns {{ platform: string, chatId: string } | null} 发送成功返回平台信息，失败返回 null
   */
  async sendProactive(text) {
    const cleaned = this._cleanReplyForPlatform(text);
    if (!cleaned) return null;

    // 按优先级尝试已连接的平台
    for (const [platformKey, entry] of this._platforms) {
      if (entry.status !== "connected" || !entry.adapter) continue;
      const target = this._pickLatestDmTarget(platformKey);
      if (!target) continue;
      const basePlatform = entry.platform || platformKey;

      // QQ 私信可能需要 guild_id，通过 adapter 做 userId -> guildId 解析
      const chatId = basePlatform === "qq"
        ? (entry.adapter.resolveOwnerChatId?.(target.chatId) || target.chatId)
        : target.chatId;
      try {
        await entry.adapter.sendReply(chatId, cleaned);
        debugLog()?.log("bridge", `→ ${platformKey} proactive to latest dm (${cleaned.length} chars)`);
        this._pushMessage({
          platform: basePlatform, direction: "out", sessionKey: target.sessionKey,
          sender: this.engine.agentName, text: cleaned,
          isGroup: false, ts: Date.now(),
        });

        return { platform: basePlatform, chatId, sessionKey: target.sessionKey };
      } catch (err) {
        console.error(`[bridge] proactive send failed (${platformKey}): ${err.message}`);
        debugLog()?.error("bridge", `proactive send failed (${platformKey}): ${err.message}`);
      }
    }

    return null;
  }

  /** 为指定平台实例（platformKey）选择最近活跃的私聊目标 */
  _pickLatestDmTarget(platformKey) {
    const index = this.engine.getBridgeIndex?.() || {};
    const bridgeDir = path.join(this.engine.agent.sessionDir, "bridge");
    let best = null;

    for (const [sessionKey, raw] of Object.entries(index)) {
      const entry = typeof raw === "string" ? { file: raw } : raw;
      if (!entry?.file) continue;

      const parsed = parseSessionKey(sessionKey);
      if (parsed.platformKey !== platformKey || parsed.chatType !== "dm") continue;

      const sessionPath = path.join(bridgeDir, entry.file);
      let lastActive = 0;
      try {
        lastActive = fs.statSync(sessionPath).mtimeMs || 0;
      } catch {}

      if (!best || lastActive > best.lastActive) {
        best = { sessionKey, chatId: parsed.chatId, lastActive };
      }
    }

    return best ? { sessionKey: best.sessionKey, chatId: best.chatId } : null;
  }

  /**
   * 从桌面端发送本地文件到 bridge 平台
   * @param {string} platform
   * @param {string} chatId
   * @param {string} filePath - 已校验过安全性的本地文件路径
   */
  async sendMediaFile(platform, chatId, filePath) {
    const entry = this._platforms.get(platform)
      || [...this._platforms.values()].find((e) => e?.platform === platform && e?.status === "connected")
      || [...this._platforms.values()].find((e) => e?.platform === platform);
    if (!entry?.adapter) throw new Error(`platform ${platform} not connected`);

    const buffer = fs.readFileSync(filePath);
    const mime = detectMime(buffer, "application/octet-stream");
    const filename = path.basename(filePath);

    // 优先用 sendMediaBuffer（接受 Buffer 的直传方法），fallback 到 sendMedia（URL）
    const ownerUserId = entry?.platform === "qq"
      ? (entry.adapter.resolveOwnerUserId?.(chatId) || null)
      : null;

    if (entry.adapter.sendMediaBuffer) {
      await entry.adapter.sendMediaBuffer(chatId, buffer, { mime, filename, userId: ownerUserId || undefined });
    } else if (mime.startsWith("image/") && entry.adapter.sendMedia) {
      // data URL fallback（飞书 sendMedia 内部通过 downloadMedia 解析 data URL）
      // 注：QQ 的 sendMedia 需要公开 HTTP URL，data URL 不支持
      const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
      await entry.adapter.sendMedia(chatId, dataUrl, { userId: ownerUserId || undefined });
    } else {
      await entry.adapter.sendReply(chatId, `[文件: ${filename}]`);
    }
  }

  /** 广播状态到前端（通过 Hub EventBus） */
  _emitStatus(platform, status, error, botId = null) {
    this._hub.eventBus.emit(
      { type: "bridge_status", platform, botId, status, error: error || null },
      null,
    );
  }

  /** 记录消息并广播到前端 */
  _pushMessage(entry) {
    this._messageLog.push(entry);
    if (this._messageLog.length > this._messageLogMax) {
      this._messageLog.shift();
    }
    this._hub.eventBus.emit(
      { type: "bridge_message", message: entry },
      null,
    );
  }

  /** 获取最近消息日志（供 REST API 使用） */
  getMessages(limit = 50) {
    return this._messageLog.slice(-limit);
  }
}
