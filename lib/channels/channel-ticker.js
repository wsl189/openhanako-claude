/**
 * channel-ticker.js — 频道事件调度器（无轮询）
 *
 * 设计目标：
 * - 彻底事件驱动，不做周期轮询
 * - 有明确 @ 目标时：直接执行被 @ 成员（可并行），不做 triage
 * - 仅“用户消息且无 @”时：按 agent 顺序串行 triage
 * - 执行中的任务不被后续消息中断，后续消息排队
 */

import {
  readBookmarks,
  updateBookmark,
  getNewMessages,
  getRecentMessages,
  formatMessagesForLLM,
} from "./channel-store.js";
import { debugLog } from "../debug-log.js";
import { getLocale } from "../../server/i18n.js";
import fs from "fs";
import path from "path";

/**
 * 创建频道事件调度器
 *
 * @param {object} opts
 * @param {string} opts.channelsDir - 频道目录
 * @param {string} opts.agentsDir - agents 父目录
 * @param {() => string[]} opts.getAgentOrder - 返回参与频道处理的 agent ID 列表
 * @param {(agentId, channelName, newMessages, allUpdates, opts?) => Promise<{replied, replyContent?}>} opts.executeCheck
 * @param {(agentId, channelName, contextText) => Promise<void>} opts.onMemorySummarize
 * @param {(event, data) => void} [opts.onEvent]
 * @returns {{ start: () => void, stop: () => Promise<void>, triggerImmediate: (channelName: string, opts?: object) => Promise<void>, isRunning: boolean }}
 */
