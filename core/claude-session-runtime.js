import { query } from "@anthropic-ai/claude-agent-sdk";
import { normalizeContentBlocks } from "./claude-transcript.js";
import { patchSessionMetadata } from "./claude-session-store.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

function toSessionUserMessage(text = "", images = []) {
  return {
    role: "user",
    content: buildUserContent(text, images),
  };
}

function toSessionAssistantMessage(message) {
  return {
    role: "assistant",
    content: normalizeContentBlocks(message?.message?.content),
    _responseId: message?.message?.id || message?.uuid,
  };
}

class AsyncMessageQueue {
  constructor() {
    this._items = [];
    this._waiters = [];
    this._closed = false;
  }

  push(value) {
    if (this._closed) throw new Error("message queue is closed");
    const waiter = this._waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this._items.push(value);
  }

  close() {
    this._closed = true;
    while (this._waiters.length > 0) {
      const waiter = this._waiters.shift();
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  next() {
    if (this._items.length > 0) {
      return Promise.resolve({ value: this._items.shift(), done: false });
    }
    if (this._closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this._waiters.push(resolve);
    });
  }
}

function extractMessageText(message) {
  const parts = message?.message?.content;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function isSessionNotFoundError(error) {
  const message = String(error?.message || error || "");
  return /no conversation found with session id/i.test(message);
}

function isAbortError(error) {
  const name = String(error?.name || "").trim();
  const message = String(error?.message || error || "").trim();
  return (
    name === "AbortError"
    || /^aborted$/i.test(message)
    || /request was aborted/i.test(message)
    || /fetchrequestcanceledexception/i.test(message)
    || /query closed before response received/i.test(message)
  );
}

function extractResultErrorMessage(message) {
  if (!message?.is_error) return "";
  if (Array.isArray(message?.errors) && message.errors.length > 0) {
    return String(message.errors[0] || "");
  }
  if (typeof message?.result === "string") return message.result;
  return "";
}

function getMcpAttachTimeoutMs() {
  const raw = Number.parseInt(process.env.HANAKO_MCP_ATTACH_TIMEOUT_MS || "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 8_000;
}

function shouldReapplyMcpServers() {
  return process.env.HANAKO_REAPPLY_MCP_SERVERS === "1";
}

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function toContextUsageSnapshot(usage, fallbackUsage = null, model = null) {
  if (!usage && !fallbackUsage) return null;
  const fallbackTokens = fallbackUsage
    ? ((fallbackUsage.input_tokens || 0) + (fallbackUsage.output_tokens || 0))
    : null;
  const tokens = usage?.totalTokens ?? fallbackTokens;
  const modelContextWindow = toPositiveInt(model?.contextWindow ?? model?.context);
  const sdkContextWindow = toPositiveInt(usage?.maxTokens ?? usage?.rawMaxTokens);
  const contextWindow = modelContextWindow ?? sdkContextWindow ?? null;
  const shouldTrustSdkPercentage = !modelContextWindow || modelContextWindow === sdkContextWindow;
  const percent = usage?.percentage != null && shouldTrustSdkPercentage
    ? Math.round(usage.percentage)
    : (
      tokens != null && contextWindow
        ? Math.min(100, Math.round((tokens / contextWindow) * 100))
        : null
    );
  return {
    tokens,
    contextWindow,
    percent,
  };
}

function normalizeContextUsageSnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const tokens = Number.isFinite(raw.tokens) ? Number(raw.tokens) : null;
  const contextWindow = Number.isFinite(raw.contextWindow) ? Number(raw.contextWindow) : null;
  const percent = Number.isFinite(raw.percent)
    ? Math.max(0, Math.min(100, Math.round(Number(raw.percent))))
    : (
      tokens != null && contextWindow
        ? Math.min(100, Math.round((tokens / contextWindow) * 100))
        : null
    );
  if (tokens == null && contextWindow == null && percent == null) return null;
  return { tokens, contextWindow, percent };
}

function applyModelToContextUsageSnapshot(raw, model = null) {
  const snapshot = normalizeContextUsageSnapshot(raw);
  const modelContextWindow = toPositiveInt(model?.contextWindow ?? model?.context);
  if (!snapshot || !modelContextWindow || snapshot.contextWindow === modelContextWindow) return snapshot;
  const percent = snapshot.tokens != null
    ? Math.min(100, Math.round((snapshot.tokens / modelContextWindow) * 100))
    : snapshot.percent;
  return {
    tokens: snapshot.tokens,
    contextWindow: modelContextWindow,
    percent,
  };
}

function shouldLogContextUsage() {
  const raw = String(process.env.HANAKO_CONTEXT_USAGE_LOG || "").trim();
  return /^(1|true|yes|on)$/i.test(raw);
}

function formatUsageList(items = [], nameKey = "name", limit = 12) {
  if (!Array.isArray(items) || items.length === 0) return "(none)";
  return items
    .slice()
    .sort((a, b) => Number(b?.tokens || 0) - Number(a?.tokens || 0))
    .slice(0, limit)
    .map((item) => {
      const name = String(item?.[nameKey] || item?.name || item?.categoryName || "(unnamed)");
      const tokens = Number.isFinite(item?.tokens) ? item.tokens : 0;
      const suffix = item?.isLoaded != null ? ` loaded=${!!item.isLoaded}` : "";
      return `${name}:${tokens}${suffix}`;
    })
    .join(", ");
}

function buildContextUsageLog(usage, snapshot) {
  if (!usage && !snapshot) return "";
  const total = usage?.totalTokens ?? snapshot?.tokens ?? "?";
  const max = usage?.maxTokens ?? usage?.rawMaxTokens ?? snapshot?.contextWindow ?? "?";
  const percent = usage?.percentage != null ? Math.round(usage.percentage) : (snapshot?.percent ?? "?");
  const lines = [
    `[context-usage] total=${total}/${max} (${percent}%) model=${usage?.model || "unknown"}`,
  ];
  if (usage?.categories) lines.push(`[context-usage] categories: ${formatUsageList(usage.categories)}`);
  if (usage?.systemPromptSections) lines.push(`[context-usage] systemPromptSections: ${formatUsageList(usage.systemPromptSections)}`);
  if (usage?.systemTools) lines.push(`[context-usage] systemTools: ${formatUsageList(usage.systemTools)}`);
  if (usage?.deferredBuiltinTools) lines.push(`[context-usage] deferredBuiltinTools: ${formatUsageList(usage.deferredBuiltinTools)}`);
  if (usage?.mcpTools) lines.push(`[context-usage] mcpTools: ${formatUsageList(usage.mcpTools)}`);
  if (usage?.skills) {
    const skills = usage.skills;
    lines.push(`[context-usage] skills: total=${skills.totalSkills ?? "?"} included=${skills.includedSkills ?? "?"} tokens=${skills.tokens ?? "?"}`);
    lines.push(`[context-usage] skillFrontmatter: ${formatUsageList(skills.skillFrontmatter)}`);
  }
  if (usage?.memoryFiles) lines.push(`[context-usage] memoryFiles: ${formatUsageList(usage.memoryFiles, "path")}`);
  if (usage?.messageBreakdown) {
    const mb = usage.messageBreakdown;
    lines.push(`[context-usage] messages: toolCalls=${mb.toolCallTokens ?? 0}, toolResults=${mb.toolResultTokens ?? 0}, attachments=${mb.attachmentTokens ?? 0}`);
  }
  return lines.join("\n");
}

export class ClaudeSessionRuntime {
  constructor({
    sessionId = null,
    resumeSessionId = null,
    cwd,
    sessionPath,
    options,
    initialContextUsage = null,
  }) {
    this.sessionId = sessionId;
    this.resumeSessionId = resumeSessionId;
    this.cwd = cwd;
    this.sessionPath = sessionPath;
    this.options = {
      ...options,
      cwd,
      includePartialMessages: false,
      persistSession: true,
    };
    this.model = null;
    this.sessionManager = {
      getSessionId: () => this.sessionId,
      getSessionFile: () => this.sessionPath,
      getCwd: () => this.cwd,
      getMessages: () => this.messages,
    };
    this.messages = [];
    this.isStreaming = false;
    this.thinkingLevel = this.options?.thinking;
    this._queue = new AsyncMessageQueue();
    this._subscribers = new Set();
    this._pendingTurn = null;
    this._pendingCompaction = null;
    this._lastUsage = null;
    this._lastContextUsage = normalizeContextUsageSnapshot(initialContextUsage);
    this.isCompacting = false;
    this._query = null;
    this._pumpPromise = null;
    this._pumpActive = false;
    this._lastAssistantResponseId = null;
    this._activeCompactionTrigger = null;
    this._allowSessionNotFoundRetry = false;
    this._abortRequested = false;
    this._pendingSteerInterrupts = 0;
    this._lastContextUsageLogKey = "";
  }

  _persistContextUsageSnapshot(snapshot) {
    const normalized = normalizeContextUsageSnapshot(snapshot);
    if (!this.sessionPath || !normalized) return;
    try {
      patchSessionMetadata(this.sessionPath, {
        contextUsage: {
          ...normalized,
          updatedAt: new Date().toISOString(),
        },
      });
    } catch {
      // ignore metadata patch failures
    }
  }

  _syncSessionId(nextSessionId) {
    const normalized = String(nextSessionId || "").trim();
    if (!normalized) return;
    const changed = normalized !== this.sessionId;
    this.sessionId = normalized;
    // Keep resume id aligned with the latest confirmed SDK session id.
    // This is required after abort(), because the next prompt starts a new
    // query() instance and must resume the same conversation.
    this.resumeSessionId = normalized;
    if (changed && this.sessionPath) {
      try {
        patchSessionMetadata(this.sessionPath, { sessionId: normalized });
      } catch {
        // ignore metadata patch failures
      }
    }
  }

  async _restartQuery({ resume = true } = {}) {
    if (this._pendingTurn) {
      throw new Error("Claude session is already running a turn");
    }
    if (this._pendingCompaction || this.isCompacting) {
      throw new Error("Claude session is already compacting");
    }

    this._queue.close();
    this._query?.close?.();
    await this._pumpPromise?.catch(() => {});

    this._queue = new AsyncMessageQueue();
    this._query = null;
    this._pumpPromise = null;
    this.resumeSessionId = resume ? (this.sessionId || this.resumeSessionId) : null;
    if (!resume) this.sessionId = null;

    await this.start();
  }

  async start() {
    if (this._query && this._pumpActive) return;
    if (this._query && !this._pumpActive) {
      this._query = null;
      this._pumpPromise = null;
    }
    this._abortRequested = false;
    this._pendingSteerInterrupts = 0;
    this._query = query({
      prompt: this._queue,
      options: {
        ...this.options,
        ...(this.resumeSessionId ? { resume: this.resumeSessionId } : {}),
      },
    });
    // Some SDK/CLI combinations can miss in-process MCP registration from the
    // initial query() options path. Keep the fallback behind an explicit flag:
    // newer SDKs attach from query() options and a second setMcpServers call
    // starts duplicate stdio MCP servers.
    if (
      shouldReapplyMcpServers()
      &&
      this.options?.mcpServers
      && Object.keys(this.options.mcpServers).length > 0
      && typeof this._query?.setMcpServers === "function"
    ) {
      const timeoutMs = getMcpAttachTimeoutMs();
      let settled = false;
      let timeoutId = null;
      const attachPromise = Promise.resolve()
        .then(() => this._query.setMcpServers(this.options.mcpServers))
        .catch((err) => {
          if (!settled) {
            console.warn(`[runtime] setMcpServers failed: ${err?.message || err}`);
          }
        });
      const timeoutPromise = new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          if (settled) return resolve();
          console.warn(`[runtime] setMcpServers timeout (${timeoutMs}ms), continue without waiting`);
          resolve();
        }, timeoutMs);
      });
      await Promise.race([attachPromise, timeoutPromise]);
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
    }
    this._pumpActive = true;
    this._pumpPromise = this._pump();
    this.refreshContextUsage().catch(() => {});
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
        // ignore subscriber errors
      }
    }
  }

  _recordAssistantMessage(message) {
    const assistant = toSessionAssistantMessage(message);
    const last = this.messages[this.messages.length - 1];
    if (
      last?.role === "assistant"
      && last?._responseId
      && assistant._responseId
      && last._responseId === assistant._responseId
    ) {
      last.content = assistant.content;
      return;
    }
    this.messages.push(assistant);
  }

  _recordToolEvent(event) {
    if (event?.type === "tool_end") {
      this.messages.push({
        role: "tool",
        toolName: event.name || "",
        toolUseId: event.toolCallId || null,
        args: event.args,
        content: normalizeContentBlocks(event.content || []),
        details: event.details,
      });
    }
  }

  async _pump() {
    const activeQuery = this._query;
    try {
      for await (const message of activeQuery) {
        if (message?.session_id) {
          this._syncSessionId(message.session_id);
        }
        if (message?.type === "system" && message?.subtype === "status") {
          const nextCompacting = message.status === "compacting";
          if (nextCompacting && !this.isCompacting) {
            this._activeCompactionTrigger = this._pendingCompaction ? "manual" : "auto";
            this._emit({ type: "compaction_start", trigger: this._activeCompactionTrigger });
          }
          this.isCompacting = nextCompacting;
        }
        if (message?.type === "system" && message?.subtype === "init") {
          this._emit({
            type: "sdk_init",
            tools: Array.isArray(message.tools) ? message.tools : [],
            mcpServers: Array.isArray(message.mcp_servers) ? message.mcp_servers : [],
          });
        }
        if (message?.type === "system" && message?.subtype === "compact_boundary") {
          if (this._activeCompactionTrigger) {
            this._emit({ type: "compaction_end", trigger: this._activeCompactionTrigger });
          }
          this._activeCompactionTrigger = null;
          this.isCompacting = false;
          this.refreshContextUsage().catch(() => {});
        }
        if (message?.type === "result") {
          const resultErrorMessage = extractResultErrorMessage(message);
          const recoverableSessionNotFound = (
            this._allowSessionNotFoundRetry
            && message?.is_error
            && isSessionNotFoundError(resultErrorMessage)
          );
          if (recoverableSessionNotFound) {
            this.isStreaming = false;
            if (this._activeCompactionTrigger) {
              this._emit({ type: "compaction_end", trigger: this._activeCompactionTrigger });
              this._activeCompactionTrigger = null;
            }
            this.isCompacting = false;
            const turn = this._pendingTurn;
            this._pendingTurn = null;
            turn?.reject(new Error(resultErrorMessage || "No conversation found with session ID"));
            const compaction = this._pendingCompaction;
            this._pendingCompaction = null;
            compaction?.reject(new Error(resultErrorMessage || "No conversation found with session ID"));
            this.refreshContextUsage(message.usage).catch(() => {});
            continue;
          }
          const manualCompactionResult = Boolean(this._pendingCompaction);
          const steerInterruptedTurn = this._pendingSteerInterrupts > 0 && !!this._pendingTurn;
          if (steerInterruptedTurn) {
            this._pendingSteerInterrupts -= 1;
            this._lastUsage = message.usage || this._lastUsage;
            this.refreshContextUsage(message.usage).catch(() => {});
            continue;
          }
          this._lastUsage = message.usage || null;
          this.isStreaming = false;
          if (this._activeCompactionTrigger) {
            this._emit({ type: "compaction_end", trigger: this._activeCompactionTrigger });
            this._activeCompactionTrigger = null;
          }
          this.isCompacting = false;
          const turn = this._pendingTurn;
          this._pendingTurn = null;
          turn?.resolve(message);
          const compaction = this._pendingCompaction;
          this._pendingCompaction = null;
          if (compaction) {
            if (message.is_error) {
              compaction.reject(new Error(message.errors?.[0] || "Claude compaction failed"));
            } else {
              compaction.resolve(message);
            }
          }
          this.refreshContextUsage(message.usage).catch(() => {});
          if (manualCompactionResult) {
            message._hanakoManualCompaction = true;
          }
        }
        if (message?.type === "assistant") {
          this._lastAssistantText = extractMessageText(message);
          this._recordAssistantMessage(message);
        }
        this._emit(message);
      }
    } catch (error) {
      this.isStreaming = false;
      this._activeCompactionTrigger = null;
      this.isCompacting = false;
      const turn = this._pendingTurn;
      this._pendingTurn = null;
      turn?.reject(error);
      const compaction = this._pendingCompaction;
      this._pendingCompaction = null;
      compaction?.reject(error);
      if (
        !(this._allowSessionNotFoundRetry && isSessionNotFoundError(error))
        && !isAbortError(error)
      ) {
        this._emit({ type: "runtime_error", error });
      }
    } finally {
      this.isStreaming = false;
      this._activeCompactionTrigger = null;
      this.isCompacting = false;

      if (this._pendingTurn) {
        const turn = this._pendingTurn;
        this._pendingTurn = null;
        turn.reject(new Error(this._abortRequested ? "aborted" : "Claude runtime stream closed"));
      }
      if (this._pendingCompaction) {
        const compaction = this._pendingCompaction;
        this._pendingCompaction = null;
        compaction.reject(new Error(this._abortRequested ? "aborted" : "Claude runtime stream closed"));
      }

      if (this._query === activeQuery) {
        this._query = null;
        this._pumpPromise = null;
      }
      this._pumpActive = false;
      this._abortRequested = false;
      this._pendingSteerInterrupts = 0;
    }
  }

  _enqueueUserPrompt(text, opts = {}, { recordLocalMessage = true } = {}) {
    this._abortRequested = false;
    this.isStreaming = true;
    this._pendingTurn = deferred();
    if (recordLocalMessage) {
      this.messages.push(toSessionUserMessage(text, opts.images || []));
    }
    this._queue.push({
      type: "user",
      message: {
        role: "user",
        content: buildUserContent(text, opts.images || []),
      },
      parent_tool_use_id: null,
    });
    return this._pendingTurn.promise;
  }

  async _recoverFromInvalidResumeSession() {
    // 历史 metadata 中残留的 sessionId 可能已在 SDK 侧不存在，清空后重新启动为新会话。
    this.resumeSessionId = null;
    this.sessionId = null;
    await this._restartQuery({ resume: false });
  }

  async prompt(text, opts = {}) {
    await this.start();
    if (this._pendingTurn) {
      throw new Error("Claude session is already running a turn");
    }
    this._allowSessionNotFoundRetry = true;
    try {
      return await this._enqueueUserPrompt(text, opts, { recordLocalMessage: true });
    } catch (error) {
      if (!isSessionNotFoundError(error)) throw error;
      await this._recoverFromInvalidResumeSession();
      return await this._enqueueUserPrompt(text, opts, { recordLocalMessage: false });
    } finally {
      this._allowSessionNotFoundRetry = false;
    }
  }

  steer(text) {
    if (!this.isStreaming) return false;
    this._pendingSteerInterrupts += 1;
    this._queue.push({
      type: "user",
      message: {
        role: "user",
        content: buildUserContent(text, []),
      },
      parent_tool_use_id: null,
      priority: "now",
    });
    return true;
  }

  async abort() {
    if (!this.isStreaming) return false;
    this._abortRequested = true;
    const abortError = new Error("Request was aborted.");
    // 关键：用户点击停止时，立即释放当前 pending turn。
    // 避免 SDK 中断信号已发出但底层流尚未结束时，后续 prompt 被“还在运行”卡住。
    const turn = this._pendingTurn;
    this._pendingTurn = null;
    turn?.reject(abortError);
    this.isStreaming = false;
    this._pendingSteerInterrupts = 0;

    if (this._activeCompactionTrigger) {
      this._emit({ type: "compaction_end", trigger: this._activeCompactionTrigger });
      this._activeCompactionTrigger = null;
    }
    this.isCompacting = false;
    const compaction = this._pendingCompaction;
    this._pendingCompaction = null;
    compaction?.reject(abortError);

    const activeQuery = this._query;
    const activePump = this._pumpPromise;
    const activeQueue = this._queue;
    // 立即切断旧流引用：后续 prompt 必须走新 query/new queue，
    // 不允许再把消息写进已被 abort 的旧队列。
    this._query = null;
    this._pumpPromise = null;
    this._pumpActive = false;
    this._queue = new AsyncMessageQueue();
    try {
      activeQueue?.close?.();
    } catch {}
    if (!activeQuery) {
      activePump?.catch(() => {});
      return true;
    }
    const hasInterrupt = typeof activeQuery.interrupt === "function";
    try {
      if (hasInterrupt) {
        await activeQuery.interrupt();
      }
    } catch (error) {
      if (!isAbortError(error)) throw error;
    } finally {
      try {
        activeQuery?.close?.();
      } catch {}
    }
    activePump?.catch(() => {});
    return true;
  }

  async close() {
    this._queue.close();
    this._query?.close?.();
    this._pendingCompaction?.reject?.(new Error("Claude session closed"));
    this._pendingCompaction = null;
    await this._pumpPromise?.catch(() => {});
  }

  async setModel(model) {
    const nextModel = typeof model === "string" ? model : model?.id;
    if (!nextModel) {
      throw new Error("model id is required");
    }
    if (String(this.options?.model || "").trim() === nextModel) {
      this.model = typeof model === "string"
        ? { id: nextModel, name: nextModel }
        : model;
      return;
    }
    this.model = typeof model === "string"
      ? { id: nextModel, name: nextModel }
      : model;
    this.options = {
      ...this.options,
      model: nextModel,
    };
    // 切换模型时避免沿用旧会话 resume，兼容部分中转服务不支持跨模型恢复。
    await this._restartQuery({ resume: false });
  }

  setThinkingLevel(level) {
    this.thinkingLevel = level;
    this.options = {
      ...this.options,
      thinking: level,
    };
  }

  async refreshContextUsage(fallbackUsage = null) {
    if (!this._query?.getContextUsage) {
      if (fallbackUsage) {
        this._lastContextUsage = toContextUsageSnapshot(null, fallbackUsage, this.model);
        this._persistContextUsageSnapshot(this._lastContextUsage);
      }
      return applyModelToContextUsageSnapshot(this._lastContextUsage, this.model);
    }

    try {
      const usage = await this._query.getContextUsage();
      const nextContextUsage = toContextUsageSnapshot(usage, fallbackUsage || this._lastUsage, this.model);
      if (nextContextUsage) {
        this._lastContextUsage = nextContextUsage;
        this._persistContextUsageSnapshot(this._lastContextUsage);
      }
      if (shouldLogContextUsage()) {
        const logKey = JSON.stringify({
          total: usage?.totalTokens ?? nextContextUsage?.tokens ?? null,
          skills: usage?.skills?.tokens ?? null,
          tools: usage?.categories?.find?.((c) => c?.name === "tools")?.tokens ?? null,
          messages: usage?.categories?.find?.((c) => c?.name === "messages")?.tokens ?? null,
        });
        if (logKey !== this._lastContextUsageLogKey) {
          this._lastContextUsageLogKey = logKey;
          const text = buildContextUsageLog(usage, nextContextUsage);
          if (text) console.log(text);
        }
      }
      return this._lastContextUsage;
    } catch {
      if (!this._lastContextUsage && fallbackUsage) {
        this._lastContextUsage = toContextUsageSnapshot(null, fallbackUsage, this.model);
        this._persistContextUsageSnapshot(this._lastContextUsage);
      }
      return applyModelToContextUsageSnapshot(this._lastContextUsage, this.model);
    }
  }

  getContextUsage() {
    return applyModelToContextUsageSnapshot(
      this._lastContextUsage || toContextUsageSnapshot(null, this._lastUsage, this.model),
      this.model,
    );
  }

  async compact() {
    await this.start();
    if (this._pendingTurn) {
      throw new Error("Claude session is already running a turn");
    }
    if (this._pendingCompaction || this.isCompacting) {
      throw new Error("Claude session is already compacting");
    }

    this._pendingCompaction = deferred();
    this._queue.push({
      type: "user",
      message: {
        role: "user",
        content: "/compact",
      },
      parent_tool_use_id: null,
      isSynthetic: true,
      priority: "now",
    });
    return this._pendingCompaction.promise;
  }
}
