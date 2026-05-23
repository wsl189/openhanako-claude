/**
 * WebSocket 聊天路由
 *
 * 桥接 Claude/Hanako streaming 事件 → WebSocket 消息
 * 支持多 session 并发：后台 session 静默运行，只转发当前活跃 session 的事件
 */
import { XingParser, ThinkTagParser } from "../../core/events.js";
import { wsSend, wsParse } from "../ws-protocol.js";
import { debugLog } from "../../lib/debug-log.js";
import { t } from "../i18n.js";
import { BrowserManager } from "../../lib/browser/browser-manager.js";
import { stripSdkDiagnosticLines } from "../../lib/text/assistant-visible-text.js";
import { patchSessionMetadata } from "../../core/claude-session-store.js";
import {
  createSessionStreamState,
  beginSessionStream,
  finishSessionStream,
  appendSessionStreamEvent,
  resumeSessionStream,
} from "../session-stream-store.js";

/** tool_start/tool_end 仅广播前端展示所需字段；文本参数会按长度裁剪（同步维护前端 extractToolDetail） */
const TOOL_ARG_SUMMARY_KEYS = [
  "file_path", "path", "command", "cmd", "pattern", "url", "query", "q",
  "key", "value", "action", "type", "schedule", "prompt", "label", "cwd",
  "location", "ticker", "team", "opponent", "target", "ref_id", "id", "session_id",
  "task", "model", "max_turns", "permission_mode", "thinking", "timeout_sec", "continue", "dangerously_skip_permissions",
  "search_query", "weather", "finance", "sports", "open", "click", "find", "image_query",
  "tool_uses",
  // setup_settings 核心结构（保留完整嵌套对象供前端生成具体变更摘要）
  "tutorial", "agent", "mcp", "memory", "dry_run",
  // skill 工具关键字段
  "skill", "skill_name", "skillName", "skill_path", "skillPath", "github_url", "githubUrl",
  // 编辑/写入工具关键信息：让前端展开时能展示“实际写入/替换内容”
  "content", "old_string", "new_string", "old_text", "new_text", "replace_all", "offset", "limit", "lineno",
];
const DESK_MUTATING_TOOL_NAMES = new Set(["write", "edit", "bash", "generate_images"]);
const EDE_DIAGNOSTIC_RE = /^\s*(?:⚠\s*)?\[ede_diagnostic\]\b/i;
const TOOL_RESULT_TEXT_MAX_LEN = 12_000;
const TOOL_ARG_DEFAULT_TEXT_MAX_LEN = 1_600;
const TOOL_ARG_LONG_TEXT_MAX_LEN = 12_000;
const TOOL_ARG_ARRAY_MAX_ITEMS = 12;
const TOOL_ARG_OBJECT_MAX_KEYS = 40;
const TOOL_ARG_LONG_TEXT_KEYS = new Set(["content", "old_string", "new_string", "old_text", "new_text"]);
const CHAT_TURN_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.HANAKO_CHAT_TURN_TIMEOUT_MS || "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 5 * 60 * 60 * 1000;
})();

function toModelRef(model) {
  if (!model || typeof model !== "object") return "";
  const id = String(model.id || "").trim();
  if (!id) return "";
  const provider = String(model.provider || "").trim();
  return provider ? `${provider}/${id}` : id;
}

function compactToolArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== "object") return undefined;
  const args = {};
  for (const k of TOOL_ARG_SUMMARY_KEYS) {
    if (rawArgs[k] !== undefined) args[k] = compactToolArgValue(rawArgs[k], k, 0);
  }
  return Object.keys(args).length ? args : undefined;
}

