/**
 * WebSocket 聊天路由
 *
 * 桥接 Pi SDK streaming 事件 → WebSocket 消息
 * 支持多 session 并发：后台 session 静默运行，只转发当前活跃 session 的事件
 */
import { XingParser, ThinkTagParser } from "../../core/events.js";
import { wsSend, wsParse } from "../ws-protocol.js";
import { debugLog } from "../../lib/debug-log.js";
import { t } from "../i18n.js";
import { BrowserManager } from "../../lib/browser/browser-manager.js";
import {
  createSessionStreamState,
  beginSessionStream,
  finishSessionStream,
  appendSessionStreamEvent,
  resumeSessionStream,
} from "../session-stream-store.js";

/** tool_start/tool_end 仅广播这些 arg 字段，避免传输完整文件内容（同步维护前端 extractToolDetail） */
const TOOL_ARG_SUMMARY_KEYS = [
  "file_path", "path", "command", "cmd", "pattern", "url", "query", "q",
  "key", "value", "action", "type", "schedule", "prompt", "label", "cwd",
  "location", "ticker", "team", "opponent", "target", "ref_id", "id", "session_id",
  "task", "model", "max_turns", "permission_mode", "thinking", "timeout_sec", "continue", "dangerously_skip_permissions",
  "search_query", "weather", "finance", "sports", "open", "click", "find", "image_query",
  "tool_uses",
];
const DESK_MUTATING_TOOL_NAMES = new Set(["write", "edit", "bash", "generate_images"]);

function compactToolArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== "object") return undefined;
  const args = {};
  for (const k of TOOL_ARG_SUMMARY_KEYS) {
    if (rawArgs[k] !== undefined) args[k] = rawArgs[k];
  }
  return Object.keys(args).length ? args : undefined;
}

/**
 * 从 Pi SDK 的 content 块中提取纯文本
 */
function isReasoningLikeType(type) {
  const normalized = String(type || "").toLowerCase();
  if (!normalized || normalized === "text") return false;
  return /(reason|think|analysis|commentary|summary)/.test(normalized);
}

function pickBlockText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (typeof block.reasoning === "string") return block.reasoning;
  if (typeof block.thinking === "string") return block.thinking;
  if (typeof block.output_text === "string") return block.output_text;
  return "";
}

function extractContentParts(content) {
  if (typeof content === "string") return { text: content, thinking: "" };
  if (Array.isArray(content)) {
    let text = "";
    let thinking = "";
    for (const block of content) {
      const part = pickBlockText(block);
      if (!part) continue;
      if (isReasoningLikeType(block?.type)) thinking += part;
      else text += part;
    }
    return { text, thinking };
  }
  if (!content || typeof content !== "object") return { text: "", thinking: "" };
  if (typeof content.output_text === "string") return { text: content.output_text, thinking: "" };
  const part = pickBlockText(content);
  if (!part) return { text: "", thinking: "" };
  if (isReasoningLikeType(content.type)) return { text: "", thinking: part };
  return { text: part, thinking: "" };
}

function extractText(content) {
  return extractContentParts(content).text;
}

function extractTitleSourceText(content) {
  return extractText(content)
    .replace(/\r/g, "")
    .replace(/```(?:think|analysis|reasoning|commentary|summary)?[\s\S]*?```/gi, " ")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, " ")
    .replace(/<xing\b[^>]*>[\s\S]*?<\/xing>/gi, " ")
    .replace(/<(?:analysis|commentary|summary)\b[^>]*>[\s\S]*?<\/(?:analysis|commentary|summary)>/gi, " ")
    .replace(/<\/?(?:think|xing|analysis|commentary|summary)\b[^>]*>/gi, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isLikelyZh(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ""));
}

function hasFileOutputs(toolName, details) {
  if (!details || typeof details !== "object") return false;
  if (toolName === "present_files" || toolName === "create_artifact") return false;
  if (!Array.isArray(details.files) || details.files.length === 0) return false;
  return details.files.some((item) => {
    if (!item || typeof item !== "object") return false;
    return typeof item.filePath === "string" && item.filePath.trim().length > 0;
  });
}

