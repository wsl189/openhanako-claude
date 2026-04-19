/**
 * session-key.js — bridge sessionKey 解析工具
 *
 * 从 sessionKey 中提取平台、聊天类型、chatId。
 * 数据驱动：新增平台只需在 SESSION_PREFIX_MAP 注册前缀。
 */

// sessionKey 前缀 → [platform, chatType]
export const SESSION_PREFIX_MAP = [
  ["tg_dm_",       "telegram", "dm"],
  ["tg_group_",    "telegram", "group"],
  ["fs_dm_",       "feishu",   "dm"],
  ["fs_group_",    "feishu",   "group"],
  ["qq_dm_",       "qq",       "dm"],
  ["qq_group_",    "qq",       "group"],
  ["wx_dm_",       "wechat",   "dm"],
];

/** 已知平台列表（从前缀表去重） */
export const KNOWN_PLATFORMS = [...new Set(SESSION_PREFIX_MAP.map(([, p]) => p))];

function parseRawSession(rawSessionKey) {
  for (const [prefix, platform, chatType] of SESSION_PREFIX_MAP) {
    if (rawSessionKey.startsWith(prefix)) {
      return { platform, chatType, chatId: rawSessionKey.slice(prefix.length) };
    }
  }
  return { platform: "unknown", chatType: "dm", chatId: rawSessionKey };
}

/** 从 sessionKey 解析平台 + 类型 + chatId */
export function parseSessionKey(sessionKey) {
  // 新格式：<platform[:botId]>::<rawSessionKey>
  const sepIdx = sessionKey.indexOf("::");
  if (sepIdx > 0) {
    const platformKey = sessionKey.slice(0, sepIdx);
    const rawSessionKey = sessionKey.slice(sepIdx + 2);
    const base = parseRawSession(rawSessionKey);
    const colonIdx = platformKey.indexOf(":");
    const platform = colonIdx > 0 ? platformKey.slice(0, colonIdx) : platformKey;
    const botId = colonIdx > 0 ? platformKey.slice(colonIdx + 1) : null;
    return {
      platform: platform || base.platform,
      platformKey,
      botId: botId || null,
      chatType: base.chatType,
      chatId: base.chatId,
      rawSessionKey,
    };
  }

  const base = parseRawSession(sessionKey);
  return {
    ...base,
    platformKey: base.platform,
    botId: null,
    rawSessionKey: sessionKey,
  };
}

/** 组装带 bot 命名空间的 sessionKey（单 bot 平台返回 raw） */
export function buildSessionKey(platformKey, rawSessionKey) {
  if (!platformKey || !rawSessionKey) return rawSessionKey || "";
  if (!platformKey.includes(":")) return rawSessionKey;
  if (rawSessionKey.includes("::")) return rawSessionKey;
  return `${platformKey}::${rawSessionKey}`;
}

/** 从 platformKey 拆出 base platform + botId */
export function parsePlatformKey(platformKey) {
  if (!platformKey) return { platform: "", botId: null };
  const colonIdx = platformKey.indexOf(":");
  if (colonIdx <= 0) return { platform: platformKey, botId: null };
  return {
    platform: platformKey.slice(0, colonIdx),
    botId: platformKey.slice(colonIdx + 1) || null,
  };
}

/**
 * 从平台和 botId 构造 platformKey
 * - 单 bot 平台返回 base platform
 * - 多 bot 平台返回 <platform>:<botId>
 */
export function buildPlatformKey(platform, botId) {
  if (!botId) return platform;
  return `${platform}:${botId}`;
}

/**
 * 从 bridge 配置读取多 bot 列表（兼容旧单 bot 结构）
 * @param {"telegram"|"feishu"|"qq"} platform
 * @param {object} cfg
 */
export function normalizeBridgeBots(platform, cfg) {
  if (Array.isArray(cfg?.bots)) {
    return cfg.bots.filter(Boolean).map((b) => ({ ...b }));
  }

  if (platform === "telegram" && cfg?.token) {
    return [{
      id: "default",
      name: "Default Bot",
      token: cfg.token,
      enabled: cfg.enabled !== false,
      agentId: cfg.agentId || null,
    }];
  }

  if (platform === "qq" && cfg?.appID && (cfg?.appSecret || cfg?.token)) {
    return [{
      id: "default",
      name: "Default Bot",
      appID: cfg.appID,
      appSecret: cfg.appSecret || cfg.token,
      enabled: cfg.enabled !== false,
      agentId: cfg.agentId || null,
      dmGuildMap: cfg.dmGuildMap || {},
    }];
  }

  if (platform === "feishu" && cfg?.appId && cfg?.appSecret) {
    return [{
      id: "default",
      name: cfg?.name || "Feishu Bot",
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      enabled: cfg.enabled !== false,
      agentId: cfg.agentId || null,
    }];
  }

  return [];
}

/** 将 bot 列表写回平台配置（统一新结构） */
export function writeBridgeBots(cfg, bots) {
  const next = { ...(cfg || {}) };
  next.bots = bots;
  // 清掉旧字段，避免歧义
  delete next.token;
  delete next.appID;
  delete next.appId;
  delete next.appSecret;
  delete next.dmGuildMap;
  delete next.name;
  delete next.enabled;
  delete next.agentId;
  return next;
}

/**
 * 从 bridge index 中按 userId 去重收集已知用户
 * @param {object} index - bridge-index.json 的内容
 * @returns {Record<string, Array<{userId: string, name: string|null}>>}
 */
export function collectKnownUsers(index) {
  const byPlatform = {};

  for (const [sessionKey, raw] of Object.entries(index)) {
    const entry = typeof raw === "string" ? { file: raw } : raw;
    if (!entry.userId) continue;

    const { platform } = parseSessionKey(sessionKey);
    if (platform === "unknown") continue;

    if (!byPlatform[platform]) byPlatform[platform] = new Map();
    const map = byPlatform[platform];
    if (!map.has(entry.userId) || entry.name) {
      map.set(entry.userId, { userId: entry.userId, name: entry.name || null });
    }
  }

  const result = {};
  for (const [platform, map] of Object.entries(byPlatform)) {
    result[platform] = [...map.values()];
  }
  return result;
}
