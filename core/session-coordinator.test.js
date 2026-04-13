import { describe, expect, it } from "vitest";
import { SessionCoordinator } from "./session-coordinator.js";

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

  it("does not parse text tool markup fallback in assistant content", () => {
    const coordinator = new SessionCoordinator({});
    const content = [{
      type: "text",
      text: "<function_calls><invoke name=\"Bash\"><parameter name=\"command\">ls -la</parameter></invoke></function_calls>",
    }];

    const translated = coordinator._translateClaudeEvent({
      type: "assistant",
      message: { content },
    }, "/tmp/session-c");

    expect(translated.some((event) => event.type === "tool_start")).toBe(false);
  });

  it("marks text-style tool markup turn as protocol mismatch", () => {
    const coordinator = new SessionCoordinator({});
    const sessionPath = "/tmp/session-markup";

    coordinator._translateClaudeEvent({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "<Glob><path>/Users/tc/Desktop/*</path></Glob>" }],
      },
    }, sessionPath);

    coordinator._translateClaudeEvent({
      type: "result",
      is_error: false,
    }, sessionPath);

    const state = coordinator._streamState.get(sessionPath);
    expect(state?.lastTurnProtocolMismatch).toBe(true);
  });

  it("marks singular function_call text block as protocol mismatch", () => {
    const coordinator = new SessionCoordinator({});
    const sessionPath = "/tmp/session-markup-function-call";

    coordinator._translateClaudeEvent({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: "function_call\n{\"tool\":\"Glob\",\"input\":{\"AbsolutePathPattern\":\"/Users/tc/Desktop/*\"}}\n</function_call>",
        }],
      },
    }, sessionPath);

    coordinator._translateClaudeEvent({
      type: "result",
      is_error: false,
    }, sessionPath);

    const state = coordinator._streamState.get(sessionPath);
    expect(state?.lastTurnProtocolMismatch).toBe(true);
  });

  it("marks plain tool_call trace text as protocol mismatch", () => {
    const coordinator = new SessionCoordinator({});
    const sessionPath = "/tmp/session-markup-tool-call-trace";

    coordinator._translateClaudeEvent({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: "tool_call: - id: \"glob_1\" depth: \"1\" dir: \"/Users/tc/Desktop\" Glob: null\ntool_call_end: glob_1",
        }],
      },
    }, sessionPath);

    coordinator._translateClaudeEvent({
      type: "result",
      is_error: false,
    }, sessionPath);

    const state = coordinator._streamState.get(sessionPath);
    expect(state?.lastTurnProtocolMismatch).toBe(true);
  });

  it("does not mark protocol mismatch when structured tool_use exists", () => {
    const coordinator = new SessionCoordinator({});
    const sessionPath = "/tmp/session-structured-tool";

    coordinator._translateClaudeEvent({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "tool-9", name: "Glob", input: { path: "/Users/tc/Desktop/*" } }],
      },
    }, sessionPath);

    coordinator._translateClaudeEvent({
      type: "result",
      is_error: false,
    }, sessionPath);

    const state = coordinator._streamState.get(sessionPath);
    expect(state?.lastTurnProtocolMismatch).toBe(false);
  });

  it("falls back to latest pending tool when tool_result id mismatches", () => {
    const coordinator = new SessionCoordinator({});
    coordinator._translateClaudeEvent({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "tool-structured-1",
          name: "Bash",
          input: { command: "pwd" },
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

  it("does not surface ede_diagnostic-only result errors", () => {
    const coordinator = new SessionCoordinator({});
    const translated = coordinator._translateClaudeEvent({
      type: "result",
      is_error: true,
      errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
    }, "/tmp/session-e");

    expect(translated).toEqual([{ type: "turn_end" }]);
  });

  it("prefers real result error after ede_diagnostic preface", () => {
    const coordinator = new SessionCoordinator({});
    const translated = coordinator._translateClaudeEvent({
      type: "result",
      is_error: true,
      errors: [
        "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
        "Permission denied",
      ],
    }, "/tmp/session-f");

    expect(translated).toContainEqual({
      type: "error",
      message: "Permission denied",
    });
    expect(translated).toContainEqual({ type: "turn_end" });
  });

  it("does not surface abort-like runtime errors", () => {
    const coordinator = new SessionCoordinator({});
    const translated = coordinator._translateClaudeEvent({
      type: "runtime_error",
      error: {
        message: "Error: Request was aborted.\n    at ML.makeRequest (file:///tmp/cli.js:47:3448)",
      },
    }, "/tmp/session-abort-runtime");

    expect(translated).toEqual([{ type: "turn_end" }]);
  });

  it("does not surface query-closed runtime errors", () => {
    const coordinator = new SessionCoordinator({});
    const translated = coordinator._translateClaudeEvent({
      type: "runtime_error",
      error: {
        message: "Error: Query closed before response received",
      },
    }, "/tmp/session-query-closed-runtime");

    expect(translated).toEqual([{ type: "turn_end" }]);
  });

  it("does not surface abort-like result errors", () => {
    const coordinator = new SessionCoordinator({});
    const translated = coordinator._translateClaudeEvent({
      type: "result",
      is_error: true,
      errors: ["Error: Request was aborted."],
    }, "/tmp/session-abort-result");

    expect(translated).toEqual([{ type: "turn_end" }]);
  });

  it("does not surface SDK telemetry export runtime errors", () => {
    const coordinator = new SessionCoordinator({});
    const translated = coordinator._translateClaudeEvent({
      type: "runtime_error",
      error: {
        message: "Error: 1P event logging: 19 events failed to export (status=403, code=ERR_BAD_REQUEST, Request failed with status code 403) at bL1.queueFailedEvents (file:///tmp/node_modules/@anthropic-ai/claude-agent-sdk/cli.js:1:1)",
      },
    }, "/tmp/session-sdk-telemetry-runtime");

    expect(translated).toEqual([{ type: "turn_end" }]);
  });

  it("does not surface SDK telemetry export runtime errors in new format", () => {
    const coordinator = new SessionCoordinator({});
    const translated = coordinator._translateClaudeEvent({
      type: "runtime_error",
      error: {
        message: "Error: Failed to export 17 events (status=403, code=ERR_BAD_REQUEST, Request failed with status code 403)\n at bL1.doExport (file:///tmp/node_modules/@anthropic-ai/claude-agent-sdk/cli.js:1:1)",
      },
    }, "/tmp/session-sdk-telemetry-runtime-new");

    expect(translated).toEqual([{ type: "turn_end" }]);
  });

  it("does not surface SDK telemetry export result errors", () => {
    const coordinator = new SessionCoordinator({});
    const translated = coordinator._translateClaudeEvent({
      type: "result",
      is_error: true,
      errors: [
        "Error: 1P event logging: 3 events failed to export (status=403, code=ERR_BAD_REQUEST, Request failed with status code 403) at bL1.doExport (file:///tmp/node_modules/@anthropic-ai/claude-agent-sdk/cli.js:1:1)",
      ],
    }, "/tmp/session-sdk-telemetry-result");

    expect(translated).toEqual([{ type: "turn_end" }]);
  });

  it("does not surface SDK telemetry export result errors in new format", () => {
    const coordinator = new SessionCoordinator({});
    const translated = coordinator._translateClaudeEvent({
      type: "result",
      is_error: true,
      errors: [
        "Error: Failed to export 17 events (status=403, code=ERR_BAD_REQUEST, Request failed with status code 403)\n at bL1.doExport (file:///tmp/node_modules/@anthropic-ai/claude-agent-sdk/cli.js:1:1)",
      ],
    }, "/tmp/session-sdk-telemetry-result-new");

    expect(translated).toEqual([{ type: "turn_end" }]);
  });
});