export default async function chatRoute(app, { engine, hub }) {
  let activeWsClients = 0;
  let disconnectAbortTimer = null;
  const DISCONNECT_ABORT_GRACE_MS = 15_000;
  const sessionState = new Map(); // sessionPath -> shared stream state
  const autoCompactionBeforeTokens = new Map(); // sessionPath -> tokens before auto-compaction

  function cancelDisconnectAbort() {
    if (disconnectAbortTimer) {
      clearTimeout(disconnectAbortTimer);
      disconnectAbortTimer = null;
    }
  }

  function scheduleDisconnectAbort() {
    if (disconnectAbortTimer || activeWsClients > 0) return;
    disconnectAbortTimer = setTimeout(() => {
      disconnectAbortTimer = null;
      if (activeWsClients > 0) return;

      // 中断所有正在 streaming 的会话（焦点 + 后台）
      debugLog()?.log("ws", `no clients for ${DISCONNECT_ABORT_GRACE_MS}ms, aborting all streaming`);
      engine.abortAllStreaming().catch(() => {});
    }, DISCONNECT_ABORT_GRACE_MS);
  }

  const MAX_SESSION_STATES = 20;

  function getState(sessionPath) {
    if (!sessionPath) return null;
    if (!sessionState.has(sessionPath)) {
      // 超过上限时，淘汰非流式的旧 entry
      if (sessionState.size >= MAX_SESSION_STATES) {
        for (const [sp, ss] of sessionState) {
          if (!ss.isStreaming && sp !== sessionPath) {
            sessionState.delete(sp);
            if (sessionState.size < MAX_SESSION_STATES) break;
          }
        }
      }
      sessionState.set(sessionPath, {
        thinkTagParser: new ThinkTagParser(),
        xingParser: new XingParser(),
        isThinking: false,
        thinkingHadDelta: false,
        hasOutput: false,
        hasToolCall: false,
        userAborted: false,
        titleRequested: false,
        ...createSessionStreamState(),
      });
    }
    return sessionState.get(sessionPath);
  }

  const clients = new Set();

  function broadcast(msg) {
    for (const client of clients) {
      wsSend(client, msg);
    }
  }

  function getUsageBySessionPath(sessionPath) {
    const session = sessionPath ? engine.getSessionByPath(sessionPath) : engine.session;
    return session?.getContextUsage?.() || null;
  }

  async function getUsageWithRetry(sessionPath, beforeTokens = null) {
    let usage = getUsageBySessionPath(sessionPath);
    for (let i = 0; i < 4; i++) {
      const hasNumbers = usage?.tokens != null && usage?.contextWindow != null;
      const looksUpdated = beforeTokens == null || usage?.tokens == null || usage.tokens < beforeTokens;
      if (hasNumbers && looksUpdated) return usage;
      await new Promise(resolve => setTimeout(resolve, 250));
      usage = getUsageBySessionPath(sessionPath);
    }
    return usage;
  }

  function followupContextUsage(sessionPath, beforeTokens = null) {
    if (!sessionPath) return;
    const maxAttempts = 18; // ~7.2s
    const intervalMs = 400;
    let attempts = 0;
    let lastSig = null;

    const tick = () => {
      const usage = getUsageBySessionPath(sessionPath);
      const hasNumbers = usage?.tokens != null && usage?.contextWindow != null;
      if (hasNumbers) {
        const sig = `${usage.tokens}|${usage.contextWindow}|${usage.percent ?? ""}`;
        const improved = beforeTokens == null || usage.tokens < beforeTokens;
        const finalTry = attempts >= maxAttempts;
        if (sig !== lastSig && (improved || finalTry)) {
          lastSig = sig;
          broadcast({
            type: "context_usage",
            sessionPath,
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent ?? null,
          });
        }
        if (improved || finalTry) return;
      } else if (attempts >= maxAttempts) {
        return;
      }
      attempts += 1;
      setTimeout(tick, intervalMs);
    };

    setTimeout(tick, intervalMs);
  }

  // 浏览器缩略图 30s 定时刷新（browser 活跃时）
  let _browserThumbTimer = null;
  function startBrowserThumbPoll() {
    if (_browserThumbTimer) return;
    _browserThumbTimer = setInterval(async () => {
      const browser = BrowserManager.instance();
      if (!browser.isRunning) { stopBrowserThumbPoll(); return; }
      const thumbnail = await browser.thumbnail();
      if (thumbnail) {
        broadcast({ type: "browser_status", running: true, url: browser.currentUrl, thumbnail });
      }
    }, 30_000);
  }
  function stopBrowserThumbPoll() {
    if (_browserThumbTimer) { clearInterval(_browserThumbTimer); _browserThumbTimer = null; }
  }

  function emitStreamEvent(sessionPath, ss, event) {
    const entry = appendSessionStreamEvent(ss, event);
    // Phase 4: 始终广播所有事件，前端按 sessionPath 路由到对应 panel
    broadcast({
      ...event,
      sessionPath,
      streamId: entry.streamId,
      seq: entry.seq,
    });
    return entry;
  }

  function maybeGenerateFirstTurnTitle(sessionPath, ss) {
    if (!sessionPath || !ss || ss.titleRequested) return;

    const session = engine.getSessionByPath(sessionPath);
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const userMsgCount = messages.filter(m => m.role === "user").length;
    if (userMsgCount !== 1) return;

    const userMsg = messages.find(m => m.role === "user");
    const userText = extractText(userMsg?.content).trim();
    if (!userText) return;

    const assistantMsg = messages.find(m => m.role === "assistant");
    const assistantText = extractTitleSourceText(assistantMsg?.content);

    ss.titleRequested = true;
    generateSessionTitle(engine, broadcast, {
      sessionPath,
      userTextHint: userText,
      assistantTextHint: assistantText,
    }).then((ok) => {
      if (!ok) ss.titleRequested = false;
    }).catch((err) => {
      ss.titleRequested = false;
      console.error("[chat] generateSessionTitle error:", err.message);
    });
  }

  // 单订阅：事件只写入一次，再按需广播到所有连接中的客户端。
  hub.subscribe(async (event, sessionPath) => {
    const isActive = sessionPath === engine.currentSessionPath;
    const ss = sessionPath ? getState(sessionPath) : null;

    if (event.type === "message_update") {
      if (!ss) return;
      const sub = event.assistantMessageEvent?.type;
      const emitThinkingFallback = (rawThinking, { onlyIfNoDelta = false } = {}) => {
        const thinking = typeof rawThinking === "string" ? rawThinking : "";
        if (!thinking.trim()) return false;
        if (onlyIfNoDelta && ss.thinkingHadDelta) return false;
        if (!ss.isThinking) {
          ss.isThinking = true;
          emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
        }
        ss.thinkingHadDelta = true;
        emitStreamEvent(sessionPath, ss, { type: "thinking_delta", delta: thinking });
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        return true;
      };
      const feedTextChunk = (rawChunk) => {
        const chunk = typeof rawChunk === "string" ? rawChunk : "";
        if (!chunk) return false;
        if (ss.isThinking) {
          ss.isThinking = false;
          emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        }

        // ThinkTagParser（最外层）→ XingParser
        ss.thinkTagParser.feed(chunk, (tEvt) => {
          switch (tEvt.type) {
            case "think_start":
              ss.thinkingHadDelta = false;
              emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
              break;
            case "think_text":
              if (tEvt.data) ss.thinkingHadDelta = true;
              emitStreamEvent(sessionPath, ss, { type: "thinking_delta", delta: tEvt.data });
              break;
            case "think_end":
              emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
              break;
            case "text":
              ss.xingParser.feed(tEvt.data, (xEvt) => {
                switch (xEvt.type) {
                  case "text":
                    emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: xEvt.data });
                    break;
                  case "xing_start":
                    emitStreamEvent(sessionPath, ss, { type: "xing_start", title: xEvt.title });
                    break;
                  case "xing_text":
                    emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
                    break;
                  case "xing_end":
                    emitStreamEvent(sessionPath, ss, { type: "xing_end" });
                    break;
                }
              });
              break;
          }
        });
        return true;
      };

      if (sub === "text_delta") {
        if (feedTextChunk(event.assistantMessageEvent.delta)) {
          ss.hasOutput = true;
        }
      } else if (sub === "text_end") {
        // 某些 provider 只在 text_end 提供完整 content，不会持续发 text_delta。
        if (!ss.hasOutput) {
          const { text, thinking } = extractContentParts(event.assistantMessageEvent.content);
          emitThinkingFallback(thinking, { onlyIfNoDelta: true });
          if (feedTextChunk(text)) {
            ss.hasOutput = true;
          }
        }
      } else if (sub === "done") {
        // 最终 done 事件里通常带 partial 快照，作为 text_end 缺失时的兜底。
        if (!ss.hasOutput) {
          const { text, thinking } = extractContentParts(event.assistantMessageEvent.partial?.content);
          emitThinkingFallback(thinking, { onlyIfNoDelta: true });
          if (feedTextChunk(text)) {
            ss.hasOutput = true;
          }
        }
      } else if (sub === "thinking_start") {
        if (!ss.isThinking) {
          ss.isThinking = true;
          ss.thinkingHadDelta = false;
          emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
        }
      } else if (sub === "thinking_delta") {
        if (!ss.isThinking) {
          ss.isThinking = true;
          ss.thinkingHadDelta = false;
          emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
        }
        if (event.assistantMessageEvent.delta) ss.thinkingHadDelta = true;
        emitStreamEvent(sessionPath, ss, {
          type: "thinking_delta",
          delta: event.assistantMessageEvent.delta || "",
        });
      } else if (sub === "thinking_end") {
        // 兼容只在 thinking_end 带完整内容、不发 thinking_delta 的 provider。
        emitThinkingFallback(
          event.assistantMessageEvent.content
          || event.assistantMessageEvent.delta
          || "",
          { onlyIfNoDelta: true },
        );
        if (ss.isThinking) {
          ss.isThinking = false;
          emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        }
      } else if (sub === "toolcall_start") {
        // 不在这里关闭 thinking 状态
      } else if (sub === "error") {
        if (isActive) broadcast({ type: "error", message: event.assistantMessageEvent.error || "Unknown error" });
      }
    } else if (event.type === "tool_execution_start") {
      if (!ss) return;
      ss.hasToolCall = true;
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }
      // 只保留前端展示需要的字段，避免广播完整文件内容
      const args = compactToolArgs(event.args);
      emitStreamEvent(sessionPath, ss, { type: "tool_start", name: event.toolName || "", args });
    } else if (event.type === "tool_execution_end") {
      if (!ss) return;
      const details = event.result?.details;
      const hasDetailsError = typeof details?.error === "string" && details.error.trim().length > 0;
      const args = compactToolArgs(event.args);
      emitStreamEvent(sessionPath, ss, {
        type: "tool_end",
        name: event.toolName || "",
        success: !event.isError && !hasDetailsError,
        args,
        details,
      });

      if (event.toolName === "present_files") {
        const details = event.result?.details || {};
        const files = details.files || [];
        if (files.length === 0 && details.filePath) {
          files.push({ filePath: details.filePath, label: details.label, ext: details.ext || "" });
        }
        for (const f of files) {
          emitStreamEvent(sessionPath, ss, {
            type: "file_output",
            filePath: f.filePath,
            label: f.label,
            ext: f.ext || "",
          });
        }
      }

      if (event.toolName === "create_artifact") {
        const d = event.result?.details || {};
        emitStreamEvent(sessionPath, ss, {
          type: "artifact",
          artifactId: d.artifactId,
          artifactType: d.type,
          title: d.title,
          content: d.content,
          language: d.language,
        });
      }

      if (event.toolName === "browser") {
        const d = event.result?.details || {};
        if (d.action === "screenshot" && event.result?.content) {
          const imgBlock = event.result.content.find(c => c.type === "image");
          if (imgBlock?.source?.data) {
            emitStreamEvent(sessionPath, ss, {
              type: "browser_screenshot",
              base64: imgBlock.source.data,
              mimeType: imgBlock.source.media_type || "image/jpeg",
            });
          }
        }

        const statusMsg = {
          type: "browser_status",
          running: d.running ?? false,
          url: d.url || null,
        };
        if (d.thumbnail) statusMsg.thumbnail = d.thumbnail;
        emitStreamEvent(sessionPath, ss, statusMsg);
        if (statusMsg.running) startBrowserThumbPoll();
        else stopBrowserThumbPoll();
      }

      if (event.toolName === "generate_images" && event.result?.content) {
        const imageBlocks = event.result.content.filter(c => c?.type === "image" && c?.source?.data);
        for (const imgBlock of imageBlocks) {
          emitStreamEvent(sessionPath, ss, {
            type: "browser_screenshot",
            base64: imgBlock.source.data,
            mimeType: imgBlock.source.media_type || "image/png",
          });
        }
      }

      if (event.toolName === "cron") {
        const d = event.result?.details || {};
        if (d.action === "pending_add" && d.jobData) {
          emitStreamEvent(sessionPath, ss, { type: "cron_confirmation", jobData: d.jobData });
        }
      }

      const toolName = String(event.toolName || "").toLowerCase();
      const shouldRefreshDesk = isActive && (
        DESK_MUTATING_TOOL_NAMES.has(toolName)
        || hasFileOutputs(toolName, details)
      );
      if (shouldRefreshDesk) {
        broadcast({ type: "desk_changed" });
      }
    } else if (event.type === "jian_update") {
      broadcast({ type: "jian_update", content: event.content });
    } else if (event.type === "desk_changed") {
      broadcast({ type: "desk_changed" });
    } else if (event.type === "devlog") {
      broadcast({ type: "devlog", text: event.text, level: event.level });
    } else if (event.type === "browser_bg_status") {
      broadcast({ type: "browser_bg_status", running: event.running, url: event.url });
    } else if (event.type === "cron_changed") {
      broadcast({ type: "cron_changed" });
    } else if (event.type === "skills_changed") {
      broadcast({ type: "skills_changed" });
    } else if (event.type === "cron_confirmation" && event.confirmId) {
      // 新的阻塞式 cron 确认（通过 emitEvent 触发）
      if (ss) {
        emitStreamEvent(sessionPath, ss, {
          type: "cron_confirmation",
          confirmId: event.confirmId,
          jobData: event.jobData,
        });
      } else {
        // 兜底：无流状态时也广播，避免确认卡片丢失
        broadcast({
          type: "cron_confirmation",
          sessionPath: sessionPath || null,
          confirmId: event.confirmId,
          jobData: event.jobData,
        });
      }
    } else if (event.type === "settings_confirmation") {
      if (ss) {
        emitStreamEvent(sessionPath, ss, {
          type: "settings_confirmation",
          confirmId: event.confirmId,
          settingKey: event.settingKey,
          cardType: event.cardType,
          currentValue: event.currentValue,
          proposedValue: event.proposedValue,
          options: event.options,
          optionLabels: event.optionLabels || null,
          label: event.label,
          description: event.description,
          frontend: event.frontend,
        });
      } else {
        broadcast({
          type: "settings_confirmation",
          sessionPath: sessionPath || null,
          confirmId: event.confirmId,
          settingKey: event.settingKey,
          cardType: event.cardType,
          currentValue: event.currentValue,
          proposedValue: event.proposedValue,
          options: event.options,
          optionLabels: event.optionLabels || null,
          label: event.label,
          description: event.description,
          frontend: event.frontend,
        });
      }
    } else if (event.type === "confirmation_resolved") {
      broadcast({
        type: "confirmation_resolved",
        confirmId: event.confirmId,
        action: event.action,
        value: event.value,
      });
    } else if (event.type === "apply_frontend_setting") {
      broadcast({
        type: "apply_frontend_setting",
        key: event.key,
        value: event.value,
      });
    } else if (event.type === "activity_update") {
      broadcast({ type: "activity_update", activity: event.activity });
    } else if (event.type === "notification") {
      broadcast({ type: "notification", title: event.title, body: event.body });
    } else if (event.type === "channel_agent_activity") {
      broadcast({
        type: "channel_agent_activity",
        channelName: event.channelName,
        agentId: event.agentId,
        active: !!event.active,
      });
    } else if (event.type === "channel_new_message") {
      broadcast({ type: "channel_new_message", channelName: event.channelName, sender: event.sender });
    } else if (event.type === "dm_new_message") {
      broadcast({ type: "dm_new_message", from: event.from, to: event.to });
    } else if (event.type === "turn_end") {
      if (!ss) return;
      // 关闭结构化 thinking（如有）——必须在 flush 之前，否则前端收不到 thinking_end
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }
      // flush 顺序：ThinkTag → Xing（和 feed 顺序一致）
      const feedXingPipeline = (text) => {
        ss.xingParser.feed(text, (xEvt) => {
          switch (xEvt.type) {
            case "text":
              emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: xEvt.data });
              break;
            case "xing_start":
              emitStreamEvent(sessionPath, ss, { type: "xing_start", title: xEvt.title });
              break;
            case "xing_text":
              emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
              break;
            case "xing_end":
              emitStreamEvent(sessionPath, ss, { type: "xing_end" });
              break;
          }
        });
      };
      ss.thinkTagParser.flush((tEvt) => {
        if (tEvt.type === "think_text") {
          emitStreamEvent(sessionPath, ss, { type: "thinking_delta", delta: tEvt.data });
        } else if (tEvt.type === "think_end") {
          emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        } else if (tEvt.type === "text") {
          feedXingPipeline(tEvt.data);
        }
      });
      ss.xingParser.flush((xEvt) => {
        if (xEvt.type === "text") {
          emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: xEvt.data });
        } else if (xEvt.type === "xing_text") {
          emitStreamEvent(sessionPath, ss, { type: "xing_text", delta: xEvt.data });
        }
      });

      // 回填保护：某些 provider 可能在流事件里没有 text_delta，
      // 但最终 assistant 消息已写入 session（例如只给最终聚合文本）。
      // 这种情况下补发一次 text_delta，避免误报“模型未返回任何内容”。
      if (!ss.hasOutput && !ss.hasToolCall) {
        const session = engine.getSessionByPath(sessionPath);
        const messages = Array.isArray(session?.messages) ? session.messages : [];
        const lastAssistant = [...messages].reverse().find((m) => m?.role === "assistant");
        const finalText = extractText(lastAssistant?.content).trim();
        if (finalText) {
          ss.hasOutput = true;
          if (isActive) {
            emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: finalText });
          }
        }
      }

      // 空回复检测：本轮没有文本输出也没有工具调用，提示用户检查配置。
      // 若是用户主动点击停止（abort），不应提示“模型未返回任何内容”。
      if (!ss.hasOutput && !ss.hasToolCall && isActive && !ss.userAborted) {
        broadcast({ type: "error", message: t("error.modelNoResponse") });
      }

      emitStreamEvent(sessionPath, ss, { type: "turn_end" });
      finishSessionStream(ss);
      if (sessionPath) {
        engine.clearSessionPendingImages(sessionPath);
      }
      ss.hasOutput = false;
      ss.hasToolCall = false;
      ss.userAborted = false;
      ss.thinkingHadDelta = false;
      ss.thinkTagParser.reset();
      ss.xingParser.reset();

      if (isActive) {
        debugLog()?.log("ws", "assistant reply done");
      }
      maybeGenerateFirstTurnTitle(sessionPath, ss);
    } else if (event.type === "auto_compaction_start") {
      if (sessionPath) {
        const before = getUsageBySessionPath(sessionPath);
        autoCompactionBeforeTokens.set(sessionPath, before?.tokens ?? null);
      }
      if (isActive) broadcast({ type: "compaction_start", sessionPath });
    } else if (event.type === "auto_compaction_end") {
      if (isActive) {
        const beforeTokens = sessionPath ? autoCompactionBeforeTokens.get(sessionPath) ?? null : null;
        if (sessionPath) autoCompactionBeforeTokens.delete(sessionPath);
        const usage = await getUsageWithRetry(sessionPath, beforeTokens);
        broadcast({
          type: "compaction_end",
          sessionPath,
          success: true,
          tokens: usage?.tokens ?? null,
          contextWindow: usage?.contextWindow ?? null,
          percent: usage?.percent ?? null,
        });
        followupContextUsage(sessionPath, beforeTokens);
      }
    }
  });

  app.get("/ws", { websocket: true }, (socket, req) => {
    const ws = socket;
    let closed = false;
    activeWsClients++;
    clients.add(ws);
    cancelDisconnectAbort();
    debugLog()?.log("ws", "client connected");

    // 注意：token 校验由 server/index.js 的 onRequest hook 统一处理，
    // Fastify @fastify/websocket 的 WS 升级请求也会经过该 hook

    // 处理客户端消息
    ws.on("message", async (raw) => {
      const msg = wsParse(raw);
      if (!msg) return;

      if (msg.type === "abort") {
        const abortPath = msg.sessionPath || engine.currentSessionPath;
        const ss = abortPath ? getState(abortPath) : null;
        if (ss) ss.userAborted = true;
        if (engine.isSessionStreaming(abortPath)) {
          try { await hub.abort(abortPath); } catch {}
        }
        return;
      }

      if (msg.type === "steer" && msg.text) {
        debugLog()?.log("ws", `steer (${msg.text.length} chars)`);
        const steerPath = msg.sessionPath || engine.currentSessionPath;
        if (engine.steerSession(steerPath, msg.text)) {
          wsSend(ws, { type: "steered" });
          return;
        }
        // agent 已停止，降级为正常 prompt（下面的 prompt 分支会处理）
        debugLog()?.log("ws", `steer missed, falling back to prompt`);
        msg.type = "prompt";
      }

      // session 切回时，前端请求补发离屏期间的流式内容
      if (msg.type === "resume_stream") {
        const currentPath = msg.sessionPath || engine.currentSessionPath;
        const ss = sessionState.get(currentPath);
        if (ss) {
          const resumed = resumeSessionStream(ss, {
            streamId: msg.streamId,
            sinceSeq: msg.sinceSeq,
          });
          wsSend(ws, {
            type: "stream_resume",
            sessionPath: currentPath,
            streamId: resumed.streamId,
            sinceSeq: resumed.sinceSeq,
            nextSeq: resumed.nextSeq,
            reset: resumed.reset,
            truncated: resumed.truncated,
            isStreaming: resumed.isStreaming,
            events: resumed.events,
          });
        } else {
          wsSend(ws, {
            type: "stream_resume",
            sessionPath: currentPath,
            streamId: null,
            sinceSeq: Number.isFinite(msg.sinceSeq) ? Math.max(0, msg.sinceSeq) : 0,
            nextSeq: 1,
            reset: false,
            truncated: false,
            isStreaming: false,
            events: [],
          });
        }
        return;
      }

      if (msg.type === "context_usage") {
        const targetPath = msg.sessionPath || engine.currentSessionPath;
        const usage = getUsageBySessionPath(targetPath);
        wsSend(ws, {
          type: "context_usage",
          sessionPath: targetPath || null,
          tokens: usage?.tokens ?? null,
          contextWindow: usage?.contextWindow ?? null,
          percent: usage?.percent ?? null,
        });
        return;
      }

      if (msg.type === "compact") {
        const targetPath = msg.sessionPath || engine.currentSessionPath;
        const session = targetPath ? engine.getSessionByPath(targetPath) : engine.session;
        if (!session) {
          wsSend(ws, { type: "error", message: t("error.noActiveSession") });
          return;
        }
        if (session.isCompacting) {
          wsSend(ws, { type: "error", message: t("error.compacting") });
          return;
        }
        // streaming 时不允许手动压缩，避免与 prompt 并发
        if (engine.isStreaming) {
          wsSend(ws, { type: "error", message: t("error.waitForReply") });
          return;
        }
        const beforeUsage = getUsageBySessionPath(targetPath);
        broadcast({ type: "compaction_start", sessionPath: targetPath || null });
        try {
          await session.compact();
          const usage = await getUsageWithRetry(targetPath, beforeUsage?.tokens ?? null);
          broadcast({
            type: "compaction_end",
            sessionPath: targetPath || null,
            success: true,
            tokens: usage?.tokens ?? null,
            contextWindow: usage?.contextWindow ?? null,
            percent: usage?.percent ?? null,
          });
          followupContextUsage(targetPath, beforeUsage?.tokens ?? null);
        } catch (err) {
          // Already compacted / Nothing to compact 不算错误
          const msg = err.message || "";
          if (msg.includes("Already compacted") || msg.includes("Nothing to compact")) {
            const usage = getUsageBySessionPath(targetPath);
            broadcast({
              type: "compaction_end",
              sessionPath: targetPath || null,
              success: false,
              tokens: usage?.tokens ?? null,
              contextWindow: usage?.contextWindow ?? null,
              percent: usage?.percent ?? null,
            });
            followupContextUsage(targetPath, beforeUsage?.tokens ?? null);
          } else {
            broadcast({ type: "compaction_end", sessionPath: targetPath || null, success: false });
            wsSend(ws, { type: "error", message: t("error.compactFailed", { msg }) });
          }
        }
        return;
      }

      if (msg.type === "prompt" && (msg.text || msg.images?.length)) {
        // 图片校验：最多 10 张，单张 ≤ 20MB，仅允许常见图片 MIME
        if (msg.images?.length) {
          const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
          const MAX_IMAGES = 10;
          const MAX_BYTES = 20 * 1024 * 1024; // 20MB base64 ≈ 15MB 原始
          if (msg.images.length > MAX_IMAGES) {
            wsSend(ws, { type: "error", message: t("error.maxImages", { max: MAX_IMAGES }) });
            return;
          }
          for (const img of msg.images) {
            if (!img?.mimeType || !ALLOWED_MIME.has(img.mimeType)) {
              wsSend(ws, { type: "error", message: t("error.unsupportedImageFormat", { mime: img?.mimeType || "unknown" }) });
              return;
            }
            if (img.data && img.data.length > MAX_BYTES) {
              wsSend(ws, { type: "error", message: t("error.imageTooLarge") });
              return;
            }
          }
        }
        // 只发图片没文字时补一个占位文本，防止空 text 导致某些 API 异常
        let promptText = msg.text || "";
        if (!promptText.trim() && msg.images?.length) {
          promptText = t("error.viewImage");
        }
        const promptSessionPath = msg.sessionPath || engine.currentSessionPath;
        if (msg.images?.length) {
          engine.setSessionPendingImages(promptSessionPath, msg.images);
        } else {
          engine.clearSessionPendingImages(promptSessionPath);
        }
        debugLog()?.log("ws", `user message (${promptText.length} chars, ${msg.images?.length || 0} images)`);
        // Phase 2: 客户端可指定 sessionPath，否则用焦点 session
        if (engine.isSessionStreaming(promptSessionPath)) {
          wsSend(ws, { type: "error", message: t("error.stillStreaming", { name: engine.agentName }) });
          return;
        }
        const ss = getState(promptSessionPath);
        try {
          ss.thinkTagParser.reset();
          ss.xingParser.reset();
          ss.userAborted = false;
          ss.thinkingHadDelta = false;
          ss.titleRequested = false;
          beginSessionStream(ss);
          broadcast({ type: "status", isStreaming: true, sessionPath: promptSessionPath });
          // 透传图片给主对话模型：支持原生多模态模型直接看图回复，
          // 同时仍保留 pendingImages 供 describe_images 工具按需使用。
          await hub.send(promptText, { sessionPath: promptSessionPath, images: msg.images });
          broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
        } catch (err) {
          if (!err.message?.includes("aborted")) {
            wsSend(ws, { type: "error", message: err.message });
          }
          broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath });
        }
      }
    });

    ws.on("error", (err) => {
      console.error("[ws] error:", err.message);
      debugLog()?.error("ws", err.message);
    });

    // 清理：WS 断开时只中断前台 session（后台 channel triage / cron 不受影响）
    ws.on("close", () => {
      if (closed) return;
      closed = true;
      activeWsClients = Math.max(0, activeWsClients - 1);
      clients.delete(ws);
      debugLog()?.log("ws", "client disconnected");
      scheduleDisconnectAbort();
      // 无活跃客户端时，清理非流式 session 状态（防止 Map 无限增长）
      if (activeWsClients === 0) {
        for (const [sp, ss] of sessionState) {
          if (!ss.isStreaming) sessionState.delete(sp);
        }
      }
    });
  });
}

