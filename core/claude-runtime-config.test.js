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

  it("defaults CLAUDE_CONFIG_DIR to current agent directory", () => {
    const config = createConfig({
      agent: { agentDir: "/tmp/agent-claude-dir" },
    });

    expect(config.options.env.CLAUDE_CONFIG_DIR).toBe("/tmp/agent-claude-dir");
  });

  it("keeps explicit CLAUDE_CONFIG_DIR from runtime env", () => {
    const config = createConfig({
      agent: { agentDir: "/tmp/agent-claude-dir" },
      env: {
        CLAUDE_CONFIG_DIR: "/tmp/custom-claude-dir",
      },
    });

    expect(config.options.env.CLAUDE_CONFIG_DIR).toBe("/tmp/custom-claude-dir");
  });

  it("uses non-partial streaming and bypass permission mode", () => {
    const config = createConfig();
    expect(config.options.includePartialMessages).toBe(false);
    expect(config.options.permissionMode).toBe("bypassPermissions");
    expect(config.options.allowDangerouslySkipPermissions).toBe(false);
    expect(config.options.settings).toEqual({
      skipWebFetchPreflight: true,
    });
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

  it("defaults settingSources to user and does not force options.tools by default", () => {
    const config = createConfig({
      toolProfile: {
        tools: {
          builtin_enabled: ["Read", "Glob", "Grep"],
        },
      },
    });
    expect(config.options.settingSources).toEqual(["user"]);
    expect(config.options.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect("tools" in config.options).toBe(false);
  });

  it("supports settingSources override via env", () => {
    const config = createConfig({
      env: {
        HANAKO_CLAUDE_SETTING_SOURCES: "project,local,invalid",
      },
    });
    expect(config.options.settingSources).toEqual(["project", "local"]);
  });

  it("prefers agent setting_sources over env override", () => {
    const config = createConfig({
      agent: {
        config: {
          claude: {
            setting_sources: ["user", "project"],
          },
        },
      },
      env: {
        HANAKO_CLAUDE_SETTING_SOURCES: "local",
      },
    });
    expect(config.options.settingSources).toEqual(["user", "project"]);
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

  it("includes enabled custom MCP tools in allowedTools", () => {
    const config = createConfig({
      toolProfile: {
        tools: {
          builtin_enabled: ["Read", "Glob"],
          custom_enabled: ["web_fetch", "todo", "notify"],
        },
      },
      customTools: [
        { name: "web_fetch", parameters: { type: "object", properties: {} } },
        { name: "todo", parameters: { type: "object", properties: {} } },
        { name: "notify", parameters: { type: "object", properties: {} } },
      ],
    });

    expect(config.options.allowedTools).toEqual([
      "Read",
      "Glob",
      "mcp__hanako__*",
    ]);
    expect(config.diagnostics?.customToolsLoaded).toEqual(["web_fetch", "todo", "notify"]);
    expect(config.diagnostics?.allowedTools).toEqual([
      "Read",
      "Glob",
      "mcp__hanako__*",
    ]);
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
