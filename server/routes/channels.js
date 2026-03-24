/**
 * channels.js — 频道 REST API
 *
 * Channel ID 化：文件名为 ch_{id}.md，frontmatter 含 id/name/description/members。
 *
 * 端点：
 * GET    /api/channels              — 列出所有频道 + 用户 bookmark + 未读数
 * POST   /api/channels              — 创建新频道
 * GET    /api/channels/:id          — 获取频道消息 + 成员列表
 * POST   /api/channels/:id/messages — 用户发送群聊消息
 * POST   /api/channels/:id/new      — 开启新对话（重置上下文，保留历史）
 * POST   /api/channels/:id/reset    — 清空频道消息并重置
 * POST   /api/channels/:id/read     — 更新用户已读 bookmark
 * DELETE /api/channels/:id          — 删除频道
 */

import fs from "fs";
import path from "path";
import { debugLog } from "../../lib/debug-log.js";
import {
  parseChannel,
  createChannel,
  appendMessage,
  appendContextResetMarker,
  clearChannelMessages,
  readBookmarks,
  updateBookmark,
  addBookmarkEntry,
  getChannelMeta,
  isContextResetMessage,
} from "../../lib/channels/channel-store.js";
import { collectMentionedAgentIds } from "../../lib/channels/channel-mentions.js";

