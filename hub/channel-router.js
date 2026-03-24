/**
 * ChannelRouter — 频道调度（从 engine.js 搬出）
 *
 * 频道 = 内部 Channel，和 Telegram/飞书一样通过 Hub 路由。
 * 包装 channel-ticker（不改 ticker，只提供回调）。
 *
 * 搬出的方法：
 *   _getChannelAgentOrder  → getAgentOrder()
 *   _executeChannelCheck   → _executeCheck()
 *   _executeChannelReply   → _executeReply()
 *   _channelMemorySummarize → _memorySummarize()
 *   _setupChannelPostHandler → setupPostHandler()
 *   toggleChannels          → toggle()
 */

import fs from "fs";
import path from "path";
import { createChannelTicker } from "../lib/channels/channel-ticker.js";
import { appendMessage, formatMessagesForLLM, getChannelMeta } from "../lib/channels/channel-store.js";
import { collectMentionedAgentIds } from "../lib/channels/channel-mentions.js";
import { loadConfig } from "../lib/memory/config-loader.js";
import { callProviderText } from "../lib/llm/provider-client.js";
import { runAgentSession } from "./agent-executor.js";
import { debugLog } from "../lib/debug-log.js";
import { getLocale } from "../server/i18n.js";

export class ChannelRouter {
  /**
   * @param {object} opts
   * @param {import('./index.js').Hub} opts.hub
   */
  static _AGENT_ORDER_TTL = 30_000; // 30 秒

  constructor({ hub }) {
    this._hub = hub;
    this._ticker = null;
    this._agentOrderCache = null; // { list: string[], ts: number }
  }

  /** @returns {import('../core/engine.js').HanaEngine} */
  get _engine() { return this._hub.engine; }

  // ──────────── 生命周期 ────────────

  start() {
    const engine = this._engine;
    if (!engine.channelsDir) return;

    this._ticker = createChannelTicker({
      channelsDir: engine.channelsDir,
      agentsDir: engine.agentsDir,
      getAgentOrder: () => this.getAgentOrder(),
      executeCheck: (agentId, channelName, newMessages, allUpdates, opts) =>
        this._executeCheck(agentId, channelName, newMessages, allUpdates, opts),
      onMemorySummarize: (agentId, channelName, contextText) =>
        this._memorySummarize(agentId, channelName, contextText),
      // 群聊改为事件驱动：收到消息才 triage，不再依赖周期轮询。
      enablePolling: false,
      onEvent: (event, data) => {
        this._hub.eventBus.emit({ type: event, ...data }, null);
      },
    });
    this._ticker.start();
  }

  async stop() {
    if (this._ticker) {
      await this._ticker.stop();
      this._ticker = null;
    }
  }

  async toggle(enabled) {
    if (enabled) {
      if (this._ticker) return;
      this.start();
    } else {
      await this.stop();
    }
  }

  triggerImmediate(channelName, opts) {
    return this._ticker?.triggerImmediate(channelName, opts);
  }

  /**
   * 注入频道 post 回调到所有 agent
   * agent 用 channel tool 发消息后：
   * - 无 @：不触发
   * - 有 @：仅触发被 @ 的 agent
   * 使用异步非抢占调度，避免打断当前回复生成。
   */
  setupPostHandler() {
    const postHandler = (channelName, senderId, content = "") => {
      this._handleAgentPost(channelName, senderId, content);
    };

    for (const [, agent] of this._engine.agents || []) {
      agent._channelPostHandler = postHandler;
    }
  }

  // ──────────── 频道 Agent 顺序 ────────────

  /** 获取参与频道轮转的 agent 列表（只含有 channels.md 的，30s TTL 缓存） */
  getAgentOrder() {
    const now = Date.now();
    if (this._agentOrderCache && now - this._agentOrderCache.ts < ChannelRouter._AGENT_ORDER_TTL) {
      return this._agentOrderCache.list;
    }
    try {
      const entries = fs.readdirSync(this._engine.agentsDir, { withFileTypes: true });
      const list = entries
        .filter(e => e.isDirectory())
        .filter(e => {
          const channelsMd = path.join(this._engine.agentsDir, e.name, "channels.md");
          return fs.existsSync(channelsMd);
        })
        .map(e => e.name);
      this._agentOrderCache = { list, ts: now };
      return list;
    } catch {
      return [];
    }
  }