/**
 * 后台生成 session 标题：从第一轮对话提取摘要
 * 只在 session 还没有自定义标题时执行
 */
async function generateSessionTitle(engine, notify, opts = {}) {
  try {
    const sessionPath = opts.sessionPath || engine.currentSessionPath;
    if (!sessionPath) return false;

    // 检查是否已有标题（避免重复生成）
    const sessions = await engine.listSessions();
    const current = sessions.find(s => s.path === sessionPath);
    if (current?.title) return true;

    const session = engine.getSessionByPath(sessionPath);
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const userMsg = messages.find(m => m.role === "user");
    const assistantMsg = messages.find(m => m.role === "assistant");
    if (!userMsg && !opts.userTextHint) return false;

    const userText = (opts.userTextHint || extractText(userMsg?.content)).trim();
    const assistantText = (opts.assistantTextHint ?? extractTitleSourceText(assistantMsg?.content)).trim();
    if (!userText) return false;

    const TITLE_TIMEOUT = 15_000; // 15 秒超时
    let title = await Promise.race([
      engine.summarizeTitle(userText, assistantText || ""),
      new Promise(resolve => setTimeout(() => resolve(null), TITLE_TIMEOUT)),
    ]);

    // API 失败时，使用最小兜底标题（不做本地语义提取）
    if (!title) {
      const isZh = isLikelyZh(userText);
      const compact = userText.replace(/\n/g, " ").trim();
      const chars = Array.from(compact);
      const rawFallback = chars.slice(0, 8).join("");
      const fallback = rawFallback
        ? (chars.length > 8 ? `${rawFallback}...` : rawFallback)
        : (isZh ? "新对话" : "New chat");
      title = fallback;
      console.log("[chat] session 标题 API 失败，使用 fallback:", title);
    }

    // 保存标题
    await engine.saveSessionTitle(sessionPath, title);

    // 通知前端更新
    notify({ type: "session_title", title, path: sessionPath });
    return true;
  } catch (err) {
    console.error("[chat] 生成 session 标题失败:", err.message);
    return false;
  }
}