export default async function channelsRoute(app, { engine, hub }) {

  /** 用户 bookmark 文件路径 */
  function userBookmarkPath() {
    return path.join(engine.userDir, "channel-bookmarks.md");
  }

  /** 安全路径校验：id 不能穿越出 channelsDir */
  function safeChannelPath(id) {
    const filePath = path.join(engine.channelsDir, `${id}.md`);
    const resolved = path.resolve(filePath);
    const base = path.resolve(engine.channelsDir);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      return null;
    }
    return resolved;
  }

  // ── 列出所有频道 ──
  app.get("/api/channels", async (_req, reply) => {
    try {
      const channelsDir = engine.channelsDir;
      if (!channelsDir || !fs.existsSync(channelsDir)) {
        return { channels: [], bookmarks: {} };
      }

      const files = fs.readdirSync(channelsDir).filter(f => f.endsWith(".md"));
      const bookmarks = readBookmarks(userBookmarkPath());

      const channels = [];
      for (const f of files) {
        const channelId = f.replace(".md", "");
        const filePath = path.join(channelsDir, f);
        const content = fs.readFileSync(filePath, "utf-8");
        const { meta, messages } = parseChannel(content);
        const visibleMessages = messages.filter(m => !isContextResetMessage(m));
        const members = Array.isArray(meta.members) ? meta.members : [];

        const lastMsg = visibleMessages[visibleMessages.length - 1];
        const bookmark = bookmarks.get(channelId);

        let newMessageCount = 0;
        if (bookmark && bookmark !== "never") {
          newMessageCount = visibleMessages.filter(m => m.timestamp > bookmark).length;
        } else {
          newMessageCount = visibleMessages.length;
        }

        channels.push({
          id: channelId,
          name: meta.name || channelId,
          description: meta.description || "",
          members,
          messageCount: visibleMessages.length,
          newMessageCount,
          lastMessage: lastMsg?.body?.slice(0, 60) || "",
          lastSender: lastMsg?.sender || "",
          lastTimestamp: lastMsg?.timestamp || "",
        });
      }

      channels.sort((a, b) =>
        (b.lastTimestamp || "").localeCompare(a.lastTimestamp || "")
      );

      const bookmarksObj = {};
      for (const [k, v] of bookmarks) bookmarksObj[k] = v;

      return { channels, bookmarks: bookmarksObj };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 创建新频道 ──
  app.post("/api/channels", async (req, reply) => {
    try {
      const { name, description, members, intro } = req.body || {};

      if (!name || typeof name !== "string") {
        reply.code(400);
        return { error: "name is required" };
      }
      if (!Array.isArray(members) || members.length < 2) {
        reply.code(400);
        return { error: "members must be an array with at least 2 items" };
      }

      const channelsDir = engine.channelsDir;
      fs.mkdirSync(channelsDir, { recursive: true });

      const { id: channelId } = createChannel(channelsDir, {
        name,
        description: description || undefined,
        members,
        intro: intro || undefined,
      });

      // 给每个 agent 成员的 channels.md 添加 bookmark
      const agentsDir = engine.agentsDir;
      for (const memberId of members) {
        const memberDir = path.join(agentsDir, memberId);
        if (fs.existsSync(memberDir)) {
          const memberChannelsMd = path.join(memberDir, "channels.md");
          addBookmarkEntry(memberChannelsMd, channelId);
        }
      }

      // 也给用户添加 bookmark
      addBookmarkEntry(userBookmarkPath(), channelId);

      debugLog()?.log("api", `POST /channels — created "${channelId}" (${name}) members=[${members}]`);
      return { ok: true, id: channelId, name, members };
    } catch (err) {
      if (err.message?.includes("已存在")) {
        reply.code(409);
      } else {
        reply.code(500);
      }
      return { error: err.message };
    }
  });

  // ── 获取频道消息 ──
  app.get("/api/channels/:name", async (req, reply) => {
    try {
      const { name } = req.params;
      const filePath = safeChannelPath(name);
      if (!filePath) { reply.code(400); return { error: "Invalid channel id" }; }

      if (!fs.existsSync(filePath)) {
        reply.code(404);
        return { error: "Channel not found" };
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const { meta, messages } = parseChannel(content);
      const members = Array.isArray(meta.members) ? meta.members : [];
      const apiMessages = messages.map((m) =>
        isContextResetMessage(m)
          ? { ...m, body: "", isContextReset: true }
          : m,
      );

      return {
        id: meta.id || name,
        name: meta.name || name,
        description: meta.description || "",
        messages: apiMessages,
        members,
      };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 用户发送消息 ──
  app.post("/api/channels/:name/messages", async (req, reply) => {
    try {
      const { name } = req.params;
      const filePath = safeChannelPath(name);
      if (!filePath) { reply.code(400); return { error: "Invalid channel id" }; }

      const { body } = req.body || {};

      if (typeof body !== "string" || !body.trim()) {
        reply.code(400);
        return { error: "body is required" };
      }

      if (!fs.existsSync(filePath)) {
        reply.code(404);
        return { error: "Channel not found" };
      }

      const senderName = engine.userName || "user";
      const result = appendMessage(filePath, senderName, body);

      debugLog()?.log("api", `POST /channels/${name}/messages`);

      // 提取 @ 提及（多提及时用于并行 triage）
      const meta = getChannelMeta(filePath);
      const channelMembers = Array.isArray(meta.members) ? meta.members : [];
      const allAgents = engine.listAgents?.() || [];
      const mentionedAgents = collectMentionedAgentIds(body, allAgents, channelMembers);

      hub.triggerChannelTriage(name, { source: "user", mentionedAgents })?.catch(err =>
        console.error(`[channel] 触发频道调度失败: ${err.message}`)
      );

      return { ok: true, timestamp: result.timestamp };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 显式终止频道中未完成回复 ──
  app.post("/api/channels/:name/stop", async (req, reply) => {
    try {
      const { name } = req.params;
      const filePath = safeChannelPath(name);
      if (!filePath) { reply.code(400); return { error: "Invalid channel id" }; }
      if (!fs.existsSync(filePath)) {
        reply.code(404);
        return { error: "Channel not found" };
      }

      const stopResult = hub.stopChannelReplies?.(`channel:${name}:user-stop`) || { aborted: false, version: 0 };
      debugLog()?.log("api", `POST /channels/${name}/stop — aborted=${!!stopResult?.aborted}`);
      return { ok: true, stopped: true, aborted: !!stopResult?.aborted, version: stopResult?.version || 0 };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 更新用户已读 bookmark ──
  app.post("/api/channels/:name/read", async (req, reply) => {
    try {
      const { name } = req.params;
      const filePath = safeChannelPath(name);
      if (!filePath) { reply.code(400); return { error: "Invalid channel id" }; }

      const { timestamp } = req.body || {};

      if (!timestamp) {
        reply.code(400);
        return { error: "timestamp is required" };
      }

      updateBookmark(userBookmarkPath(), name, timestamp);
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 开始新对话（保留历史，仅重置上下文） ──
  app.post("/api/channels/:name/new", async (req, reply) => {
    try {
      const { name } = req.params;
      const filePath = safeChannelPath(name);
      if (!filePath) { reply.code(400); return { error: "Invalid channel id" }; }
      if (!fs.existsSync(filePath)) {
        reply.code(404);
        return { error: "Channel not found" };
      }

      const timestamp = await appendContextResetMarker(filePath);
      if (!timestamp) {
        reply.code(500);
        return { error: "Failed to append context reset marker" };
      }

      debugLog()?.log("api", `POST /channels/${name}/new`);
      return { ok: true, timestamp };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 清空频道消息（保留元数据） ──
  app.post("/api/channels/:name/reset", async (req, reply) => {
    try {
      const { name } = req.params;
      const filePath = safeChannelPath(name);
      if (!filePath) { reply.code(400); return { error: "Invalid channel id" }; }
      if (!fs.existsSync(filePath)) {
        reply.code(404);
        return { error: "Channel not found" };
      }

      await clearChannelMessages(filePath);
      debugLog()?.log("api", `POST /channels/${name}/reset`);
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 删除频道 ──
  app.delete("/api/channels/:name", async (req, reply) => {
    try {
      const { name } = req.params;
      const filePath = safeChannelPath(name);
      if (!filePath) { reply.code(400); return { error: "Invalid channel id" }; }

      engine.deleteChannelByName(name);
      debugLog()?.log("api", `DELETE /channels/${name}`);
      return { ok: true };
    } catch (err) {
      if (err.message?.includes("不存在")) {
        reply.code(404);
      } else {
        reply.code(500);
      }
      return { error: err.message };
    }
  });
}
