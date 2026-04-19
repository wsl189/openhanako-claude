/**
 * bridge.js — 外部平台接入 REST API
 *
 * 管理 Telegram / 飞书 / QQ 等外部消息平台的连接。
 */

import fs from "fs";
import os from "os";
import path from "path";
import { debugLog } from "../../lib/debug-log.js";
import {
  parseSessionKey,
  KNOWN_PLATFORMS,
  normalizeBridgeBots,
  writeBridgeBots,
  buildPlatformKey,
} from "../../lib/bridge/session-key.js";
import { getWechatQrcode, pollWechatQrcodeStatus } from "../../lib/bridge/wechat-login.js";
import { t } from "../i18n.js";

const MULTI_BOT_PLATFORMS = new Set(["telegram", "feishu", "qq"]);
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
  if (platform === "feishu") {
    const appId = draft.appId || draft.appID || "";
    const appSecret = draft.appSecret || draft.appsecret || "";
    return {
      id: effectiveId,
      name: (draft.name || "").trim() || "Feishu Bot",
      appId,
      appSecret,
      enabled: draft.enabled !== false,
      agentId: draft.agentId || null,
    };
  }
  return draft;
}

function listAgentRoots(engine) {
  const agents = engine.listAgents?.() || [];
  return agents.map((a) => {
    const runtime = engine.getAgent?.(a.id);
    return {
      id: a.id,
      name: a.name || runtime?.agentName || a.id,
      sessionDir: runtime?.sessionDir || path.join(engine.agentsDir, a.id, "sessions"),
    };
  });
}

function readBridgeIndexFromSessionDir(sessionDir) {
  const bridgeDir = path.join(sessionDir, "bridge");
  const indexPath = path.join(bridgeDir, "bridge-sessions.json");
  let index = {};
  try {
    index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) || {};
  } catch {}
  return { bridgeDir, indexPath, index };
}

function writeBridgeIndexToPath(indexPath, index) {
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n", "utf-8");
}

function getBoundAgentsForPlatform(engine, platform) {
  const prefs = engine.getPreferences?.() || {};
  const bridge = prefs.bridge || {};
  const agentMap = getAgentMap(engine);
  const ids = new Set();

  const includeAll = !platform;

  for (const p of ["telegram", "feishu", "qq"]) {
    if (!includeAll && platform !== p) continue;
    for (const bot of normalizeBridgeBots(p, bridge[p])) {
      if (bot?.agentId) ids.add(bot.agentId);
    }
  }
  if (includeAll || platform === "wechat") {
    const wechatAgentId = bridge.wechat?.agentId;
    if (wechatAgentId) ids.add(wechatAgentId);
  }

  return [...ids].map((id) => ({ id, name: agentMap.get(id) || id }));
}

function parseBridgeMessagesFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) return { messages: [] };
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);

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
      let content = textContent || `[图片 x${imageCount}]`;
      // 平台对话面板里不展示中间层标签（仅清理 assistant 输出，避免误改用户原文）
      if (msg.role === "assistant" && content) {
        const finalMatches = [...content.matchAll(/<final>\s*([\s\S]*?)\s*<\/final>/gi)];
        if (finalMatches.length) {
          content = finalMatches[finalMatches.length - 1][1];
        } else {
          const replyingMatches = [...content.matchAll(/<replying>\s*([\s\S]*?)\s*<\/replying>/gi)];
          if (replyingMatches.length) {
            content = replyingMatches[replyingMatches.length - 1][1];
          }
        }
        content = content
          .replace(/```(?:think|analysis|commentary|summary)[\s\S]*?```\n*/gi, "")
          .replace(/<(?:think|analysis|commentary|summary)>[\s\S]*?<\/(?:think|analysis|commentary|summary)>\s*/gi, "")
          .replace(/<xing\s+title=["\u201C\u201D][^"\u201C\u201D]*["\u201C\u201D]>[\s\S]*?<\/xing>\s*/gi, "")
          .replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/gi, "")
          .replace(/<\/?(?:final|replying)\s*>/gi, "")
          .trim();
      }
      messages.push({
        role: msg.role,
        content,
        timestamp: line.timestamp || line.ts || null,
      });
    }

    return { messages };
  } catch (err) {
    return { messages: [], error: err.message };
  }
}

