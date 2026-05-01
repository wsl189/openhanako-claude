import { describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSessionRuntime } from "./claude-session-runtime.js";

describe("ClaudeSessionRuntime resume recovery", () => {
  it("returns cached context usage before SDK query starts", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();

    const runtime = new ClaudeSessionRuntime({
      sessionId: "s1",
      resumeSessionId: "s1",
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test-cached-context.json",
      options: {},
      initialContextUsage: {
        tokens: 12345,
        contextWindow: 200000,
        percent: 6,
      },
    });

    await expect(runtime.refreshContextUsage()).resolves.toEqual({
      tokens: 12345,
      contextWindow: 200000,
      percent: 6,
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("uses the runtime model context window for SDK context usage", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();
    const iterator = (async function* stream() {})();
    iterator.close = vi.fn();
    iterator.getContextUsage = vi.fn(async () => ({
      totalTokens: 100000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 50,
    }));
    queryMock.mockReturnValue(iterator);

    const runtime = new ClaudeSessionRuntime({
      sessionId: "s1",
      resumeSessionId: null,
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test-model-context.json",
      options: {},
    });
    runtime.model = { id: "deepseek-v4-pro", contextWindow: 1048576 };
    await runtime.start();

    await expect(runtime.refreshContextUsage()).resolves.toEqual({
      tokens: 100000,
      contextWindow: 1048576,
      percent: 10,
    });
    await runtime.close();
  });

  it("respects explicit includePartialMessages=true for SDK query", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();
    queryMock.mockImplementation(({ prompt }) => {
      async function* stream() {
        for await (const _input of prompt) {
          yield {
            type: "result",
            is_error: false,
          };
          return;
        }
      }
      const iterator = stream();
      iterator.close = vi.fn();
      iterator.getContextUsage = vi.fn(async () => null);
      return iterator;
    });

    const runtime = new ClaudeSessionRuntime({
      sessionId: "s1",
      resumeSessionId: null,
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test-options.json",
      options: {
        includePartialMessages: true,
      },
    });

    await runtime.prompt("hello");
    await runtime.close();

    expect(queryMock.mock.calls.length).toBeGreaterThan(0);
    expect(queryMock.mock.calls[0]?.[0]?.options?.includePartialMessages).toBe(true);
    expect(queryMock.mock.calls[0]?.[0]?.options?.persistSession).toBe(true);
  });

  it("restarts the SDK query when max output env changes for the same model", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();
    queryMock.mockImplementation(() => {
      async function* stream() {}
      const iterator = stream();
      iterator.close = vi.fn();
      iterator.getContextUsage = vi.fn(async () => null);
      return iterator;
    });

    const runtime = new ClaudeSessionRuntime({
      sessionId: "s1",
      resumeSessionId: null,
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test-max-output-env.json",
      options: {
        model: "deepseek-v4-pro",
        env: {
          OTHER: "ok",
        },
      },
    });

    await runtime.setModel({
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      maxOutputTokensOverride: 131072,
    });
    await runtime.close();

    expect(runtime.options.model).toBe("deepseek-v4-pro");
    expect(runtime.options.env).toMatchObject({
      OTHER: "ok",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "131072",
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0]?.[0]?.options?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS)
      .toBe("131072");
  });

  it("does not re-apply configured mcpServers by default", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();
    const setMcpServers = vi.fn(async () => {});
    queryMock.mockImplementation(({ prompt }) => {
      async function* stream() {
        for await (const _input of prompt) {
          yield {
            type: "result",
            is_error: false,
          };
          return;
        }
      }
      const iterator = stream();
      iterator.close = vi.fn();
      iterator.getContextUsage = vi.fn(async () => null);
      iterator.setMcpServers = setMcpServers;
      return iterator;
    });

    const mcpServers = {
      hanako: {
        type: "sdk",
        name: "hanako-tools",
        instance: {},
      },
    };

    const runtime = new ClaudeSessionRuntime({
      sessionId: "s1",
      resumeSessionId: null,
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test-mcp.json",
      options: {
        mcpServers,
      },
    });

    await runtime.prompt("hello");
    await runtime.close();

    expect(setMcpServers).not.toHaveBeenCalled();
  });

  it("re-applies configured mcpServers when compatibility flag is enabled", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();
    const setMcpServers = vi.fn(async () => {});
    queryMock.mockImplementation(({ prompt }) => {
      async function* stream() {
        for await (const _input of prompt) {
          yield {
            type: "result",
            is_error: false,
          };
          return;
        }
      }
      const iterator = stream();
      iterator.close = vi.fn();
      iterator.getContextUsage = vi.fn(async () => null);
      iterator.setMcpServers = setMcpServers;
      return iterator;
    });

    const mcpServers = {
      hanako: {
        type: "sdk",
        name: "hanako-tools",
        instance: {},
      },
    };
    const prevReapply = process.env.HANAKO_REAPPLY_MCP_SERVERS;
    process.env.HANAKO_REAPPLY_MCP_SERVERS = "1";

    try {
      const runtime = new ClaudeSessionRuntime({
        sessionId: "s1",
        resumeSessionId: null,
        cwd: process.cwd(),
        sessionPath: "/tmp/hanako-runtime-test-mcp.json",
        options: {
          mcpServers,
        },
      });

      await runtime.prompt("hello");
      await runtime.close();

      expect(setMcpServers).toHaveBeenCalledTimes(1);
      expect(setMcpServers).toHaveBeenCalledWith(mcpServers);
    } finally {
      if (prevReapply == null) delete process.env.HANAKO_REAPPLY_MCP_SERVERS;
      else process.env.HANAKO_REAPPLY_MCP_SERVERS = prevReapply;
    }
  });

  it("does not hang prompt when setMcpServers stalls and compatibility flag is enabled", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();

    queryMock.mockImplementation(({ prompt }) => {
      async function* stream() {
        for await (const _input of prompt) {
          yield {
            type: "assistant",
            session_id: "mcp-timeout-session",
            message: {
              content: [{ type: "text", text: "ok" }],
            },
          };
          yield {
            type: "result",
            session_id: "mcp-timeout-session",
            is_error: false,
          };
          return;
        }
      }
      const iterator = stream();
      iterator.close = vi.fn();
      iterator.getContextUsage = vi.fn(async () => null);
      iterator.setMcpServers = vi.fn(() => new Promise(() => {}));
      return iterator;
    });

    const prevTimeout = process.env.HANAKO_MCP_ATTACH_TIMEOUT_MS;
    const prevReapply = process.env.HANAKO_REAPPLY_MCP_SERVERS;
    process.env.HANAKO_MCP_ATTACH_TIMEOUT_MS = "1";
    process.env.HANAKO_REAPPLY_MCP_SERVERS = "1";

    try {
      const runtime = new ClaudeSessionRuntime({
        sessionId: "mcp-timeout",
        resumeSessionId: null,
        cwd: process.cwd(),
        sessionPath: "/tmp/hanako-runtime-test-mcp-timeout.json",
        options: {
          mcpServers: {
            hanako: {
              type: "sdk",
              name: "hanako-tools",
              instance: {},
            },
          },
        },
      });

      await runtime.prompt("hello");
      await runtime.close();
      expect(queryMock).toHaveBeenCalledTimes(1);
    } finally {
      if (prevTimeout == null) delete process.env.HANAKO_MCP_ATTACH_TIMEOUT_MS;
      else process.env.HANAKO_MCP_ATTACH_TIMEOUT_MS = prevTimeout;
      if (prevReapply == null) delete process.env.HANAKO_REAPPLY_MCP_SERVERS;
      else process.env.HANAKO_REAPPLY_MCP_SERVERS = prevReapply;
    }
  });

  it("retries as a fresh session when resume session is missing", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();
    queryMock.mockImplementation(({ prompt, options }) => {
      const callNo = queryMock.mock.calls.length;
      async function* stream() {
        for await (const _input of prompt) {
          if (callNo === 1) {
            throw new Error(`No conversation found with session ID: ${options?.resume}`);
          }
          yield {
            type: "assistant",
            session_id: "sdk-session-new",
            message: {
              content: [{ type: "text", text: "hello" }],
            },
          };
          yield {
            type: "result",
            session_id: "sdk-session-new",
            usage: { input_tokens: 1, output_tokens: 1 },
            is_error: false,
          };
          return;
        }
      }
      const iterator = stream();
      iterator.close = vi.fn();
      iterator.getContextUsage = vi.fn(async () => null);
      return iterator;
    });

    const runtime = new ClaudeSessionRuntime({
      sessionId: "stale-session",
      resumeSessionId: "stale-session",
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test.json",
      options: {},
    });

    const errors = [];
    const unsub = runtime.subscribe((event) => {
      if (event?.type === "runtime_error") errors.push(event);
    });

    await runtime.prompt("hi");

    unsub();
    await runtime.close();

    expect(queryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(queryMock.mock.calls[0]?.[0]?.options?.resume).toBe("stale-session");
    expect(queryMock.mock.calls.some((call) => call?.[0]?.options?.resume == null)).toBe(true);
    expect(errors.length).toBe(0);
    expect(runtime.sessionId).toBe("sdk-session-new");
    expect(runtime.messages.filter((m) => m?.role === "user").length).toBe(1);
  });

  it("retries when SDK returns recoverable result error for missing session", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();
    queryMock.mockImplementation(({ prompt, options }) => {
      const callNo = queryMock.mock.calls.length;
      async function* stream() {
        for await (const _input of prompt) {
          if (callNo === 1) {
            yield {
              type: "result",
              session_id: "stale-session",
              is_error: true,
              errors: [`No conversation found with session ID: ${options?.resume}`],
            };
            return;
          }
          yield {
            type: "assistant",
            session_id: "sdk-session-new-2",
            message: {
              content: [{ type: "text", text: "recovered" }],
            },
          };
          yield {
            type: "result",
            session_id: "sdk-session-new-2",
            usage: { input_tokens: 1, output_tokens: 1 },
            is_error: false,
          };
          return;
        }
      }
      const iterator = stream();
      iterator.close = vi.fn();
      iterator.getContextUsage = vi.fn(async () => null);
      return iterator;
    });

    const runtime = new ClaudeSessionRuntime({
      sessionId: "stale-session",
      resumeSessionId: "stale-session",
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test-2.json",
      options: {},
    });

    const errors = [];
    const results = [];
    const unsub = runtime.subscribe((event) => {
      if (event?.type === "runtime_error") errors.push(event);
      if (event?.type === "result") results.push(event);
    });

    await runtime.prompt("hello");

    unsub();
    await runtime.close();

    expect(queryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(queryMock.mock.calls[0]?.[0]?.options?.resume).toBe("stale-session");
    expect(queryMock.mock.calls.some((call) => call?.[0]?.options?.resume == null)).toBe(true);
    expect(errors.length).toBe(0);
    expect(results.some((r) => r?.is_error)).toBe(false);
    expect(runtime.sessionId).toBe("sdk-session-new-2");
    expect(runtime.messages.filter((m) => m?.role === "user").length).toBe(1);
  });

  it("does not pass stale sessionId when restart query with resume disabled", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();
    queryMock.mockImplementation(({ prompt }) => {
      async function* stream() {
        for await (const _input of prompt) {
          yield {
            type: "assistant",
            session_id: "new-session-after-switch",
            message: { content: [{ type: "text", text: "ok" }] },
          };
          yield {
            type: "result",
            session_id: "new-session-after-switch",
            is_error: false,
          };
          return;
        }
      }
      const iterator = stream();
      iterator.close = vi.fn();
      iterator.getContextUsage = vi.fn(async () => null);
      return iterator;
    });

    const runtime = new ClaudeSessionRuntime({
      sessionId: "stale-session",
      resumeSessionId: "stale-session",
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test-3.json",
      options: {},
    });

    await runtime.setModel("another-model");
    await runtime.prompt("hello");
    await runtime.close();

    expect(queryMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of queryMock.mock.calls) {
      expect(call?.[0]?.options?.resume).toBeUndefined();
      expect(call?.[0]?.options?.sessionId).toBeUndefined();
    }
  });

  it("does not restart query when switching to the same model id", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();

    queryMock.mockImplementation(({ prompt }) => {
      async function* stream() {
        for await (const _input of prompt) {
          yield {
            type: "result",
            is_error: false,
          };
          return;
        }
      }
      const iterator = stream();
      iterator.close = vi.fn();
      iterator.getContextUsage = vi.fn(async () => null);
      return iterator;
    });

    const runtime = new ClaudeSessionRuntime({
      sessionId: "same-model-session",
      resumeSessionId: null,
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test-same-model.json",
      options: {
        model: "claude-3-7-sonnet",
      },
    });

    await runtime.start();
    await runtime.setModel("claude-3-7-sonnet");
    await runtime.prompt("hello");
    await runtime.close();

    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("recovers when a prestarted query stream ends before next prompt", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();
    queryMock.mockImplementation(({ prompt }) => {
      const callNo = queryMock.mock.calls.length;
      async function* stream() {
        if (callNo === 1) {
          yield {
            type: "result",
            is_error: true,
            errors: ["No conversation found with session ID: stale-session"],
          };
          return;
        }
        for await (const _input of prompt) {
          yield {
            type: "assistant",
            session_id: "recovered-session",
            message: { content: [{ type: "text", text: "back" }] },
          };
          yield {
            type: "result",
            session_id: "recovered-session",
            is_error: false,
          };
          return;
        }
      }
      const iterator = stream();
      iterator.close = vi.fn();
      iterator.getContextUsage = vi.fn(async () => null);
      return iterator;
    });

    const runtime = new ClaudeSessionRuntime({
      sessionId: "stale-session",
      resumeSessionId: "stale-session",
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test-4.json",
      options: {},
    });

    await runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.prompt("hello after restart");
    await runtime.close();

    expect(queryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(runtime.sessionId).toBe("recovered-session");
    expect(runtime.messages.filter((m) => m?.role === "assistant").length).toBe(1);
  });

  it("does not emit runtime_error when a turn is aborted", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();

    let rejectActiveTurn = null;
    let enteredTurnResolve;
    const enteredTurn = new Promise((resolve) => {
      enteredTurnResolve = resolve;
    });

    queryMock.mockImplementation(({ prompt }) => {
      async function* stream() {
        for await (const _input of prompt) {
          enteredTurnResolve?.();
          await new Promise((_, reject) => {
            rejectActiveTurn = reject;
          });
        }
      }
      const iterator = stream();
      iterator.close = vi.fn();
      iterator.getContextUsage = vi.fn(async () => null);
      iterator.interrupt = vi.fn(async () => {
        rejectActiveTurn?.(new Error("Request was aborted."));
      });
      return iterator;
    });

    const runtime = new ClaudeSessionRuntime({
      sessionId: "abort-session",
      resumeSessionId: null,
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test-abort.json",
      options: {},
    });

    const errors = [];
    const unsub = runtime.subscribe((event) => {
      if (event?.type === "runtime_error") errors.push(event);
    });

    const pending = runtime.prompt("please abort");
    await enteredTurn;
    await runtime.abort();
    await expect(pending).rejects.toThrow("Request was aborted.");

    unsub();
    await runtime.close();

    expect(errors).toEqual([]);
  });

  it("closes the active query when aborting so the turn stops promptly", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();

    let rejectActiveTurn = null;
    let enteredTurnResolve;
    const enteredTurn = new Promise((resolve) => {
      enteredTurnResolve = resolve;
    });

    const close = vi.fn();
    const interrupt = vi.fn(async () => {
      rejectActiveTurn?.(new Error("Request was aborted."));
    });

    queryMock.mockImplementation(({ prompt }) => {
      async function* stream() {
        for await (const _input of prompt) {
          enteredTurnResolve?.();
          await new Promise((_, reject) => {
            rejectActiveTurn = reject;
          });
        }
      }
      const iterator = stream();
      iterator.close = close;
      iterator.getContextUsage = vi.fn(async () => null);
      iterator.interrupt = interrupt;
      return iterator;
    });

    const runtime = new ClaudeSessionRuntime({
      sessionId: "abort-close-session",
      resumeSessionId: null,
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test-abort-close.json",
      options: {},
    });

    const pending = runtime.prompt("stop quickly");
    await enteredTurn;
    await expect(runtime.abort()).resolves.toBe(true);
    await expect(pending).rejects.toThrow("Request was aborted.");

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    await runtime.close();
  });

  it("releases pending turn immediately on abort even if interrupt does not end stream", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();

    let enteredTurnResolve;
    const enteredTurn = new Promise((resolve) => {
      enteredTurnResolve = resolve;
    });

    let unblockStream = null;
    let closed = false;
    const close = vi.fn(() => {
      closed = true;
      unblockStream?.();
    });
    const interrupt = vi.fn(async () => {
      // 模拟 SDK interrupt 未立即结束流（真实场景会偶发这个竞态）
    });

    queryMock.mockImplementation(({ prompt }) => {
      async function* stream() {
        for await (const _input of prompt) {
          enteredTurnResolve?.();
          await new Promise((resolve) => {
            unblockStream = resolve;
          });
          if (closed) {
            throw new Error("Query closed before response received");
          }
        }
      }
      const iterator = stream();
      iterator.close = close;
      iterator.getContextUsage = vi.fn(async () => null);
      iterator.interrupt = interrupt;
      return iterator;
    });

    const runtime = new ClaudeSessionRuntime({
      sessionId: "abort-immediate-release-session",
      resumeSessionId: null,
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test-abort-immediate-release.json",
      options: {},
    });

    const pending = runtime.prompt("stop quickly but keep responsive");
    await enteredTurn;

    await expect(runtime.abort()).resolves.toBe(true);
    await expect(pending).rejects.toThrow("Request was aborted.");
    expect(runtime.isStreaming).toBe(false);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    await runtime.close();
  });

  it("closes the active query even when interrupt never resolves", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();

    let enteredTurnResolve;
    const enteredTurn = new Promise((resolve) => {
      enteredTurnResolve = resolve;
    });

    let unblockStream = null;
    let closed = false;
    const close = vi.fn(() => {
      closed = true;
      unblockStream?.();
    });
    const interrupt = vi.fn(() => new Promise(() => {}));

    queryMock.mockImplementation(({ prompt }) => {
      async function* stream() {
        for await (const _input of prompt) {
          enteredTurnResolve?.();
          await new Promise((resolve) => {
            unblockStream = resolve;
          });
          if (closed) {
            throw new Error("Query closed before response received");
          }
        }
      }
      const iterator = stream();
      iterator.close = close;
      iterator.getContextUsage = vi.fn(async () => null);
      iterator.interrupt = interrupt;
      return iterator;
    });

    const runtime = new ClaudeSessionRuntime({
      sessionId: "abort-hanging-interrupt-session",
      resumeSessionId: null,
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test-abort-hanging-interrupt.json",
      options: {},
    });

    const pending = runtime.prompt("stop even if interrupt hangs");
    await enteredTurn;

    await expect(runtime.abort()).resolves.toBe(true);
    await expect(pending).rejects.toThrow("Request was aborted.");
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0]?.[0]?.options?.abortController?.signal?.aborted).toBe(true);

    await runtime.close();
  });

  it("ignores late messages from an aborted query", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();

    let enteredTurnResolve;
    const enteredTurn = new Promise((resolve) => {
      enteredTurnResolve = resolve;
    });
    let releaseLateMessages = null;

    queryMock.mockImplementation(({ prompt }) => {
      async function* stream() {
        for await (const _input of prompt) {
          enteredTurnResolve?.();
          await new Promise((resolve) => {
            releaseLateMessages = resolve;
          });
          yield {
            type: "assistant",
            message: {
              id: "late-after-abort",
              content: [{ type: "text", text: "this should not be recorded" }],
            },
          };
          yield {
            type: "result",
            session_id: "late-after-abort-session",
            is_error: false,
            usage: {},
          };
          return;
        }
      }
      const iterator = stream();
      iterator.close = vi.fn(() => {
        releaseLateMessages?.();
      });
      iterator.getContextUsage = vi.fn(async () => null);
      iterator.interrupt = vi.fn(async () => {});
      return iterator;
    });

    const runtime = new ClaudeSessionRuntime({
      sessionId: "abort-late-message-session",
      resumeSessionId: null,
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test-abort-late-message.json",
      options: {},
    });
    const events = [];
    runtime.subscribe((event) => events.push(event));

    const pending = runtime.prompt("stop before late output");
    await enteredTurn;
    await expect(runtime.abort()).resolves.toBe(true);
    await expect(pending).rejects.toThrow("Request was aborted.");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runtime.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "stop before late output" }],
      },
    ]);
    expect(events.some((event) => event?.message?.id === "late-after-abort")).toBe(false);
    expect(events.some((event) => event?.type === "result")).toBe(false);

    await runtime.close();
  });

  it("can start a new prompt immediately after abort without reusing old queue", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();

    let firstEnteredResolve;
    const firstEntered = new Promise((resolve) => {
      firstEnteredResolve = resolve;
    });

    let releaseFirstStream = null;
    let firstClosed = false;
    let queryCallCount = 0;

    queryMock.mockImplementation(({ prompt }) => {
      queryCallCount += 1;
      const callIndex = queryCallCount;

      async function* stream() {
        if (callIndex === 1) {
          for await (const _input of prompt) {
            firstEnteredResolve?.();
            await new Promise((resolve) => {
              releaseFirstStream = resolve;
            });
            if (firstClosed) {
              throw new Error("Query closed before response received");
            }
          }
          return;
        }

        for await (const _input of prompt) {
          yield {
            type: "assistant",
            message: {
              id: "after-abort-assistant",
              content: [{ type: "text", text: "after abort" }],
            },
          };
          yield {
            type: "result",
            session_id: "after-abort-session",
            is_error: false,
            usage: {},
          };
          return;
        }
      }

      const iterator = stream();
      iterator.getContextUsage = vi.fn(async () => null);
      iterator.interrupt = vi.fn(async () => {});
      iterator.close = vi.fn(() => {
        if (callIndex === 1) {
          firstClosed = true;
          setTimeout(() => releaseFirstStream?.(), 25);
        }
      });
      return iterator;
    });

    const runtime = new ClaudeSessionRuntime({
      sessionId: "abort-then-reprompt",
      resumeSessionId: null,
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test-abort-then-reprompt.json",
      options: {},
    });

    const firstPending = runtime.prompt("first prompt");
    await firstEntered;
    await expect(runtime.abort()).resolves.toBe(true);
    await expect(firstPending).rejects.toThrow("Request was aborted.");

    const secondResult = await runtime.prompt("second prompt after abort");
    expect(secondResult?.type).toBe("result");
    expect(queryCallCount).toBeGreaterThanOrEqual(2);

    await runtime.close();
  });

  it("keeps the turn pending across a steer interruption result", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();

    let firstAssistantResolve;
    const firstAssistantEmitted = new Promise((resolve) => {
      firstAssistantResolve = resolve;
    });
    let steerCalledResolve;
    const steerCalled = new Promise((resolve) => {
      steerCalledResolve = resolve;
    });
    let intermediateResultResolve;
    const intermediateResultSeen = new Promise((resolve) => {
      intermediateResultResolve = resolve;
    });

    queryMock.mockImplementation(({ prompt }) => {
      async function* stream() {
        let index = 0;
        for await (const input of prompt) {
          index += 1;
          if (index === 1) {
            yield {
              type: "assistant",
              message: {
                id: "before-steer",
                content: [{ type: "text", text: "before steer" }],
              },
            };
            firstAssistantResolve?.();
            await steerCalled;
            yield {
              type: "result",
              session_id: "steer-session",
              is_error: false,
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            intermediateResultResolve?.();
            continue;
          }

          expect(input.message.content[0].text).toContain("interrupt me");
          yield {
            type: "assistant",
            message: {
              id: "after-steer",
              content: [{ type: "text", text: "after steer" }],
            },
          };
          yield {
            type: "result",
            session_id: "steer-session",
            is_error: false,
            usage: { input_tokens: 2, output_tokens: 2 },
          };
          return;
        }
      }
      const iterator = stream();
      iterator.close = vi.fn();
      iterator.getContextUsage = vi.fn(async () => null);
      return iterator;
    });

    const runtime = new ClaudeSessionRuntime({
      sessionId: "steer-session",
      resumeSessionId: null,
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test-steer.json",
      options: {},
    });
    const events = [];
    runtime.subscribe((event) => events.push(event));

    const pending = runtime.prompt("first prompt");
    await firstAssistantEmitted;
    expect(runtime.steer("interrupt me")).toBe(true);
    steerCalledResolve?.();
    await intermediateResultSeen;
    expect(runtime.isStreaming).toBe(true);

    const result = await pending;
    expect(result?.type).toBe("result");
    expect(runtime.isStreaming).toBe(false);
    expect(events.filter((event) => event.type === "result")).toHaveLength(1);
    expect(events.filter((event) => event.type === "assistant").map((event) => event.message.id)).toEqual([
      "before-steer",
      "after-steer",
    ]);

    await runtime.close();
  });

  it("keeps conversation resume id after abort so later prompts continue context", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();

    let secondEnteredResolve;
    const secondEntered = new Promise((resolve) => {
      secondEnteredResolve = resolve;
    });

    let releaseSecondStream = null;
    let secondClosed = false;

    queryMock.mockImplementation(({ prompt }) => {
      const callNo = queryMock.mock.calls.length;

      async function* stream() {
        if (callNo === 1) {
          for await (const _input of prompt) {
            yield {
              type: "assistant",
              session_id: "persist-session",
              message: {
                id: "persist-first-assistant",
                content: [{ type: "text", text: "first reply" }],
              },
            };
            yield {
              type: "result",
              session_id: "persist-session",
              is_error: false,
              usage: {},
            };
            return;
          }
          return;
        }

        if (callNo === 2) {
          for await (const _input of prompt) {
            secondEnteredResolve?.();
            await new Promise((resolve) => {
              releaseSecondStream = resolve;
            });
            if (secondClosed) {
              throw new Error("Query closed before response received");
            }
          }
          return;
        }

        for await (const _input of prompt) {
          yield {
            type: "assistant",
            session_id: "persist-session",
            message: {
              id: "persist-third-assistant",
              content: [{ type: "text", text: "still same session" }],
            },
          };
          yield {
            type: "result",
            session_id: "persist-session",
            is_error: false,
            usage: {},
          };
          return;
        }
      }

      const iterator = stream();
      iterator.getContextUsage = vi.fn(async () => null);
      iterator.interrupt = vi.fn(async () => {});
      iterator.close = vi.fn(() => {
        if (callNo === 2) {
          secondClosed = true;
          setTimeout(() => releaseSecondStream?.(), 25);
        }
      });
      return iterator;
    });

    const runtime = new ClaudeSessionRuntime({
      sessionId: "local-metadata-placeholder",
      resumeSessionId: null,
      cwd: process.cwd(),
      sessionPath: "/tmp/hanako-runtime-test-abort-resume-preserve.json",
      options: {},
    });

    await runtime.prompt("first turn to get real session id");

    const secondPending = runtime.prompt("second turn then abort");
    await secondEntered;
    await expect(runtime.abort()).resolves.toBe(true);
    await expect(secondPending).rejects.toThrow("Request was aborted.");

    const thirdResult = await runtime.prompt("third turn should continue");
    expect(thirdResult?.type).toBe("result");

    expect(queryMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(queryMock.mock.calls[2]?.[0]?.options?.resume).toBe("persist-session");

    await runtime.close();
  });
});