function clipToolArgText(raw, maxLen) {
  const text = String(raw ?? "").replace(/\r/g, "");
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function compactToolArgValue(value, keyHint = "", depth = 0) {
  if (typeof value === "string") {
    const maxLen = TOOL_ARG_LONG_TEXT_KEYS.has(keyHint)
      ? TOOL_ARG_LONG_TEXT_MAX_LEN
      : TOOL_ARG_DEFAULT_TEXT_MAX_LEN;
    return clipToolArgText(value, maxLen);
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, TOOL_ARG_ARRAY_MAX_ITEMS).map((item) => compactToolArgValue(item, keyHint, depth + 1));
    if (value.length > TOOL_ARG_ARRAY_MAX_ITEMS) {
      items.push(`…(${value.length - TOOL_ARG_ARRAY_MAX_ITEMS} more items)`);
    }
    return items;
  }
  if (typeof value === "object") {
    if (depth >= 2) return "[omitted nested object]";
    const out = {};
    const keys = Object.keys(value).slice(0, TOOL_ARG_OBJECT_MAX_KEYS);
    for (const key of keys) {
      out[key] = compactToolArgValue(value[key], key, depth + 1);
    }
    const omitted = Object.keys(value).length - keys.length;
    if (omitted > 0) out.__omittedKeys = omitted;
    return out;
  }
  return String(value);
}

function isSdkDiagnosticChunk(text) {
  return EDE_DIAGNOSTIC_RE.test(String(text || "").trim());
}

function isAbortLikeErrorMessage(message) {
  const text = String(message || "").trim();
  if (!text) return false;
  return (
    /^aborted$/i.test(text)
    || /request was aborted/i.test(text)
    || /aborterror/i.test(text)
    || /fetchrequestcanceledexception/i.test(text)
    || /query closed before response received/i.test(text)
  );
}

function isSdkTelemetryExportNoise(message) {
  const text = String(message || "").trim();
  if (!text) return false;
  const hasExportFailure = /\bfailed\s+to\s+export\b/i.test(text) && /\bevents?\b/i.test(text);
  if (!hasExportFailure) return false;
  const hasSdkExportMarker = (
    /@anthropic-ai\/claude-agent-sdk\/cli\.js/i.test(text)
    || /\bqueueFailedEvents\b/i.test(text)
    || /\bdoExport\b/i.test(text)
    || /\b(?:1p|first-party)\s+event\s+logging\b/i.test(text)
  );
  if (!hasSdkExportMarker) return false;
  return (
    /\bstatus=\d{3}\b/i.test(text)
    || /\bERR_[A-Z_]+\b/i.test(text)
    || /request failed with status code \d{3}/i.test(text)
    || /\b(?:1p|first-party)\s+event\s+logging\b/i.test(text)
  );
}

function shouldSuppressUserFacingErrorMessage(message) {
  const text = String(message || "").trim();
  if (!text) return false;
  return (
    EDE_DIAGNOSTIC_RE.test(text)
    || isAbortLikeErrorMessage(text)
    || isSdkTelemetryExportNoise(text)
  );
}

function createTurnTimeoutError(timeoutMs) {
  const err = new Error(`Turn timed out after ${timeoutMs}ms`);
  err.code = "TURN_TIMEOUT";
  err.timeoutMs = timeoutMs;
  return err;
}

function isTurnTimeoutError(err) {
  return err?.code === "TURN_TIMEOUT";
}

function getTurnTimeoutMessage(timeoutMs) {
  const sec = Math.max(1, Math.round(timeoutMs / 1000));
  const translated = t("error.replyTimeout", { sec: String(sec) });
  if (translated && translated !== "error.replyTimeout") return translated;
  return `等待模型回复超时（${sec} 秒），已自动停止。请重试。`;
}

function getSteerPromptText(text) {
  const isZh = (process.env.HANAKO_LANG || "zh").startsWith("zh");
  return `${isZh ? "（插话）\n" : "(Interjection)\n"}${text}`;
}