function findBridgeSessionRecord(engine, sessionKey, explicitAgentId = "") {
  const allAgents = listAgentRoots(engine);
  const targets = explicitAgentId
    ? allAgents.filter((a) => a.id === explicitAgentId)
    : allAgents;

  for (const agent of targets) {
    const { bridgeDir, indexPath, index } = readBridgeIndexFromSessionDir(agent.sessionDir);
    const raw = index[sessionKey];
    const file = typeof raw === "string" ? raw : raw?.file;
    if (!file) continue;
    return { agent, bridgeDir, indexPath, index, raw, file };
  }
  return null;
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

    const fsBots = normalizeBridgeBots("feishu", bridge.feishu).map((bot, idx) => {
      const botId = bot.id || `legacy-${idx}`;
      const platformKey = buildPlatformKey("feishu", bot.id || null);
      const st = live[platformKey] || {};
      const appId = bot.appId || bot.appID || "";
      const secret = bot.appSecret || bot.appsecret || "";
      return {
        id: botId,
        name: bot.name || "Feishu Bot",
        configured: !!(appId && secret),
        enabled: bot.enabled !== false,
        status: st.status || "disconnected",
        error: st.error || null,
        appID: appId,
        appSecretMasked: secret ? mask(secret) : "",
        agentId: bot.agentId || null,
        agentName: bot.agentId ? (agentMap.get(bot.agentId) || bot.agentId) : null,
      };
    });

    const wechatCfg = bridge.wechat || {};
    const wechatLive = live.wechat || {};
    const wechatToken = wechatCfg.botToken || "";

    return {
      telegram: {
        configured: tgBots.some((b) => b.configured),
        enabled: tgBots.some((b) => b.enabled),
        status: summarizePlatformStatus(tgBots),
        error: tgBots.find((b) => b.error)?.error || null,
        bots: tgBots,
      },
      feishu: {
        configured: fsBots.some((b) => b.configured),
        enabled: fsBots.some((b) => b.enabled),
        status: summarizePlatformStatus(fsBots),
        error: fsBots.find((b) => b.error)?.error || null,
        bots: fsBots,
      },
      qq: {
        configured: qqBots.some((b) => b.configured),
        enabled: qqBots.some((b) => b.enabled),
        status: summarizePlatformStatus(qqBots),
        error: qqBots.find((b) => b.error)?.error || null,
        bots: qqBots,
      },
      wechat: {
        configured: !!wechatToken,
        enabled: wechatCfg.enabled !== false && !!wechatToken,
        status: wechatLive.status || "disconnected",
        error: wechatLive.error || null,
        token: wechatToken,
        agentId: wechatCfg.agentId || null,
        agentName: wechatCfg.agentId ? (agentMap.get(wechatCfg.agentId) || wechatCfg.agentId) : null,
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

    if (!MULTI_BOT_PLATFORMS.has(platform)) {
      if (platform === "wechat") {
        const patch = {
          ...oldCfg,
          ...(credentials || {}),
          ...(typeof enabled === "boolean" ? { enabled } : {}),
          ...(agentId !== undefined ? { agentId: agentId || null } : {}),
        };
        prefs.bridge[platform] = patch;
        engine.savePreferences(prefs);
        bridgeManager.startPlatformFromConfig(platform, patch);
        debugLog()?.log("api", `POST /api/bridge/config platform=${platform} enabled=${patch.enabled !== false}`);
        return { ok: true };
      }
      reply.code(400);
      return { error: "unsupported platform" };
    }

    // 兼容旧请求：将 platform 级 token/appID/appSecret 落到 default bot
    const bots = normalizeBridgeBots(platform, oldCfg);
    let defaultBot = bots.find((b) => b.id === "default");
    if (!defaultBot) {
      const defaultName = platform === "feishu" ? "Feishu Bot" : "Default Bot";
      defaultBot = normalizeBotDraft(platform, { id: "default", name: defaultName, enabled: true });
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
  });

  /** 多 bot：新增或更新 bot */
  app.post("/api/bridge/bot-upsert", async (req, reply) => {
    const { platform, bot } = req.body || {};
    if (!MULTI_BOT_PLATFORMS.has(platform)) {
      reply.code(400);
      return { error: "platform must be telegram, feishu or qq" };
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
    const prevSecret = prev?.token || prev?.appSecret || prev?.appsecret || "";
    const prevAppID = prev?.appID || prev?.appId || "";

    if (platform === "telegram" && !(merged.token || prevSecret)) {
      reply.code(400);
      return { error: "token required" };
    }
    if (platform === "feishu" && !(merged.appId || prevAppID)) {
      reply.code(400);
      return { error: "appId required" };
    }
    if (platform === "feishu" && !(merged.appSecret || prevSecret)) {
      reply.code(400);
      return { error: "appSecret required" };
    }
    if (platform === "qq" && !(merged.appID || prevAppID)) {
      reply.code(400);
      return { error: "appID required" };
    }
    if (platform === "qq" && !(merged.appSecret || prevSecret)) {
      reply.code(400);
      return { error: "appSecret required" };
    }

    if (!merged.token && prevSecret) merged.token = prevSecret;
    if (!merged.appID && prevAppID) merged.appID = prevAppID;
    if (!merged.appId && prevAppID) merged.appId = prevAppID;
    if (!merged.appSecret && prevSecret) merged.appSecret = prevSecret;
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

  /** 兼容旧端：平台级绑定 agent（写入 default bot） */
  app.post("/api/bridge/platform-bind", async (req, reply) => {
    const { platform, agentId } = req.body || {};
    if (!platform || !MULTI_BOT_PLATFORMS.has(platform)) {
      reply.code(400);
      return { error: "platform must be telegram, feishu or qq" };
    }
    const prefs = engine.getPreferences();
    if (!prefs.bridge) prefs.bridge = {};
    const oldCfg = prefs.bridge[platform] || {};
    const bots = normalizeBridgeBots(platform, oldCfg);
    let defaultBot = bots.find((b) => b.id === "default");
    if (!defaultBot) {
      const defaultName = platform === "feishu" ? "Feishu Bot" : "Default Bot";
      defaultBot = normalizeBotDraft(platform, { id: "default", name: defaultName, enabled: true });
      bots.push(defaultBot);
    }
    const nextBots = bots.map((b) => (b.id === "default" ? { ...b, agentId: agentId || null } : b));
    prefs.bridge[platform] = writeBridgeBots(oldCfg, nextBots);
    engine.savePreferences(prefs);
    bridgeManager.startPlatformFromConfig(platform, prefs.bridge[platform]);
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
  app.get("/api/bridge/sessions", async (req, reply) => {
    const platform = req.query?.platform; // optional filter
    if (platform && !BRIDGE_PLATFORMS.includes(platform)) {
      reply.code(400);
      return { error: "invalid platform", sessions: [], boundAgents: [] };
    }

    const allAgents = listAgentRoots(engine);
    const boundAgents = getBoundAgentsForPlatform(engine, platform);
    const boundSet = platform
      ? new Set(boundAgents.map((a) => a.id))
      : (boundAgents.length ? new Set(boundAgents.map((a) => a.id)) : null);
    const sessions = [];

    for (const agent of allAgents) {
      if (boundSet && !boundSet.has(agent.id)) continue;
      const { bridgeDir, index } = readBridgeIndexFromSessionDir(agent.sessionDir);

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
          sessionKey,
          platform: plat,
          platformKey,
          botId,
          chatType,
          chatId,
          file,
          lastActive,
          displayName: entry.name || null,
          avatarUrl: entry.avatarUrl || null,
          agentId: agent.id,
          agentName: agent.name,
        });
      }
    }

    // 按最后活跃时间排序
    sessions.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
    return { sessions, boundAgents };
  });

  /** 按 agent + 平台聚合历史 */
  app.get("/api/bridge/agents/:agentId/history", async (req, reply) => {
    const agentId = typeof req.params?.agentId === "string" ? req.params.agentId.trim() : "";
    const platform = typeof req.query?.platform === "string" ? req.query.platform.trim() : "";

    if (!agentId) {
      reply.code(400);
      return { error: "agentId required", agentId: "", sessions: [] };
    }
    if (platform && !BRIDGE_PLATFORMS.includes(platform)) {
      reply.code(400);
      return { error: "invalid platform", agentId, sessions: [] };
    }

    const allAgents = listAgentRoots(engine);
    const agent = allAgents.find((a) => a.id === agentId);
    if (!agent) {
      reply.code(404);
      return { error: "agent not found", agentId, sessions: [] };
    }

    // 如果平台存在绑定关系，仅允许查看已绑定 agent
    const boundAgents = getBoundAgentsForPlatform(engine, platform || undefined);
    const boundSet = new Set(boundAgents.map((a) => a.id));
    if (platform && !boundSet.has(agentId)) {
      return { agentId, agentName: agent.name, sessions: [] };
    }

    const { bridgeDir, index } = readBridgeIndexFromSessionDir(agent.sessionDir);
    const sessions = [];

    for (const [sessionKey, raw] of Object.entries(index)) {
      const entry = typeof raw === "string" ? { file: raw } : raw;
      const file = entry.file;
      if (!file) continue;

      const parsed = parseSessionKey(sessionKey);
      if (platform && parsed.platform !== platform) continue;

      const fp = path.resolve(bridgeDir, file);
      if (!fp.startsWith(path.resolve(bridgeDir) + path.sep)) continue;

      let lastActive = null;
      try {
        const stat = fs.statSync(fp);
        lastActive = stat.mtimeMs;
      } catch {}

      const { messages } = parseBridgeMessagesFile(fp);
      sessions.push({
        sessionKey,
        platform: parsed.platform,
        platformKey: parsed.platformKey,
        botId: parsed.botId,
        chatType: parsed.chatType,
        chatId: parsed.chatId,
        displayName: entry.name || null,
        avatarUrl: entry.avatarUrl || null,
        lastActive,
        messages,
      });
    }

    sessions.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
    return { agentId, agentName: agent.name, sessions };
  });

  /** 读取指定 bridge session 的消息 */
  app.get("/api/bridge/sessions/:sessionKey/messages", async (req) => {
    const { sessionKey } = req.params;
    const explicitAgentId = typeof req.query?.agentId === "string" ? req.query.agentId.trim() : "";
    const hit = findBridgeSessionRecord(engine, sessionKey, explicitAgentId);
    if (!hit) return { error: "session not found", messages: [] };

    const fp = path.resolve(hit.bridgeDir, hit.file);

    // 防止 path traversal
    if (!fp.startsWith(path.resolve(hit.bridgeDir) + path.sep)) {
      return { error: "invalid session path", messages: [] };
    }

    const { messages, error } = parseBridgeMessagesFile(fp);
    if (error) return { error, messages: [] };
    return { messages };
  });

  /** 重置 bridge session（清除上下文，下次消息新建 session） */
  app.post("/api/bridge/sessions/:sessionKey/reset", async (req) => {
    const { sessionKey } = req.params;
    const explicitAgentId = typeof req.query?.agentId === "string" ? req.query.agentId.trim() : "";
    const hit = findBridgeSessionRecord(engine, sessionKey, explicitAgentId);
    if (!hit) return { ok: false, error: "session not found" };

    // 保留元数据（name, avatarUrl），只删 file 引用
    const entry = typeof hit.raw === "string" ? {} : { ...hit.raw };
    delete entry.file;
    hit.index[sessionKey] = entry;
    writeBridgeIndexToPath(hit.indexPath, hit.index);

    return { ok: true };
  });

  /** 发送媒体到 bridge 平台（桌面端推送文件） */
  app.post("/api/bridge/send-media", async (req, reply) => {
    const { platform, chatId, filePath, path: pathArg } = req.body || {};
    const targetPath = typeof filePath === "string" && filePath.trim()
      ? filePath
      : (typeof pathArg === "string" ? pathArg : "");
    if (!platform || !chatId || !targetPath) {
      reply.code(400);
      return { error: "platform, chatId, filePath required" };
    }

    const hanaHome = path.resolve(engine.hanakoHome);
    const homeFolder = typeof engine.getHomeFolder === "function" ? engine.getHomeFolder() : null;
    const deskHome = engine.agent?.deskManager?.homePath;
    const userHome = os.homedir();
    const rawRoots = [
      hanaHome,
      homeFolder ? path.resolve(homeFolder) : null,
      engine.homeCwd ? path.resolve(engine.homeCwd) : null,
      engine.cwd ? path.resolve(engine.cwd) : null,
      engine.deskCwd ? path.resolve(engine.deskCwd) : null,
      deskHome ? path.resolve(deskHome) : null,
      userHome ? path.join(userHome, "Documents") : null,
      userHome ? path.join(userHome, "Desktop") : null,
      userHome ? path.join(userHome, "Downloads") : null,
      userHome ? path.join(userHome, "Pictures") : null,
    ].filter(Boolean);
    const allowedRoots = rawRoots.map((root) => {
      try { return fs.realpathSync(root); }
      catch { return root; }
    });

    const resolved = path.resolve(targetPath);
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
      } else if (platform === "wechat") {
        // 用 getconfig 验证 token（不污染 cursor）
        const crypto = await import("node:crypto");
        const uin = Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
        const res = await fetch("https://ilinkai.weixin.qq.com/ilink/bot/getconfig", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "AuthorizationType": "ilink_bot_token",
            "Authorization": `Bearer ${credentials.botToken}`,
            "X-WECHAT-UIN": uin,
          },
          body: JSON.stringify({ base_info: { channel_version: "1.0.0" } }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json();
        if (data.ret && data.ret !== 0) {
          return { ok: false, error: data.errmsg || `errcode ${data.ret}` };
        }
        return { ok: true, info: { msg: "微信 iLink 连接成功" } };
      }
      return { ok: false, error: t("error.platformTestUnsupported") };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /** 获取微信扫码登录二维码 */
  app.post("/api/bridge/wechat/qrcode", async () => {
    return getWechatQrcode();
  });

  /** 轮询微信扫码状态 */
  app.post("/api/bridge/wechat/qrcode-status", async (req) => {
    const { qrcodeId } = req.body || {};
    return pollWechatQrcodeStatus(qrcodeId);
  });
}
