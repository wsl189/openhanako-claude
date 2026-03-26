/**
 * channel-ticker.js — 频道事件调度器（无轮询）
 *
 * 设计目标：
 * - 彻底事件驱动，不做周期轮询
 * - 有明确 @ 目标时：直接执行被 @ 成员（可并行），不做 triage
 * - 仅“用户消息且无 @”时：按 agent 顺序串行 triage
 * - 普通用户输入不打断正在生成；显式 stop 命令可中断未完成回复
 */

import {
  addBookmarkEntry,
  readBookmarks,
  updateBookmark,
  getNewMessages,
  getRecentMessages,
} from "./channel-store.js";
import { debugLog } from "../debug-log.js";
import fs from "fs";
import path from "path";

/**
 * 创建频道事件调度器
 *
 * @param {object} opts
 * @param {string} opts.channelsDir - 频道目录
 * @param {string} opts.agentsDir - agents 父目录
 * @param {() => string[]} opts.getAgentOrder - 返回参与频道处理的 agent ID 列表
 * @param {(agentId, channelName, newMessages, allUpdates, opts?) => Promise<{replied, replyContent?, replyTimestamp?}>} opts.executeCheck
 * @param {(agentId, channelName, memoryInput) => Promise<void>} opts.onMemorySummarize
 * @param {(event, data) => void} [opts.onEvent]
 * @returns {{ start: () => void, stop: () => Promise<void>, triggerImmediate: (channelName: string, opts?: object) => Promise<void>, stopUnfinishedReplies: (reason?: string) => {aborted: boolean, version: number}, isRunning: boolean }}
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
  const _memoryChainByAgent = new Map();
  let _runningJobs = 0;
  let _activeDispatchController = null;
  let _dispatchVersion = 0;

  const isAbortError = (err) =>
    err?.name === "AbortError" || /abort/i.test(String(err?.message || ""));

  /**
   * 记忆摘要后台执行（不阻塞调度主链）：
   * - 同一 agent 串行，避免 summary 文件并发覆盖
   * - 不向外抛错，避免未捕获 rejection
   */
  function enqueueMemorySummarize(agentId, channelName, memoryInput) {
    if (!onMemorySummarize || !agentId) return;
    const prev = _memoryChainByAgent.get(agentId) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => onMemorySummarize(agentId, channelName, memoryInput))
      .catch((err) => {
        console.error(`[channel-ticker] ${agentId}/#${channelName} 记忆摘要失败: ${err.message}`);
      });

    _memoryChainByAgent.set(agentId, next);
    next.finally(() => {
      if (_memoryChainByAgent.get(agentId) === next) {
        _memoryChainByAgent.delete(agentId);
      }
    });
  }

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
  async function processAgentOnce(agentId, channelName, { forceReply = false, signal } = {}) {
    if (signal?.aborted) return { status: "aborted" };
    const channelFile = path.join(channelsDir, `${channelName}.md`);
    const channelsMdPath = path.join(agentsDir, agentId, "channels.md");
    let bookmarks = readBookmarks(channelsMdPath);

    if (!bookmarks.has(channelName)) {
      // 明确被 @ 时，兼容老数据（成员存在但 channels.md 缺条目）：
      // 自动补 bookmark，避免“看得到 @ 却不回复”。
      if (!forceReply) return { status: "skip" };
      if (!fs.existsSync(path.join(agentsDir, agentId))) return { status: "skip" };
      addBookmarkEntry(channelsMdPath, channelName);
      bookmarks = readBookmarks(channelsMdPath);
      if (!bookmarks.has(channelName)) return { status: "skip" };
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
      const result = await executeCheck(agentId, channelName, recentMsgs, [], { forceReply, signal });
      if (signal?.aborted) return { status: "aborted" };

      const latestTs = getLatestTimestamp(channelFile);
      if (latestTs) {
        updateBookmark(channelsMdPath, channelName, latestTs);
      }

      if (result?.replied) {
        enqueueMemorySummarize(agentId, channelName, {
          recentMessages: recentMsgs,
          reply: result.replyContent
            ? {
                sender: agentId,
                body: result.replyContent,
                timestamp: result.replyTimestamp || latestTs || null,
              }
            : null,
        });
      }

      return { status: "ok", channelsMdPath };
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        debugLog()?.log("ticker", `dispatch aborted: ${agentId}/#${channelName}`);
        return { status: "aborted" };
      }
      console.error(`[channel-ticker] ${agentId}/#${channelName} 处理失败: ${err.message}`);
      return { status: "error" };
    }
  }

  /**
   * 有明确 @ 对象时：并行直回（无 triage）
   */
  async function runMentionDispatch(channelName, allAgents, mentionedAgents, signal, { source = "user" } = {}) {
    if (signal?.aborted) return;
    const channelFile = path.join(channelsDir, `${channelName}.md`);
    const dispatchStartLatestTs = getLatestTimestamp(channelFile);
    const cached = new Set(allAgents || []);
    const seen = new Set();
    const agents = [];
    for (const id of (mentionedAgents || [])) {
      const agentId = String(id || "").trim();
      if (!agentId || seen.has(agentId)) continue;
      seen.add(agentId);
      // 定向 @ 优先信任显式目标；即使 agent 顺序缓存暂时没刷新，也允许执行。
      if (cached.has(agentId) || fs.existsSync(path.join(agentsDir, agentId))) {
        agents.push(agentId);
      }
    }

    if (agents.length === 0) return;

    console.log(`\x1b[90m[channel-ticker] #${channelName} 定向 @ 调度（${agents.length} 人）：${agents.join(", ")}\x1b[0m`);
    debugLog()?.log("ticker", `mention dispatch #${channelName}: ${agents.join(",")}`);
    onEvent?.("channel_dispatch_start", { channelName, mode: "mention_direct", agents });

    const processedEntries = [];
    const settled = await Promise.allSettled(
      agents.map(agentId => processAgentOnce(agentId, channelName, { forceReply: true, signal })),
    );
    if (signal?.aborted) return;
    for (const item of settled) {
      const r = item.status === "fulfilled" ? item.value : null;
      if (r?.status === "ok" && r.channelsMdPath) {
        processedEntries.push({ channelsMdPath: r.channelsMdPath });
      }
    }

    syncProcessedBookmarksToLatest(channelFile, channelName, processedEntries);
    // 仅用户触发的定向分发推进“未被 @”成员书签。
    // agent 级联触发时不推进，避免在同秒时间戳下吞掉下一跳 @ 消息。
    if (source === "user") {
      markUnmentionedAgentsAsReadByTimestamp(channelName, allAgents, agents, dispatchStartLatestTs);
    }
    onEvent?.("channel_dispatch_done", { channelName, mode: "mention_direct", agents });
  }

  /**
   * 仅“用户无 @ 输入”时：全员顺序 triage
   */
  async function runUserTriageDispatch(channelName, allAgents, signal) {
    if (signal?.aborted) return;
    const channelFile = path.join(channelsDir, `${channelName}.md`);
    if (allAgents.length === 0) return;

    console.log(`\x1b[90m[channel-ticker] #${channelName} 用户无 @，执行顺序 triage（${allAgents.length} 人）\x1b[0m`);
    debugLog()?.log("ticker", `user triage #${channelName}: ${allAgents.join(",")}`);
    onEvent?.("channel_dispatch_start", { channelName, mode: "user_triage", agents: allAgents });

    const processedEntries = [];
    for (const agentId of allAgents) {
      if (signal?.aborted) break;
      // 顺序执行：后一个 agent 能看到前一个 agent 的回复。
      const r = await processAgentOnce(agentId, channelName, { forceReply: false, signal });
      if (r?.status === "ok" && r.channelsMdPath) {
        processedEntries.push({ channelsMdPath: r.channelsMdPath });
      }
    }
    if (signal?.aborted) return;

    syncProcessedBookmarksToLatest(channelFile, channelName, processedEntries);
    onEvent?.("channel_dispatch_done", { channelName, mode: "user_triage", agents: allAgents });
  }

  async function runDispatch(channelName, { mentionedAgents, source = "user", signal } = {}) {
    if (_stopped || !channelName) return;
    if (signal?.aborted) return;
    const allAgents = getAgentOrder() || [];

    const mentions = Array.isArray(mentionedAgents)
      ? [...new Set(mentionedAgents.filter(Boolean))]
      : [];

    if (mentions.length > 0) {
      await runMentionDispatch(channelName, allAgents, mentions, signal, { source });
      return;
    }

    if (allAgents.length === 0) return;

    // 只允许用户“无 @”触发顺序 triage
    if (source === "user") {
      await runUserTriageDispatch(channelName, allAgents, signal);
      return;
    }

    debugLog()?.log("ticker", `skip dispatch #${channelName}: source=${source}, no mentions`);
  }

  function enqueueDispatch(task, { version = 0 } = {}) {
    const run = async () => {
      if (_stopped) return;
      if (version < _dispatchVersion) {
        debugLog()?.log("ticker", `drop stale dispatch task (v${version} < v${_dispatchVersion})`);
        return;
      }
      _runningJobs += 1;
      const controller = new AbortController();
      _activeDispatchController = controller;
      try {
        await task(controller.signal);
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) {
          debugLog()?.log("ticker", "dispatch task aborted");
          return;
        }
        console.error(`[channel-ticker] 调度任务失败: ${err.message}`);
      } finally {
        if (_activeDispatchController === controller) {
          _activeDispatchController = null;
        }
        _runningJobs = Math.max(0, _runningJobs - 1);
      }
    };
    _dispatchChain = _dispatchChain.then(run, run);
    return _dispatchChain;
  }

  function abortRunningDispatch(reason = "manual-stop") {
    const ctrl = _activeDispatchController;
    if (!ctrl || ctrl.signal.aborted) return false;
    ctrl.abort(new DOMException(reason, "AbortError"));
    return true;
  }

  function stopUnfinishedReplies(reason = "manual-stop") {
    _dispatchVersion += 1;
    const aborted = abortRunningDispatch(reason);
    debugLog()?.log("ticker", `stop unfinished replies: reason=${reason}, aborted=${aborted}, version=${_dispatchVersion}`);
    return { aborted, version: _dispatchVersion };
  }

  /**
   * 事件触发入口（串行排队；不自动中断）
   *
   * @param {string} channelName
   * @param {{ mentionedAgents?: string[], source?: "user" | "agent" }} [opts]
   */
  function triggerImmediate(channelName, { mentionedAgents, source = "user" } = {}) {
    if (_stopped) return Promise.resolve();
    const normalizedSource = source === "agent" ? "agent" : "user";
    const version = _dispatchVersion;
    return enqueueDispatch(
      (signal) => runDispatch(channelName, { mentionedAgents, source: normalizedSource, signal }),
      { version },
    );
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
    stopUnfinishedReplies,
    get isRunning() { return _runningJobs > 0; },
  };
}
