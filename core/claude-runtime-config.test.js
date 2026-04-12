import { describe, expect, it } from "vitest";
import { buildClaudeRuntimeConfig } from "./claude-runtime-config.js";

function createConfig(overrides = {}) {
  return buildClaudeRuntimeConfig({
    agent: {
      agentDir: "/tmp/agent",
      buildSystemAppendPrompt: () => "",
      ...overrides.agent,
    },
    cwd: "/tmp",
    workspace: "/tmp",
    ...overrides,
  });
}

describe("buildClaudeRuntimeConfig env", () => {
  it("inherits process env by default", () => {
    const config = createConfig();
    const inheritedKey = ["PATH", "HOME", "USERPROFILE"].find((key) => typeof process.env[key] === "string");
    expect(inheritedKey).toBeTruthy();
    expect(config.options.env[inheritedKey]).toBe(process.env[inheritedKey]);
  });

  it("allows explicit env overrides", () => {
    const config = createConfig({
      env: {
        PATH: "/custom/path",
        HANAKO_TEST_ENV: "ok",
      },
    });

    expect(config.options.env.PATH).toBe("/custom/path");
    expect(config.options.env.HANAKO_TEST_ENV).toBe("ok");
  });

  it("uses Proma-aligned non-partial streaming and permission settings", () => {
    const config = createConfig();
    expect(config.options.includePartialMessages).toBe(false);
    expect(config.options.permissionMode).toBe("acceptEdits");
    expect(config.options.allowDangerouslySkipPermissions).toBe(false);
  });

  it("restricts strict sandbox filesystem to workspace and explicit whitelist rules", () => {
    const config = createConfig({
      workspace: "/tmp/workspace",
      toolProfile: {
        sandbox: {
          mode: "standard",
          path_rules: [
            { path: "/tmp/ro", access: "read_only" },
            { path: "/tmp/rw", access: "read_write" },
          ],
        },
      },
    });

    expect(config.options.sandbox).toMatchObject({
      enabled: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowRead: ["/tmp/workspace", "/tmp/ro", "/tmp/rw"],
        allowWrite: ["/tmp/workspace", "/tmp/rw"],
      },
    });
  });

  it("uses Proma-aligned setting sources and does not force options.tools by default", () => {
    const config = createConfig({
      toolProfile: {
        tools: {
          builtin_enabled: ["Read", "Glob", "Grep"],
        },
      },
    });
    expect(config.options.settingSources).toEqual(["user", "project"]);
    expect(config.options.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect("tools" in config.options).toBe(false);
  });

  it("can force options.tools via env for compatibility debugging", () => {
    const original = process.env.HANAKO_FORCE_SDK_TOOLS_OPTION;
    process.env.HANAKO_FORCE_SDK_TOOLS_OPTION = "1";
    try {
      const config = createConfig({
        toolProfile: {
          tools: {
            builtin_enabled: ["Read", "Glob"],
          },
        },
      });
      expect(config.options.tools).toEqual(["Read", "Glob"]);
      expect(config.options.allowedTools).toEqual(["Read", "Glob"]);
      expect(config.diagnostics?.forcedToolsOption).toBe(true);
    } finally {
      if (original === undefined) delete process.env.HANAKO_FORCE_SDK_TOOLS_OPTION;
      else process.env.HANAKO_FORCE_SDK_TOOLS_OPTION = original;
    }
  });

  it("installs canUseTool handler by default to avoid permission prompt deadlocks", async () => {
    const original = process.env.HANAKO_CLAUDE_PERMISSION_STRATEGY;
    delete process.env.HANAKO_CLAUDE_PERMISSION_STRATEGY;
    try {
      const config = createConfig();
      expect(typeof config.options.canUseTool).toBe("function");
      const decision = await config.options.canUseTool("mcp__MiniMax__web_search", { query: "latest" }, {
        signal: new AbortController().signal,
        toolUseID: "tool-1",
      });
      expect(decision).toMatchObject({
        behavior: "allow",
        updatedInput: { query: "latest" },
      });
      expect(config.diagnostics?.permissionStrategy).toBe("auto_allow");
      expect(config.diagnostics?.hasCanUseTool).toBe(true);
    } finally {
      if (original === undefined) delete process.env.HANAKO_CLAUDE_PERMISSION_STRATEGY;
      else process.env.HANAKO_CLAUDE_PERMISSION_STRATEGY = original;
    }
  });

  it("denies Bash calls that explicitly try to disable sandbox", async () => {
    const config = createConfig();
    const decision = await config.options.canUseTool("Bash", {
      command: "ls",
      dangerouslyDisableSandbox: true,
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-bash-1",
    });
    expect(decision).toMatchObject({
      behavior: "deny",
    });
    expect(decision.message).toContain("disabling sandbox");
  });

  it("denies Bash privilege escalation commands while allowing normal Bash commands", async () => {
    const config = createConfig();
    const denied = await config.options.canUseTool("Bash", {
      command: "sudo ls /",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-bash-2",
    });
    expect(denied).toMatchObject({
      behavior: "deny",
    });

    const allowed = await config.options.canUseTool("Bash", {
      command: "npm test",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-bash-3",
    });
    expect(allowed).toMatchObject({
      behavior: "allow",
      updatedInput: { command: "npm test" },
    });
  });

  it("denies Bash path access outside workspace/path_rules in strict mode", async () => {
    const config = createConfig({
      workspace: "/tmp/workspace",
      toolProfile: {
        sandbox: {
          mode: "standard",
          path_rules: [{ path: "/tmp/extra", access: "read_only" }],
        },
      },
    });

    const denied = await config.options.canUseTool("Bash", {
      command: "ls -la /tmp/outside",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-bash-4",
    });
    expect(denied).toMatchObject({ behavior: "deny" });
    expect(denied.message).toContain("/tmp/outside");

    const allowedWorkspace = await config.options.canUseTool("Bash", {
      command: "ls -la /tmp/workspace",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-bash-5",
    });
    expect(allowedWorkspace).toMatchObject({ behavior: "allow" });

    const allowedWhitelist = await config.options.canUseTool("Bash", {
      command: "cat /tmp/extra/readme.txt",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-bash-6",
    });
    expect(allowedWhitelist).toMatchObject({ behavior: "allow" });
  });

  it("allows outside path inspection in balanced mode (sandbox policy governs runtime execution)", async () => {
    const config = createConfig({
      workspace: "/tmp/workspace",
      toolProfile: {
        sandbox: {
          mode: "balanced",
          path_rules: [{ path: "/tmp/extra", access: "read_only" }],
        },
      },
    });
    const decision = await config.options.canUseTool("Bash", {
      command: "ls -la /tmp/outside",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-bash-7",
    });
    expect(decision).toMatchObject({ behavior: "allow" });
  });

  it("supports disabling auto permission handler via env", () => {
    const original = process.env.HANAKO_CLAUDE_PERMISSION_STRATEGY;
    process.env.HANAKO_CLAUDE_PERMISSION_STRATEGY = "none";
    try {
      const config = createConfig();
      expect(config.options.canUseTool).toBeUndefined();
      expect(config.diagnostics?.permissionStrategy).toBe("none");
      expect(config.diagnostics?.hasCanUseTool).toBe(false);
    } finally {
      if (original === undefined) delete process.env.HANAKO_CLAUDE_PERMISSION_STRATEGY;
      else process.env.HANAKO_CLAUDE_PERMISSION_STRATEGY = original;
    }
  });
});
