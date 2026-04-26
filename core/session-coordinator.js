/**
 * SessionCoordinator — Session 生命周期管理
 *
 * 负责 Hanako 本地 session metadata 与 Claude Agent SDK session runtime 的桥接。
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { renameSession } from "@anthropic-ai/claude-agent-sdk";
import { createModuleLogger } from "../lib/debug-log.js";
import { BrowserManager } from "../lib/browser/browser-manager.js";
import { sanitizeAssistantVisibleText } from "../lib/text/assistant-visible-text.js";
import { t, getLocale } from "../server/i18n.js";
import {
  createSessionMetadata,
  isClaudeSessionPath,
  listSessionMetadata,
  patchSessionMetadata,
  readSessionMetadata,
} from "./claude-session-store.js";
import { ClaudeSessionRuntime } from "./claude-session-runtime.js";
import { buildClaudeRuntimeConfig, CLAUDE_BUILTIN_TOOL_NAMES } from "./claude-runtime-config.js";
import { readSessionMessagesFromLog } from "./session-message-log.js";
import { normalizeWorkspacePath } from "./path-utils.js";
import { normalizeModelRef } from "./model-ref.js";

const log = createModuleLogger("session");
const EDE_DIAGNOSTIC_RE = /^\s*(?:⚠\s*)?\[ede_diagnostic\]/i;

export const PATROL_TOOLS_DEFAULT = [
  "search_memory", "pin_memory", "unpin_memory",
  "recall_experience", "record_experience",
  "cron", "notify",
  "present_files", "channel",
];

function getSteerPrefix() {
  const isZh = getLocale().startsWith("zh");
  return isZh ? "（插话）\n" : "(Interjection)\n";
}

function normalizeAnthropicBaseUrlForSdk(url = "") {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(v1\/)?messages$/i, "")
    .replace(/\/v1$/i, "");
}

function modelToRef(model) {
  if (!model || typeof model !== "object") return "";
  const id = String(model.id || "").trim();
  if (!id) return "";
  const provider = String(model.provider || "").trim();
  return provider ? `${provider}/${id}` : id;
}

function firstNonEmptyModelRef(...candidates) {
  for (const candidate of candidates) {
    const ref = normalizeModelRef(candidate);
    if (ref) return ref;
  }
  return "";
}

function extractAssistantTextFromSdkMessage(message) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function extractToolUsesFromAssistantContent(content = []) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === "tool_use" && block.id)
    .map((block) => ({
      id: block.id,
      name: block.name || "",
      args: block.input,
    }));
}

function resolveCustomToolName(rawName, customToolNames = new Set()) {
  const raw = String(rawName || "").trim();
  if (!raw) return "";
  const names = customToolNames instanceof Set
    ? [...customToolNames].map((name) => String(name || "").trim()).filter(Boolean)
    : [];
  if (!names.length) return raw;

  const direct = names.find((name) => name === raw);
  if (direct) return direct;

  const lowered = raw.toLowerCase();
  const directCaseInsensitive = names.find((name) => name.toLowerCase() === lowered);
  if (directCaseInsensitive) return directCaseInsensitive;

  const mcpMatch = raw.match(/^mcp__[A-Za-z0-9_-]+__(.+)$/i);
  const suffix = String(mcpMatch?.[1] || "").trim();
  if (!suffix) return raw;

  const serverMatch = raw.match(/^mcp__([A-Za-z0-9_-]+)__(.+)$/i);
  const serverName = String(serverMatch?.[1] || "").trim().toLowerCase();
  if (serverName) {
    const hasServerSwitch = names.some((name) => name.toLowerCase() === serverName);
    if (hasServerSwitch) return suffix;
  }

  const suffixDirect = names.find((name) => name === suffix);
  if (suffixDirect) return suffixDirect;

  const suffixLowered = suffix.toLowerCase();
  const suffixCaseInsensitive = names.find((name) => name.toLowerCase() === suffixLowered);
  if (suffixCaseInsensitive) return suffixCaseInsensitive;

  return raw;
}

function isCustomToolCall(rawName, resolvedToolName, customToolNames = new Set()) {
  const resolved = String(resolvedToolName || "").trim();
  if (resolved && customToolNames.has(resolved)) return true;

  const raw = String(rawName || "").trim();
  if (!raw) return false;
  const serverMatch = raw.match(/^mcp__([A-Za-z0-9_-]+)__(.+)$/i);
  const serverName = String(serverMatch?.[1] || "").trim().toLowerCase();
  if (!serverName) return false;
  const names = customToolNames instanceof Set
    ? [...customToolNames].map((name) => String(name || "").trim().toLowerCase()).filter(Boolean)
    : [];
  return names.includes(serverName);
}

function normalizeContentBlocks(content) {
  if (Array.isArray(content)) return content.filter(Boolean);
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return [{ type: "text", text: content.text }];
    if (typeof content.content === "string") return [{ type: "text", text: content.content }];
  }
  return [];
}

function tryParseJson(raw = "") {
  const text = String(raw || "").trim();
  if (!text || !/^[\[{]/.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractToolResultPayload(rawContent) {
  let content = normalizeContentBlocks(rawContent);
  let details;

  if (!content.length && typeof rawContent === "string") {
    const parsed = tryParseJson(rawContent);
    if (parsed && typeof parsed === "object") {
      if (parsed.details && typeof parsed.details === "object") {
        details = parsed.details;
      } else if (parsed.structuredContent?.details && typeof parsed.structuredContent.details === "object") {
        details = parsed.structuredContent.details;
      }
      if (parsed.content !== undefined) {
        content = normalizeContentBlocks(parsed.content);
      }
      if (!content.length && Array.isArray(parsed.content)) {
        content = parsed.content.filter(Boolean);
      }
      if (!content.length && typeof rawContent === "string") {
        content = [{ type: "text", text: rawContent }];
      }
    }
  }

  if (!content.length && rawContent && typeof rawContent === "object") {
    if (rawContent.details && typeof rawContent.details === "object") {
      details = rawContent.details;
    } else if (rawContent.structuredContent?.details && typeof rawContent.structuredContent.details === "object") {
      details = rawContent.structuredContent.details;
    }
    if (rawContent.content !== undefined) {
      content = normalizeContentBlocks(rawContent.content);
    }
  }

  return {
    content: content.length ? content : [{ type: "text", text: String(rawContent || "") }],
    details,
  };
}

function parseToolInputFromJsonDelta(rawInput = "") {
  const text = String(rawInput || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isEdeDiagnosticErrorMessage(message) {
  return EDE_DIAGNOSTIC_RE.test(String(message || "").trim());
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
  // 仅过滤 SDK telemetry 导出噪音，避免误伤真实业务错误。
  return (
    /\bstatus=\d{3}\b/i.test(text)
    || /\bERR_[A-Z_]+\b/i.test(text)
    || /request failed with status code \d{3}/i.test(text)
    || /\b(?:1p|first-party)\s+event\s+logging\b/i.test(text)
  );
}

function pickUserFacingRuntimeErrorMessage(rawMessage, fallback = "") {
  const text = String(rawMessage || "").trim();
  if (!text) return fallback;
  if (isEdeDiagnosticErrorMessage(text)) return "";
  if (isAbortLikeErrorMessage(text)) return "";
  if (isSdkTelemetryExportNoise(text)) return "";
  return text;
}

function pickUserFacingResultErrorMessage(event) {
  const errors = Array.isArray(event?.errors)
    ? event.errors.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (errors.length > 0) {
    const message = errors.find((item) =>
      !isEdeDiagnosticErrorMessage(item)
      && !isAbortLikeErrorMessage(item)
      && !isSdkTelemetryExportNoise(item)
    );
    return message || "";
  }
  const resultText = String(event?.result || "").trim();
  if (
    resultText
    && !isEdeDiagnosticErrorMessage(resultText)
    && !isAbortLikeErrorMessage(resultText)
    && !isSdkTelemetryExportNoise(resultText)
  ) {
    return resultText;
  }
  if (resultText && isAbortLikeErrorMessage(resultText)) return "";
  return "Claude execution failed";
}

function hasToolDetailsError(details) {
  if (!details || typeof details !== "object") return false;
  const error = details.error;
  if (typeof error === "string") return error.trim().length > 0;
  if (Array.isArray(error)) return error.some((item) => String(item || "").trim().length > 0);
  return false;
}

function resolveToolEndSuccess(event) {
  if (typeof event?.success === "boolean") return event.success;
  return !hasToolDetailsError(event?.details);
}

const MAX_CACHED_SESSIONS = 20;
const TEXT_TOOL_MARKUP_RE = /<(?:glob|read|write|edit|bash|grep|function_call|function_calls|minimax:tool_call)\b|<assistant\b[^>]*\bto=|\[TOOL_CALL\]|\bfunction_call\s*\n\s*\{|\btool_call(?:_start|_end)?\s*:/i;

function hasTextStyleToolMarkup(content = []) {
  if (!Array.isArray(content) || content.length === 0) return false;
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  if (!text) return false;
  return TEXT_TOOL_MARKUP_RE.test(text);
}

export class SessionCoordinator {
  constructor(deps) {
    this._d = deps;
    this._session = null;
    this._sessionStarted = false;
    this._sessions = new Map();
    this._headlessRefCount = 0;
    this._streamState = new Map();
  }

  get session() { return this._session; }
  get sessionStarted() { return this._sessionStarted; }
  get sessions() { return this._sessions; }

  get currentSessionPath() {
    return this._session?.sessionManager?.getSessionFile?.() ?? null;
  }

  _refreshSessionPrompt(agent) {
    if (!agent) return;
    agent.refreshSystemPrompt?.();
  }

  _buildSessionEnv(models, agentConfig, modelRef) {
    const resolved = models.resolveModelWithCredentials(modelRef, agentConfig);
    const cleanEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("ANTHROPIC_")) cleanEnv[key] = value;
    }
    const normalizedBaseUrl = normalizeAnthropicBaseUrlForSdk(resolved.base_url);
    return {
      model: resolved.model,
      env: {
        ...cleanEnv,
        ANTHROPIC_BASE_URL: normalizedBaseUrl || undefined,
        ANTHROPIC_API_KEY: resolved.api_key || undefined,
        ANTHROPIC_AUTH_TOKEN: resolved.auth_token || undefined,
      },
      resolved,
    };
  }

  _emitRuntimeEvent(event, sessionPath) {
    this._d.emitEvent(event, sessionPath);
  }

  _getStreamState(sessionPath, customToolNames = []) {
    if (!this._streamState.has(sessionPath)) {
      this._streamState.set(sessionPath, {
        blockTypes: new Map(),
        blockToolUseByIndex: new Map(),
        toolCalls: new Map(),
        turnSawStructuredToolUse: false,
        turnSawTextToolMarkup: false,
        lastTurnProtocolMismatch: false,
        customToolNames: new Set(customToolNames),
        availableToolNames: new Set([...CLAUDE_BUILTIN_TOOL_NAMES, ...customToolNames]),
      });
    }
    const state = this._streamState.get(sessionPath);
    state.customToolNames = new Set(customToolNames);
    state.availableToolNames = new Set([...CLAUDE_BUILTIN_TOOL_NAMES, ...customToolNames]);
    return state;
  }

  _translateClaudeEvent(event, sessionPath, customToolNames = []) {
    const state = this._getStreamState(sessionPath, customToolNames);
    const translated = [];

    if (event?.type === "stream_event") {
      const raw = event.event;
      if (raw?.type === "content_block_start") {
        const block = raw.content_block || null;
        if (block?.type) state.blockTypes.set(raw.index, block.type);
        if (block?.type === "thinking") {
          translated.push({ type: "thinking_start" });
          if (typeof block.thinking === "string" && block.thinking) {
            if (TEXT_TOOL_MARKUP_RE.test(block.thinking)) {
              state.turnSawTextToolMarkup = true;
            }
            translated.push({ type: "thinking_delta", delta: block.thinking });
          }
        } else if (block?.type === "tool_use" && block.id) {
          state.turnSawStructuredToolUse = true;
          const resolvedToolName = resolveCustomToolName(block.name || "", state.customToolNames);
          const isCustom = isCustomToolCall(block.name || "", resolvedToolName, state.customToolNames);
          if (Number.isInteger(raw.index)) {
            state.blockToolUseByIndex.set(raw.index, block.id);
          }
          state.toolCalls.set(block.id, {
            name: resolvedToolName,
            args: block.input,
            rawInput: typeof block.input === "object" ? JSON.stringify(block.input) : "",
            custom: isCustom,
          });
          translated.push({
            type: "tool_start",
            name: resolvedToolName,
            toolCallId: block.id,
            args: block.input,
          });
        } else if (block?.type === "text" && typeof block.text === "string" && block.text) {
          translated.push({ type: "text_delta", delta: block.text });
        }
      } else if (raw?.type === "content_block_delta") {
        if (raw?.delta?.type === "text_delta") {
          if (TEXT_TOOL_MARKUP_RE.test(raw.delta.text || "")) {
            state.turnSawTextToolMarkup = true;
          }
          translated.push({ type: "text_delta", delta: raw.delta.text || "" });
        } else if (raw?.delta?.type === "thinking_delta") {
          if (TEXT_TOOL_MARKUP_RE.test(raw.delta.thinking || "")) {
            state.turnSawTextToolMarkup = true;
          }
          translated.push({ type: "thinking_delta", delta: raw.delta.thinking || "" });
        } else if (raw?.delta?.type === "input_json_delta") {
          const toolUseId = state.blockToolUseByIndex.get(raw.index);
          const toolMeta = toolUseId ? state.toolCalls.get(toolUseId) : null;
          if (toolUseId && toolMeta) {
            const nextRawInput = `${toolMeta.rawInput || ""}${raw.delta.partial_json || ""}`;
            toolMeta.rawInput = nextRawInput;
            const parsed = parseToolInputFromJsonDelta(nextRawInput);
            if (parsed && typeof parsed === "object") {
              toolMeta.args = parsed;
              translated.push({
                type: "tool_start",
                name: toolMeta.name || "",
                toolCallId: toolUseId,
                args: toolMeta.args,
              });
            }
          }
        }
      } else if (raw?.type === "content_block_stop") {
        const blockType = state.blockTypes.get(raw.index);
        if (blockType === "thinking") {
          translated.push({ type: "thinking_end" });
        }
        if (blockType === "tool_use") {
          state.blockToolUseByIndex.delete(raw.index);
        }
        state.blockTypes.delete(raw.index);
      }
    } else if (event?.type === "assistant") {
      const content = event.message?.content || [];
      const assistantMessageId = String(event.message?.id || "").trim();
      const assistantUuid = String(event.uuid || "").trim();
      const sdkAssistantMessage = {
        role: "assistant",
        content: Array.isArray(content) ? content : [],
      };
      if (assistantMessageId) {
        sdkAssistantMessage.messageId = assistantMessageId;
      }
      if (assistantUuid) {
        sdkAssistantMessage.uuid = assistantUuid;
      }
      translated.push({
        type: "sdk_message",
        message: sdkAssistantMessage,
      });
      const structuredToolUses = extractToolUsesFromAssistantContent(content);
      if (structuredToolUses.length > 0) {
        state.turnSawStructuredToolUse = true;
      } else if (hasTextStyleToolMarkup(content)) {
        state.turnSawTextToolMarkup = true;
      }
      for (const toolUse of structuredToolUses) {
        const resolvedToolName = resolveCustomToolName(toolUse.name || "", state.customToolNames);
        const isCustom = isCustomToolCall(toolUse.name || "", resolvedToolName, state.customToolNames);
        if (state.toolCalls.has(toolUse.id)) {
          const prev = state.toolCalls.get(toolUse.id);
          const nextArgs = toolUse.args && typeof toolUse.args === "object" ? toolUse.args : prev?.args;
          state.toolCalls.set(toolUse.id, {
            ...prev,
            name: resolvedToolName || prev?.name || "",
            args: nextArgs,
            custom: isCustom || prev?.custom === true,
          });
          translated.push({
            type: "tool_start",
            name: resolvedToolName || prev?.name || "",
            toolCallId: toolUse.id,
            args: nextArgs,
          });
          continue;
        }
        state.toolCalls.set(toolUse.id, {
          name: resolvedToolName,
          args: toolUse.args,
          custom: isCustom,
        });
        translated.push({
          type: "tool_start",
          name: resolvedToolName,
          toolCallId: toolUse.id,
          args: toolUse.args,
        });
      }
      translated.push({ type: "assistant_snapshot", content });
    } else if (event?.type === "user") {
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      const toolResultContent = content.filter((block) => block?.type === "tool_result" && block.tool_use_id);
      if (toolResultContent.length) {
        const userMessageId = String(event.message?.id || "").trim();
        const userUuid = String(event.uuid || "").trim();
        const sdkUserMessage = {
          role: "user",
          content: toolResultContent,
        };
        if (userMessageId) {
          sdkUserMessage.messageId = userMessageId;
        }
        if (userUuid) {
          sdkUserMessage.uuid = userUuid;
        }
        translated.push({
          type: "sdk_message",
          message: sdkUserMessage,
        });
      }
      for (const block of content) {
        if (block?.type !== "tool_result" || !block.tool_use_id) continue;
        const toolUseId = block.tool_use_id;
        let matchedToolUseId = toolUseId;
        let toolMeta = state.toolCalls.get(toolUseId) || null;
        if (!toolMeta) {
          const pending = [...state.toolCalls.entries()]
            .reverse()
            .find(([, meta]) => !meta?.custom);
          if (pending) {
            matchedToolUseId = pending[0];
            toolMeta = pending[1];
          }
        }
        const resolvedToolMeta = toolMeta || {};
        // 自定义 MCP 工具由 onToolEnd 注入详细事件，避免重复落 tool_end。
        if (resolvedToolMeta.custom) continue;
        const payload = extractToolResultPayload(block.content);
        translated.push({
          type: "tool_end",
          name: resolvedToolMeta.name || "",
          toolCallId: matchedToolUseId || toolUseId,
          args: resolvedToolMeta.args,
          success: block.is_error !== true,
          content: payload.content,
          details: payload.details,
        });
        if (matchedToolUseId) {
          state.toolCalls.delete(matchedToolUseId);
        } else {
          state.toolCalls.delete(toolUseId);
        }
      }
    } else if (event?.type === "tool_use_summary") {
      for (const toolUseId of event.preceding_tool_use_ids || []) {
        const toolMeta = state.toolCalls.get(toolUseId);
        if (!toolMeta || toolMeta.custom) continue;
        translated.push({
          type: "tool_end",
          name: toolMeta.name || "",
          toolCallId: toolUseId,
          args: toolMeta.args,
          success: true,
          content: [{ type: "text", text: event.summary || "" }],
          details: { summary: event.summary || "" },
        });
        state.toolCalls.delete(toolUseId);
      }
    } else if (event?.type === "tool_start") {
      const alreadyOpen = [...state.toolCalls.values()].some((toolMeta) => (
        toolMeta.custom && toolMeta.name === event.name
      ));
      if (!alreadyOpen) {
        state.toolCalls.set(event.toolCallId, {
          name: event.name || "",
          args: event.args,
          custom: true,
        });
        translated.push({
          type: "tool_start",
          name: event.name || "",
          toolCallId: event.toolCallId,
          args: event.args,
        });
      }
    } else if (event?.type === "tool_end") {
      let matchedToolUseId = event.toolCallId;
      if (!state.toolCalls.has(matchedToolUseId)) {
        const pending = [...state.toolCalls.entries()]
          .reverse()
          .find(([, toolMeta]) => toolMeta.custom && toolMeta.name === event.name);
        matchedToolUseId = pending?.[0] || event.toolCallId || null;
      }
      const toolMeta = matchedToolUseId ? (state.toolCalls.get(matchedToolUseId) || {}) : {};
      translated.push({
        type: "tool_end",
        name: event.name || toolMeta.name || "",
        toolCallId: matchedToolUseId,
        args: event.args || toolMeta.args,
        success: resolveToolEndSuccess(event),
        content: event.content || [],
        details: event.details,
      });
      if (matchedToolUseId) state.toolCalls.delete(matchedToolUseId);
    } else if (event?.type === "plan_mode_confirmation") {
      translated.push({
        type: "plan_mode_confirmation",
        confirmId: event.confirmId || null,
        phase: event.phase === "exit" ? "exit" : "enter",
        prompt: typeof event.prompt === "string" ? event.prompt : "",
        allowedPrompts: Array.isArray(event.allowedPrompts) ? event.allowedPrompts : [],
      });
    } else if (event?.type === "ask_user_confirmation") {
      translated.push({
        type: "ask_user_confirmation",
        confirmId: event.confirmId || null,
        questions: Array.isArray(event.questions) ? event.questions : [],
      });
    } else if (event?.type === "compaction_start") {
      if (event.trigger === "auto") {
        translated.push({ type: "auto_compaction_start" });
      }
    } else if (event?.type === "compaction_end") {
      if (event.trigger === "auto") {
        translated.push({ type: "auto_compaction_end" });
      }
    } else if (event?.type === "result") {
      state.lastTurnProtocolMismatch = state.turnSawTextToolMarkup && !state.turnSawStructuredToolUse;
      if (event._hanakoManualCompaction) {
        state.turnSawStructuredToolUse = false;
        state.turnSawTextToolMarkup = false;
        return translated;
      }
      if (event.is_error) {
        const errorMessage = pickUserFacingResultErrorMessage(event);
        if (errorMessage) {
          translated.push({ type: "error", message: errorMessage });
        }
      }
      translated.push({ type: "turn_end" });
      state.blockTypes.clear();
      state.blockToolUseByIndex.clear();
      state.toolCalls.clear();
      state.turnSawStructuredToolUse = false;
      state.turnSawTextToolMarkup = false;
    } else if (event?.type === "runtime_error") {
      const errorMessage = pickUserFacingRuntimeErrorMessage(
        event.error?.message,
        "Claude runtime error",
      );
      if (errorMessage) {
        translated.push({ type: "error", message: errorMessage });
      }
      translated.push({ type: "turn_end" });
      state.blockTypes.clear();
      state.blockToolUseByIndex.clear();
      state.toolCalls.clear();
      state.turnSawStructuredToolUse = false;
      state.turnSawTextToolMarkup = false;
      state.lastTurnProtocolMismatch = false;
    }

    return translated;
  }

  async _createRuntime({
    agent,
    sessionPath,
    metadata,
    cwd,
    memoryEnabled,
    resumeExisting = true,
    builtinEnabledOverride = null,
    customEnabledOverride = null,
    systemAppend = "",
    noTools = false,
    noMemory = false,
  }) {
    const normalizedCwd = normalizeWorkspacePath(cwd, process.cwd());
    const models = this._d.getModels();
    const modelRef = firstNonEmptyModelRef(
      metadata?.model,
      agent?.config?.models?.chat,
      modelToRef(models.defaultModel),
      modelToRef(models.currentModel),
    );
    if (!modelRef) {
      throw new Error(t("error.noAvailableModel"));
    }
    const { model, env, resolved } = this._buildSessionEnv(models, agent?.config, modelRef);
    const resolvedModelRef = modelToRef(model) || modelRef;

    log.log(
      `[runtime-route] claude-sdk-runtime `
      + `provider=${resolved?.provider || "unknown"} api=${resolved?.api || "unknown"} `
      + `base=${resolved?.base_url || ""}`,
    );

    const agentId = path.basename(agent?.agentDir || "");
    const toolProfile = this._d.getAgentPermissionConfig?.(agentId)
      || agent?._engine?.getAgentPermissionConfig?.(agentId)
      || null;
    if (!toolProfile && !noTools && !builtinEnabledOverride && !customEnabledOverride) {
      log.warn(
        `[runtime-tools] missing permission profile for agent=${agentId || "unknown"}; `
        + "custom tools may be unavailable",
      );
    }
    let runtime = null;
    const runtimeConfig = buildClaudeRuntimeConfig({
      agent,
      cwd: normalizedCwd,
      workspace: normalizeWorkspacePath(
        agent?.config?.desk?.home_folder || this._d.getHomeCwd(),
        normalizedCwd,
      ),
      toolProfile,
      customTools: agent?.tools || [],
      builtinEnabledOverride,
      customEnabledOverride,
      noTools,
      noMemory,
      systemAppend,
      model,
      env,
      confirmStore: this._d.getConfirmStore?.() || null,
      sessionPath,
      createToolContext: () => ({
        sessionManager: runtime?.sessionManager,
      }),
      emitToolEvent: (event) => {
        runtime?._recordToolEvent?.(event);
        runtime?._emit?.(event);
      },
    });
    const runtimeTools = runtimeConfig?.diagnostics || {};
    log.log(
      `[runtime-tools] settings=${JSON.stringify(runtimeTools.settingSources || [])} `
      + `allowedTools=${JSON.stringify(runtimeTools.allowedTools || runtimeTools.builtinEnabled || [])} `
      + `builtinEnabled=${JSON.stringify(runtimeTools.builtinEnabled || [])} `
      + `forcedToolsOption=${runtimeTools.forcedToolsOption === true} `
      + `permissionStrategy=${runtimeTools.permissionStrategy || "unknown"} `
      + `canUseTool=${runtimeTools.hasCanUseTool === true} `
      + `customLoaded=${JSON.stringify(runtimeTools.customToolsLoaded || [])}`,
    );

    runtime = new ClaudeSessionRuntime({
      sessionId: metadata?.sessionId || randomUUID(),
      resumeSessionId: resumeExisting ? (metadata?.sessionId || null) : null,
      cwd: normalizedCwd,
      sessionPath,
      options: runtimeConfig.options,
      initialContextUsage: metadata?.contextUsage || null,
    });
    runtime.model = model;
    if (sessionPath && resolvedModelRef && resolvedModelRef !== metadata?.model) {
      try {
        patchSessionMetadata(sessionPath, { model: resolvedModelRef });
      } catch {
        // ignore metadata patch failures
      }
    }
    return runtime;
  }

  _bindRuntime(sessionPath, session, agentId, memoryEnabled) {
    // 显式打标：当前 runtime 统一输出结构化流事件，前端可跳过 legacy 标签解析链。
    session.hanakoStructuredStream = true;
    session.hanakoRuntimeSource = "claude-sdk-runtime";
    const customToolNames = (
      this._d.getAgentById(agentId)?.tools
      || this._d.getAgent()?.tools
      || []
    ).map((tool) => tool?.name).filter(Boolean);
    const unsub = session.subscribe((event) => {
      if (event?.type === "sdk_init") {
        const mcpServers = Array.isArray(event.mcpServers) ? event.mcpServers : [];
        const mcpStatuses = mcpServers.map((item) => ({
          name: String(item?.name || ""),
          status: String(item?.status || ""),
        }));
        const mcpTools = (Array.isArray(event.tools) ? event.tools : [])
          .map((name) => String(name || ""))
          .filter((name) => name.startsWith("mcp__"));
        log.log(
          `[sdk-init] session=${path.basename(sessionPath || "")} `
          + `mcpServers=${JSON.stringify(mcpStatuses)} `
          + `mcpTools=${JSON.stringify(mcpTools)}`,
        );
      }
      for (const translatedEvent of this._translateClaudeEvent(event, sessionPath, customToolNames)) {
        this._emitRuntimeEvent(translatedEvent, sessionPath);
      }
    });
    const old = this._sessions.get(sessionPath);
    old?.unsub?.();
    this._sessions.set(sessionPath, {
      session,
      agentId,
      memoryEnabled,
      lastTouchedAt: Date.now(),
      unsub,
    });
    if (this._sessions.size > MAX_CACHED_SESSIONS) {
      const candidates = [...this._sessions.entries()]
        .filter(([key, e]) => key !== sessionPath && !e.session.isStreaming)
        .sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt);
      for (const [key, entry] of candidates) {
        entry.unsub?.();
        entry.session?.close?.();
        this._sessions.delete(key);
        if (this._sessions.size <= MAX_CACHED_SESSIONS) break;
      }
    }
  }

  async createSession(_sessionMgr = null, cwd, memoryEnabled = true) {
    const t0 = Date.now();
    const effectiveCwd = cwd || this._d.getHomeCwd() || process.cwd();
    const agent = this._d.getAgent();
    const sessionDir = agent.sessionDir;
    fs.mkdirSync(sessionDir, { recursive: true });
    agent.setMemoryEnabled(memoryEnabled);
    this._refreshSessionPrompt(agent);

    const models = this._d.getModels();
    const initialModelRef = firstNonEmptyModelRef(
      modelToRef(models.currentModel),
      modelToRef(models.defaultModel),
      agent?.config?.models?.chat,
    );

    const { sessionPath, metadata } = createSessionMetadata(sessionDir, {
      sessionId: randomUUID(),
      cwd: effectiveCwd,
      model: initialModelRef || null,
      agentId: this._d.getActiveAgentId(),
      memoryEnabled,
    });
    const runtime = await this._createRuntime({
      agent,
      sessionPath,
      metadata,
      cwd: effectiveCwd,
      memoryEnabled,
      resumeExisting: false,
    });

    this._session = runtime;
    this._sessionStarted = false;
    this._bindRuntime(sessionPath, runtime, this._d.getActiveAgentId(), memoryEnabled);
    log.log(`session created (${Date.now() - t0}ms), model=${runtime.options?.model || "?"}`);
    return runtime;
  }

  _readSessionMemoryEnabled(sessionPath, agent = this._d.getAgent()) {
    try {
      return readSessionMetadata(sessionPath)?.memoryEnabled !== false;
    } catch {
      return agent?.memoryEnabled !== false;
    }
  }

  async refreshCurrentSessionTools() {
    const sessionPath = this.currentSessionPath;
    if (!sessionPath) return { reloaded: false, reason: "no-active-session" };
    const currentEntry = this._sessions.get(sessionPath);
    const currentSession = currentEntry?.session || this._session;
    if (!currentSession) return { reloaded: false, reason: "session-not-cached" };
    if (currentSession.isStreaming) return { reloaded: false, reason: "streaming" };

    const targetAgentId = this._d.agentIdFromSessionPath(sessionPath);
    if (targetAgentId && targetAgentId !== this._d.getActiveAgentId()) {
      await this._d.switchAgentOnly(targetAgentId);
      this._d.getSkills()?.syncAgentSkills?.(this._d.getAgent());
    }
    const agent = this._d.getAgentById(targetAgentId) || this._d.getAgent();
    let metadata = readSessionMetadata(sessionPath);
    const liveModelRef = modelToRef(currentSession?.model);
    // 刷新 runtime 时以“当前会话正在使用的模型”为准，避免回退到 metadata 旧值。
    if (liveModelRef && liveModelRef !== metadata?.model) {
      metadata = { ...metadata, model: liveModelRef };
      try {
        patchSessionMetadata(sessionPath, { model: liveModelRef });
      } catch {
        // ignore metadata patch failure
      }
    }
    const memoryEnabled = metadata?.memoryEnabled !== false;
    const wasStarted = this._sessionStarted;
    const runtime = await this._createRuntime({
      agent,
      sessionPath,
      metadata,
      cwd: metadata.cwd,
      memoryEnabled,
      resumeExisting: true,
    });
    this._session = runtime;
    this._sessionStarted = wasStarted;
    this._bindRuntime(sessionPath, runtime, targetAgentId || this._d.getActiveAgentId(), memoryEnabled);
    return { reloaded: true, sessionPath };
  }

  async switchSession(sessionPath) {
    if (!isClaudeSessionPath(sessionPath)) {
      throw new Error(`unsupported session path: ${sessionPath}`);
    }
    const targetAgentId = this._d.agentIdFromSessionPath(sessionPath);
    if (targetAgentId && targetAgentId !== this._d.getActiveAgentId()) {
      await this._d.switchAgentOnly(targetAgentId);
      this._d.getSkills()?.syncAgentSkills?.(this._d.getAgent());
    }

    const memoryEnabled = this._readSessionMemoryEnabled(sessionPath, this._d.getAgent());
    const existing = this._sessions.get(sessionPath);
    if (existing) {
      if (this._session && this._session !== existing.session) {
        const oldSp = this._session.sessionManager?.getSessionFile?.();
        if (oldSp) {
          const oldEntry = this._sessions.get(oldSp);
          const oldAgent = oldEntry ? this._d.getAgentById(oldEntry.agentId) : this._d.getAgent();
          await oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch(() => {});
        }
      }
      this._session = existing.session;
      existing.lastTouchedAt = Date.now();
      const targetAgent = this._d.getAgentById(existing.agentId) || this._d.getAgent();
      targetAgent.setMemoryEnabled(memoryEnabled);
      this._refreshSessionPrompt(targetAgent);
      return existing.session;
    }

    if (this._session) {
      const oldSp = this._session.sessionManager?.getSessionFile?.();
      if (oldSp) {
        const oldEntry = this._sessions.get(oldSp);
        const oldAgent = oldEntry ? this._d.getAgentById(oldEntry.agentId) : this._d.getAgent();
        await oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch(() => {});
      }
    }

    const metadata = readSessionMetadata(sessionPath);
    const agent = this._d.getAgentById(targetAgentId) || this._d.getAgent();
    const runtime = await this._createRuntime({
      agent,
      sessionPath,
      metadata,
      cwd: metadata.cwd,
      memoryEnabled,
      resumeExisting: true,
    });
    this._session = runtime;
    this._sessionStarted = false;
    this._bindRuntime(sessionPath, runtime, targetAgentId || this._d.getActiveAgentId(), memoryEnabled);
    return runtime;
  }

  async prompt(text, opts) {
    if (!this._session) throw new Error(t("error.noActiveSessionPrompt"));
    this._sessionStarted = true;
    const sp = this._session.sessionManager?.getSessionFile?.();
    let promptAgent = this._d.getAgent();
    if (sp) {
      const entry = this._sessions.get(sp);
      if (entry) entry.lastTouchedAt = Date.now();
      promptAgent = entry ? (this._d.getAgentById(entry.agentId) || promptAgent) : promptAgent;
    }
    this._refreshSessionPrompt(promptAgent);
    const promptOpts = opts?.images?.length ? { images: opts.images } : undefined;
    await this._session.prompt(text, promptOpts);
    const streamState = sp ? this._streamState.get(sp) : null;
    if (streamState?.lastTurnProtocolMismatch) {
      streamState.lastTurnProtocolMismatch = false;
      log.warn(
        "[tool-protocol] detected text-style tool markup without structured tool_use; "
        + "keeping current session without auto-replay (Proma-aligned behavior)",
      );
    }
    if (sp) {
      const entry = this._sessions.get(sp);
      const agent = entry ? this._d.getAgentById(entry.agentId) : this._d.getAgent();
      agent?._memoryTicker?.notifyTurn(sp);
    }
  }

  async abort() {
    if (this._session?.isStreaming) {
      await this._session.abort();
    }
  }

  steer(text) {
    if (!this._session?.isStreaming) return false;
    const sp = this._session.sessionManager?.getSessionFile?.();
    if (sp) {
      const entry = this._sessions.get(sp);
      if (entry) entry.lastTouchedAt = Date.now();
    }
    return this._session.steer(getSteerPrefix() + text);
  }

  async promptSession(sessionPath, text, opts) {
    const entry = this._sessions.get(sessionPath);
    if (!entry) throw new Error(t("error.sessionNotInCache", { path: sessionPath }));
    entry.lastTouchedAt = Date.now();
    if (sessionPath === this.currentSessionPath) this._sessionStarted = true;
    const promptAgent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
    this._refreshSessionPrompt(promptAgent);
    const promptOpts = opts?.images?.length ? { images: opts.images } : undefined;
    await entry.session.prompt(text, promptOpts);
    const streamState = this._streamState.get(sessionPath);
    if (streamState?.lastTurnProtocolMismatch) {
      streamState.lastTurnProtocolMismatch = false;
      log.warn(
        "[tool-protocol] detected text-style tool markup without structured tool_use; "
        + "keeping current session without auto-replay (Proma-aligned behavior)",
      );
    }
    promptAgent?._memoryTicker?.notifyTurn(sessionPath);
  }

  steerSession(sessionPath, text) {
    const entry = this._sessions.get(sessionPath);
    if (!entry?.session.isStreaming) return false;
    entry.lastTouchedAt = Date.now();
    return entry.session.steer(getSteerPrefix() + text);
  }

  async abortSession(sessionPath) {
    const entry = this._sessions.get(sessionPath);
    if (!entry?.session.isStreaming) return false;
    await entry.session.abort();
    return true;
  }

  async abortAllStreaming() {
    const tasks = [];
    for (const [, entry] of this._sessions) {
      if (entry.session.isStreaming) {
        tasks.push(entry.session.abort().catch(() => {}));
      }
    }
    await Promise.all(tasks);
    return tasks.length;
  }

  async closeSession(sessionPath) {
    const entry = this._sessions.get(sessionPath);
    if (entry) {
      if (entry.session.isStreaming) {
        try { await entry.session.abort(); } catch {}
      }
      entry.unsub?.();
      await entry.session.close?.();
      this._sessions.delete(sessionPath);
    }
    if (sessionPath === this.currentSessionPath) {
      this._session = null;
    }
    this._streamState.delete(sessionPath);
  }

  async closeAllSessions() {
    for (const [sp, entry] of this._sessions) {
      const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
      agent?._memoryTicker?.notifySessionEnd(sp).catch(() => {});
      if (entry.session.isStreaming) {
        try { await entry.session.abort(); } catch {}
      }
      entry.unsub?.();
      await entry.session.close?.();
    }
    this._sessions.clear();
    this._session = null;
    this._streamState.clear();
  }

  async cleanupSession() {
    await this.closeAllSessions();
    log.log("sessions cleaned up");
  }

  getSessionByPath(sessionPath) {
    return this._sessions.get(sessionPath)?.session ?? null;
  }

  isSessionStreaming(sessionPath) {
    return !!this.getSessionByPath(sessionPath)?.isStreaming;
  }

  async abortSessionByPath(sessionPath) {
    const session = this.getSessionByPath(sessionPath);
    if (!session?.isStreaming) return false;
    await session.abort();
    return true;
  }

  async listSessions() {
    const allSessions = [];
    const agents = this._d.listAgents();
    for (const agent of agents) {
      const sessionDir = path.join(this._d.agentsDir, agent.id, "sessions");
      if (!fs.existsSync(sessionDir)) continue;
      const listed = listSessionMetadata(sessionDir, {
        includeArchived: false,
        directOnly: true,
      });
      for (const item of listed) {
        const meta = item.metadata;
        let historyMessages = [];
        try {
          historyMessages = readSessionMessagesFromLog(item.sessionPath, { limit: 200 });
        } catch {
          historyMessages = [];
        }
        const firstUser = historyMessages.find((message) => message?.role === "user");
        const firstMessage = firstUser
          ? extractAssistantTextFromSdkMessage({
            message: {
              content: Array.isArray(firstUser?.content)
                ? firstUser.content
                : [{ type: "text", text: String(firstUser?.content || "") }],
            },
          })
          : "";
        const messageCount = historyMessages.filter((message) =>
          message?.role === "user" || message?.role === "assistant"
        ).length;
        allSessions.push({
          path: item.sessionPath,
          title: meta.title || null,
          firstMessage: firstMessage || "",
          modified: new Date(meta.updatedAt || meta.createdAt || Date.now()),
          messageCount,
          cwd: meta.cwd || null,
          agentId: agent.id,
          agentName: agent.name,
        });
      }
    }

    const currentPath = this.currentSessionPath;
    const activeAgentId = this._d.getActiveAgentId();
    if (currentPath && this._sessionStarted && !allSessions.find((s) => s.path === currentPath)) {
      allSessions.unshift({
        path: currentPath,
        title: null,
        firstMessage: "",
        modified: new Date(),
        messageCount: 0,
        cwd: this._session?.sessionManager?.getCwd?.() || "",
        agentId: activeAgentId,
        agentName: this._d.getAgent().agentName,
      });
    }

    allSessions.sort((a, b) => b.modified - a.modified);
    return allSessions;
  }

  async saveSessionTitle(sessionPath, title) {
    const metadata = patchSessionMetadata(sessionPath, { title });
    try {
      await renameSession(metadata.sessionId, title || "", { dir: metadata.cwd });
    } catch {
      // local metadata is source of truth for Hanako UI
    }
  }

  createSessionContext() {
    const models = this._d.getModels();
    const skills = this._d.getSkills();
    return {
      authStorage: models.authStorage,
      modelRegistry: models.modelRegistry,
      resourceLoader: this._d.getResourceLoader(),
      allSkills: skills.allSkills,
      getSkillsForAgent: (ag) => skills.getSkillsForAgent(ag),
      buildTools: (cwd, customTools, opts) => this._d.buildTools(cwd, customTools, opts),
      resolveModel: (agentConfig) => {
        let id = agentConfig?.models?.chat;
        if (!id) {
          if (models.defaultModel) return models.defaultModel;
          throw new Error(t("error.resolveModelNoChatModel"));
        }
        const found = models.availableModels.find((m) => m.id === id);
        if (!found) {
          if (models.defaultModel) return models.defaultModel;
          throw new Error(t("error.resolveModelNotAvailable", { id }));
        }
        return found;
      },
    };
  }

  promoteActivitySession(activitySessionFile) {
    const agent = this._d.getAgent();
    const oldPath = path.join(agent.agentDir, "activity", activitySessionFile);
    if (!fs.existsSync(oldPath)) return null;
    const newPath = path.join(agent.sessionDir, activitySessionFile);
    try {
      fs.renameSync(oldPath, newPath);
      agent._memoryTicker?.notifyPromoted(newPath);
      log.log(`promoted activity session: ${activitySessionFile}`);
      return newPath;
    } catch (err) {
      log.error(`promoteActivitySession failed: ${err.message}`);
      return null;
    }
  }

  async executeIsolated(prompt, opts = {}) {
    const targetAgent = opts.agentId ? this._d.getAgentById(opts.agentId) : this._d.getAgent();
    if (!targetAgent) throw new Error(t("error.agentNotInitialized", { id: opts.agentId }));
    if (opts.signal?.aborted) {
      return { sessionPath: null, replyText: "", error: "aborted" };
    }

    const bm = BrowserManager.instance();
    const wasBrowserRunning = bm.isRunning;
    this._headlessRefCount++;
    if (this._headlessRefCount === 1) bm.setHeadless(true);

    let sessionPath = null;
    let runtime = null;
    try {
      const sessionDir = opts.persist || targetAgent.sessionDir;
      fs.mkdirSync(sessionDir, { recursive: true });
      const execCwd = opts.cwd || targetAgent?.config?.desk?.home_folder || this._d.getHomeCwd() || process.cwd();
      const patrolAllowed = opts.toolFilter || targetAgent.config?.desk?.patrol_tools || PATROL_TOOLS_DEFAULT;
      const builtinOverride = opts.builtinFilter
        ? opts.builtinFilter
        : CLAUDE_BUILTIN_TOOL_NAMES;
      const customOverride = patrolAllowed;
      const { sessionPath: createdPath, metadata } = createSessionMetadata(sessionDir, {
        sessionId: randomUUID(),
        cwd: execCwd,
        agentId: path.basename(targetAgent.agentDir),
        memoryEnabled: true,
      });
      sessionPath = createdPath;

      runtime = await this._createRuntime({
        agent: targetAgent,
        sessionPath,
        metadata,
        cwd: execCwd,
        memoryEnabled: true,
        resumeExisting: false,
        builtinEnabledOverride: builtinOverride,
        customEnabledOverride: customOverride,
      });

      let replyText = "";
      const unsub = runtime.subscribe((event) => {
        if (event?.type === "stream_event") {
          const raw = event.event;
          if (raw?.type === "content_block_delta" && raw?.delta?.type === "text_delta") {
            replyText += raw.delta.text || "";
          }
        } else if (event?.type === "assistant") {
          const finalText = extractAssistantTextFromSdkMessage(event);
          if (finalText) replyText = finalText;
        } else if (event?.type === "result" && typeof event.result === "string" && event.result.trim()) {
          replyText = event.result.trim();
        }
      });

      const abortHandler = () => runtime.abort();
      opts.signal?.addEventListener("abort", abortHandler, { once: true });
      if (opts.signal?.aborted) {
        opts.signal.removeEventListener("abort", abortHandler);
        unsub?.();
        try { await runtime.close(); } catch {}
        if (!opts.persist && sessionPath) {
          try { fs.unlinkSync(sessionPath); } catch {}
        }
        return { sessionPath: null, replyText: "", error: "aborted" };
      }

      try {
        await runtime.prompt(prompt);
      } finally {
        opts.signal?.removeEventListener("abort", abortHandler);
        unsub?.();
      }

      replyText = sanitizeAssistantVisibleText(replyText);
      if (!opts.persist && sessionPath) {
        try { fs.unlinkSync(sessionPath); } catch {}
        return { sessionPath: null, replyText, error: null };
      }
      return { sessionPath, replyText, error: null };
    } catch (err) {
      log.error(`isolated execution failed: ${err.message}`);
      if (!opts.persist && sessionPath) {
        try { fs.unlinkSync(sessionPath); } catch {}
      }
      return { sessionPath: null, replyText: "", error: err.message };
    } finally {
      if (runtime) {
        try { await runtime.close(); } catch {}
      }
      this._headlessRefCount = Math.max(0, this._headlessRefCount - 1);
      if (this._headlessRefCount === 0) bm.setHeadless(false);
      const browserNowRunning = bm.isRunning;
      if (browserNowRunning !== wasBrowserRunning) {
        this._d.emitEvent({ type: "browser_bg_status", running: browserNowRunning, url: bm.currentUrl }, null);
      }
    }
  }
}
