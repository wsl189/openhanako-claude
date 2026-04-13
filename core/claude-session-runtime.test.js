import { describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSessionRuntime } from "./claude-session-runtime.js";

describe("ClaudeSessionRuntime resume recovery", () => {
  it("forces includePartialMessages=false for SDK query", async () => {
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
    expect(queryMock.mock.calls[0]?.[0]?.options?.includePartialMessages).toBe(false);
    expect(queryMock.mock.calls[0]?.[0]?.options?.persistSession).toBe(true);
  });

  it("re-applies configured mcpServers via setMcpServers on start", async () => {
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

    expect(setMcpServers).toHaveBeenCalledTimes(1);
    expect(setMcpServers).toHaveBeenCalledWith(mcpServers);
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
});
