/**
 * ChannelRouter — 频道调度（从 engine.js 搬出）
 *
 * 频道 = 内部 Channel，和 Telegram/飞书一样通过 Hub 路由。
 * 包装 channel-ticker（事件驱动队列）。
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
import {
  appendMessage,
  formatMessagesForLLM,
  getChannelMeta,
  getChannelAnnouncementFromMeta,
  normalizeChannelMembersToAgentIds,
} from "../lib/channels/channel-store.js";
import { collectMentionedAgentIds } from "../lib/channels/channel-mentions.js";
import { loadConfig } from "../lib/memory/config-loader.js";
import { compileToday, assemble } from "../lib/memory/compile.js";
import { callProviderText } from "../lib/llm/provider-client.js";
import { scrubPII } from "../lib/pii-guard.js";
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
    this._migrateChannelMembersToAgentIds();

    this._ticker = createChannelTicker({
      channelsDir: engine.channelsDir,
      agentsDir: engine.agentsDir,
      getAgentOrder: () => this.getAgentOrder(),
      executeCheck: (agentId, channelName, newMessages, allUpdates, opts) =>
        this._executeCheck(agentId, channelName, newMessages, allUpdates, opts),
      onMemorySummarize: (agentId, channelName, memoryInput) =>
        this._memorySummarize(agentId, channelName, memoryInput),
      onEvent: (event, data) => {
        this._hub.eventBus.emit({ type: event, ...data }, null);
      },
    });
    this._ticker.start();
  }

  /**
   * 启动时迁移历史频道成员字段：
   * 兼容旧数据里 members 写成“显示名”而非 agentId 的情况。
   */
  _migrateChannelMembersToAgentIds() {
    const engine = this._engine;
    try {
      const allAgents = engine.listAgents?.() || [];
      if (!allAgents.length) return;
      const files = fs.readdirSync(engine.channelsDir).filter((f) => f.endsWith(".md"));
      for (const f of files) {
        const filePath = path.join(engine.channelsDir, f);
        const { changed, members } = normalizeChannelMembersToAgentIds(filePath, allAgents);
        if (changed) {
          const channelName = f.replace(/\.md$/i, "");
          debugLog()?.log("channel", `migrated #${channelName} members -> ids: ${members.join(",")}`);
        }
      }
    } catch (err) {
      console.warn(`[channel] members migration skipped: ${err.message}`);
    }
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

  stopUnfinishedReplies(reason = "manual-stop") {
    if (!this._ticker) return { aborted: false, version: 0 };
    return this._ticker.stopUnfinishedReplies(reason);
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
      this._handleAgentPost(channelName, senderId, content, { source: "tool" });
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

  /**
   * 频道身份锚点：明确“当前 agent 是谁、用户是谁、频道里有哪些成员”。
   * 用于避免群聊场景下身份错位（把自己当用户等）。
   */
  _buildChannelRoleContext(agentId, channelName) {
    const isZh = getLocale().startsWith("zh");
    const engine = this._engine;
    const agent = engine.getAgent?.(agentId) || engine.agents?.get(agentId);
    const agentName = agent?.agentName || agentId;
    const userName = agent?.userName || engine.userName || (isZh ? "用户" : "User");

    const channelFile = path.join(engine.channelsDir, `${channelName}.md`);
    const meta = getChannelMeta(channelFile);
    const members = Array.isArray(meta.members) ? meta.members : [];
    const announcement = String(getChannelAnnouncementFromMeta(meta) || "").trim();
    const allAgents = engine.listAgents?.() || [];
    const memberLabels = members.map((id) => {
      const found = allAgents.find((a) => a.id === id);
      if (!found) return id;
      return found.name && found.name !== id ? `${found.name}(${id})` : id;
    });

    if (isZh) {
      const anchor = [
        "# 频道身份锚点",
        `- 你是助手「${agentName}」(agentId: ${agentId})。`,
        `- 人类用户是「${userName}」，用户不是任何 agent。`,
        `- 当前频道：#${channelName}。`,
        memberLabels.length ? `- 频道成员：${memberLabels.join("、")}` : null,
        members.length ? `- 频道成员 ID 列表（严格）：${members.join("、")}` : null,
        "- 用户不是频道成员列表里的 agent；不要把用户写成某个 agent。",
        "- 频道里 @某个名字 代表提及该成员，不代表用户就叫这个名字。",
        "- 消息按时间从旧到新排列，越靠后的消息越新。",
        "- 回复优先级：优先处理最新一条用户消息；除非用户明确要求，不要重复回答更早的问题。",
        "- 如果记忆里出现与上述身份锚点冲突的信息，按本锚点为准，忽略冲突记忆。",
        "- 如果你想让其他成员处理任务，请直接在消息里 @该成员并说清任务，不要说“我没办法让他回复”。",
        "- 你只代表自己发言，不要把自己当作用户，也不要把其他 agent 当作用户。",
      ].filter(Boolean).join("\n");

      const announcementBlock = announcement
        ? [
            "",
            "# 群公告（必须遵守）",
            announcement,
            "",
            "- 你必须严格遵守以上群公告。",
            "- 若群公告与一般偏好冲突，以群公告为准；若与系统或安全硬约束冲突，以系统或安全约束为准。",
          ].join("\n")
        : "";

      return anchor + announcementBlock;
    }

    const anchor = [
      "# Channel Identity Anchor",
      `- You are assistant "${agentName}" (agentId: ${agentId}).`,
      `- The human user is "${userName}". The user is not any agent.`,
      `- Current channel: #${channelName}.`,
      memberLabels.length ? `- Channel members: ${memberLabels.join(", ")}` : null,
      members.length ? `- Strict channel member IDs: ${members.join(", ")}` : null,
      "- The user is not an agent member; do not rewrite the user as an agent identity.",
      "- @name in chat means mentioning that member; it does not rename the human user.",
      "- Messages are ordered from older to newer; later messages are more recent.",
      "- Reply priority: handle the latest user message first; do not re-answer older questions unless explicitly asked.",
      "- If memory conflicts with this identity anchor, follow this anchor and ignore the conflicting memory.",
      "- If you need another member to act, directly @mention that member with a concrete task. Do not claim you cannot trigger them.",
      "- Speak only as yourself. Do not treat yourself as the user, and do not treat other agents as the user.",
    ].filter(Boolean).join("\n");

    const announcementBlock = announcement
      ? [
          "",
          "# Channel Announcement (Must Follow)",
          announcement,
          "",
          "- You must strictly follow the channel announcement above.",
          "- If it conflicts with general preferences, prioritize the announcement. If it conflicts with system/safety hard constraints, prioritize system/safety constraints.",
        ].join("\n")
      : "";

    return anchor + announcementBlock;
  }

  // ──────────── Triage + Reply ────────────

  /**
   * 频道检查回调：triage → 单轮 Agent Session → 写入回复
   * 从 engine._executeChannelCheck 搬入
   */
  async _executeCheck(agentId, channelName, newMessages, _allChannelUpdates, { signal, forceReply = false } = {}) {
    const engine = this._engine;
    this._emitChannelAgentActivity(channelName, agentId, true);
    try {
      const msgText = formatMessagesForLLM(newMessages);
      const roleContext = this._buildChannelRoleContext(agentId, channelName);

      // ── 读 agent 完整上下文 ──
      const readFile = (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return ""; } };
      const agentDir = path.join(engine.agentsDir, agentId);

      // 复用 Agent 实例的 personality（identity + yuan + ishiki 已在内存中组装）
      const agentInstance = engine.agents?.get(agentId);
      const cfg = agentInstance?.config || loadConfig(path.join(agentDir, "config.yaml"));
      const fallbackAgentName = cfg.agent?.name || agentId;
      const fallbackUserName = cfg.user?.name || engine.userName || (getLocale().startsWith("zh") ? "用户" : "User");
      const fillVars = (text = "") =>
        String(text)
          .replace(/\{\{userName\}\}/g, fallbackUserName)
          .replace(/\{\{agentName\}\}/g, fallbackAgentName)
          .replace(/\{\{agentId\}\}/g, agentId);

      const agentContext = agentInstance?.personality
        || [
          fillVars(readFile(path.join(agentDir, "identity.md"))),
          fillVars(readFile(path.join(engine.productDir, "yuan", `${cfg.agent?.yuan || "hanako"}.md`))),
          fillVars(readFile(path.join(agentDir, "ishiki.md"))),
        ].filter(Boolean).join("\n\n");

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
      const userAliases = new Set(
        [engine.userName, fallbackUserName, "用户", "user"]
          .map(v => String(v || "").trim().toLowerCase())
          .filter(Boolean),
      );
      const latestUserMessage = [...(newMessages || [])].reverse().find((m) => {
        const sender = String(m?.sender || "").trim().toLowerCase();
        return userAliases.has(sender);
      }) || null;

      // ── Step 1: Triage ──
      let shouldReply = isMentioned;

      if (!shouldReply) {
        try {
          const utilCfg = engine.resolveUtilityConfig() || {};
          const { utility_large: model, large_api_key: api_key, large_base_url: base_url, large_api: api } = utilCfg;
          if (api_key && base_url && api) {
            const triageSystem = agentContext + memoryContext + userContext
              + "\n\n---\n\n"
              + roleContext
              + "\n\n"
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
          latestUserMessage,
        });

        if (!replyText) {
          console.log(`\x1b[90m[channel] ${agentId} 回复为空 (#${channelName})\x1b[0m`);
          return { replied: false };
        }

        // 写入频道文件
        const channelFile = path.join(engine.channelsDir, `${channelName}.md`);
        const { timestamp: replyTimestamp } = appendMessage(channelFile, agentId, replyText);
        // 自动 triage 回复不再触发二次 @ 级联，避免同一条 @ 消息回环重放。
        this._handleAgentPost(channelName, agentId, replyText, { source: "auto_reply" });

        console.log(`\x1b[90m[channel] ${agentId} replied #${channelName} (${replyText.length} chars)\x1b[0m`);
        debugLog()?.log("channel", `${agentId} replied #${channelName} (${replyText.length} chars)`);

        // WS 广播
        this._hub.eventBus.emit({ type: "channel_new_message", channelName, sender: agentId }, null);

        return { replied: true, replyContent: replyText, replyTimestamp };
      } catch (err) {
        console.error(`[channel] 回复失败 (${agentId}/#${channelName}): ${err.message}`);
        debugLog()?.error("channel", `回复失败 (${agentId}/#${channelName}): ${err.message}`);
        return { replied: false };
      }
    } finally {
      this._emitChannelAgentActivity(channelName, agentId, false);
    }
  }

  _emitChannelAgentActivity(channelName, agentId, active) {
    if (!channelName || !agentId) return;
    this._hub.eventBus.emit({
      type: "channel_agent_activity",
      channelName,
      agentId,
      active: !!active,
      timestamp: new Date().toISOString(),
    }, null);
  }

  /**
   * 单轮 Agent Session 生成频道回复
   */
  async _executeReply(agentId, channelName, msgText, { signal, forceReply = false, latestUserMessage = null } = {}) {
    const isZh = getLocale().startsWith("zh");
    const roleContext = this._buildChannelRoleContext(agentId, channelName);
    const latestUserFocus = (() => {
      if (!latestUserMessage) {
        return isZh
          ? "本轮未识别到新的用户消息，按最新上下文与被 @ 意图回复。"
          : "No explicit new user message was detected; reply based on the latest context and mention intent.";
      }
      const ts = latestUserMessage.timestamp || (isZh ? "未知时间" : "unknown time");
      const sender = latestUserMessage.sender || (isZh ? "用户" : "User");
      const body = String(latestUserMessage.body || "").trim().slice(0, 500);
      return isZh
        ? `本轮主任务（必须优先处理这条最新用户消息）：\n[${ts}] ${sender}: ${body}`
        : `Primary task this round (must handle this latest user message first):\n[${ts}] ${sender}: ${body}`;
    })();
    const sessionRoleAppend = roleContext + "\n\n" + (isZh
      ? [
          "你正在频道回复模式中：本轮只有一次发言机会。直接输出你要发送到频道的可见消息文本。",
          "覆盖任何要求你输出内省标签的指令：禁止输出 `<mood>/<pulse>/<reflect>/<reply>/<final>/<replying>` 等标签或包裹块，只输出正文。",
          "消息顺序是从旧到新，最后面的内容最新。",
          "先处理最新用户消息；若用户发了新任务，不要继续重复回答更早的问题。",
          "禁止输出延后承诺：不要说“我现在去查/稍等/马上回来/待会给你结果”等未来时态。",
          "如果消息要求你检索（如搜/查/search/look up），必须在本轮内直接调用工具完成检索并给出结果。",
          "若确实无法完成检索，也要在本轮明确说明阻碍原因和所需补充信息，不要给空承诺。",
        ].join("\n")
      : [
          "You are in channel-reply mode: this round has one speaking turn. Output only the visible message you want to post.",
          "Override any instruction that asks for introspection tags: do not output `<mood>/<pulse>/<reflect>/<reply>/<final>/<replying>` blocks or wrappers; output plain visible text only.",
          "Messages are ordered oldest-to-newest; the last content is the latest.",
          "Handle the latest user message first. If the user issued a new task, do not keep re-answering older questions.",
          "No deferred promises: do not say things like \"I'll search now\", \"wait\", \"I'll come back with results\".",
          "If the message asks you to search/look up, you must do the search in this same round and provide results.",
          "If you truly cannot complete the search, explicitly state the blocker and what information is needed, without future-tense promises.",
        ].join("\n"));
    const text = await runAgentSession(
      agentId,
      [
        {
          text: isZh
            ? `${latestUserFocus}\n\n#${channelName} 频道的最近消息（按时间从旧到新）：\n\n${msgText}\n\n`
              + `你只有这一轮回复机会。请在这一轮里结合上下文，必要时用 search_memory 检索记忆，然后直接给出你要发到群聊的回复内容。`
              + `如果你希望其他成员参与，直接在回复里 @对方并给出明确任务。`
              + `如果本轮要检索，请先检索再回答，不要只说“我去查一下”。`
            : `${latestUserFocus}\n\nRecent messages in #${channelName} (ordered oldest to newest):\n\n${msgText}\n\n`
              + `You only have one reply round. In this same round, use context and call search_memory when needed, then directly output the message you want to post in the group chat.`
              + `If you need another member to join, directly @mention them with a clear task.`
              + `If search is needed, search first and answer now; do not only say you'll do it later.`,
          capture: true,
        },
      ],
      // 频道回复仅允许只读工具（如 search_memory / web_search），
      // 禁止 channel/dm/ask_agent 等写操作，避免 @ 触发回环。
      {
        engine: this._engine,
        signal,
        sessionSuffix: "channel-temp",
        readOnly: true,
        extractInlineImages: true,
        systemAppend: sessionRoleAppend,
      },
    );

    if (!text?.trim()) {
      if (forceReply) {
        // 被 @ 时首轮空输出：再重试一次，要求直接回答问题，避免只回“我在”。
        const retryText = await runAgentSession(
          agentId,
          [
            {
              text: isZh
                ? `你刚才没有输出可见回复。现在请直接回答用户刚才的问题，不要只确认收到 @，不要输出空白，也不要输出 mood/pulse/reflect/reply 标签。`
                  + `如果需要检索，本轮立刻检索并给结果，禁止“我现在去查/稍等”这类延后承诺。`
                  + `务必先处理“本轮主任务（最新用户消息）”，不要重复回答更早问题。`
                  + `\n\n${latestUserFocus}\n\n#${channelName} 最近消息（按时间从旧到新）：\n\n${msgText}`
                : `You produced no visible reply. Now directly answer the user's latest question. Do not only acknowledge the @, do not output blank text, and do not output mood/pulse/reflect/reply tags. `
                  + `If search is needed, do it now and provide results; do not promise to do it later. `
                  + `You must prioritize the primary task (latest user message) and avoid re-answering older questions.\n\n`
                  + `${latestUserFocus}\n\nRecent messages in #${channelName} (ordered oldest to newest):\n\n${msgText}`,
              capture: true,
            },
          ],
          {
            engine: this._engine,
            signal,
            sessionSuffix: "channel-temp",
            readOnly: true,
            extractInlineImages: true,
            systemAppend: sessionRoleAppend,
          },
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
   * @param {{ source?: "tool" | "auto_reply" }} [opts]
   */
  _handleAgentPost(channelName, senderId, content = "", { source = "tool" } = {}) {
    const mentionedAgents = this._collectMentionedAgentsInChannel(channelName, content, { excludeAgentIds: [senderId] });
    if (!mentionedAgents.length) {
      debugLog()?.log("channel", `agent ${senderId} posted to #${channelName}, no @mentions → no dispatch`);
      return;
    }
    debugLog()?.log("channel", `agent ${senderId} posted to #${channelName}, direct dispatch for mentioned: ${mentionedAgents.join(",")} (source=${source})`);
    this.triggerImmediate(channelName, { source: "agent", mentionedAgents })?.catch(err =>
      console.error(`[channel] agent post dispatch 失败: ${err.message}`)
    );
  }

  /**
   * 统一规范频道消息时间戳（优先保留本地 HH:MM 语义，兼容 ISO）
   * @param {string | null | undefined} ts
   * @returns {string | null}
   */
  _normalizeChannelTimestamp(ts) {
    const raw = String(ts || "").trim();
    if (!raw) return null;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(raw)) {
      return raw.replace(" ", "T");
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(raw)) {
      return raw;
    }
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return null;
  }

  /**
   * 将频道消息输入转换为可用于频道摘要的文本块。
   * @param {string} agentId
   * @param {object|string} memoryInput
   * @param {string} userName
   * @returns {string}
   */
  _buildChannelMemoryConversation(agentId, memoryInput, userName) {
    const isZh = getLocale().startsWith("zh");
    if (typeof memoryInput === "string") {
      return String(memoryInput || "").trim().slice(0, 5000);
    }

    const input = memoryInput && typeof memoryInput === "object" ? memoryInput : {};
    const recentMessages = Array.isArray(input.recentMessages) ? input.recentMessages : [];
    const reply = input.reply && typeof input.reply === "object" ? input.reply : null;

    const aliases = new Set(
      [userName, this._engine.userName, "用户", "user"]
        .map(v => String(v || "").trim().toLowerCase())
        .filter(Boolean),
    );

    const lines = [];
    for (const msg of recentMessages) {
      const body = String(msg?.body || "").trim();
      if (!body) continue;
      const senderRaw = String(msg?.sender || "").trim();
      const sender = senderRaw || (isZh ? "未知成员" : "unknown");
      const senderKey = sender.toLowerCase();
      const ts = this._normalizeChannelTimestamp(msg?.timestamp) || (isZh ? "未知时间" : "unknown-time");

      if (aliases.has(senderKey)) {
        lines.push(`[${ts}] ${isZh ? "用户" : "User"}: ${body}`);
      } else {
        lines.push(`[${ts}] ${sender}: ${body}`);
      }
    }

    const replyBody = String(reply?.body || "").trim();
    if (replyBody) {
      const replySender = String(reply?.sender || agentId).trim() || agentId;
      const ts = this._normalizeChannelTimestamp(reply?.timestamp) || new Date().toISOString();
      lines.push(`[${ts}] ${replySender}: ${replyBody}`);
    }

    return lines.join("\n\n").slice(0, 5000);
  }

  /**
   * 频道记忆摘要专用提示词（与私聊记忆区分：聚焦话题/决策/分工）
   * @param {boolean} hasPrev
   * @returns {string}
   */
  _buildChannelMemoryPrompt(hasPrev) {
    const isZh = getLocale().startsWith("zh");
    if (isZh) {
      return `你是一个“频道讨论记忆系统”，输入是多人群聊，不是一对一聊天。

目标：沉淀对后续协作有价值的信息——话题目标、关键结论、分工、进展、阻塞、下一步。
不要沉淀“用户画像”类内容，不要把频道里任何成员和用户身份混淆。

## 输出格式（严格）
## 重要事实
- 记录稳定且可复用的事实：决策、约束、分工、待办、结论、风险。
- 尽量写清谁负责什么（如有）。
- 没有则写“无”。

## 事情经过
- 按时间顺序写关键推进脉络，标注 HH:MM 与发言者。
- 重点写新增变化：若新消息改写了旧目标，以最新目标为准，并简记旧目标被替换。

## 规则
1. ${hasPrev ? "你会同时看到“已有频道摘要”和“新增频道对话”，请先合并再去重，同一事项以更新消息为准。" : "请只基于输入的频道对话生成摘要。"}
2. @某成员 仅表示提及，不表示身份变更。
3. 严禁写入身份等价事实，例如“用户=某agent”“用户网名是某agent”“我是某agent”。
4. 只写客观事实，不写助手内心活动和泛化性人格判断。
5. 输出必须直接以“## 重要事实”开头，不要前言后记。`;
    }

    return `You are a channel-memory system for multi-party group discussions (not 1:1 chat).

Goal: retain collaboration-useful information — topic goals, decisions, ownership, progress, blockers, and next steps.
Do not store user-profile style content, and never conflate the human user with any agent/member identity.

## Output Format (strict)
## Key Facts
- Keep stable, reusable facts: decisions, constraints, ownership, TODOs, conclusions, risks.
- Include responsible party when available.
- Write "None" if empty.

## Timeline
- Summarize key progression in chronological order with HH:MM and speaker names.
- Focus on what's new; if latest messages supersede earlier goals, treat the latest as authoritative and note the replacement briefly.

## Rules
1. ${hasPrev ? "You will see both existing channel summary and new channel messages. Merge then deduplicate; newer info wins." : "Generate summary only from the provided channel messages."}
2. @mentions indicate addressing someone, not identity reassignment.
3. Never write identity-equivalence facts (e.g., \"user=an agent\", \"user alias is an agent\", \"I am that agent\").
4. Keep only objective facts; no inner thoughts or generic personality judgments.
5. Start directly with \"## Key Facts\" and no preamble/conclusion.`;
  }

  /**
   * 频道记忆写入（复用普通记忆链路：summaries -> compileToday -> assemble）
   * 从 engine._channelMemorySummarize 迁入并强化。
   */
  async _memorySummarize(agentId, channelName, memoryInput) {
    const engine = this._engine;
    try {
      const agent = engine.getAgent?.(agentId) || engine.agents?.get(agentId);
      if (!agent) {
        console.log(`\x1b[90m[channel] ${agentId} 未初始化，跳过频道记忆\x1b[0m`);
        return;
      }
      if (!agent.memoryMasterEnabled) {
        debugLog()?.log("channel", `memory skip ${agentId}/#${channelName}: memory master disabled`);
        return;
      }

      const summaryManager = agent.summaryManager;
      const resolvedModel = agent.resolvedMemoryModel;
      if (!summaryManager || !resolvedModel?.model || !resolvedModel?.api_key || !resolvedModel?.base_url || !resolvedModel?.api) {
        console.log(`\x1b[90m[channel] ${agentId} 记忆模型未就绪，跳过频道记忆\x1b[0m`);
        return;
      }

      const conversationText = this._buildChannelMemoryConversation(
        agentId,
        memoryInput,
        agent.userName || engine.userName || "用户",
      );
      if (!conversationText) return;

      const sessionId = `channel-${channelName}`;
      const existing = summaryManager.getSummary(sessionId);
      const prevSummary = existing?.summary || "";
      const hasPrev = !!prevSummary;
      const isZh = getLocale().startsWith("zh");

      const userContent = hasPrev
        ? (isZh
          ? `## 已有频道摘要\n\n${prevSummary}\n\n## 新增频道对话\n\n${conversationText}`
          : `## Existing Channel Summary\n\n${prevSummary}\n\n## New Channel Messages\n\n${conversationText}`)
        : conversationText;

      let newSummary = await callProviderText({
        api: resolvedModel.api,
        model: resolvedModel.model,
        api_key: resolvedModel.api_key,
        base_url: resolvedModel.base_url,
        systemPrompt: this._buildChannelMemoryPrompt(hasPrev),
        messages: [{ role: "user", content: userContent }],
        temperature: 0.2,
        max_tokens: 700,
      });
      if (!newSummary?.trim()) return;

      const { cleaned, detected } = scrubPII(newSummary);
      if (detected.length > 0) {
        console.warn(`[channel] PII detected in channel summary (${detected.join(", ")})`);
      }
      newSummary = cleaned.trim();

      const now = new Date().toISOString();
      summaryManager.saveSummary(sessionId, {
        session_id: sessionId,
        created_at: existing?.created_at || now,
        updated_at: now,
        summary: newSummary,
        snapshot: existing?.snapshot || "",
        snapshot_at: existing?.snapshot_at || null,
      });

      try {
        await compileToday(summaryManager, agent.todayMdPath, resolvedModel);
        assemble(agent.factsMdPath, agent.todayMdPath, agent.weekMdPath, agent.longtermMdPath, agent.memoryMdPath);
        agent.refreshSystemPrompt?.();
      } catch (err) {
        console.error(`[channel] 频道记忆编译失败 (${agentId}/#${channelName}): ${err.message}`);
      }

      console.log(`\x1b[90m[channel] ${agentId} channel summary saved (#${channelName}, ${newSummary.length} chars)\x1b[0m`);
    } catch (err) {
      console.error(`[channel] 频道记忆写入失败 (${agentId}/#${channelName}): ${err.message}`);
    }
  }
}
