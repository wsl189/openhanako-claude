import { randomUUID } from "crypto";
import { extractTextFromContent } from "./claude-transcript.js";
import {
  appendSessionContextReset,
  appendSessionMessageLog,
  readSessionMessagesFromLog,
} from "./session-message-log.js";
import { patchSessionMetadata } from "./claude-session-store.js";
import { createProviderAdapter, streamSSE } from "./provider-adapters.js";
import { extractTextToolCalls } from "./provider-tool-call-fallback.js";
import { stripRawToolCallMarkup } from "../lib/text/assistant-visible-text.js";

const PROVIDER_STREAM_MAX_RETRIES = 2;
const PROVIDER_STREAM_BASE_DELAY_MS = 800;
const PROVIDER_STREAM_MAX_DELAY_MS = 4000;
const PROVIDER_OVERLOAD_MAX_RETRIES = 4;
const PROVIDER_OVERLOAD_BASE_DELAY_MS = 1500;
const PROVIDER_OVERLOAD_MAX_DELAY_MS = 12000;
const PROVIDER_CONTEXT_WINDOW_FALLBACK = 128_000;
const PROVIDER_COMPACT_MIN_MESSAGES = 10;
const PROVIDER_COMPACT_KEEP_MESSAGES = 24;
const PROVIDER_COMPACT_SUMMARY_MARKER = "[[hanako:provider-compacted]]";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nowIso() {
  return new Date().toISOString();
}

function buildUserContent(text = "", images = []) {
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const image of images || []) {
    if (!image?.data || !image?.mimeType) continue;
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mimeType,
        data: image.data,
      },
    });
  }
  return content.length ? content : [{ type: "text", text: "" }];
}

function normalizeToolResultContent(content) {
  if (Array.isArray(content)) return content.filter(Boolean);
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return [{ type: "text", text: content.text }];
    if (typeof content.content === "string") return [{ type: "text", text: content.content }];
  }
  return [{ type: "text", text: String(content || "") }];
}

