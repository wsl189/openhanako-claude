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

  it("keeps assistant sdk_message identity fields for frontend de-dup", () => {
    const coordinator = new SessionCoordinator({});
    const translated = coordinator._translateClaudeEvent({
      type: "assistant",
      uuid: "assistant-uuid-1",
      message: {
        id: "assistant-message-1",
        content: [{ type: "thinking", thinking: "plan" }],
      },
    }, "/tmp/session-with-assistant-id");

    expect(translated).toContainEqual({
      type: "sdk_message",
      message: {
        role: "assistant",
        messageId: "assistant-message-1",
        uuid: "assistant-uuid-1",
        content: [{ type: "thinking", thinking: "plan" }],
      },
    });
  });

  it("keeps partial assistant snapshots off the discrete sdk_message path", () => {
    const coordinator = new SessionCoordinator({});
    const content = [
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "hello" },
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
    ];

    const translated = coordinator._translateClaudeEvent({
      type: "assistant",
      message: { id: "assistant-message-1", content },
    }, "/tmp/session-partial-assistant", [], { suppressAssistantSdkMessage: true });

    expect(translated.some((evt) => evt.type === "sdk_message" && evt.message?.role === "assistant")).toBe(false);
    expect(translated).toContainEqual({ type: "assistant_snapshot", content });
    expect(translated).toContainEqual({
      type: "tool_start",
      name: "Read",
      toolCallId: "tool-1",
      args: { file_path: "README.md" },
    });
  });

  it("merges content_block_start text into the first text delta", () => {
    const coordinator = new SessionCoordinator({});
    const sessionPath = "/tmp/session-text-start-plus-delta";

    let translated = coordinator._translateClaudeEvent({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "完整正文" },
      },
    }, sessionPath);

    expect(translated).toEqual([]);

    translated = coordinator._translateClaudeEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "正文" },
      },
    }, sessionPath);

    expect(translated).toEqual([{ type: "text_delta", delta: "完整正文" }]);

    translated = coordinator._translateClaudeEvent({
      type: "stream_event",
      event: {
        type: "content_block_stop",
        index: 0,
      },
    }, sessionPath);

    expect(translated).toEqual([]);
  });

  it("dedupes cumulative first text delta that already includes content_block_start text", () => {
    const coordinator = new SessionCoordinator({});
    const sessionPath = "/tmp/session-text-start-cumulative-delta";

    let translated = coordinator._translateClaudeEvent({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "完整" },
      },
    }, sessionPath);

    expect(translated).toEqual([]);

    translated = coordinator._translateClaudeEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "完整正文" },
      },
    }, sessionPath);

    expect(translated).toEqual([{ type: "text_delta", delta: "完整正文" }]);

    translated = coordinator._translateClaudeEvent({
      type: "stream_event",
      event: {
        type: "content_block_stop",
        index: 0,
      },
    }, sessionPath);

    expect(translated).toEqual([]);
  });

  it("emits content_block_start text on stop when no text deltas arrive", () => {
    const coordinator = new SessionCoordinator({});
    const sessionPath = "/tmp/session-text-start-only";

    let translated = coordinator._translateClaudeEvent({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "只有起始块正文" },
      },
    }, sessionPath);

    expect(translated).toEqual([]);

    translated = coordinator._translateClaudeEvent({
      type: "stream_event",
      event: {
        type: "content_block_stop",
        index: 0,
      },
    }, sessionPath);

    expect(translated).toEqual([{ type: "text_delta", delta: "只有起始块正文" }]);
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

  it("normalizes Claude TodoWrite results into todo details for the UI", () => {
    const coordinator = new SessionCoordinator({});
    const sessionPath = "/tmp/session-todowrite";

    coordinator._translateClaudeEvent({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "todo-1",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "verify TodoWrite event", status: "in_progress", activeForm: "verifying TodoWrite event" },
              { content: "report result", status: "pending", activeForm: "reporting result" },
            ],
          },
        }],
      },
    }, sessionPath);

    const translated = coordinator._translateClaudeEvent({
      type: "user",
      tool_use_result: {
        oldTodos: [],
        newTodos: [
          { content: "verify TodoWrite event", status: "completed", activeForm: "verifying TodoWrite event" },
          { content: "report result", status: "pending", activeForm: "reporting result" },
        ],
        verificationNudgeNeeded: false,
      },
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "todo-1",
          content: "Todos have been modified successfully.",
        }],
      },
    }, sessionPath);

    expect(translated).toContainEqual(expect.objectContaining({
      type: "tool_end",
      name: "TodoWrite",
      toolCallId: "todo-1",
      details: {
        todos: [
          {
            content: "verify TodoWrite event",
            text: "verify TodoWrite event",
            status: "completed",
            activeForm: "verifying TodoWrite event",
            done: true,
          },
          {
            content: "report result",
            text: "report result",
            status: "pending",
            activeForm: "reporting result",
            done: false,
          },
        ],
      },
    }));
  });

  it("merges write-like tool_use_result details for diff preview data", () => {
    const coordinator = new SessionCoordinator({});
    const sessionPath = "/tmp/session-write-diff";

    coordinator._translateClaudeEvent({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "edit-1",
          name: "Edit",
          input: {
            file_path: "/tmp/poem.txt",
            old_string: "春眠不觉晓",
            new_string: "处处闻啼鸟",
          },
        }],
      },
    }, sessionPath);

    const translated = coordinator._translateClaudeEvent({
      type: "user",
      tool_use_result: {
        file_path: "/tmp/poem.txt",
        oldString: "春眠不觉晓",
        newString: "处处闻啼鸟",
        structured_patch: [{
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-春眠不觉晓", "+处处闻啼鸟"],
        }],
        userModified: false,
      },
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "edit-1",
          content: "updated",
        }],
      },
    }, sessionPath);

    expect(translated).toContainEqual(expect.objectContaining({
      type: "tool_end",
      name: "Edit",
      toolCallId: "edit-1",
      success: true,
      details: expect.objectContaining({
        filePath: "/tmp/poem.txt",
        oldString: "春眠不觉晓",
        newString: "处处闻啼鸟",
        userModified: false,
        structuredPatch: [{
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-春眠不觉晓", "+处处闻啼鸟"],
        }],
      }),
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

  it("marks lone minimax closing tag text as protocol mismatch", () => {
    const coordinator = new SessionCoordinator({});
    const sessionPath = "/tmp/session-markup-minimax-close";

    coordinator._translateClaudeEvent({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: "</minimax:tool_call>",
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

  it("prefers explicit tool_end success over details.error for custom tools", () => {
    const coordinator = new SessionCoordinator({});
    const sessionPath = "/tmp/session-custom-tool-success";

    coordinator._translateClaudeEvent({
      type: "tool_start",
      name: "mcp__hanako__generate_images",
      toolCallId: "custom-tool-1",
      args: { prompt: "a cute puppy" },
    }, sessionPath);

    const translated = coordinator._translateClaudeEvent({
      type: "tool_end",
      name: "mcp__hanako__generate_images",
      toolCallId: "custom-tool-1",
      success: true,
      details: { error: "legacy-warning", imageCount: 1 },
      content: [{ type: "text", text: "generated successfully" }],
    }, sessionPath);

    expect(translated).toContainEqual(expect.objectContaining({
      type: "tool_end",
      toolCallId: "custom-tool-1",
      success: true,
    }));
  });

  it("normalizes mcp-prefixed custom tool names to avoid duplicate browser rows", () => {
    const coordinator = new SessionCoordinator({});
    const sessionPath = "/tmp/session-custom-tool-mcp-alias";
    const customToolNames = ["browser"];

    const mcpStart = coordinator._translateClaudeEvent({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "sdk-tool-1",
          name: "mcp__hanako__browser",
          input: { url: "https://news.google.com" },
        }],
      },
    }, sessionPath, customToolNames);
    expect(mcpStart).toContainEqual(expect.objectContaining({
      type: "tool_start",
      name: "browser",
      toolCallId: "sdk-tool-1",
    }));

    const customStart = coordinator._translateClaudeEvent({
      type: "tool_start",
      name: "browser",
      toolCallId: "custom-tool-1",
      args: { url: "https://news.google.com" },
    }, sessionPath, customToolNames);
    expect(customStart.some((event) => event.type === "tool_start")).toBe(false);

    const mcpToolResult = coordinator._translateClaudeEvent({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "sdk-tool-1",
          content: [{ type: "text", text: "ok" }],
        }],
      },
    }, sessionPath, customToolNames);
    expect(mcpToolResult.some((event) => event.type === "tool_end")).toBe(false);

    const customEnd = coordinator._translateClaudeEvent({
      type: "tool_end",
      name: "browser",
      toolCallId: "custom-tool-1",
      success: true,
      content: [{ type: "text", text: "ok" }],
    }, sessionPath, customToolNames);
    expect(customEnd).toContainEqual(expect.objectContaining({
      type: "tool_end",
      name: "browser",
      success: true,
    }));
    expect(customEnd.some((event) => event.name === "mcp__hanako__browser")).toBe(false);
  });

  it("normalizes custom MCP sub-tools and suppresses duplicate start rows", () => {
    const coordinator = new SessionCoordinator({});
    const sessionPath = "/tmp/session-custom-mcp-alias";
    const customToolNames = ["browser"];

    const mcpStart = coordinator._translateClaudeEvent({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "sdk-tool-browser-1",
          name: "mcp__hanako__browser",
          input: {},
        }],
      },
    }, sessionPath, customToolNames);
    expect(mcpStart).toContainEqual(expect.objectContaining({
      type: "tool_start",
      name: "browser",
      toolCallId: "sdk-tool-browser-1",
    }));

    const customStart = coordinator._translateClaudeEvent({
      type: "tool_start",
      name: "browser",
      toolCallId: "custom-browser-1",
      args: {},
    }, sessionPath, customToolNames);
    expect(customStart.some((event) => event.type === "tool_start")).toBe(false);

    const mcpToolResult = coordinator._translateClaudeEvent({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "sdk-tool-browser-1",
          content: [{ type: "text", text: "Captured current display (1920x1080)." }],
        }],
      },
    }, sessionPath, customToolNames);
    expect(mcpToolResult.some((event) => event.type === "tool_end")).toBe(false);

    const customEnd = coordinator._translateClaudeEvent({
      type: "tool_end",
      name: "browser",
      toolCallId: "custom-browser-1",
      success: true,
      content: [{ type: "text", text: "Captured current display (1920x1080)." }],
    }, sessionPath, customToolNames);
    expect(customEnd).toContainEqual(expect.objectContaining({
      type: "tool_end",
      name: "browser",
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