  // ──────────── Triage + Reply ────────────

  /**
   * 频道检查回调：triage → 单轮 Agent Session → 写入回复
   * 从 engine._executeChannelCheck 搬入
   */
  async _executeCheck(agentId, channelName, newMessages, _allChannelUpdates, { signal, forceReply = false } = {}) {
    const engine = this._engine;
    const msgText = formatMessagesForLLM(newMessages);

    // ── 读 agent 完整上下文 ──
    const readFile = (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return ""; } };
    const agentDir = path.join(engine.agentsDir, agentId);

    // 复用 Agent 实例的 personality（identity + yuan + ishiki 已在内存中组装）
    const agentInstance = engine.agents?.get(agentId);
    const cfg = agentInstance?.config || loadConfig(path.join(agentDir, "config.yaml"));

    const agentContext = agentInstance?.personality
      || [readFile(path.join(agentDir, "identity.md")),
          readFile(path.join(engine.productDir, "yuan", `${cfg.agent?.yuan || "hanako"}.md`)),
          readFile(path.join(agentDir, "ishiki.md"))].filter(Boolean).join("\n\n");

    // memory.md 和 user.md 内容会变，仍需从磁盘读取
    const memoryMd = readFile(path.join(agentDir, "memory", "memory.md"));
    const userMd = readFile(path.join(engine.userDir, "user.md"));
    const isZh = getLocale().startsWith("zh");
    const memoryContext = memoryMd?.trim()
      ? (isZh ? `\n\n你的记忆：\n${memoryMd}` : `\n\nYour memory:\n${memoryMd}`)
      : "";
    const userContext = userMd?.trim()
      ? (isZh ? `\n\n用户档案：\n${userMd}` : `\n\nUser profile:\n${userMd}`)
      : "";

    // @ 是否命中以路由层显式解析结果为准，避免从历史窗口误判“被 @”。
    const isMentioned = !!forceReply;

    // ── Step 1: Triage ──
    let shouldReply = isMentioned;

    if (!shouldReply) {
      try {
        const utilCfg = engine.resolveUtilityConfig() || {};
        const { utility_large: model, large_api_key: api_key, large_base_url: base_url, large_api: api } = utilCfg;
        if (api_key && base_url && api) {
          const triageSystem = agentContext + memoryContext + userContext
            + "\n\n---\n\n"
            + (isZh
              ? "你在一个群聊频道里。阅读以下最近的消息，判断你是否要回复。\n"
                + "回答 YES 的情况：有人跟你说话、@你、问了你能回答的问题、或者你有想说的话。\n"
                + "回答 NO 的情况：别人已经充分回答了问题（你没有新的补充）、话题跟你无关、你插不上话、或者你刚回复过且没人追问你。\n"
                + "只回答 YES 或 NO。"
              : "You are in a group chat channel. Read the recent messages below and decide whether you should reply.\n"
                + "Answer YES if: someone is talking to you, @-mentions you, asks a question you can answer, or you have something to say.\n"
                + "Answer NO if: the question has already been adequately answered (you have nothing new to add), the topic is irrelevant to you, you can't contribute, or you just replied and no one followed up.\n"
                + "Answer only YES or NO.");

          const triageTimeout = AbortSignal.timeout(10_000);
          const triageSignal = signal
            ? AbortSignal.any([signal, triageTimeout])
            : triageTimeout;
          const answer = await callProviderText({
            api,
            model,
            api_key,
            base_url,
            systemPrompt: triageSystem,
            messages: [{ role: "user", content: isZh ? `#${channelName} 频道最近消息：\n${msgText}` : `#${channelName} recent messages:\n${msgText}` }],
            temperature: 0,
            max_tokens: 10,
            timeoutMs: 10_000,
            signal: triageSignal,
          });
          shouldReply = answer.trim().toUpperCase().includes("YES");
        } else {
          // utility_large 凭证不完整，跳过 triage 直接回复
          shouldReply = true;
        }
      } catch (err) {
        // utility 模型未配置或 triage 调用失败 → 默认回复（让 agent 自己在 reply 阶段判断要不要说话）
        console.warn(`[channel] triage 不可用，默认回复 (${agentId}/#${channelName}): ${err.message}`);
        shouldReply = true;
      }
    }