function toolContentToText(content) {
  return normalizeToolResultContent(content)
    .map((item) => {
      if (typeof item?.text === "string") return item.text;
      if (typeof item?.content === "string") return item.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function buildAssistantBlocks({ thinking = "", text = "" } = {}) {
  const blocks = [];
  if (thinking) {
    blocks.push({ type: "thinking", thinking });
  }
  if (text) {
    blocks.push({ type: "text", text });
  }
  return blocks;
}

function buildFallbackReplyFromToolResults(toolOutputs = []) {
  if (!Array.isArray(toolOutputs) || toolOutputs.length === 0) return "";
  const successful = toolOutputs.filter((item) => item && item.isError !== true);
  const source = successful.length ? successful : toolOutputs;
  const chosen = source
    .slice()
    .reverse()
    .find((item) => typeof item?.text === "string" && item.text.trim());
  if (!chosen) {
    return "工具已执行完成，但模型未返回最终说明。请查看上方工具结果。";
  }
  const payload = chosen.text.trim();
  return payload.length > 4000 ? `${payload.slice(0, 4000)}\n...(输出已截断)` : payload;
}

function isAbortError(error, signal = null) {
  if (signal?.aborted) return true;
  if (!error) return false;
  if (error.name === "AbortError") return true;
  return /abort/i.test(String(error.message || error));
}

function getRetryableStatus(error) {
  return error?.response?.status || error?.status || error?.statusCode || null;
}

function isRetryableProviderError(error, signal = null) {
  if (isAbortError(error, signal)) return false;
  const status = getRetryableStatus(error);
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;

  const codes = new Set(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]);
  if (codes.has(error?.code) || codes.has(error?.cause?.code)) return true;

  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("fetch failed")
    || message.includes("network error")
    || message.includes("connection reset")
    || message.includes("timed out")
    || message.includes("socket hang up")
  );
}

function getProviderRetryPolicy(error) {
  const status = getRetryableStatus(error);
  if (status === 429 || status === 529) {
    return {
      maxRetries: PROVIDER_OVERLOAD_MAX_RETRIES,
      baseDelayMs: PROVIDER_OVERLOAD_BASE_DELAY_MS,
      maxDelayMs: PROVIDER_OVERLOAD_MAX_DELAY_MS,
    };
  }
  return {
    maxRetries: PROVIDER_STREAM_MAX_RETRIES,
    baseDelayMs: PROVIDER_STREAM_BASE_DELAY_MS,
    maxDelayMs: PROVIDER_STREAM_MAX_DELAY_MS,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeRuntimeText(acc = "", next = "") {
  const a = String(acc || "");
  const b = String(next || "");
  if (!b) return a;
  if (!a) return b;
  if (b.startsWith(a)) return b;
  if (a.endsWith(b)) return a;
  const max = Math.min(a.length, b.length);
  for (let k = max; k > 0; k -= 1) {
    if (a.slice(-k) === b.slice(0, k)) {
      return a + b.slice(k);
    }
  }
  return a + b;
}

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function messageToPlainText(message) {
  if (!message || typeof message !== "object") return "";
  const role = String(message.role || "").trim();
  if (role === "user" || role === "assistant" || role === "system") {
    return extractTextFromContent(message.content || "");
  }
  if (role === "tool") {
    const toolName = message.toolName ? `[${message.toolName}] ` : "";
    const args = message.args && typeof message.args === "object"
      ? JSON.stringify(message.args)
      : "";
    const content = toolContentToText(message.content || "");
    return `${toolName}${args} ${content}`.trim();
  }
  return extractTextFromContent(message.content || "");
}

function estimateTokensFromMessages(messages = []) {
  let chars = 0;
  for (const message of messages || []) {
    const role = String(message?.role || "");
    const body = messageToPlainText(message);
    chars += role.length + body.length + 12;
  }
  return Math.max(1, Math.round(chars / 4));
}

function compactLine(text = "", limit = 220) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function buildCompactedSummary(messages = []) {
  const rows = [];
  let budget = 4800;
  for (const message of messages) {
    const role = String(message?.role || "").toLowerCase();
    if (role !== "user" && role !== "assistant" && role !== "tool") continue;
    const raw = compactLine(messageToPlainText(message));
    if (!raw) continue;
    const tag = role === "user" ? "User"
      : role === "assistant" ? "Assistant"
        : `Tool(${String(message?.toolName || "unknown")})`;
    const line = `${tag}: ${raw}`;
    if (line.length + 1 > budget) break;
    rows.push(line);
    budget -= line.length + 1;
  }
  if (rows.length === 0) return "";
  return [
    PROVIDER_COMPACT_SUMMARY_MARKER,
    "Compacted conversation summary (earlier turns):",
    ...rows,
  ].join("\n");
}

export class ProviderSessionRuntime {
  constructor({
    sessionId = null,
    cwd,
    sessionPath,
    resolvedModel,
    systemPrompt = "",
    tools = [],
    thinking = "medium",
    fetchFn = fetch,
  }) {
    this.sessionId = sessionId || randomUUID();
    this.cwd = cwd;
    this.sessionPath = sessionPath;
    this.resolvedModel = resolvedModel;
    this.systemPrompt = systemPrompt;
    this.tools = tools;
    this.thinking = thinking;
    this.fetchFn = fetchFn;
    this.messages = readSessionMessagesFromLog(sessionPath);
    this.isStreaming = false;
    this.isCompacting = false;
    this.eventProtocol = "hanako";
    this._subscribers = new Set();
    this._pendingTurn = null;
    this._abortController = null;
    this._lastContextUsage = null;
    this.refreshContextUsage();
    this.sessionManager = {
      getSessionId: () => this.sessionId,
      getSessionFile: () => this.sessionPath,
      getCwd: () => this.cwd,
      getMessages: () => this.messages,
    };
  }

  async start() {
    return this;
  }

  subscribe(callback) {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  _emit(event) {
    for (const callback of this._subscribers) {
      try {
        callback(event);
      } catch {
        // ignore
      }
    }
  }

  _appendMessage(message, timestamp = nowIso()) {
    this.messages.push(message);
    appendSessionMessageLog(this.sessionPath, message, timestamp);
    this.refreshContextUsage();
    try {
      patchSessionMetadata(this.sessionPath, {});
    } catch {
      // ignore metadata patch failures
    }
  }

  async prompt(text, opts = {}) {
    await this.start();
    if (this._pendingTurn) {
      throw new Error("Provider session is already running a turn");
    }

    this.isStreaming = true;
    this._abortController = new AbortController();
    this._pendingTurn = deferred();

    const userMessage = {
      role: "user",
      content: buildUserContent(text, opts.images || []),
    };
    this._appendMessage(userMessage);

    this._runTurn(text, opts).catch((error) => {
      const pending = this._pendingTurn;
      this._pendingTurn = null;
      this.isStreaming = false;
      pending?.reject(error);
      if (!isAbortError(error, this._abortController?.signal)) {
        this._emit({ type: "error", message: error?.message || "Provider runtime error" });
      }
      this._emit({ type: "turn_end" });
    });

    return this._pendingTurn.promise;
  }

  async _runTurn(text, opts = {}) {
    const adapter = createProviderAdapter(this.resolvedModel.api);
    const history = this.messages.slice(0, -1);
    const toolDefs = (this.tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description || tool.label || tool.name,
      parameters: tool.parameters || { type: "object", properties: {} },
    }));

    let continuationMessages = [];
    let pendingToolResults = false;
    let hadToolRound = false;
    let round = 0;
    const maxToolRounds = 20;
    const accumulatedToolCalls = [];
    let accumulatedText = "";
    let accumulatedThinking = "";
    let thinkingStarted = false;
    let sawTextToolFallback = false;
    const toolOutputs = [];

    const emitReasoning = (delta = "") => {
      if (!delta) return;
      if (!thinkingStarted) {
        thinkingStarted = true;
        this._emit({ type: "thinking_start" });
      }
      accumulatedThinking += delta;
      this._emit({ type: "thinking_delta", delta });
    };

    const runOnce = async ({ includeTools }) => {
      const request = adapter.buildStreamRequest({
        baseUrl: this.resolvedModel.base_url,
        apiKey: this.resolvedModel.api_key,
        modelId: this.resolvedModel.model,
        history,
        userMessage: text,
        currentImages: opts.images || [],
        systemMessage: this.systemPrompt,
        thinkingEnabled: this.thinking !== "off",
        tools: includeTools ? toolDefs : [],
        continuationMessages: continuationMessages.length ? continuationMessages : undefined,
      });

      for (let attempt = 0; ; attempt += 1) {
        let sawMeaningfulEvent = false;
        try {
          return await streamSSE({
            request,
            adapter,
            signal: this._abortController?.signal,
            fetchFn: this.fetchFn,
            onEvent: (event) => {
              if (event.type !== "done") {
                sawMeaningfulEvent = true;
              }
              if (event.type === "chunk" && event.delta) {
                accumulatedText += event.delta;
                this._emit({ type: "text_delta", delta: event.delta });
              } else if (event.type === "reasoning" && event.delta) {
                emitReasoning(event.delta);
              }
            },
          });
        } catch (error) {
          const retryPolicy = getProviderRetryPolicy(error);
          const canRetry = (
            !sawMeaningfulEvent
            && attempt < retryPolicy.maxRetries
            && isRetryableProviderError(error, this._abortController?.signal)
          );
          if (!canRetry) throw error;

          const delay = Math.min(
            retryPolicy.baseDelayMs * (2 ** attempt),
            retryPolicy.maxDelayMs,
          );
          const jitter = Math.round(delay * 0.1 * Math.random());
          await sleep(delay + jitter);
        }
      }
    };

    while (round < maxToolRounds) {
      round += 1;
      pendingToolResults = false;

      const { content, reasoning, toolCalls, stopReason } = await runOnce({ includeTools: true });
      if (content) {
        // 某些 provider 只在最终聚合里返回 content，不一定逐 chunk 推送。
        accumulatedText = mergeRuntimeText(accumulatedText, content);
      }
      const textToolFallback = !toolCalls?.length
        ? extractTextToolCalls(
          content,
          (this.tools || []).map((tool) => tool?.name).filter(Boolean),
        )
        : { toolCalls: [], cleanedText: content };
      const effectiveToolCalls = toolCalls?.length ? toolCalls : textToolFallback.toolCalls;
      const effectiveContent = toolCalls?.length ? content : textToolFallback.cleanedText;
      const effectiveStopReason = effectiveToolCalls.length > 0 ? "tool_use" : stopReason;
      if (textToolFallback.toolCalls.length > 0) {
        sawTextToolFallback = true;
      }
      if (reasoning) {
        // SSE callback has already emitted deltas; this keeps aggregate complete if callback was bypassed.
        if (accumulatedThinking !== reasoning && reasoning.startsWith(accumulatedThinking)) {
          emitReasoning(reasoning.slice(accumulatedThinking.length));
        }
      }

      if (!effectiveToolCalls?.length || effectiveStopReason !== "tool_use") {
        break;
      }

      const toolResults = [];
      for (const toolCall of effectiveToolCalls) {
        accumulatedToolCalls.push(toolCall);
        this._emit({
          type: "tool_start",
          name: toolCall.name,
          toolCallId: toolCall.id,
          args: toolCall.arguments || {},
        });

        const toolDef = (this.tools || []).find((tool) => tool?.name === toolCall.name);
        if (!toolDef?.execute) {
          const message = `Unknown tool: ${toolCall.name}`;
          const toolMessage = {
            role: "tool",
            toolName: toolCall.name,
            toolUseId: toolCall.id,
            args: toolCall.arguments || {},
            content: [{ type: "text", text: message }],
            details: { error: message },
          };
          this._appendMessage(toolMessage);
          this._emit({
            type: "tool_end",
            name: toolCall.name,
            toolCallId: toolCall.id,
            args: toolCall.arguments || {},
            success: false,
            content: toolMessage.content,
            details: toolMessage.details,
          });
          toolResults.push({
            toolCallId: toolCall.id,
            content: message,
            isError: true,
          });
          toolOutputs.push({ name: toolCall.name, text: message, isError: true });
          continue;
        }

        try {
          const result = await toolDef.execute(
            toolCall.id,
            toolCall.arguments || {},
            this._abortController?.signal,
            undefined,
            { sessionManager: this.sessionManager },
          );
          const normalizedContent = normalizeToolResultContent(result?.content || []);
          const details = result?.details || {};
          const toolMessage = {
            role: "tool",
            toolName: toolCall.name,
            toolUseId: toolCall.id,
            args: toolCall.arguments || {},
            content: normalizedContent,
            details,
          };
          this._appendMessage(toolMessage);
          this._emit({
            type: "tool_end",
            name: toolCall.name,
            toolCallId: toolCall.id,
            args: toolCall.arguments || {},
            success: !details?.error,
            content: normalizedContent,
            details,
          });
          toolResults.push({
            toolCallId: toolCall.id,
            content: toolContentToText(normalizedContent),
            isError: !!details?.error,
          });
          toolOutputs.push({
            name: toolCall.name,
            text: toolContentToText(normalizedContent),
            isError: !!details?.error,
          });
        } catch (error) {
          if (isAbortError(error, this._abortController?.signal)) {
            throw error;
          }
          const message = error instanceof Error ? error.message : String(error);
          const toolMessage = {
            role: "tool",
            toolName: toolCall.name,
            toolUseId: toolCall.id,
            args: toolCall.arguments || {},
            content: [{ type: "text", text: message }],
            details: { error: message },
          };
          this._appendMessage(toolMessage);
          this._emit({
            type: "tool_end",
            name: toolCall.name,
            toolCallId: toolCall.id,
            args: toolCall.arguments || {},
            success: false,
            content: toolMessage.content,
            details: toolMessage.details,
          });
          toolResults.push({
            toolCallId: toolCall.id,
            content: message,
            isError: true,
          });
          toolOutputs.push({ name: toolCall.name, text: message, isError: true });
        }
      }

      continuationMessages = [
        ...continuationMessages,
        { role: "assistant", content: effectiveContent, toolCalls: effectiveToolCalls },
        { role: "tool", results: toolResults },
      ];
      pendingToolResults = true;
      hadToolRound = true;
    }

    if (pendingToolResults && continuationMessages.length > 0) {
      const finalPass = await runOnce({ includeTools: false });
      if (finalPass?.content) {
        accumulatedText = mergeRuntimeText(accumulatedText, finalPass.content);
      }
      if (finalPass?.reasoning) {
        if (accumulatedThinking !== finalPass.reasoning && finalPass.reasoning.startsWith(accumulatedThinking)) {
          emitReasoning(finalPass.reasoning.slice(accumulatedThinking.length));
        }
      }
    }

    // 某些 provider 在工具结果后可能返回 stop_reason=tool_use 但不给结构化 toolCalls，
    // 导致上面循环提前退出且正文为空。这里兜底再做一次“无工具”收口请求。
    if (
      hadToolRound
      && !stripRawToolCallMarkup(accumulatedText).trim()
    ) {
      const settlePass = await runOnce({ includeTools: false });
      if (settlePass?.content) {
        accumulatedText = mergeRuntimeText(accumulatedText, settlePass.content);
      }
      if (settlePass?.reasoning) {
        if (accumulatedThinking !== settlePass.reasoning && settlePass.reasoning.startsWith(accumulatedThinking)) {
          emitReasoning(settlePass.reasoning.slice(accumulatedThinking.length));
        }
      }
    }

    const sanitizedAccumulatedText = stripRawToolCallMarkup(accumulatedText);
    let finalVisibleText = sawTextToolFallback ? sanitizedAccumulatedText : accumulatedText;
    if (!String(finalVisibleText || "").trim() && sanitizedAccumulatedText.trim()) {
      finalVisibleText = sanitizedAccumulatedText;
    }
    if (hadToolRound && !stripRawToolCallMarkup(finalVisibleText).trim()) {
      const fallbackReply = buildFallbackReplyFromToolResults(toolOutputs);
      if (fallbackReply) {
        finalVisibleText = fallbackReply;
        accumulatedText = mergeRuntimeText(accumulatedText, fallbackReply);
        this._emit({ type: "text_delta", delta: fallbackReply });
      }
    } else if (!stripRawToolCallMarkup(finalVisibleText).trim()) {
      const looksLikeToolMarkup = /<function_calls\b|<minimax:tool_call\b|<assistant\b[^>]*\bto\s*=|<tool_use\b|\[TOOL_CALL\]/i.test(accumulatedText);
      if (looksLikeToolMarkup) {
        const fallbackReply = "工具调用已触发，但未拿到可展示的最终回复。请重试一次。";
        finalVisibleText = fallbackReply;
        accumulatedText = mergeRuntimeText(accumulatedText, fallbackReply);
        this._emit({ type: "text_delta", delta: fallbackReply });
      }
    }

    if (thinkingStarted) {
      this._emit({ type: "thinking_end" });
    }

    const assistantBlocks = buildAssistantBlocks({
      thinking: accumulatedThinking,
      text: finalVisibleText,
    });
    if (assistantBlocks.length > 0) {
      const assistantMessage = {
        role: "assistant",
        content: assistantBlocks,
      };
      this._appendMessage(assistantMessage);
      this._emit({ type: "assistant_snapshot", content: assistantBlocks });
    }

    this.isStreaming = false;
    const pending = this._pendingTurn;
    this._pendingTurn = null;
    pending?.resolve({
      ok: true,
      content: accumulatedText,
      toolCalls: accumulatedToolCalls,
    });
    this.refreshContextUsage();
    this._emit({ type: "turn_end" });
  }

  steer() {
    return false;
  }

  async abort() {
    if (!this.isStreaming || !this._abortController) return false;
    this._abortController.abort();
    return true;
  }

  async close() {
    if (this.isStreaming) {
      try { await this.abort(); } catch {}
    }
    this._subscribers.clear();
  }

  async setModel(model) {
    const nextModel = typeof model === "string" ? model : model?.id;
    if (!nextModel) {
      throw new Error("model id is required");
    }
    this.resolvedModel = {
      ...this.resolvedModel,
      ...(typeof model === "object" ? model : null),
      model: nextModel,
      id: nextModel,
    };
    this.refreshContextUsage();
  }

  setThinkingLevel(level) {
    this.thinking = level;
  }

  async refreshContextUsage() {
    const contextWindow = toPositiveInt(this.resolvedModel?.contextWindow)
      || toPositiveInt(this.resolvedModel?.context)
      || PROVIDER_CONTEXT_WINDOW_FALLBACK;
    const tokens = estimateTokensFromMessages(this.messages || []);
    this._lastContextUsage = {
      tokens,
      contextWindow,
      percent: contextWindow
        ? Math.min(100, Math.round((tokens / contextWindow) * 100))
        : null,
    };
    return this._lastContextUsage;
  }

  getContextUsage() {
    if (!this._lastContextUsage) {
      const contextWindow = toPositiveInt(this.resolvedModel?.contextWindow)
        || toPositiveInt(this.resolvedModel?.context)
        || PROVIDER_CONTEXT_WINDOW_FALLBACK;
      const tokens = estimateTokensFromMessages(this.messages || []);
      return {
        tokens,
        contextWindow,
        percent: contextWindow
          ? Math.min(100, Math.round((tokens / contextWindow) * 100))
          : null,
      };
    }
    return this._lastContextUsage;
  }

  async compact() {
    if (this.isStreaming) {
      throw new Error("Provider session is still streaming");
    }
    if (this.isCompacting) {
      throw new Error("Provider session is already compacting");
    }
    this.isCompacting = true;
    try {
      if (!Array.isArray(this.messages) || this.messages.length < PROVIDER_COMPACT_MIN_MESSAGES) {
        throw new Error("Nothing to compact");
      }

      const keepCount = Math.min(
        PROVIDER_COMPACT_KEEP_MESSAGES,
        Math.max(8, Math.floor(this.messages.length * 0.45)),
      );
      const splitAt = this.messages.length - keepCount;
      if (splitAt <= 1) {
        throw new Error("Nothing to compact");
      }

      const older = this.messages.slice(0, splitAt);
      const recent = this.messages.slice(splitAt);
      const summaryText = buildCompactedSummary(older);
      if (!summaryText) {
        throw new Error("Nothing to compact");
      }

      const summaryMessage = {
        role: "assistant",
        content: [{ type: "text", text: summaryText }],
      };
      this.messages = [summaryMessage, ...recent];
      appendSessionContextReset(this.sessionPath, this.messages, nowIso());
      this.refreshContextUsage();

      try {
        patchSessionMetadata(this.sessionPath, {});
      } catch {
        // ignore metadata patch failures
      }
      return this.getContextUsage();
    } finally {
      this.isCompacting = false;
    }
  }
}
