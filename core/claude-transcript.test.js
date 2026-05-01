import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

import {
  buildSessionMessagesFromTranscriptEntries,
  encodeClaudeProjectDir,
  resolveClaudeTranscriptPath,
} from "./claude-transcript.js";

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === null || value === undefined || value === "") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      const old = previous[key];
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    }
  }
}

describe("resolveClaudeTranscriptPath", () => {
  it("resolves transcript from HANA_HOME agent projects", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-transcript-hana-home-"));
    const sessionId = `sid-hana-home-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const cwd = "/Users/demo/project";
    const transcriptPath = path.join(
      root,
      "agents",
      "agent-test",
      "projects",
      encodeClaudeProjectDir(cwd),
      `${sessionId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, "", "utf-8");

    const resolved = withEnv(
      {
        HANA_HOME: root,
        CLAUDE_CONFIG_DIR: "",
      },
      () => resolveClaudeTranscriptPath(sessionId, cwd),
    );
    expect(resolved).toBe(transcriptPath);
  });

  it("resolves transcript from CLAUDE_CONFIG_DIR projects", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-transcript-claude-config-"));
    const sessionId = `sid-claude-config-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const cwd = "/Users/demo/workspace";
    const transcriptPath = path.join(
      root,
      "projects",
      encodeClaudeProjectDir(cwd),
      `${sessionId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, "", "utf-8");

    const resolved = withEnv(
      {
        CLAUDE_CONFIG_DIR: root,
        HANA_HOME: path.join(root, "no-hanako-home"),
      },
      () => resolveClaudeTranscriptPath(sessionId, cwd),
    );
    expect(resolved).toBe(transcriptPath);
  });
});

describe("buildSessionMessagesFromTranscriptEntries", () => {
  it("filters internal skill/compaction transcript user entries", () => {
    const entries = [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "正常用户输入" }],
        },
      },
      {
        type: "user",
        isMeta: true,
        sourceToolUseID: "tool-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "Base directory for this skill: /tmp/skill\n\n# SKILL" }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "text",
            text: "This session is being continued from a previous conversation that ran out of context. ...",
          }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "[Request interrupted by user]" }],
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "助手回复" }],
        },
      },
    ];

    const out = buildSessionMessagesFromTranscriptEntries(entries);
    expect(out).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "正常用户输入" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "助手回复" }],
      },
    ]);
  });

  it("keeps user tool_result blocks as tool messages", () => {
    const entries = [
      {
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool-use-1", name: "web_fetch", input: { url: "https://a.com" } }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-use-1", content: "ok" }],
        },
      },
    ];

    const out = buildSessionMessagesFromTranscriptEntries(entries);
    expect(out).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-use-1", name: "web_fetch", input: { url: "https://a.com" } }],
      },
      {
        role: "tool",
        toolName: "web_fetch",
        args: { url: "https://a.com" },
        toolUseId: "tool-use-1",
        content: [{ type: "text", text: "ok" }],
        details: undefined,
      },
    ]);
  });
});