    console.log(`\x1b[90m[channel] triage ${agentId}/#${channelName}: ${shouldReply ? "YES" : "NO"}${isMentioned ? " (@)" : ""}\x1b[0m`);
    debugLog()?.log("channel", `triage ${agentId}/#${channelName}: ${shouldReply ? "YES" : "NO"}${isMentioned ? " (mentioned)" : ""} (${newMessages.length} msgs)`);

    if (!shouldReply) {
      return { replied: false };
    }

    // ── Step 2: 单轮 Agent Session 生成回复 ──
    try {
      const replyText = await this._executeReply(agentId, channelName, msgText, {
        signal,
        forceReply: isMentioned,
      });

      if (!replyText) {
        console.log(`\x1b[90m[channel] ${agentId} 回复为空 (#${channelName})\x1b[0m`);
        return { replied: false };
      }

      // 写入频道文件
      const channelFile = path.join(engine.channelsDir, `${channelName}.md`);
      appendMessage(channelFile, agentId, replyText);
      this._handleAgentPost(channelName, agentId, replyText);

      console.log(`\x1b[90m[channel] ${agentId} replied #${channelName} (${replyText.length} chars)\x1b[0m`);
      debugLog()?.log("channel", `${agentId} replied #${channelName} (${replyText.length} chars)`);

      // WS 广播
      this._hub.eventBus.emit({ type: "channel_new_message", channelName, sender: agentId }, null);

      return { replied: true, replyContent: replyText };
    } catch (err) {
      console.error(`[channel] 回复失败 (${agentId}/#${channelName}): ${err.message}`);
      debugLog()?.error("channel", `回复失败 (${agentId}/#${channelName}): ${err.message}`);
      return { replied: false };
    }
  }

  /**
   * 单轮 Agent Session 生成频道回复
   */
  async _executeReply(agentId, channelName, msgText, { signal, forceReply = false } = {}) {
    const isZh = getLocale().startsWith("zh");
    const text = await runAgentSession(
      agentId,
      [
        {
          text: isZh
            ? `#${channelName} 频道的最近消息：\n\n${msgText}\n\n`
              + `你只有这一轮回复机会。请在这一轮里结合上下文，必要时用 search_memory 检索记忆，然后直接给出你要发到群聊的回复内容。`
            : `Recent messages in #${channelName}:\n\n${msgText}\n\n`
              + `You only have one reply round. In this same round, use context and call search_memory when needed, then directly output the message you want to post in the group chat.`,
          capture: true,
        },
      ],
      { engine: this._engine, signal, sessionSuffix: "channel-temp" },
    );

    if (!text?.trim()) {
      if (forceReply) {
        // 被 @ 时首轮空输出：再重试一次，要求直接回答问题，避免只回“我在”。
        const retryText = await runAgentSession(
          agentId,
          [
            {
              text: isZh
                ? `你刚才没有输出可见回复。现在请直接回答用户刚才的问题，不要只确认收到 @，不要输出空白，也不要输出 mood/pulse 标签。\n\n#${channelName} 最近消息：\n\n${msgText}`
                : `You produced no visible reply. Now directly answer the user's latest question. Do not only acknowledge the @, do not output blank text, and do not output mood/pulse tags.\n\nRecent messages in #${channelName}:\n\n${msgText}`,
              capture: true,
            },
          ],
          { engine: this._engine, signal, sessionSuffix: "channel-temp" },
        );
        if (retryText?.trim()) return retryText.trim();
        return isZh ? "我看到你的问题了，刚才生成失败了，请再发一次，我会直接回答。" : "I saw your question, but generation failed just now. Please send it again and I'll answer directly.";
      }
      debugLog()?.log("channel", `${agentId}/#${channelName}: chose not to reply`);
      return null;
    }

    return text.trim();
  }

  /**
   * 在频道上下文中提取被 @ 的 agent（可排除发送者自己）
   * @param {string} channelName
   * @param {string} text
   * @param {{ excludeAgentIds?: string[] }} [opts]
   * @returns {string[]}
   */
  _collectMentionedAgentsInChannel(channelName, text, { excludeAgentIds = [] } = {}) {
    const channelFile = path.join(this._engine.channelsDir, `${channelName}.md`);
    const meta = getChannelMeta(channelFile);
    const channelMembers = Array.isArray(meta.members) ? meta.members : [];
    const allAgents = this._engine.listAgents?.() || [];

    const excluded = new Set((excludeAgentIds || []).filter(Boolean));
    return collectMentionedAgentIds(String(text || ""), allAgents, channelMembers)
      .filter(id => !excluded.has(id));
  }

  /**
   * 统一处理“agent 在频道发言后”的 @ 触发逻辑
   * @param {string} channelName
   * @param {string} senderId
   * @param {string} content
   */
  _handleAgentPost(channelName, senderId, content = "") {
    const mentionedAgents = this._collectMentionedAgentsInChannel(channelName, content, { excludeAgentIds: [senderId] });
    if (!mentionedAgents.length) {
      debugLog()?.log("channel", `agent ${senderId} posted to #${channelName}, no @mentions → skip triage`);
      return;
    }
    debugLog()?.log("channel", `agent ${senderId} posted to #${channelName}, queue triage for mentioned: ${mentionedAgents.join(",")}`);
    setTimeout(() => {
      this.triggerImmediate(channelName, { mentionedAgents, interruptCurrent: false })?.catch(err =>
        console.error(`[channel] agent post triage 失败: ${err.message}`)
      );
    }, 0);
  }

  /**
   * 频道记忆摘要
   * 从 engine._channelMemorySummarize 搬入
   */
  async _memorySummarize(agentId, channelName, contextText) {
    const engine = this._engine;
    try {
      const utilCfg = engine.resolveUtilityConfig() || {};
      const { utility: model, api_key, base_url, api } = utilCfg;
      if (!api_key || !base_url || !api) {
        console.log(`\x1b[90m[channel] ${agentId} 无 API 配置，跳过记忆摘要\x1b[0m`);
        return;
      }

      const isZhMem = getLocale().startsWith("zh");
      const summaryText = await callProviderText({
        api,
        model,
        api_key,
        base_url,
        systemPrompt: isZhMem
          ? "将频道对话摘要为一条简短的记忆（一两句话），记录关键信息和结论。直接输出摘要，不要前缀。"
          : "Summarize the channel conversation into a brief memory (one or two sentences), capturing key information and conclusions. Output the summary directly, no prefix.",
        messages: [{ role: "user", content: isZhMem ? `频道 #${channelName}：\n${contextText.slice(0, 2000)}` : `Channel #${channelName}:\n${contextText.slice(0, 2000)}` }],
        temperature: 0.3,
        max_tokens: 200,
      });

      // 写入 agent 的 fact store
      const isCurrentAgent = (agentId === engine.currentAgentId);
      let factStore = null;
      let needClose = false;

      if (isCurrentAgent && engine.agent?.factStore) {
        factStore = engine.agent.factStore;
      } else {
        const { FactStore } = await import("../lib/memory/fact-store.js");
        const dbPath = path.join(engine.agentsDir, agentId, "memory", "facts.db");
        factStore = new FactStore(dbPath);
        needClose = true;
      }

      const now = new Date();
      try {
        factStore.add({
          fact: `[#${channelName}] ${summaryText}`,
          tags: [isZhMem ? "频道" : "channel", channelName],
          time: now.toISOString().slice(0, 16),
          session_id: `channel-${channelName}`,
        });
      } finally {
        if (needClose) factStore.close();
      }

      console.log(`\x1b[90m[channel] ${agentId} memory saved (#${channelName}, ${summaryText.length} chars)\x1b[0m`);
    } catch (err) {
      console.error(`[channel] 记忆摘要失败 (${agentId}/#${channelName}): ${err.message}`);
    }
  }
}
