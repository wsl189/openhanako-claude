/**
 * bridge.js — 外部平台接入 REST API
 *
 * 管理 Telegram / 飞书 / QQ 等外部消息平台的连接。
 */

import fs from "fs";
import path from "path";
import { debugLog } from "../../lib/debug-log.js";
import {
  parseSessionKey,
  KNOWN_PLATFORMS,
  normalizeBridgeBots,
  writeBridgeBots,
  buildPlatformKey,
} from "../../lib/bridge/session-key.js";
import { t } from "../i18n.js";

const MULTI_BOT_PLATFORMS = new Set(["telegram", "qq"]);
const BRIDGE_PLATFORMS = [...KNOWN_PLATFORMS];

function makeBotId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function parseLegacyBotIndex(botId = "") {
  if (typeof botId !== "string" || !botId.startsWith("legacy-")) return -1;
  const idx = Number.parseInt(botId.slice("legacy-".length), 10);
  return Number.isInteger(idx) && idx >= 0 ? idx : -1;
}

function summarizePlatformStatus(items = []) {
  if (items.some((x) => x.status === "connected")) return "connected";
  if (items.some((x) => x.status === "error")) return "error";
  return "disconnected";
}

function getAgentMap(engine) {
  const agents = engine.listAgents?.() || [];
  return new Map(agents.map((a) => [a.id, a.name || a.id]));
}

function normalizeBotDraft(platform, bot = {}, fallback = {}) {
  const draft = { ...fallback, ...bot };
  const incomingId = draft.id || "";
  const effectiveId = incomingId && !incomingId.startsWith("legacy-")
    ? incomingId
    : (fallback?.id || makeBotId());

  if (platform === "telegram") {
    const token = draft.token || draft.appSecret || draft.appsecret || "";
    return {
      id: effectiveId,
      name: (draft.name || "").trim() || "Telegram Bot",
      token,
      enabled: draft.enabled !== false,
      agentId: draft.agentId || null,
    };
  }
  if (platform === "qq") {
    const appID = draft.appID || draft.appId || "";
    const appSecret = draft.appSecret || draft.appsecret || draft.token || "";
    return {
      id: effectiveId,
      name: (draft.name || "").trim() || "QQ Bot",
      appID,
      appSecret,
      dmGuildMap: draft.dmGuildMap || {},
      enabled: draft.enabled !== false,
      agentId: draft.agentId || null,
    };
  }
  return draft;
}