export function createChannelTicker({
  channelsDir,
  agentsDir,
  getAgentOrder,
  executeCheck,
  onMemorySummarize,
  onEvent,
}) {
  let _stopped = true;
  let _dispatchChain = Promise.resolve();
  let _runningJobs = 0;

  /** 获取频道文件中最新一条消息时间戳 */
  function getLatestTimestamp(channelFile) {
    if (!fs.existsSync(channelFile)) return null;
    const content = fs.readFileSync(channelFile, "utf-8");
    const headerRe = /^### .+? \| (\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)$/gm;
    let lastMatch = null;
    let m;
    while ((m = headerRe.exec(content)) !== null) {
      lastMatch = m[1];
    }
    return lastMatch;
  }

  /**
   * 将本次成功处理过的 bookmark 对齐到频道最终最新时间戳。
   * 这样可以避免并行处理时 bookmark 落后导致重复触发。
   *
   * @param {string} channelFile
   * @param {string} channelName
   * @param {Array<{ channelsMdPath: string }>} processedEntries
   */
  function syncProcessedBookmarksToLatest(channelFile, channelName, processedEntries) {
    if (!processedEntries?.length) return;
    const latestTs = getLatestTimestamp(channelFile);
    if (!latestTs) return;

    const dedup = new Set(processedEntries.map(e => e.channelsMdPath).filter(Boolean));
    for (const channelsMdPath of dedup) {
      const bookmarks = readBookmarks(channelsMdPath);
      if (!bookmarks.has(channelName)) continue;
      updateBookmark(channelsMdPath, channelName, latestTs);
    }
  }

  /**
   * 将未被 @ 的 agent 书签推进到指定时间戳。
   * 这个时间戳应为“触发事件发生时”的最新消息时间，而非调度结束后的最新时间。
   * 这样可避免级联 @（A 回 @B）被误判为 B 已读。
   *
   * @param {string} channelName
   * @param {string[]} allAgents
   * @param {string[]} mentionedAgents
   * @param {string|null} timestamp
   */
  function markUnmentionedAgentsAsReadByTimestamp(channelName, allAgents, mentionedAgents, timestamp) {
    if (!timestamp) return;

    const mentioned = new Set((mentionedAgents || []).filter(Boolean));
    for (const agentId of allAgents || []) {
      if (mentioned.has(agentId)) continue;
      const channelsMdPath = path.join(agentsDir, agentId, "channels.md");
      const bookmarks = readBookmarks(channelsMdPath);
      if (!bookmarks.has(channelName)) continue;
      updateBookmark(channelsMdPath, channelName, timestamp);
    }
  }

  /**
   * 执行单个 agent 在单个频道的一轮处理。
   * - forceReply=true: 跳过 triage，直接进入回复轮
   * - forceReply=false: 按 executeCheck 内部 triage 规则决定是否回复
   */
  async function processAgentOnce(agentId, channelName, { forceReply = false } = {}) {
    const channelFile = path.join(channelsDir, `${channelName}.md`);
    const channelsMdPath = path.join(agentsDir, agentId, "channels.md");
    const bookmarks = readBookmarks(channelsMdPath);

    if (!bookmarks.has(channelName)) {
      return { status: "skip" };
    }

    const bookmark = bookmarks.get(channelName);
    const bk = bookmark === "never" ? null : bookmark;
    const unread = getNewMessages(channelFile, bk, agentId);
    if (unread.length === 0) {
      return { status: "skip" };
    }

    const recentMsgs = getRecentMessages(channelFile, 20, agentId);
    if (recentMsgs.length === 0) {
      return { status: "skip" };
    }

    try {
      const result = await executeCheck(agentId, channelName, recentMsgs, [], { forceReply });

      const latestTs = getLatestTimestamp(channelFile);
      if (latestTs) {
        updateBookmark(channelsMdPath, channelName, latestTs);
      }

      if (result?.replied && onMemorySummarize) {
        const contextText = formatMessagesForLLM(recentMsgs);
        const myReplyTag = getLocale().startsWith("zh") ? "[我的回复]" : "[My reply]";
        const fullContext = result.replyContent
          ? `${contextText}\n\n${myReplyTag} ${result.replyContent}`
          : contextText;
        await onMemorySummarize(agentId, channelName, fullContext);
      }

      return { status: "ok", channelsMdPath };
    } catch (err) {
      console.error(`[channel-ticker] ${agentId}/#${channelName} 处理失败: ${err.message}`);
      return { status: "error" };
    }
  }

  /**
   * 有明确 @ 对象时：并行直回（无 triage）
   */
  async function runMentionDispatch(channelName, allAgents, mentionedAgents) {
    const channelFile = path.join(channelsDir, `${channelName}.md`);
    const dispatchStartLatestTs = getLatestTimestamp(channelFile);
    const mentionSet = new Set((mentionedAgents || []).filter(Boolean));
    const agents = allAgents.filter(id => mentionSet.has(id));

    if (agents.length === 0) return;

    console.log(`\x1b[90m[channel-ticker] #${channelName} 定向 @ 调度（${agents.length} 人）：${agents.join(", ")}\x1b[0m`);
    debugLog()?.log("ticker", `mention dispatch #${channelName}: ${agents.join(",")}`);
    onEvent?.("channel_dispatch_start", { channelName, mode: "mention_direct", agents });

    const processedEntries = [];
    const settled = await Promise.allSettled(
      agents.map(agentId => processAgentOnce(agentId, channelName, { forceReply: true })),
    );
    for (const item of settled) {
      const r = item.status === "fulfilled" ? item.value : null;
      if (r?.status === "ok" && r.channelsMdPath) {
        processedEntries.push({ channelsMdPath: r.channelsMdPath });
      }
    }

    syncProcessedBookmarksToLatest(channelFile, channelName, processedEntries);
    // 关键：把未被 @ 的成员只推进到“本次触发前”的时间点，
    // 避免吞掉本轮被 @ 成员新产出的级联 @ 消息。
    markUnmentionedAgentsAsReadByTimestamp(channelName, allAgents, agents, dispatchStartLatestTs);
    onEvent?.("channel_dispatch_done", { channelName, mode: "mention_direct", agents });
  }

  /**
   * 仅“用户无 @ 输入”时：全员顺序 triage
   */
  async function runUserTriageDispatch(channelName, allAgents) {
    const channelFile = path.join(channelsDir, `${channelName}.md`);
    if (allAgents.length === 0) return;

    console.log(`\x1b[90m[channel-ticker] #${channelName} 用户无 @，执行顺序 triage（${allAgents.length} 人）\x1b[0m`);
    debugLog()?.log("ticker", `user triage #${channelName}: ${allAgents.join(",")}`);
    onEvent?.("channel_dispatch_start", { channelName, mode: "user_triage", agents: allAgents });

    const processedEntries = [];
    for (const agentId of allAgents) {
      // 顺序执行：后一个 agent 能看到前一个 agent 的回复。
      const r = await processAgentOnce(agentId, channelName, { forceReply: false });
      if (r?.status === "ok" && r.channelsMdPath) {
        processedEntries.push({ channelsMdPath: r.channelsMdPath });
      }
    }

    syncProcessedBookmarksToLatest(channelFile, channelName, processedEntries);
    onEvent?.("channel_dispatch_done", { channelName, mode: "user_triage", agents: allAgents });
  }

  async function runDispatch(channelName, { mentionedAgents, source = "user" } = {}) {
    if (_stopped || !channelName) return;
    const allAgents = getAgentOrder() || [];
    if (allAgents.length === 0) return;

    const mentions = Array.isArray(mentionedAgents)
      ? [...new Set(mentionedAgents.filter(Boolean))]
      : [];

    if (mentions.length > 0) {
      await runMentionDispatch(channelName, allAgents, mentions);
      return;
    }

    // 只允许用户“无 @”触发顺序 triage
    if (source === "user") {
      await runUserTriageDispatch(channelName, allAgents);
      return;
    }

    debugLog()?.log("ticker", `skip dispatch #${channelName}: source=${source}, no mentions`);
  }

  function enqueueDispatch(task) {
    const run = async () => {
      if (_stopped) return;
      _runningJobs += 1;
      try {
        await task();
      } catch (err) {
        console.error(`[channel-ticker] 调度任务失败: ${err.message}`);
      } finally {
        _runningJobs = Math.max(0, _runningJobs - 1);
      }
    };
    _dispatchChain = _dispatchChain.then(run, run);
    return _dispatchChain;
  }

  /**
   * 事件触发入口（串行排队，不中断当前任务）
   *
   * @param {string} channelName
   * @param {{ mentionedAgents?: string[], source?: "user" | "agent" }} [opts]
   */
  function triggerImmediate(channelName, { mentionedAgents, source = "user" } = {}) {
    if (_stopped) return Promise.resolve();
    const normalizedSource = source === "agent" ? "agent" : "user";
    return enqueueDispatch(() => runDispatch(channelName, { mentionedAgents, source: normalizedSource }));
  }

  function start() {
    if (!_stopped) return;
    _stopped = false;
    console.log(`\x1b[90m[channel-ticker] 调度器已启动（纯事件驱动，无轮询）\x1b[0m`);
    debugLog()?.log("ticker", "started in event-driven mode (no polling)");
  }

  async function stop() {
    _stopped = true;
    await _dispatchChain.catch(() => {});
  }

  return {
    start,
    stop,
    triggerImmediate,
    get isRunning() { return _runningJobs > 0; },
  };
}
