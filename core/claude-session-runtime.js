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

function toContextUsageSnapshot(usage, fallbackUsage = null) {
  if (!usage && !fallbackUsage) return null;
  const fallbackTokens = fallbackUsage
    ? ((fallbackUsage.input_tokens || 0) + (fallbackUsage.output_tokens || 0))
    : null;
  const tokens = usage?.totalTokens ?? fallbackTokens;
  const contextWindow = usage?.maxTokens ?? usage?.rawMaxTokens ?? null;
  const percent = usage?.percentage != null
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

export class ClaudeSessionRuntime {
  constructor({
    sessionId = null,
    resumeSessionId = null,
    cwd,
    sessionPath,
    options,
  }) {
    this.sessionId = sessionId;
    this.resumeSessionId = resumeSessionId;
    this.cwd = cwd;
    this.sessionPath = sessionPath;
    this.options = { ...options, cwd, includePartialMessages: true, persistSession: true };
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
    this._lastContextUsage = null;
    this.isCompacting = false;
    this._query = null;
    this._pumpPromise = null;
    this._lastAssistantResponseId = null;
    this._activeCompactionTrigger = null;
  }

  _syncSessionId(nextSessionId) {
    const normalized = String(nextSessionId || "").trim();
    if (!normalized || normalized === this.sessionId) return;
    this.sessionId = normalized;
    if (this.sessionPath) {
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

    await this.start();
  }

  async start() {
    if (this._query) return;
    this._query = query({
      prompt: this._queue,
      options: {
        ...this.options,
        ...(this.resumeSessionId ? { resume: this.resumeSessionId } : {}),
        ...(!this.resumeSessionId && this.sessionId ? { sessionId: this.sessionId } : {}),
      },
    });
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
    try {
      for await (const message of this._query) {
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
        if (message?.type === "system" && message?.subtype === "compact_boundary") {
          if (this._activeCompactionTrigger) {
            this._emit({ type: "compaction_end", trigger: this._activeCompactionTrigger });
          }
          this._activeCompactionTrigger = null;
          this.isCompacting = false;
          this.refreshContextUsage().catch(() => {});
        }
        if (message?.type === "result") {
          const manualCompactionResult = Boolean(this._pendingCompaction);
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
      this._emit({ type: "runtime_error", error });
    }
  }

  async prompt(text, opts = {}) {
    await this.start();
    if (this._pendingTurn) {
      throw new Error("Claude session is already running a turn");
    }
    this.isStreaming = true;
    this._pendingTurn = deferred();
    this.messages.push(toSessionUserMessage(text, opts.images || []));
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

  steer(text) {
    if (!this.isStreaming) return false;
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
    if (!this._query?.interrupt || !this.isStreaming) return false;
    await this._query.interrupt();
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
        this._lastContextUsage = toContextUsageSnapshot(null, fallbackUsage);
      }
      return this._lastContextUsage;
    }

    try {
      const usage = await this._query.getContextUsage();
      this._lastContextUsage = toContextUsageSnapshot(usage, fallbackUsage || this._lastUsage);
      return this._lastContextUsage;
    } catch {
      if (!this._lastContextUsage && fallbackUsage) {
        this._lastContextUsage = toContextUsageSnapshot(null, fallbackUsage);
      }
      return this._lastContextUsage;
    }
  }

  getContextUsage() {
    return this._lastContextUsage || toContextUsageSnapshot(null, this._lastUsage);
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