/**
 * 从内容块中提取纯文本
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

function clipToolResultText(raw) {
  const text = String(raw || "")
    .replace(/\r/g, "")
    .trim();
  if (!text) return "";
  if (text.length <= TOOL_RESULT_TEXT_MAX_LEN) return text;
  return `${text.slice(0, TOOL_RESULT_TEXT_MAX_LEN - 1)}…`;
}

function extractToolResultText(content, details) {
  const fromContent = clipToolResultText(extractText(content));
  if (fromContent) return fromContent;
  if (!details || typeof details !== "object") return "";
  const keys = ["error", "summary", "message", "output", "result"];
  for (const key of keys) {
    const value = details[key];
    if (typeof value === "string" && value.trim()) {
      return clipToolResultText(value);
    }
  }
  return "";
}

function resolveToolEndSuccess(event) {
  if (typeof event?.success === "boolean") return event.success;
  const error = event?.details?.error;
  return !(typeof error === "string" && error.trim().length > 0);
}

function shouldBroadcastMcpChanged(event) {
  const toolName = String(event?.name || "").trim().toLowerCase();
  if (toolName !== "setup_settings") return false;
  const details = event?.details;
  if (!details || typeof details !== "object") return false;
  const isDryRun = details.dryRun === true || details.dry_run === true;
  if (isDryRun) return false;
  return !!details?.applied?.mcp;
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

function normalizeSnapshotText(text) {
  // Snapshot text is the live assistant reply, so keep it intact; history already stores it fully.
  return String(text || "");
}

export function compactAssistantSnapshotContent(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      out.push({ type: "text", text: normalizeSnapshotText(block.text) });
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      out.push({ type: "thinking", thinking: normalizeSnapshotText(block.thinking) });
      continue;
    }
    if (block.type === "tool_use" && block.id) {
      out.push({
        type: "tool_use",
        id: block.id,
        name: block.name || "",
        input: compactToolArgs(block.input),
      });
      continue;
    }
    if (
      typeof block.type === "string"
      && /(reason|think|analysis|commentary|summary)/i.test(block.type)
      && typeof block.text === "string"
    ) {
      out.push({ type: block.type, text: normalizeSnapshotText(block.text) });
    }
  }
  return out;
}

export function compactSdkMessage(message) {
  if (!message || typeof message !== "object") return null;
  const role = String(message.role || "").trim();
  const content = Array.isArray(message.content) ? message.content : [];
  if (!role || !content.length) return null;

  if (role === "assistant") {
    const messageId = String(message.messageId || message.id || "").trim();
    const messageUuid = String(message.uuid || "").trim();
    return {
      role,
      content: compactAssistantSnapshotContent(content),
      ...(messageId ? { messageId } : {}),
      ...(messageUuid ? { uuid: messageUuid } : {}),
    };
  }

  if (role === "user") {
    const toolResults = content
      .filter((block) => block?.type === "tool_result" && block.tool_use_id)
      .map((block) => ({
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        is_error: block.is_error === true,
      }));
    if (!toolResults.length) return null;
    const messageId = String(message.messageId || message.id || "").trim();
    const messageUuid = String(message.uuid || "").trim();
    return {
      role,
      content: toolResults,
      ...(messageId ? { messageId } : {}),
      ...(messageUuid ? { uuid: messageUuid } : {}),
    };
  }

  return null;
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

function getImageBlockPayload(block, defaultMime = "image/png") {
  if (!block || typeof block !== "object" || block.type !== "image") return null;
  const base64 = typeof block.data === "string"
    ? block.data
    : (typeof block.source?.data === "string" ? block.source.data : "");
  if (!base64) return null;
  const mimeType = typeof block.mimeType === "string"
    ? block.mimeType
    : (typeof block.source?.media_type === "string" ? block.source.media_type : defaultMime);
  return { base64, mimeType };
}

const CHAT_IMAGE_MIME_ALIASES = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-jpeg": "image/jpeg",
  "image/x-png": "image/png",
};
const CHAT_ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function normalizeChatImageMime(mimeType = "") {
  const normalized = String(mimeType || "").trim().toLowerCase();
  if (!normalized) return "";
  return CHAT_IMAGE_MIME_ALIASES[normalized] || normalized;
}

function shouldUseStructuredStreamForSession(engine, sessionPath) {
  const session = sessionPath ? engine.getSessionByPath(sessionPath) : engine.session;
  if (!session || typeof session !== "object") return false;
  // SessionCoordinator 会为新 runtime 显式打标，优先使用该标记；
  // Provider runtime 历史上使用 eventProtocol=hanako，也视为结构化事件流。
  if (session.hanakoStructuredStream === true) return true;
  return session.eventProtocol === "hanako";
}

export default async function chatRoute(app, { engine, hub }) {
  let activeWsClients = 0;
  let disconnectAbortTimer = null;
  const DISCONNECT_ABORT_GRACE_MS = 15_000;
  const sessionState = new Map(); // sessionPath -> shared stream state
  const autoCompactionBeforeTokens = new Map(); // sessionPath -> tokens before auto-compaction
  const contextUsagePushState = new Map(); // sessionPath -> { lastAt, lastSig, inFlight }

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
        structuredStream: false,
        lastAssistantSnapshotSig: "",
        isThinking: false,
        thinkingHadDelta: false,
        hasOutput: false,
        hasToolCall: false,
        hadError: false,
        userAborted: false,
        abortingStreamId: null,
        titleRequested: false,
        lastAssistantContent: null,
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

  async function refreshUsageBySessionPath(sessionPath, fallbackUsage = null) {
    const session = sessionPath ? engine.getSessionByPath(sessionPath) : engine.session;
    if (!session) return null;
    await session.refreshContextUsage?.(fallbackUsage);
    return session.getContextUsage?.() || null;
  }

  function scheduleContextUsagePush(sessionPath, { force = false } = {}) {
    if (!sessionPath) return;
    const now = Date.now();
    const state = contextUsagePushState.get(sessionPath) || {
      lastAt: 0,
      lastSig: "",
      inFlight: false,
    };
    if (!force) {
      if (state.inFlight) return;
      if (now - state.lastAt < 1500) return;
    }
    state.lastAt = now;
    state.inFlight = true;
    contextUsagePushState.set(sessionPath, state);

    refreshUsageBySessionPath(sessionPath)
      .then((usage) => {
        const hasNumbers = usage?.tokens != null && usage?.contextWindow != null;
        if (!hasNumbers) return;
        const sig = `${usage.tokens}|${usage.contextWindow}|${usage.percent ?? ""}`;
        if (!force && sig === state.lastSig) return;
        state.lastSig = sig;
        broadcast({
          type: "context_usage",
          sessionPath,
          tokens: usage.tokens,
          contextWindow: usage.contextWindow,
          percent: usage.percent ?? null,
        });
      })
      .catch(() => {})
      .finally(() => {
        state.inFlight = false;
      });
  }

  async function getUsageWithRetry(sessionPath, beforeTokens = null) {
    let usage = await refreshUsageBySessionPath(sessionPath);
    for (let i = 0; i < 4; i++) {
      const hasNumbers = usage?.tokens != null && usage?.contextWindow != null;
      const looksUpdated = beforeTokens == null || usage?.tokens == null || usage.tokens < beforeTokens;
      if (hasNumbers && looksUpdated) return usage;
      await new Promise(resolve => setTimeout(resolve, 250));
      usage = await refreshUsageBySessionPath(sessionPath);
    }
    return usage;
  }

  function followupContextUsage(sessionPath, beforeTokens = null) {
    if (!sessionPath) return;
    const maxAttempts = 18; // ~7.2s
    const intervalMs = 400;
    let attempts = 0;
    let lastSig = null;

    const tick = async () => {
      const usage = await refreshUsageBySessionPath(sessionPath);
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

  function resetTurnState(ss, opts = {}) {
    if (!ss) return;
    ss.hasOutput = false;
    ss.hasToolCall = false;
    ss.hadError = false;
    if (!opts.preserveUserAborted) ss.userAborted = false;
    if (!opts.preserveAbortingStreamId) ss.abortingStreamId = null;
    ss.thinkingHadDelta = false;
    ss.structuredStream = false;
    ss.lastAssistantSnapshotSig = "";
    ss.lastAssistantContent = null;
    ss.thinkTagParser.reset();
    ss.xingParser.reset();
  }

  function finalizeAbortedTurn(sessionPath, ss) {
    if (!ss || !ss.isStreaming) return false;
    const abortedStreamId = ss.streamId || null;
    if (ss.isThinking) {
      ss.isThinking = false;
      emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
    }
    emitStreamEvent(sessionPath, ss, { type: "turn_end" });
    finishSessionStream(ss);
    if (sessionPath) {
      engine.clearSessionPendingImages(sessionPath);
    }
    ss.abortingStreamId = abortedStreamId;
    resetTurnState(ss, {
      preserveUserAborted: true,
      preserveAbortingStreamId: true,
    });
    broadcast({ type: "status", isStreaming: false, sessionPath, statusStreamId: abortedStreamId });
    scheduleContextUsagePush(sessionPath, { force: true });
    return true;
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

    if (ss?.abortingStreamId) {
      if (event.type === "turn_end") {
        finishSessionStream(ss);
        resetTurnState(ss);
        return;
      }
      return;
    }

    if (event.type === "sdk_message") {
      if (!ss) return;
      const compactedMessage = compactSdkMessage(event.message);
      if (!compactedMessage) return;
      if (compactedMessage.role === "assistant") {
        ss.structuredStream = true;
      }
      emitStreamEvent(sessionPath, ss, {
        type: "sdk_message",
        message: compactedMessage,
      });
    } else if (event.type === "assistant_snapshot") {
      if (!ss) return;
      scheduleContextUsagePush(sessionPath);
      ss.lastAssistantContent = event.content || null;
      ss.structuredStream = true;
      // 某些 provider 只发 assistant_snapshot，不发 text_delta。
      // 这里一旦快照中已有可见文本，就视为本轮已有输出，避免 turn_end 回填整段 text_delta
      // 与前面快照文本叠加，导致前端偶发“最终回复重复一遍”。
      const snapshotText = stripSdkDiagnosticLines(extractText(event.content)).trim();
      if (snapshotText) ss.hasOutput = true;
      const compacted = compactAssistantSnapshotContent(event.content || []);
      const nextSig = JSON.stringify(compacted);
      if (nextSig !== ss.lastAssistantSnapshotSig) {
        ss.lastAssistantSnapshotSig = nextSig;
        emitStreamEvent(sessionPath, ss, {
          type: "assistant_snapshot",
          content: compacted,
        });
      }
    } else if (event.type === "text_delta" || event.type === "thinking_start" || event.type === "thinking_delta" || event.type === "thinking_end") {
      if (!ss) return;
      scheduleContextUsagePush(sessionPath);
      if (ss.structuredStream) {
        if (event.type === "text_delta") {
          const chunk = stripSdkDiagnosticLines(typeof event.delta === "string" ? event.delta : "");
          if (!chunk || isSdkDiagnosticChunk(chunk)) return;
          if (ss.isThinking) {
            ss.isThinking = false;
            emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
          }
          emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: chunk });
          ss.hasOutput = true;
        } else if (event.type === "thinking_start") {
          if (!ss.isThinking) {
            ss.isThinking = true;
            ss.thinkingHadDelta = false;
            emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
          }
        } else if (event.type === "thinking_delta") {
          if (!ss.isThinking) {
            ss.isThinking = true;
            ss.thinkingHadDelta = false;
            emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
          }
          if (event.delta) ss.thinkingHadDelta = true;
          emitStreamEvent(sessionPath, ss, {
            type: "thinking_delta",
            delta: event.delta || "",
          });
        } else if (event.type === "thinking_end") {
          if (ss.isThinking) {
            ss.isThinking = false;
            emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
          }
        }
        return;
      }
      const feedTextChunk = (rawChunk) => {
        const chunk = stripSdkDiagnosticLines(typeof rawChunk === "string" ? rawChunk : "");
        if (!chunk) return false;
        if (isSdkDiagnosticChunk(chunk)) return false;
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

      if (event.type === "text_delta") {
        if (feedTextChunk(event.delta)) {
          ss.hasOutput = true;
        }
      } else if (event.type === "thinking_start") {
        if (!ss.isThinking) {
          ss.isThinking = true;
          ss.thinkingHadDelta = false;
          emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
        }
      } else if (event.type === "thinking_delta") {
        if (!ss.isThinking) {
          ss.isThinking = true;
          ss.thinkingHadDelta = false;
          emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
        }
        if (event.delta) ss.thinkingHadDelta = true;
        emitStreamEvent(sessionPath, ss, {
          type: "thinking_delta",
          delta: event.delta || "",
        });
      } else if (event.type === "thinking_end") {
        if (ss.isThinking) {
          ss.isThinking = false;
          emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        }
      }
    } else if (event.type === "tool_start") {
      if (!ss) return;
      scheduleContextUsagePush(sessionPath, { force: true });
      ss.hasToolCall = true;
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }
      // 只保留前端展示需要的字段；长文本会在 compactToolArgs 中裁剪
      const args = compactToolArgs(event.args);
      emitStreamEvent(sessionPath, ss, {
        type: "tool_start",
        name: event.name || "",
        toolCallId: event.toolCallId || null,
        args,
      });
    } else if (event.type === "tool_end") {
      if (!ss) return;
      scheduleContextUsagePush(sessionPath, { force: true });
      const details = event.details;
      const args = compactToolArgs(event.args);
      const resultText = extractToolResultText(event.content, details);
      emitStreamEvent(sessionPath, ss, {
        type: "tool_end",
        name: event.name || "",
        toolCallId: event.toolCallId || null,
        success: resolveToolEndSuccess(event),
        args,
        details,
        resultText,
      });

      if (event.name === "present_files") {
        const toolDetails = event.details || {};
        const files = toolDetails.files || [];
        if (files.length === 0 && toolDetails.filePath) {
          files.push({ filePath: toolDetails.filePath, label: toolDetails.label, ext: toolDetails.ext || "" });
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

      if (event.name === "create_artifact") {
        const d = event.details || {};
        emitStreamEvent(sessionPath, ss, {
          type: "artifact",
          artifactId: d.artifactId,
          artifactType: d.type,
          title: d.title,
          content: d.content,
          language: d.language,
        });
      }

      if (event.name === "browser") {
        const d = event.details || {};
        if (d.action === "screenshot" && event.content) {
          const imgBlock = event.content.find((c) => c?.type === "image");
          const payload = getImageBlockPayload(imgBlock, "image/jpeg");
          if (payload) {
            emitStreamEvent(sessionPath, ss, {
              type: "browser_screenshot",
              base64: payload.base64,
              mimeType: payload.mimeType || "image/jpeg",
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

      if (event.name === "generate_images" && event.content) {
        const imageBlocks = event.content.filter((c) => c?.type === "image");
        for (const imgBlock of imageBlocks) {
          const payload = getImageBlockPayload(imgBlock, "image/png");
          if (!payload) continue;
          emitStreamEvent(sessionPath, ss, {
            type: "browser_screenshot",
            base64: payload.base64,
            mimeType: payload.mimeType || "image/png",
          });
        }
      }

      if (event.name === "cron") {
        const d = event.details || {};
        if (d.action === "pending_add" && d.jobData) {
          emitStreamEvent(sessionPath, ss, { type: "cron_confirmation", jobData: d.jobData });
        }
      }

      const toolName = String(event.name || "").toLowerCase();
      const shouldRefreshDesk = isActive && (
        DESK_MUTATING_TOOL_NAMES.has(toolName)
        || hasFileOutputs(toolName, details)
      );
      if (shouldRefreshDesk) {
        broadcast({ type: "desk_changed" });
      }
      if (shouldBroadcastMcpChanged(event)) {
        broadcast({ type: "mcp_changed" });
      }
    } else if (event.type === "error") {
      if (ss) ss.hadError = true;
      const errorMessage = String(event.message || "Unknown error").trim();
      if (isActive && !shouldSuppressUserFacingErrorMessage(errorMessage)) {
        broadcast({ type: "error", message: errorMessage || "Unknown error" });
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
    } else if (event.type === "plan_mode_confirmation") {
      if (ss) {
        emitStreamEvent(sessionPath, ss, {
          type: "plan_mode_confirmation",
          confirmId: event.confirmId,
          phase: event.phase === "exit" ? "exit" : "enter",
          prompt: event.prompt || "",
          allowedPrompts: Array.isArray(event.allowedPrompts) ? event.allowedPrompts : [],
        });
      } else {
        broadcast({
          type: "plan_mode_confirmation",
          sessionPath: sessionPath || null,
          confirmId: event.confirmId,
          phase: event.phase === "exit" ? "exit" : "enter",
          prompt: event.prompt || "",
          allowedPrompts: Array.isArray(event.allowedPrompts) ? event.allowedPrompts : [],
        });
      }
    } else if (event.type === "ask_user_confirmation") {
      if (ss) {
        emitStreamEvent(sessionPath, ss, {
          type: "ask_user_confirmation",
          confirmId: event.confirmId,
          questions: Array.isArray(event.questions) ? event.questions : [],
        });
      } else {
        broadcast({
          type: "ask_user_confirmation",
          sessionPath: sessionPath || null,
          confirmId: event.confirmId,
          questions: Array.isArray(event.questions) ? event.questions : [],
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
      if (!ss.structuredStream) {
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
      }

      // 回填保护：某些 provider 可能在流事件里没有 text_delta，
      // 但最终 assistant 消息已写入 session（例如只给最终聚合文本）。
      // 这种情况下补发一次 text_delta，避免误报“模型未返回任何内容”。
      if (!ss.hasOutput) {
        // 仅回填“当前轮 assistant_snapshot”聚合内容，避免在 abort 场景下
        // 误把历史最后一条 assistant 文本再补发一遍。
        const finalText = stripSdkDiagnosticLines(
          extractText(ss.lastAssistantContent),
        ).trim();
        if (finalText) {
          ss.hasOutput = true;
          if (isActive) {
            emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: finalText });
          }
        }
      }

      // 空回复检测：本轮没有文本输出也没有工具调用，提示用户检查配置。
      // 若是用户主动点击停止（abort）或插话（steer）导致当前轮提前结束，不应误报。
      if (!ss.hasOutput && !ss.hasToolCall && isActive && !ss.userAborted && !ss.hadError) {
        broadcast({ type: "error", message: t("error.modelNoResponse") });
      }

      emitStreamEvent(sessionPath, ss, { type: "turn_end" });
      finishSessionStream(ss);
      scheduleContextUsagePush(sessionPath, { force: true });
      if (sessionPath) {
        engine.clearSessionPendingImages(sessionPath);
      }
      resetTurnState(ss);

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
        if (ss) finalizeAbortedTurn(abortPath, ss);
        if (engine.isSessionStreaming(abortPath)) {
          try { await hub.abort(abortPath); } catch {}
        }
        return;
      }

      if (msg.type === "steer" && msg.text) {
        debugLog()?.log("ws", `steer (${msg.text.length} chars)`);
        const steerPath = msg.sessionPath || engine.currentSessionPath;
        if (engine.isSessionStreaming(steerPath)) {
          const ss = steerPath ? getState(steerPath) : null;
          if (ss) {
            ss.userAborted = true;
            finalizeAbortedTurn(steerPath, ss);
          }
          try { await hub.abort(steerPath); } catch {}
          wsSend(ws, { type: "steered", sessionPath: steerPath || null });
        }
        // 插话作为新一轮 prompt 立即进入，避免旧轮思考/工具链在同一轮里被重新回放。
        msg.type = "prompt";
        msg.text = getSteerPromptText(msg.text);
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
        const usage = await refreshUsageBySessionPath(targetPath);
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
          const MAX_IMAGES = 10;
          const MAX_BYTES = 20 * 1024 * 1024; // 20MB base64 ≈ 15MB 原始
          if (msg.images.length > MAX_IMAGES) {
            wsSend(ws, { type: "error", message: t("error.maxImages", { max: MAX_IMAGES }) });
            return;
          }
          const normalizedImages = [];
          for (const img of msg.images) {
            const normalizedMime = normalizeChatImageMime(img?.mimeType || "");
            if (!normalizedMime || !CHAT_ALLOWED_IMAGE_MIME.has(normalizedMime)) {
              wsSend(ws, { type: "error", message: t("error.unsupportedImageFormat", { mime: img?.mimeType || normalizedMime || "unknown" }) });
              return;
            }
            const normalizedBase64 = String(img?.data || "").replace(/\s+/g, "");
            if (normalizedBase64 && normalizedBase64.length > MAX_BYTES) {
              wsSend(ws, { type: "error", message: t("error.imageTooLarge") });
              return;
            }
            normalizedImages.push({
              type: "image",
              data: normalizedBase64,
              mimeType: normalizedMime,
            });
          }
          msg.images = normalizedImages;
        }
        // 只发图片没文字时补一个占位文本，防止空 text 导致某些 API 异常
        let promptText = msg.text || "";
        if (!promptText.trim() && msg.images?.length) {
          promptText = t("error.viewImage");
        }
        const promptSessionPath = msg.sessionPath || engine.currentSessionPath;
        const requestedModelId = String(msg.modelId || "").trim();
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
        if (requestedModelId && promptSessionPath && promptSessionPath === engine.currentSessionPath) {
          try {
            await engine.setModel(requestedModelId);
            const modelRef = toModelRef(engine.currentModel) || requestedModelId;
            patchSessionMetadata(promptSessionPath, { model: modelRef });
          } catch (err) {
            wsSend(ws, { type: "error", message: err?.message || t("error.modelNotFound", { id: requestedModelId }) });
            return;
          }
        }
        const ss = getState(promptSessionPath);
        let timeoutTimer = null;
        let turnStreamId = null;
        try {
          ss.thinkTagParser.reset();
          ss.xingParser.reset();
          ss.userAborted = false;
          ss.abortingStreamId = null;
          ss.thinkingHadDelta = false;
          ss.hadError = false;
          ss.structuredStream = shouldUseStructuredStreamForSession(engine, promptSessionPath);
          ss.lastAssistantSnapshotSig = "";
          ss.lastAssistantContent = null;
          ss.titleRequested = false;
          turnStreamId = beginSessionStream(ss);
          broadcast({ type: "status", isStreaming: true, sessionPath: promptSessionPath, statusStreamId: turnStreamId });
          // 透传图片给主对话模型：支持原生多模态模型直接看图回复，
          // 同时仍保留 pendingImages 供 describe_images 工具按需使用。
          const sendPromise = hub.send(promptText, { sessionPath: promptSessionPath, images: msg.images });
          // 防止上游 provider/SDK 卡死导致前端一直“运行中”无反馈。
          sendPromise.catch(() => {});
          const timeoutPromise = new Promise((_, reject) => {
            timeoutTimer = setTimeout(async () => {
              debugLog()?.warn("ws", `turn timeout ${CHAT_TURN_TIMEOUT_MS}ms, abort session=${promptSessionPath || "unknown"}`);
              try {
                await hub.abort(promptSessionPath);
              } catch {}
              reject(createTurnTimeoutError(CHAT_TURN_TIMEOUT_MS));
            }, CHAT_TURN_TIMEOUT_MS);
          });
          await Promise.race([sendPromise, timeoutPromise]);
          broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath, statusStreamId: turnStreamId });
        } catch (err) {
          if (isTurnTimeoutError(err)) {
            ss.userAborted = true;
            finalizeAbortedTurn(promptSessionPath, ss);
          }
          const errorMessage = isTurnTimeoutError(err)
            ? getTurnTimeoutMessage(err?.timeoutMs || CHAT_TURN_TIMEOUT_MS)
            : String(err?.message || "").trim();
          if (!ss.hadError && !shouldSuppressUserFacingErrorMessage(errorMessage)) {
            wsSend(ws, { type: "error", message: errorMessage || t("error.modelNoResponse") });
          }
          broadcast({ type: "status", isStreaming: false, sessionPath: promptSessionPath, statusStreamId: turnStreamId });
        } finally {
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
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
