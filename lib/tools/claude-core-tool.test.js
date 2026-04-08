import { describe, expect, it } from "vitest";
import { createClaudeCoreTool } from "./claude-core-tool.js";

function createCtx(cwd = "/tmp/workspace", sessionId = "s-1") {
  return {
    sessionManager: {
      getCwd: () => cwd,
      getSessionId: () => sessionId,
    },
  };
}

describe("claude-core-tool", () => {
  it("validates task parameter", async () => {
    const tool = createClaudeCoreTool({
      resolveEntryPath: () => "/tmp/claude-core/dist/cli.js",
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => true }),
      runCommand: async () => ({ exitCode: 0, output: "ok", truncated: false }),
    });

    const result = await tool.execute("tc-1", { task: "   " }, null, null, createCtx());
    expect(result.details?.error).toBe("task_required");
    expect(typeof result.content?.[0]?.text).toBe("string");
  });

  it("returns claude-core output on success", async () => {
    let received = null;
    const tool = createClaudeCoreTool({
      resolveEntryPath: () => "/tmp/claude-core/dist/cli.js",
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => true }),
      runCommand: async (opts) => {
        received = opts;
        return { exitCode: 0, output: "done", truncated: false, durationMs: 123 };
      },
    });

    const result = await tool.execute(
      "tc-2",
      {
        task: "fix tests",
        model: "claude-sonnet",
        max_turns: 4,
        permission_mode: "acceptEdits",
      },
      null,
      null,
      createCtx("/tmp/repo"),
    );

    expect(result.details?.action).toBe("completed");
    expect(result.content?.[0]?.text).toContain("done");
    expect(received?.cwd).toBe("/tmp/repo");
    expect(Array.isArray(received?.args)).toBe(true);
    expect(received.args).toContain("--dangerously-skip-permissions");
    expect(received.args).toContain("--model");
    expect(received.args).toContain("claude-sonnet");
    expect(result.details?.continued).toBe(false);
  });

  it("reports non-zero exit as failure", async () => {
    const tool = createClaudeCoreTool({
      resolveEntryPath: () => "/tmp/claude-core/dist/cli.js",
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => true }),
      runCommand: async () => ({ exitCode: 2, output: "permission denied", truncated: false }),
    });

    const result = await tool.execute("tc-3", { task: "run build" }, null, null, createCtx());
    expect(result.details?.error).toBe("exit_non_zero");
    expect(typeof result.content?.[0]?.text).toBe("string");
  });

  it("maps timeout error correctly", async () => {
    const tool = createClaudeCoreTool({
      resolveEntryPath: () => "/tmp/claude-core/dist/cli.js",
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => true }),
      runCommand: async () => {
        throw new Error("timeout:600");
      },
    });

    const result = await tool.execute("tc-4", { task: "long task", timeout_sec: 60 }, null, null, createCtx());
    expect(result.details?.error).toBe("timeout");
  });

  it("rejects non-absolute cwd", async () => {
    const tool = createClaudeCoreTool({
      resolveEntryPath: () => "/tmp/claude-core/dist/cli.js",
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => true }),
      runCommand: async () => ({ exitCode: 0, output: "ok", truncated: false }),
    });

    const result = await tool.execute("tc-5", { task: "x", cwd: "relative/path" }, null, null, createCtx());
    expect(result.details?.error).toBe("cwd_not_absolute");
  });

  it("passes -c when continue is explicitly true", async () => {
    let received = null;
    const tool = createClaudeCoreTool({
      resolveEntryPath: () => "/tmp/claude-core/dist/cli.js",
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => true }),
      runCommand: async (opts) => {
        received = opts;
        return { exitCode: 0, output: "ok", truncated: false };
      },
    });

    const result = await tool.execute(
      "tc-6",
      { task: "continue this task", continue: true },
      null,
      null,
      createCtx("/tmp/repo", "s-continue"),
    );

    expect(received.args).toContain("-c");
    expect(result.details?.continued).toBe(true);
    expect(result.details?.continueSource).toBe("explicit");
  });

  it("auto-continues for related task in same session", async () => {
    const argsList = [];
    const tool = createClaudeCoreTool({
      resolveEntryPath: () => "/tmp/claude-core/dist/cli.js",
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => true }),
      runCommand: async (opts) => {
        argsList.push(opts.args);
        return { exitCode: 0, output: "ok", truncated: false };
      },
    });

    await tool.execute(
      "tc-7a",
      { task: "Refactor auth module and add retry strategy" },
      null,
      null,
      createCtx("/tmp/repo", "s-auto"),
    );
    const second = await tool.execute(
      "tc-7b",
      { task: "Continue refactoring auth module, fix edge cases" },
      null,
      null,
      createCtx("/tmp/repo", "s-auto"),
    );

    expect(argsList[0]).not.toContain("-c");
    expect(argsList[1]).toContain("-c");
    expect(second.details?.continued).toBe(true);
    expect(second.details?.continueSource).toBe("auto-hit");
  });

  it("does not auto-continue for unrelated task", async () => {
    const argsList = [];
    const tool = createClaudeCoreTool({
      resolveEntryPath: () => "/tmp/claude-core/dist/cli.js",
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => true }),
      runCommand: async (opts) => {
        argsList.push(opts.args);
        return { exitCode: 0, output: "ok", truncated: false };
      },
    });

    await tool.execute(
      "tc-8a",
      { task: "Implement Redis cache layer with tests" },
      null,
      null,
      createCtx("/tmp/repo", "s-auto-2"),
    );
    const second = await tool.execute(
      "tc-8b",
      { task: "Write onboarding documentation for product PMs" },
      null,
      null,
      createCtx("/tmp/repo", "s-auto-2"),
    );

    expect(argsList[1]).not.toContain("-c");
    expect(second.details?.continued).toBe(false);
  });
});
