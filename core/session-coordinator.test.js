import { describe, expect, it } from "vitest";
import { SessionCoordinator } from "./session-coordinator.js";

describe("SessionCoordinator._shouldUseProviderRuntime", () => {
  it("uses provider runtime for openai-compatible APIs", () => {
    const coordinator = new SessionCoordinator({});
    expect(coordinator._shouldUseProviderRuntime({
      api: "openai-completions",
      provider: "openai",
      base_url: "https://api.openai.com/v1",
    })).toBe(true);
  });

  it("keeps official Anthropic endpoints on Claude SDK runtime", () => {
    const coordinator = new SessionCoordinator({});
    expect(coordinator._shouldUseProviderRuntime({
      api: "anthropic-messages",
      provider: "anthropic",
      base_url: "https://api.anthropic.com/v1/messages",
    })).toBe(false);
  });

  it("routes known anthropic-compatible providers to provider runtime", () => {
    const coordinator = new SessionCoordinator({});
    expect(coordinator._shouldUseProviderRuntime({
      api: "anthropic-messages",
      provider: "minimax",
      base_url: "https://api.minimaxi.com/anthropic",
    })).toBe(true);
  });

  it("routes non-anthropic unofficial anthropic gateways to provider runtime", () => {
    const coordinator = new SessionCoordinator({});
    expect(coordinator._shouldUseProviderRuntime({
      api: "anthropic-messages",
      provider: "vendor-x",
      base_url: "https://api.vendor.example/anthropic",
    })).toBe(true);
  });
});

describe("SessionCoordinator._translateClaudeEvent", () => {
  it("emits sdk_message for assistant content blocks", () => {
    const coordinator = new SessionCoordinator({});
    const content = [
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "hello" },
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
    ];

    const translated = coordinator._translateClaudeEvent({
      type: "assistant",
      message: { content },
    }, "/tmp/session-a");

    expect(translated).toContainEqual({
      type: "sdk_message",
      message: { role: "assistant", content },
    });
    expect(translated).toContainEqual({
      type: "tool_start",
      name: "Read",
      toolCallId: "tool-1",
      args: { file_path: "README.md" },
    });
    expect(translated).toContainEqual({ type: "assistant_snapshot", content });
  });

  it("emits sdk_message for user tool_result blocks", () => {
    const coordinator = new SessionCoordinator({});

    coordinator._translateClaudeEvent({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "tool-2", name: "Bash", input: { command: "npm test" } }],
      },
    }, "/tmp/session-b");

    const translated = coordinator._translateClaudeEvent({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tool-2",
          is_error: true,
          content: [{ type: "text", text: "permission denied" }],
        }],
      },
    }, "/tmp/session-b");

    expect(translated).toContainEqual({
      type: "sdk_message",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-2",
          is_error: true,
          content: [{ type: "text", text: "permission denied" }],
        }],
      },
    });
    expect(translated).toContainEqual(expect.objectContaining({
      type: "tool_end",
      toolCallId: "tool-2",
      success: false,
    }));
  });

  it("falls back to parse text tool markup in assistant content", () => {
    const coordinator = new SessionCoordinator({});
    const content = [{
      type: "text",
      text: "<function_calls><invoke name=\"Bash\"><parameter name=\"command\">ls -la</parameter></invoke></function_calls>",
    }];

    const translated = coordinator._translateClaudeEvent({
      type: "assistant",
      message: { content },
    }, "/tmp/session-c");

    expect(translated).toContainEqual({
      type: "tool_start",
      name: "Bash",
      toolCallId: expect.any(String),
      args: { command: "ls -la" },
    });
  });

  it("falls back to latest pending tool when tool_result id mismatches", () => {
    const coordinator = new SessionCoordinator({});
    coordinator._translateClaudeEvent({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: "<function_calls><invoke name=\"Bash\"><parameter name=\"command\">pwd</parameter></invoke></function_calls>",
        }],
      },
    }, "/tmp/session-d");

    const translated = coordinator._translateClaudeEvent({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "sdk-tool-use-id",
          content: [{ type: "text", text: "/Users/tc" }],
        }],
      },
    }, "/tmp/session-d");

    expect(translated).toContainEqual(expect.objectContaining({
      type: "tool_end",
      name: "Bash",
      success: true,
    }));
  });
});
