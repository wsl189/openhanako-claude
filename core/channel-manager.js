/**
 * ChannelManager — 频道管理
 *
 * 从 Engine 提取，负责频道 CRUD、成员管理、新 agent 频道初始化。
 * 不持有 engine 引用，通过构造器注入依赖。
 *
 * Channel ID 化：文件名为 ch_{id}.md，frontmatter 含 id/name/description/members。
 */
import fs from "fs";
import path from "path";
import { createModuleLogger } from "../lib/debug-log.js";
import { t } from "../server/i18n.js";
import {
  addBookmarkEntry,
  getChannelMembers,
  removeChannelMember,
  removeBookmarkEntry,
  deleteChannel,
} from "../lib/channels/channel-store.js";
import { readSessionMetadata } from "./claude-session-store.js";
import { resolveClaudeTranscriptPath } from "./claude-transcript.js";

const log = createModuleLogger("channel");

function safeSessionFileSegment(value = "") {
  const raw = String(value || "").trim();
  const safe = raw.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "default";
}

export class ChannelManager {
  /**
   * @param {object} deps
   * @param {string} deps.channelsDir - 频道目录
   * @param {string} deps.agentsDir  - agents 根目录
   * @param {string} deps.userDir    - 用户数据目录
   * @param {() => object|null} deps.getHub - 返回 Hub（可能为 null）
   */
  constructor(deps) {
    this._channelsDir = deps.channelsDir;
    this._agentsDir = deps.agentsDir;
    this._userDir = deps.userDir;
    this._getHub = deps.getHub;
  }

  /**
   * 从所有频道中清理被删除的 agent
   * - 从每个频道的 members 中移除
   * - 移除后只剩 ≤1 人的频道直接删除
   * - 清理相关 bookmark
   */
  cleanupAgentFromChannels(agentId) {
    if (!this._channelsDir || !fs.existsSync(this._channelsDir)) return;

    const channelFiles = fs.readdirSync(this._channelsDir).filter(f => f.endsWith(".md"));
    const deletedChannels = [];

    for (const f of channelFiles) {
      const filePath = path.join(this._channelsDir, f);
      const channelId = f.replace(".md", "");
      const members = getChannelMembers(filePath);

      if (!members.includes(agentId)) continue;

      try {
        removeChannelMember(filePath, agentId);
        const remaining = getChannelMembers(filePath);
        if (remaining.length <= 1) {
          deleteChannel(filePath);
          deletedChannels.push(channelId);
          this._cleanupChannelSessions([channelId]);
          log.log(`频道 "${channelId}" 成员不足，已删除`);
        }
      } catch (err) {
        log.error(`清理频道 "${channelId}" 失败: ${err.message}`);
      }
    }

    if (deletedChannels.length > 0) {
      this._cleanupBookmarks(deletedChannels, agentId);
    }
  }

  /**
   * 删除频道及其所有关联数据
   */
  deleteChannelByName(channelId) {
    const filePath = path.join(this._channelsDir, `${channelId}.md`);
    if (!fs.existsSync(filePath)) {
      throw new Error(t("error.channelNotFoundById", { id: channelId }));
    }

    deleteChannel(filePath);
    this._cleanupChannelSessions([channelId]);

    // 清理所有 agent 的 bookmark
    const agentDirs = fs.readdirSync(this._agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const d of agentDirs) {
      const channelsMd = path.join(this._agentsDir, d.name, "channels.md");
      removeBookmarkEntry(channelsMd, channelId);
    }

    // 清理用户 bookmark
    const userBookmarkPath = path.join(this._userDir, "channel-bookmarks.md");
    removeBookmarkEntry(userBookmarkPath, channelId);

    log.log(`已删除频道: ${channelId}`);
  }

  resetChannelSessions(channelId) {
    this._cleanupChannelSessions([channelId]);
  }

  /**
   * 触发频道立即 triage（用户发消息后调用）
   */
  async triggerChannelTriage(channelName, opts) {
    return this._getHub()?.triggerChannelTriage(channelName, opts);
  }

  /**
   * 为新 agent 初始化频道书签
   * - 不自动创建任何频道
   * - 仅同步当前已包含该 agent 的频道到 channels.md
   */
  setupChannelsForNewAgent(agentId) {
    const channelsMdPath = path.join(this._agentsDir, agentId, "channels.md");

    // 写 agent 的 channels.md（扫描所有频道，加入包含该 agent 的）
    const allChannels = [];
    try {
      const files = fs.readdirSync(this._channelsDir);
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const channelId = f.replace(".md", "");
        const members = getChannelMembers(path.join(this._channelsDir, f));
        if (members.includes(agentId)) {
          allChannels.push(channelId);
        }
      }
    } catch {}

    for (const ch of allChannels) {
      addBookmarkEntry(channelsMdPath, ch);
    }
  }

  /** 清理被删频道的 bookmark（从其他 agent 和用户的 bookmark 中移除） */
  _cleanupBookmarks(deletedChannels, excludeAgentId) {
    const agentDirs = fs.readdirSync(this._agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== excludeAgentId);

    for (const d of agentDirs) {
      const channelsMd = path.join(this._agentsDir, d.name, "channels.md");
      for (const ch of deletedChannels) {
        try {
          removeBookmarkEntry(channelsMd, ch);
        } catch (err) {
          log.error(`清理 ${d.name} bookmark "${ch}" 失败: ${err.message}`);
        }
      }
    }

    const userBookmarkPath = path.join(this._userDir, "channel-bookmarks.md");
    for (const ch of deletedChannels) {
      try {
        removeBookmarkEntry(userBookmarkPath, ch);
      } catch (err) {
        log.error(`清理用户 bookmark "${ch}" 失败: ${err.message}`);
      }
    }
  }

  _cleanupChannelSessions(channelIds = []) {
    if (!this._agentsDir || !fs.existsSync(this._agentsDir)) return;
    const ids = [...new Set((channelIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) return;

    const agentDirs = fs.readdirSync(this._agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const d of agentDirs) {
      const channelSessionDir = path.join(this._agentsDir, d.name, "sessions", "channel");
      for (const channelId of ids) {
        const sessionPath = path.join(channelSessionDir, `${safeSessionFileSegment(channelId)}.session.json`);
        if (!fs.existsSync(sessionPath)) continue;

        try {
          const metadata = readSessionMetadata(sessionPath);
          const transcriptPath = resolveClaudeTranscriptPath(metadata.sessionId, metadata.cwd);
          if (transcriptPath) {
            try { fs.rmSync(transcriptPath, { force: true }); } catch {}
          }
        } catch {
          // Metadata may be corrupt; still remove the local shell.
        }

        try {
          fs.rmSync(sessionPath, { force: true });
          log.log(`已清理频道会话: ${d.name}/#${channelId}`);
        } catch (err) {
          log.error(`清理频道会话失败 (${d.name}/#${channelId}): ${err.message}`);
        }
      }

      try {
        if (fs.existsSync(channelSessionDir) && fs.readdirSync(channelSessionDir).length === 0) {
          fs.rmdirSync(channelSessionDir);
        }
      } catch {}
    }
  }
}