export default async function bridgeRoute(app, { engine, bridgeManager }) {

  /** 获取所有平台连接状态 */
  app.get("/api/bridge/status", async () => {
    const prefs = engine.getPreferences();
    const bridge = prefs.bridge || {};
    const live = bridgeManager.getStatus();
    const agentMap = getAgentMap(engine);
    const mask = (s = "") => s.length <= 8 ? "••••" : s.slice(0, 4) + "••••" + s.slice(-4);

    const tgBots = normalizeBridgeBots("telegram", bridge.telegram).map((bot, idx) => {
      const botId = bot.id || `legacy-${idx}`;
      const platformKey = buildPlatformKey("telegram", bot.id || null);
      const st = live[platformKey] || {};
      const token = bot.token || bot.appSecret || bot.appsecret || "";
      return {
        id: botId,
        name: bot.name || "Telegram Bot",
        configured: !!token,
        enabled: bot.enabled !== false,
        status: st.status || "disconnected",
        error: st.error || null,
        tokenMasked: token ? mask(token) : "",
        agentId: bot.agentId || null,
        agentName: bot.agentId ? (agentMap.get(bot.agentId) || bot.agentId) : null,
      };
    });

    const qqBots = normalizeBridgeBots("qq", bridge.qq).map((bot, idx) => {
      const botId = bot.id || `legacy-${idx}`;
      const platformKey = buildPlatformKey("qq", bot.id || null);
      const st = live[platformKey] || {};
      const appID = bot.appID || bot.appId || "";
      const secret = bot.appSecret || bot.appsecret || bot.token || "";
      return {
        id: botId,
        name: bot.name || "QQ Bot",
        configured: !!(appID && secret),
        enabled: bot.enabled !== false,
        status: st.status || "disconnected",
        error: st.error || null,
        appID,
        appSecretMasked: secret ? mask(secret) : "",
        agentId: bot.agentId || null,
        agentName: bot.agentId ? (agentMap.get(bot.agentId) || bot.agentId) : null,
      };
    });

    const fs = bridge.feishu || {};
    const fsLive = live.feishu || {};

    return {
      telegram: {
        configured: tgBots.some((b) => b.configured),
        enabled: tgBots.some((b) => b.enabled),
        status: summarizePlatformStatus(tgBots),
        error: tgBots.find((b) => b.error)?.error || null,
        bots: tgBots,
      },
      feishu: {
        configured: !!(fs.appId && fs.appSecret),
        enabled: !!fs.enabled,
        status: fsLive.status || "disconnected",
        error: fsLive.error || null,
        name: fs.name || "Feishu Bot",
        appId: fs.appId || "",
        appSecretMasked: fs.appSecret ? mask(fs.appSecret) : "",
        agentId: fs.agentId || null,
        agentName: fs.agentId ? (agentMap.get(fs.agentId) || fs.agentId) : null,
      },
      qq: {
        configured: qqBots.some((b) => b.configured),
        enabled: qqBots.some((b) => b.enabled),
        status: summarizePlatformStatus(qqBots),
        error: qqBots.find((b) => b.error)?.error || null,
        bots: qqBots,
      },
    };
  });

  /** 兼容旧端：owner 入口（当前不再需要 owner 选择） */
  app.post("/api/bridge/owner", async (req) => {
    void req;
    debugLog()?.log("api", "POST /api/bridge/owner (noop)");
    return { ok: true };
  });

  /** 保存凭证 + 启停平台 */
  app.post("/api/bridge/config", async (req, reply) => {
    const { platform, credentials, enabled, agentId } = req.body || {};
    if (!platform || !BRIDGE_PLATFORMS.includes(platform)) {
      reply.code(400);
      return { error: "invalid platform" };
    }

    const prefs = engine.getPreferences();
    if (!prefs.bridge) prefs.bridge = {};
    const oldCfg = prefs.bridge[platform] || {};

    if (MULTI_BOT_PLATFORMS.has(platform)) {
      // 兼容旧请求：将 platform 级 token/appID/appSecret 落到 default bot
      const bots = normalizeBridgeBots(platform, oldCfg);
      let defaultBot = bots.find((b) => b.id === "default");
      if (!defaultBot) {
        defaultBot = normalizeBotDraft(platform, { id: "default", name: "Default Bot", enabled: true });
        bots.push(defaultBot);
      }
      defaultBot = normalizeBotDraft(platform, {
        ...defaultBot,
        ...(credentials || {}),
        ...(typeof enabled === "boolean" ? { enabled } : {}),
        ...(agentId !== undefined ? { agentId: agentId || null } : {}),
      });

      const nextBots = bots.map((b) => (b.id === "default" ? defaultBot : b));
      prefs.bridge[platform] = writeBridgeBots(oldCfg, nextBots);
      engine.savePreferences(prefs);
      bridgeManager.startPlatformFromConfig(platform, prefs.bridge[platform]);
      debugLog()?.log("api", `POST /api/bridge/config platform=${platform} default-bot enabled=${defaultBot.enabled !== false}`);
      return { ok: true, botId: "default" };
    }

    // 单平台（飞书）
    const cfg = { ...oldCfg };
    if (credentials) Object.assign(cfg, credentials);
    if (typeof enabled === "boolean") cfg.enabled = enabled;
    if (agentId !== undefined) cfg.agentId = agentId || null;
    prefs.bridge[platform] = cfg;

    engine.savePreferences(prefs);
    bridgeManager.startPlatformFromConfig(platform, cfg);
    debugLog()?.log("api", `POST /api/bridge/config platform=${platform} enabled=${!!cfg.enabled}`);
    return { ok: true };
  });

  /** 多 bot：新增或更新 bot */
  app.post("/api/bridge/bot-upsert", async (req, reply) => {
    const { platform, bot } = req.body || {};
    if (!MULTI_BOT_PLATFORMS.has(platform)) {
      reply.code(400);
      return { error: "platform must be telegram or qq" };
    }
    if (!bot || typeof bot !== "object") {
      reply.code(400);
      return { error: "bot is required" };
    }

    const prefs = engine.getPreferences();
    if (!prefs.bridge) prefs.bridge = {};
    const oldCfg = prefs.bridge[platform] || {};
    const bots = normalizeBridgeBots(platform, oldCfg);
    const incomingId = typeof bot.id === "string" ? bot.id.trim() : "";
    let idx = incomingId && !incomingId.startsWith("legacy-")
      ? bots.findIndex((b) => b.id === incomingId)
      : -1;
    if (idx < 0 && incomingId.startsWith("legacy-")) {
      const legacyIdx = parseLegacyBotIndex(incomingId);
      if (legacyIdx >= 0 && legacyIdx < bots.length) idx = legacyIdx;
    }
    const prev = idx >= 0 ? bots[idx] : null;
    const merged = normalizeBotDraft(platform, { ...bot, id: incomingId }, prev || undefined);
    const prevToken = prev?.token || prev?.appSecret || prev?.appsecret || "";
    const prevAppID = prev?.appID || prev?.appId || "";

    if (platform === "telegram" && !(merged.token || prevToken)) {
      reply.code(400);
      return { error: "token required" };
    }
    if (platform === "qq" && !(merged.appID || prevAppID)) {
      reply.code(400);
      return { error: "appID required" };
    }
    if (platform === "qq" && !(merged.appSecret || prevToken)) {
      reply.code(400);
      return { error: "appSecret required" };
    }

    if (!merged.token && prevToken) merged.token = prevToken;
    if (!merged.appID && prevAppID) merged.appID = prevAppID;
    if (!merged.appSecret && prevToken) merged.appSecret = prevToken;
    if (!merged.dmGuildMap && prev?.dmGuildMap) merged.dmGuildMap = prev.dmGuildMap;

    if (idx >= 0) bots[idx] = merged;
    else bots.push(merged);

    prefs.bridge[platform] = writeBridgeBots(oldCfg, bots);
    engine.savePreferences(prefs);
    bridgeManager.startPlatformFromConfig(platform, prefs.bridge[platform]);
    return { ok: true, bot: { id: merged.id } };
  });

  /** 多 bot：删除 bot */
  app.post("/api/bridge/bot-delete", async (req, reply) => {
    const { platform, botId } = req.body || {};
    if (!MULTI_BOT_PLATFORMS.has(platform) || !botId) {
      reply.code(400);
      return { error: "platform and botId required" };
    }

    const prefs = engine.getPreferences();
    if (!prefs.bridge) prefs.bridge = {};
    const oldCfg = prefs.bridge[platform] || {};
    const baseBots = normalizeBridgeBots(platform, oldCfg);
    const legacyIdx = parseLegacyBotIndex(botId);
    const bots = legacyIdx >= 0
      ? baseBots.filter((_, i) => i !== legacyIdx)
      : baseBots.filter((b) => b.id !== botId);
    prefs.bridge[platform] = writeBridgeBots(oldCfg, bots);
    engine.savePreferences(prefs);
    bridgeManager.startPlatformFromConfig(platform, prefs.bridge[platform]);
    return { ok: true };
  });

  /** 多 bot：绑定 agent */
  app.post("/api/bridge/bot-bind", async (req, reply) => {
    const { platform, botId, agentId } = req.body || {};
    if (!MULTI_BOT_PLATFORMS.has(platform) || !botId) {
      reply.code(400);
      return { error: "platform and botId required" };
    }

    const prefs = engine.getPreferences();
    if (!prefs.bridge) prefs.bridge = {};
    const oldCfg = prefs.bridge[platform] || {};
    const bots = normalizeBridgeBots(platform, oldCfg);
    let idx = bots.findIndex((b) => b.id === botId);
    if (idx < 0) {
      const legacyIdx = parseLegacyBotIndex(botId);
      if (legacyIdx >= 0 && legacyIdx < bots.length) idx = legacyIdx;
    }
    if (idx < 0) {
      reply.code(404);
      return { error: "bot not found" };
    }
    bots[idx] = { ...bots[idx], agentId: agentId || null };
    prefs.bridge[platform] = writeBridgeBots(oldCfg, bots);
    engine.savePreferences(prefs);
    bridgeManager.startPlatformFromConfig(platform, prefs.bridge[platform]);
    return { ok: true };
  });

  /** 单平台：绑定 agent（飞书） */
  app.post("/api/bridge/platform-bind", async (req, reply) => {
    const { platform, agentId } = req.body || {};
    if (!platform || platform !== "feishu") {
      reply.code(400);
      return { error: "platform must be feishu" };
    }
    const prefs = engine.getPreferences();
    if (!prefs.bridge) prefs.bridge = {};
    const cfg = { ...(prefs.bridge[platform] || {}), agentId: agentId || null };
    prefs.bridge[platform] = cfg;
    engine.savePreferences(prefs);
    bridgeManager.startPlatformFromConfig(platform, cfg);
    return { ok: true };
  });

  /** 兼容旧端：bridge 全局设置入口（当前无可写项） */
  app.post("/api/bridge/settings", async (req) => {
    void req;
    debugLog()?.log("api", "POST /api/bridge/settings (noop)");
    return { ok: true };
  });

  /** 停止指定平台 */
  app.post("/api/bridge/stop", async (req, reply) => {
    const { platform } = req.body || {};
    if (!platform || !BRIDGE_PLATFORMS.includes(platform)) {
      reply.code(400);
      return { error: "invalid platform" };
    }

    bridgeManager.stopPlatform(platform);

    // 同步更新 preferences
    const prefs = engine.getPreferences();
    if (prefs.bridge?.[platform]) {
      if (MULTI_BOT_PLATFORMS.has(platform)) {
        const oldCfg = prefs.bridge[platform] || {};
        const bots = normalizeBridgeBots(platform, oldCfg).map((b) => ({ ...b, enabled: false }));
        prefs.bridge[platform] = writeBridgeBots(oldCfg, bots);
      } else {
        prefs.bridge[platform].enabled = false;
      }
      engine.savePreferences(prefs);
    }

    debugLog()?.log("api", `POST /api/bridge/stop platform=${platform}`);
    return { ok: true };
  });

  /** 获取最近消息日志（实时内存缓冲） */
  app.get("/api/bridge/messages", async (req) => {
    const limit = parseInt(req.query?.limit) || 50;
    return { messages: bridgeManager.getMessages(limit) };
  });

  /** 获取 bridge session 列表 */
  app.get("/api/bridge/sessions", async (req) => {
    const platform = req.query?.platform; // optional filter
    const index = engine.getBridgeIndex();
    const bridgeDir = path.join(engine.agent.sessionDir, "bridge");
    const sessions = [];

    for (const [sessionKey, raw] of Object.entries(index)) {
      // 兼容旧格式（字符串）和新格式（对象）
      const entry = typeof raw === "string" ? { file: raw } : raw;
      const file = entry.file;
      if (!file) continue;

      // 解析 sessionKey → 平台 + 类型
      const { platform: plat, platformKey, botId, chatType, chatId } = parseSessionKey(sessionKey);

      // 按平台过滤
      if (platform && plat !== platform) continue;

      // 获取最后修改时间
      let lastActive = null;
      const fp = path.join(bridgeDir, file);
      try {
        const stat = fs.statSync(fp);
        lastActive = stat.mtimeMs;
      } catch {}

      sessions.push({
        sessionKey, platform: plat, platformKey, botId, chatType, chatId, file, lastActive,
        displayName: entry.name || null,
        avatarUrl: entry.avatarUrl || null,
      });
    }

    // 按最后活跃时间排序
    sessions.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
    return { sessions };
  });

  /** 读取指定 bridge session 的消息 */
  app.get("/api/bridge/sessions/:sessionKey/messages", async (req) => {
    const { sessionKey } = req.params;
    const index = engine.getBridgeIndex();
    const raw = index[sessionKey];
    const file = typeof raw === "string" ? raw : raw?.file;
    if (!file) return { error: "session not found", messages: [] };

    const bridgeDir = path.join(engine.agent.sessionDir, "bridge");
    const fp = path.resolve(bridgeDir, file);

    // 防止 path traversal
    if (!fp.startsWith(path.resolve(bridgeDir) + path.sep)) {
      return { error: "invalid session path", messages: [] };
    }

    try {
      const raw = fs.readFileSync(fp, "utf-8");
      const lines = raw.trim().split("\n").map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      const messages = [];
      for (const line of lines) {
        if (line.type !== "message") continue;
        const msg = line.message;
        if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;

        let textContent = "";
        let imageCount = 0;
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b.type === "text" && b.text) textContent += b.text;
            if (b.type === "image") imageCount++;
          }
        } else if (typeof msg.content === "string") {
          textContent = msg.content;
        }

        if (!textContent && imageCount === 0) continue;
        const content = textContent || `[图片 x${imageCount}]`;
        messages.push({ role: msg.role, content });
      }

      return { messages };
    } catch (err) {
      return { error: err.message, messages: [] };
    }
  });

  /** 重置 bridge session（清除上下文，下次消息新建 session） */
  app.post("/api/bridge/sessions/:sessionKey/reset", async (req) => {
    const { sessionKey } = req.params;
    const index = engine.getBridgeIndex();
    const raw = index[sessionKey];
    if (!raw) return { ok: false, error: "session not found" };

    // 保留元数据（name, avatarUrl），只删 file 引用
    const entry = typeof raw === "string" ? {} : { ...raw };
    delete entry.file;
    index[sessionKey] = entry;
    engine.saveBridgeIndex(index);

    return { ok: true };
  });

  /** 发送媒体到 bridge 平台（桌面端推送文件） */
  app.post("/api/bridge/send-media", async (req, reply) => {
    const { platform, chatId, filePath } = req.body || {};
    if (!platform || !chatId || !filePath) {
      reply.code(400);
      return { error: "platform, chatId, filePath required" };
    }

    const hanaHome = path.resolve(engine.hanakoHome);
    const deskHome = engine.agent?.deskManager?.homePath;
    const rawRoots = [hanaHome, deskHome ? path.resolve(deskHome) : null].filter(Boolean);
    const allowedRoots = rawRoots.map((root) => {
      try { return fs.realpathSync(root); }
      catch { return root; }
    });

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      reply.code(404);
      return { error: "file not found" };
    }

    let realPath;
    try { realPath = fs.realpathSync(resolved); }
    catch { return reply.code(404).send({ error: "file not found" }); }

    const isSafe = allowedRoots.some(root =>
      realPath === root || realPath.startsWith(root + path.sep)
    );
    if (!isSafe) {
      reply.code(403);
      return { error: "path outside allowed roots" };
    }

    const MAX_MEDIA_SIZE = 50 * 1024 * 1024;
    try {
      const stat = fs.statSync(realPath);
      if (stat.size > MAX_MEDIA_SIZE) {
        reply.code(413);
        return { error: `file too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 50MB)` };
      }
    } catch { return reply.code(404).send({ error: "file not found" }); }

    try {
      await bridgeManager.sendMediaFile(platform, chatId, realPath);
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  /** 测试凭证（不启动轮询） */
  app.post("/api/bridge/test", async (req, reply) => {
    const { platform, credentials } = req.body || {};
    if (!platform || !credentials) {
      reply.code(400);
      return { error: "platform and credentials required" };
    }

    if (!KNOWN_PLATFORMS.includes(platform)) {
      reply.code(400);
      return { error: "unknown platform" };
    }

    try {
      if (platform === "telegram") {
        const TelegramBot = (await import("node-telegram-bot-api")).default;
        const bot = new TelegramBot(credentials.token);
        const me = await bot.getMe();
        return { ok: true, info: { username: me.username, name: me.first_name } };
      } else if (platform === "feishu") {
        const resp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            app_id: credentials.appId,
            app_secret: credentials.appSecret,
          }),
        });
        const data = await resp.json();
        if (data.code === 0) {
          return { ok: true, info: { msg: t("error.tokenSuccess") } };
        }
        return { ok: false, error: data.msg || t("error.verifyFailed") };
      } else if (platform === "qq") {
        // v2 鉴权：appID + appSecret → access_token → /users/@me
        const tokenRes = await fetch("https://bots.qq.com/app/getAppAccessToken", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appId: credentials.appID, clientSecret: credentials.appSecret }),
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
          return { ok: false, error: tokenData.message || t("error.tokenFetchFailed") };
        }
        const meRes = await fetch("https://api.sgroup.qq.com/users/@me", {
          headers: { Authorization: `QQBot ${tokenData.access_token}` },
        });
        const me = await meRes.json();
        if (me.id) {
          return { ok: true, info: { username: me.username, name: me.username } };
        }
        return { ok: false, error: me.message || t("error.botInfoFailed") };
      }
      return { ok: false, error: t("error.platformTestUnsupported") };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}
