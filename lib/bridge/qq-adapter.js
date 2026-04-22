/**
 * qq-adapter.js — QQ 机器人适配器（v2 API）
 *
 * 使用 QQ 开放平台 v2 鉴权（AppID + AppSecret → access_token）。
 * 自建 WebSocket 连接接收消息，支持频道消息和 C2C 私信。
 *
 * 凭证：appID + appSecret，从 QQ 机器人开放平台获取。
 */

import WebSocket from "ws";
import { debugLog } from "../debug-log.js";

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const MAX_MSG_SIZE = 100_000;
const PLACEHOLDER_CONTENT = "\u200b";

function looksLikeMarkdown(text = "") {
  if (!text) return false;
  if (/```/.test(text)) return true;
  if (/^#{1,6}\s+/m.test(text)) return true;
  if (/!\[[^\]]*\]\([^)]+\)/.test(text)) return true;
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) return true;
  if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/m.test(text)) return true;
  if (/^\s*>\s+/m.test(text)) return true;
  if (/\*\*[^*]+\*\*/.test(text) || /__[^_]+__/.test(text)) return true;
  if (/~~[^~]+~~/.test(text)) return true;
  return false;
}

function markdownToPlainText(md = "") {
  let text = md;
  // 代码块保留代码内容
  text = text.replace(/```[\w-]*\n([\s\S]*?)```/g, "$1");
  // 图片与链接保留可读信息
  text = text.replace(/!\[[^\]]*]\(([^)]+)\)/g, "[图片] $1");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  // 常见 markdown 标记
  text = text.replace(/^#{1,6}\s*/gm, "");
  text = text.replace(/^\s*>\s?/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "- ");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");
  return text.trim();
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "mkv", "avi", "webm"]);
const AUDIO_EXTS = new Set(["mp3", "ogg", "wav", "m4a", "opus", "amr", "silk", "aac", "flac", "weba"]);

function extractExtFromPathLike(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  let fileLike = raw;
  try {
    fileLike = new URL(raw).pathname || "";
  } catch {
    // keep raw when not a valid URL
  }
  const noQuery = fileLike.split(/[?#]/)[0];
  const name = noQuery.split("/").pop() || noQuery;
  const m = /\.([a-zA-Z0-9]{1,12})$/.exec(name);
  return m?.[1]?.toLowerCase() || "";
}

function inferAttachmentType(att = {}) {
  const contentType = String(att.content_type || "").toLowerCase();
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";

  const ext = extractExtFromPathLike(att.filename || att.url);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "file";
}

// WebSocket OpCode
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

// Intents
const INTENTS = {
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
};

/**
 * @param {object} opts
 * @param {string} opts.appID
 * @param {string} opts.appSecret
 * @param {(msg: object) => void} opts.onMessage
 * @param {Record<string,string>} [opts.dmGuildMap]
 * @param {(userId: string, guildId: string) => void} [opts.onDmGuildDiscovered]
 * @param {(status: string, error?: string) => void} [opts.onStatus]
 */
export function createQQAdapter({ appID, appSecret, onMessage, dmGuildMap, onDmGuildDiscovered, onStatus }) {
  let accessToken = null;
  let tokenExpiresAt = 0;
  let ws = null;
  let heartbeatTimer = null;
  let lastSeq = null;
  let sessionId = null;
  let stopped = false;
  let reconnectAttempts = 0;
  let heartbeatAckReceived = true;
  let lastConnectedAt = 0;

  const userGuildMap = new Map(Object.entries(dmGuildMap || {}));
  const guildUserMap = new Map();
  for (const [userId, guildId] of userGuildMap.entries()) {
    if (!userId || !guildId || guildUserMap.has(guildId)) continue;
    guildUserMap.set(guildId, userId);
  }

  // ── Token 管理 ──

  async function refreshToken() {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: appID, clientSecret: appSecret }),
    });
    const data = await res.json();
    if (!data.access_token) {
      throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);
    }
    accessToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in || 7200) * 1000;
    debugLog()?.log("bridge", `[qq] token 已刷新，有效期 ${data.expires_in}s`);
    return accessToken;
  }

  async function getToken() {
    // 提前 5 分钟刷新
    if (!accessToken || Date.now() > tokenExpiresAt - 5 * 60 * 1000) {
      return refreshToken();
    }
    return accessToken;
  }

  // ── API 请求 ──

  async function apiRequest(method, path, body) {
    const token = await getToken();
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`QQ API [${path}] ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  function uniq(values = []) {
    const out = [];
    const seen = new Set();
    for (const v of values) {
      const x = typeof v === "string" ? v.trim() : "";
      if (!x || seen.has(x)) continue;
      seen.add(x);
      out.push(x);
    }
    return out;
  }

  function normalizeFileName(name) {
    const raw = typeof name === "string" ? name.trim() : "";
    if (!raw) return "";
    const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").replace(/\s+/g, " ").trim();
    if (!cleaned) return "";
    return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
  }

  function rememberDmGuild(userId, guildId) {
    const u = typeof userId === "string" ? userId.trim() : "";
    const g = typeof guildId === "string" ? guildId.trim() : "";
    if (!u || !g) return;
    const changed = userGuildMap.get(u) !== g;
    userGuildMap.set(u, g);
    if (!guildUserMap.has(g)) guildUserMap.set(g, u);
    if (changed) onDmGuildDiscovered?.(u, g);
  }

  function mediaTypeHint(fileType) {
    if (fileType === 4) {
      return "QQ 普通文件(file_type=4)仅支持 C2C 单聊，群聊/频道私信/频道暂不支持。";
    }
    if (fileType === 3) {
      return "QQ 语音(file_type=3)在频道相关场景兼容性有限，可改为图片/视频或文本链接。";
    }
    return "";
  }

  async function uploadRichMedia(chatId, uploadBody, { userId, fileType }) {
    const userCandidates = uniq([userId, guildUserMap.get(chatId), chatId]);
    const attempts = [];
    const seenPath = new Set();

    for (const uid of userCandidates) {
      const path = `/v2/users/${uid}/files`;
      if (seenPath.has(path)) continue;
      seenPath.add(path);
      attempts.push({ name: `users:${uid}`, path });
    }

    const groupPath = `/v2/groups/${chatId}/files`;
    if (!seenPath.has(groupPath)) {
      seenPath.add(groupPath);
      attempts.push({ name: `groups:${chatId}`, path: groupPath });
    }

    const errors = [];
    for (const attempt of attempts) {
      try {
        const res = await apiRequest("POST", attempt.path, uploadBody);
        const fileInfo = res?.file_info;
        if (!fileInfo) throw new Error("missing file_info");
        return { fileInfo, route: attempt.name };
      } catch (err) {
        errors.push(`${attempt.name}=${err.message}`);
      }
    }

    const hint = mediaTypeHint(fileType);
    const suffix = hint ? `；${hint}` : "";
    throw new Error(`[qq:upload] all routes failed chatId=${chatId}${suffix}: ${errors.join(" | ")}`);
  }

  async function sendRichMediaMessage(chatId, fileInfo, { userId, content }) {
    const text = typeof content === "string" && content.trim() ? content.trim() : " ";
    const msgBody = { msg_type: 7, media: { file_info: fileInfo }, content: text };
    const userCandidates = uniq([userId, guildUserMap.get(chatId), chatId]);
    const dmCandidates = uniq([chatId, userGuildMap.get(userId)]);
    const attempts = [];
    const seenPath = new Set();

    for (const uid of userCandidates) {
      const path = `/v2/users/${uid}/messages`;
      if (seenPath.has(path)) continue;
      seenPath.add(path);
      attempts.push({ name: `users:${uid}`, path });
    }

    const groupPath = `/v2/groups/${chatId}/messages`;
    if (!seenPath.has(groupPath)) {
      seenPath.add(groupPath);
      attempts.push({ name: `groups:${chatId}`, path: groupPath });
    }

    for (const gid of dmCandidates) {
      const path = `/dms/${gid}/messages`;
      if (seenPath.has(path)) continue;
      seenPath.add(path);
      attempts.push({ name: `dms:${gid}`, path });
    }

    const channelPath = `/channels/${chatId}/messages`;
    if (!seenPath.has(channelPath)) {
      seenPath.add(channelPath);
      attempts.push({ name: `channels:${chatId}`, path: channelPath });
    }

    const errors = [];
    for (const attempt of attempts) {
      try {
        await apiRequest("POST", attempt.path, msgBody);
        return { route: attempt.name };
      } catch (err) {
        errors.push(`${attempt.name}=${err.message}`);
      }
    }
    throw new Error(`[qq:media-send] all routes failed chatId=${chatId}: ${errors.join(" | ")}`);
  }

  // ── WebSocket ──

  async function connect() {
    if (stopped) return;
    try {
      const token = await getToken();
      const { url } = await apiRequest("GET", "/gateway");

      ws = new WebSocket(url);

      ws.on("open", () => {
        debugLog()?.log("bridge", "[qq] WebSocket 已连接");
        lastConnectedAt = Date.now();
        reconnectAttempts = 0;
      });

      ws.on("message", (raw) => {
        let payload;
        try { payload = JSON.parse(raw); } catch { return; }
        handlePayload(payload, token);
      });

      ws.on("close", (code) => {
        debugLog()?.log("bridge", `[qq] WebSocket 断开 (code: ${code})`);
        stopHeartbeat();
        if (!stopped) scheduleReconnect();
      });

      ws.on("error", (err) => {
        console.error("[qq] WebSocket error:", err.message);
        debugLog()?.error("bridge", `[qq] WebSocket error: ${err.message}`);
        onStatus?.("error", err.message);
      });
    } catch (err) {
      console.error("[qq] 连接失败:", err.message);
      onStatus?.("error", err.message);
      if (!stopped) scheduleReconnect();
    }
  }

  function handlePayload(payload, token) {
    const { op, d, s, t } = payload;
    if (s) lastSeq = s;

    switch (op) {
      case OP.HELLO:
        startHeartbeat(d.heartbeat_interval);
        // 鉴权
        if (sessionId) {
          // Resume
          wsSend({ op: OP.RESUME, d: { token: `QQBot ${token}`, session_id: sessionId, seq: lastSeq } });
        } else {
          // Identify
          wsSend({
            op: OP.IDENTIFY,
            d: {
              token: `QQBot ${token}`,
              intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GROUP_AND_C2C,
              shard: [0, 1],
            },
          });
        }
        break;

      case OP.DISPATCH:
        if (t === "READY") {
          sessionId = d.session_id;
          debugLog()?.log("bridge", `[qq] 鉴权成功，session: ${sessionId}`);
          onStatus?.("connected");
        } else if (t === "RESUMED") {
          debugLog()?.log("bridge", "[qq] 会话已恢复");
          onStatus?.("connected");
        } else {
          handleEvent(t, d);
        }
        break;

      case OP.HEARTBEAT_ACK:
        heartbeatAckReceived = true;
        break;

      case OP.RECONNECT:
        debugLog()?.log("bridge", "[qq] 收到重连指令");
        ws?.close();
        break;

      case OP.INVALID_SESSION:
        debugLog()?.log("bridge", "[qq] 会话失效，重新鉴权");
        sessionId = null;
        lastSeq = null;
        ws?.close();
        break;
    }
  }

  /** 从 QQ v2 API 事件的 data.attachments 提取统一附件 */
  function extractAttachments(data) {
    const attachments = [];
    if (data.attachments?.length) {
      for (const att of data.attachments) {
        const ct = att.content_type || "";
        const type = inferAttachmentType(att);
        attachments.push({
          type, url: att.url, filename: att.filename,
          mimeType: ct, size: att.size,
          width: att.width, height: att.height,
        });
      }
    }
    return attachments;
  }

  function handleEvent(type, data) {
    // C2C 私信
    if (type === "C2C_MESSAGE_CREATE") {
      const text = (data.content || "").trim();
      const attachments = extractAttachments(data);
      if (!text && !attachments.length) return;
      if (text.length > MAX_MSG_SIZE) return;
      onMessage({
        platform: "qq",
        chatId: data.author?.user_openid || data.author?.id,
        userId: data.author?.user_openid || data.author?.id,
        sessionKey: `qq_dm_${data.author?.user_openid || data.author?.id}`,
        text: text.slice(0, MAX_MSG_SIZE),
        senderName: data.author?.username || "User",
        isGroup: false,
        _msgId: data.id,
        attachments: attachments.length ? attachments : undefined,
      });
    }
    // 群聊消息
    else if (type === "GROUP_AT_MESSAGE_CREATE") {
      let text = (data.content || "").replace(/<@!?\d+>/g, "").trim();
      const attachments = extractAttachments(data);
      if (!text && !attachments.length) return;
      if (text.length > MAX_MSG_SIZE) return;
      onMessage({
        platform: "qq",
        chatId: data.group_openid,
        userId: data.author?.member_openid || data.author?.id,
        sessionKey: `qq_group_${data.group_openid}`,
        text: text.slice(0, MAX_MSG_SIZE),
        senderName: data.author?.username || "User",
        isGroup: true,
        _msgId: data.id,
        attachments: attachments.length ? attachments : undefined,
      });
    }
    // 频道公域消息（兼容旧的频道机器人）
    else if (type === "AT_MESSAGE_CREATE") {
      let text = (data.content || "").replace(/<@!?\d+>/g, "").trim();
      const attachments = extractAttachments(data);
      if (!text && !attachments.length) return;
      onMessage({
        platform: "qq",
        chatId: data.channel_id,
        userId: data.author?.id,
        sessionKey: `qq_group_${data.channel_id}`,
        text: text.slice(0, MAX_MSG_SIZE),
        senderName: data.author?.username || "User",
        isGroup: true,
        _msgId: data.id,
        attachments: attachments.length ? attachments : undefined,
      });
    }
    // 频道私信
    else if (type === "DIRECT_MESSAGE_CREATE") {
      const text = (data.content || "").trim();
      const attachments = extractAttachments(data);
      if (!text && !attachments.length) return;
      const chatId = data.guild_id;
      rememberDmGuild(data.author?.id, chatId);
      onMessage({
        platform: "qq",
        chatId,
        userId: data.author?.id,
        sessionKey: `qq_dm_${data.author?.id}`,
        text: text.slice(0, MAX_MSG_SIZE),
        senderName: data.author?.username || "User",
        isGroup: false,
        _msgId: data.id,
        attachments: attachments.length ? attachments : undefined,
      });
    }
  }

  function wsSend(data) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function startHeartbeat(interval) {
    stopHeartbeat();
    heartbeatAckReceived = true;
    heartbeatTimer = setInterval(() => {
      if (!heartbeatAckReceived) {
        debugLog()?.log("bridge", "[qq] 心跳超时（未收到 ACK），强制重连");
        ws?.close();
        return;
      }
      heartbeatAckReceived = false;
      wsSend({ op: OP.HEARTBEAT, d: lastSeq });
    }, interval);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    // 如果上次连接保活超过 5 分钟，说明不是启动阶段频繁失败，重置计数
    if (lastConnectedAt && Date.now() - lastConnectedAt > 5 * 60 * 1000) {
      reconnectAttempts = 0;
    }
    const delays = [1000, 2000, 5000, 10000, 30000, 60000];
    const delay = delays[Math.min(reconnectAttempts, delays.length - 1)];
    reconnectAttempts++;
    debugLog()?.log("bridge", `[qq] ${delay / 1000}s 后重连（第 ${reconnectAttempts} 次）`);
    setTimeout(() => connect(), delay);
  }

  // ── 启动 ──
  connect();

  // ── Token 定时刷新 ──
  let tokenRefreshFailures = 0;
  const tokenRefreshTimer = setInterval(async () => {
    try {
      await refreshToken();
      tokenRefreshFailures = 0;
    } catch (err) {
      tokenRefreshFailures++;
      console.error(`[qq] token 刷新失败（连续第 ${tokenRefreshFailures} 次）:`, err.message);
      debugLog()?.error("bridge", `[qq] token 刷新失败: ${err.message}`);
      if (tokenRefreshFailures >= 3) {
        onStatus?.("error", `Token 连续 ${tokenRefreshFailures} 次刷新失败`);
      }
    }
  }, 60 * 60 * 1000); // 每小时刷新

  let lastBlockTs = 0;

  return {
    async _sendChunkWithMode(chatId, chunk, _msgId, mode = "text") {
      const isMarkdown = mode === "markdown";
      const common = _msgId ? { msg_id: _msgId } : {};
      const attempts = isMarkdown
        ? [
            {
              name: "c2c-markdown",
              path: `/v2/users/${chatId}/messages`,
              body: { content: PLACEHOLDER_CONTENT, msg_type: 2, markdown: { content: chunk }, ...common },
            },
            {
              name: "group-markdown",
              path: `/v2/groups/${chatId}/messages`,
              body: { content: PLACEHOLDER_CONTENT, msg_type: 2, markdown: { content: chunk }, ...common },
            },
            {
              name: "dms-markdown",
              path: `/dms/${chatId}/messages`,
              body: { content: PLACEHOLDER_CONTENT, markdown: { content: chunk }, ...common },
            },
            {
              name: "channel-markdown",
              path: `/channels/${chatId}/messages`,
              body: { content: PLACEHOLDER_CONTENT, markdown: { content: chunk }, ...common },
            },
          ]
        : [
            {
              name: "c2c-text",
              path: `/v2/users/${chatId}/messages`,
              body: { content: chunk, msg_type: 0, ...common },
            },
            {
              name: "group-text",
              path: `/v2/groups/${chatId}/messages`,
              body: { content: chunk, msg_type: 0, ...common },
            },
            {
              name: "dms-text",
              path: `/dms/${chatId}/messages`,
              body: { content: chunk, ...common },
            },
            {
              name: "channel-text",
              path: `/channels/${chatId}/messages`,
              body: { content: chunk, ...common },
            },
          ];

      const errors = [];
      for (const attempt of attempts) {
        try {
          await apiRequest("POST", attempt.path, attempt.body);
          return;
        } catch (err) {
          errors.push(`${attempt.name}=${err.message}`);
        }
      }
      throw new Error(`[qq:${mode}] all routes failed chatId=${chatId}: ${errors.join(" | ")}`);
    },

    async sendReply(chatId, text, _msgId) {
      const MAX = 2000;
      const preferMarkdown = looksLikeMarkdown(text);
      for (let i = 0; i < text.length; i += MAX) {
        const chunk = text.slice(i, i + MAX);
        if (preferMarkdown) {
          try {
            await this._sendChunkWithMode(chatId, chunk, _msgId, "markdown");
          } catch (mdErr) {
            // 常见原因：未开通 markdown 权限。自动降级为纯文本，避免消息完全发不出去。
            const plain = markdownToPlainText(chunk);
            debugLog()?.warn("bridge", `[qq] markdown 发送失败，降级文本发送: ${mdErr.message}`);
            await this._sendChunkWithMode(chatId, plain || chunk, _msgId, "text");
          }
          continue;
        }

        await this._sendChunkWithMode(chatId, chunk, _msgId, "text");
      }
    },

    async sendBlockReply(chatId, text, _msgId) {
      const now = Date.now();
      const elapsed = now - lastBlockTs;
      const delay = 800 + Math.random() * 1200;
      if (lastBlockTs && elapsed < delay) {
        await new Promise((r) => setTimeout(r, delay - elapsed));
      }
      await this.sendReply(chatId, text, _msgId);
      lastBlockTs = Date.now();
    },

    /** 发送媒体（两步上传：先上传获取 file_info，再发送富媒体消息） */
    async sendMedia(chatId, url, opts = {}) {
      const ext = (() => { try { return new URL(url).pathname.split(".").pop()?.toLowerCase() || ""; } catch { return ""; } })();
      const imageExts = ["jpg", "jpeg", "png", "gif", "webp"];
      const videoExts = ["mp4", "mov"];
      const audioExts = ["mp3", "ogg", "wav", "silk", "amr"];
      const userId = opts?.userId ? String(opts.userId) : undefined;

      // file_type: 1=图片, 2=视频, 3=音频, 4=文件
      let fileType = 4;
      if (imageExts.includes(ext)) fileType = 1;
      else if (videoExts.includes(ext)) fileType = 2;
      else if (audioExts.includes(ext)) fileType = 3;

      const parsedName = (() => {
        try {
          const pathname = new URL(url).pathname || "";
          return normalizeFileName(pathname.split("/").pop() || "");
        } catch {
          return "";
        }
      })();

      const uploadBody = { file_type: fileType, url, srv_send_msg: false };
      if (parsedName) {
        // 兼容不同网关实现：字段未知时服务端通常会忽略
        uploadBody.file_name = parsedName;
        uploadBody.filename = parsedName;
      }
      try {
        const { fileInfo, route: uploadRoute } = await uploadRichMedia(chatId, uploadBody, { userId, fileType });
        const hintText = fileType === 4 && parsedName ? `文件：${parsedName}` : " ";
        const { route: sendRoute } = await sendRichMediaMessage(chatId, fileInfo, { userId, content: hintText });
        debugLog()?.log("bridge", `[qq] media sent upload=${uploadRoute} send=${sendRoute}`);
      } catch (err) {
        debugLog()?.error("bridge", `[qq] media send failed: ${err.message}`);
        throw err;
      }
    },

    /** 发送本地 Buffer（桌面端推送文件用，尝试 base64 上传） */
    async sendMediaBuffer(chatId, buffer, opts = {}) {
      const mime = opts?.mime || "application/octet-stream";
      const filename = opts?.filename || "file";
      const userId = opts?.userId ? String(opts.userId) : undefined;
      const imageExts = ["jpg", "jpeg", "png", "gif", "webp"];
      const videoExts = ["mp4", "mov"];
      const audioExts = ["mp3", "ogg", "wav", "silk", "amr"];
      const ext = (filename || "").split(".").pop()?.toLowerCase() || "";

      let fileType = 4;
      if (mime.startsWith("image/") || imageExts.includes(ext)) fileType = 1;
      else if (mime.startsWith("video/") || videoExts.includes(ext)) fileType = 2;
      else if (mime.startsWith("audio/") || audioExts.includes(ext)) fileType = 3;

      const safeName = normalizeFileName(filename);

      // 尝试用 file_data (base64) 上传
      const uploadBody = { file_type: fileType, file_data: buffer.toString("base64"), srv_send_msg: false };
      if (safeName) {
        uploadBody.file_name = safeName;
        uploadBody.filename = safeName;
      }
      try {
        const { fileInfo, route: uploadRoute } = await uploadRichMedia(chatId, uploadBody, { userId, fileType });
        const hintText = fileType === 4 && safeName ? `文件：${safeName}` : " ";
        const { route: sendRoute } = await sendRichMediaMessage(chatId, fileInfo, { userId, content: hintText });
        debugLog()?.log("bridge", `[qq] media buffer sent upload=${uploadRoute} send=${sendRoute}`);
      } catch (err) {
        debugLog()?.warn("bridge", `[qq] sendMediaBuffer 失败: ${err.message}`);
        throw err;
      }
    },

    async downloadAttachment(url) {
      const mediaUrl = String(url || "").trim();
      if (!mediaUrl) throw new Error("empty attachment url");
      const token = await getToken();
      const res = await fetch(mediaUrl, {
        headers: {
          Authorization: `QQBot ${token}`,
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`QQ attachment download failed (${res.status}): ${text.slice(0, 200)}`);
      }
      return Buffer.from(await res.arrayBuffer());
    },

    stop() {
      stopped = true;
      stopHeartbeat();
      clearInterval(tokenRefreshTimer);
      if (ws) {
        try { ws.close(); } catch {}
        ws = null;
      }
    },

    async getMe() {
      return apiRequest("GET", "/users/@me");
    },

    resolveOwnerChatId(userId) {
      return userGuildMap.get(userId) || null;
    },

    resolveOwnerUserId(chatId) {
      return guildUserMap.get(chatId) || null;
    },
  };
}
