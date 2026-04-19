import { describe, expect, it } from "vitest";
import { buildClaudeRuntimeConfig } from "./claude-runtime-config.js";

function createConfig(overrides = {}) {
  const { env: envOverride = {}, ...rest } = overrides;
  const mergedEnv = {
    HANAKO_BROWSER_PROVIDER: "embedded",
    HANAKO_CLAUDE_IN_CHROME_INSTALLED: "0",
    ...envOverride,
  };
  return buildClaudeRuntimeConfig({
    agent: {
      agentDir: "/tmp/agent",
      buildSystemAppendPrompt: () => "",
      ...overrides.agent,
    },
    cwd: "/tmp",
    workspace: "/tmp",
    env: mergedEnv,
    ...rest,
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

  it("pins Claude SDK executable to current process executable", () => {
    const config = createConfig();
    expect(config.options.executable).toBe(process.execPath);
  });

  it("supports explicit Claude SDK executable override", () => {
    const config = createConfig({
      env: {
        HANAKO_CLAUDE_CODE_EXECUTABLE: "/tmp/custom-node",
        HANAKO_CLAUDE_CODE_EXECUTABLE_ARGS: "[\"--trace-warnings\"]",
        HANAKO_CLAUDE_CODE_CLI_PATH: "/tmp/custom-cli.js",
      },
    });

    expect(config.options.executable).toBe("/tmp/custom-node");
    expect(config.options.executableArgs).toEqual(["--trace-warnings"]);
    expect(config.options.pathToClaudeCodeExecutable).toBe("/tmp/custom-cli.js");
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

  it("defaults settingSources to user and injects options.tools by default", () => {
    const config = createConfig({
      toolProfile: {
        tools: {
          builtin_enabled: ["Read", "Glob", "Grep"],
        },
      },
    });
    expect(config.options.settingSources).toEqual(["user"]);
    expect(config.options.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(config.options.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(config.diagnostics?.forcedToolsOption).toBe(true);
  });

  it("normalizes lowercase skill alias in builtin_enabled", () => {
    const config = createConfig({
      toolProfile: {
        tools: {
          builtin_enabled: ["skill", "read"],
        },
      },
    });
    expect(config.options.allowedTools).toEqual(["Skill", "Read"]);
    expect(config.options.tools).toEqual(["Skill", "Read"]);
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

  it("can disable options.tools via env for compatibility debugging", () => {
    const original = process.env.HANAKO_FORCE_SDK_TOOLS_OPTION;
    process.env.HANAKO_FORCE_SDK_TOOLS_OPTION = "0";
    try {
      const config = createConfig({
        toolProfile: {
          tools: {
            builtin_enabled: ["Read", "Glob"],
          },
        },
      });
      expect("tools" in config.options).toBe(false);
      expect(config.options.allowedTools).toEqual(["Read", "Glob"]);
      expect(config.diagnostics?.forcedToolsOption).toBe(false);
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

  it("auto-attaches claude-in-chrome MCP server when extension is installed", () => {
    const config = createConfig({
      env: {
        HANAKO_BROWSER_PROVIDER: "auto",
        HANAKO_CLAUDE_IN_CHROME_INSTALLED: "1",
      },
    });

    expect(config.options.mcpServers.claude_in_chrome?.type).toBe("stdio");
    expect(config.options.mcpServers.claude_in_chrome?.command).toBe(process.execPath);
    expect(config.options.mcpServers.claude_in_chrome?.args?.[0]).toContain("/lib/claude-in-chrome/entry.js");
    expect(config.options.mcpServers.claude_in_chrome?.args?.[1]).toBe("--claude-in-chrome-mcp");
    expect(config.options.allowedTools).toContain("mcp__claude_in_chrome__*");
    expect(config.diagnostics?.browserProvider?.activeProvider).toBe("claude-in-chrome");
  });

  it("respects explicit claude-in-chrome command override", () => {
    const config = createConfig({
      env: {
        HANAKO_BROWSER_PROVIDER: "claude-in-chrome",
        HANAKO_CLAUDE_IN_CHROME_COMMAND: "bun",
        HANAKO_CLAUDE_IN_CHROME_ARGS:
          "[\"/tmp/claude-core/src/entrypoints/cli.tsx\",\"--claude-in-chrome-mcp\"]",
      },
    });

    expect(config.options.mcpServers.claude_in_chrome).toEqual({
      type: "stdio",
      command: "bun",
      args: ["/tmp/claude-core/src/entrypoints/cli.tsx", "--claude-in-chrome-mcp"],
    });
    expect(config.options.allowedTools).toContain("mcp__claude_in_chrome__*");
  });

  it("does not attach claude-in-chrome tools in noTools mode", () => {
    const config = createConfig({
      noTools: true,
      env: {
        HANAKO_BROWSER_PROVIDER: "claude-in-chrome",
        HANAKO_CLAUDE_IN_CHROME_COMMAND: "bun",
        HANAKO_CLAUDE_IN_CHROME_ARGS:
          "[\"/tmp/claude-core/src/entrypoints/cli.tsx\",\"--claude-in-chrome-mcp\"]",
      },
    });

    expect(config.options.mcpServers.claude_in_chrome).toBeUndefined();
    expect(config.options.allowedTools).toEqual([]);
    expect(config.diagnostics?.useClaudeInChrome).toBe(false);
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

  it("denies tools that are outside the configured allowlist", async () => {
    const config = createConfig({
      toolProfile: {
        tools: {
          builtin_enabled: ["Read"],
        },
      },
    });
    const decision = await config.options.canUseTool("CronCreate", {}, {
      signal: new AbortController().signal,
      toolUseID: "tool-croncreate",
    });
    expect(decision).toMatchObject({
      behavior: "deny",
    });
    expect(String(decision.message || "")).toContain("not allowed");
  });

  it("enforces MCP wildcard allowlist for custom tool namespace", async () => {
    const config = createConfig({
      toolProfile: {
        tools: {
          custom_enabled: ["cron"],
        },
      },
      customTools: [
        { name: "cron", parameters: { type: "object", properties: {} } },
      ],
    });

    const allowed = await config.options.canUseTool("mcp__hanako__cron", { action: "list" }, {
      signal: new AbortController().signal,
      toolUseID: "tool-allowed",
    });
    expect(allowed).toMatchObject({
      behavior: "allow",
      updatedInput: { action: "list" },
    });

    const denied = await config.options.canUseTool("mcp__MiniMax__web_search", { query: "latest" }, {
      signal: new AbortController().signal,
      toolUseID: "tool-denied",
    });
    expect(denied).toMatchObject({
      behavior: "deny",
    });
  });

  it("requests confirmation for EnterPlanMode/ExitPlanMode when confirmStore is available", async () => {
    const emitted = [];
    let createCount = 0;
    const confirmStore = {
      create: () => {
        createCount += 1;
        if (createCount === 1) {
          return { confirmId: "plan-enter-1", promise: Promise.resolve({ action: "confirmed" }) };
        }
        return { confirmId: "plan-exit-1", promise: Promise.resolve({ action: "rejected" }) };
      },
    };
    const config = createConfig({
      sessionPath: "/tmp/session-plan.jsonl",
      confirmStore,
      emitToolEvent: (event) => emitted.push(event),
    });

    const enter = await config.options.canUseTool("EnterPlanMode", {
      prompt: "Draft a plan first",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-plan-enter",
    });
    expect(enter).toMatchObject({
      behavior: "allow",
    });

    const exit = await config.options.canUseTool("ExitPlanMode", {
      allowedPrompts: [{ tool: "Bash", prompt: "npm test" }],
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-plan-exit",
    });
    expect(exit).toMatchObject({
      behavior: "deny",
    });

    expect(emitted).toEqual([
      expect.objectContaining({
        type: "plan_mode_confirmation",
        confirmId: "plan-enter-1",
        phase: "enter",
      }),
      expect.objectContaining({
        type: "plan_mode_confirmation",
        confirmId: "plan-exit-1",
        phase: "exit",
        allowedPrompts: [{ tool: "Bash", prompt: "npm test" }],
      }),
    ]);
  });

  it("requests AskUserQuestion answers and injects them into updatedInput", async () => {
    const emitted = [];
    const confirmStore = {
      create: () => ({
        confirmId: "ask-user-1",
        promise: Promise.resolve({
          action: "confirmed",
          value: { goal: "ship it", risk: "low" },
        }),
      }),
    };
    const config = createConfig({
      sessionPath: "/tmp/session-ask.jsonl",
      confirmStore,
      emitToolEvent: (event) => emitted.push(event),
    });
    const decision = await config.options.canUseTool("AskUserQuestion", {
      questions: [
        { id: "goal", question: "What is your goal?" },
        { id: "risk", question: "Risk tolerance?", options: [{ label: "low" }, { label: "high" }] },
      ],
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-ask-user",
    });

    expect(decision).toMatchObject({
      behavior: "allow",
      updatedInput: {
        answers: { goal: "ship it", risk: "low" },
      },
    });
    expect(emitted).toEqual([
      expect.objectContaining({
        type: "ask_user_confirmation",
        confirmId: "ask-user-1",
      }),
    ]);
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

  it("denies Write/Edit paths outside workspace/path_rules in strict mode", async () => {
    const config = createConfig({
      workspace: "/tmp/workspace",
      toolProfile: {
        sandbox: {
          mode: "standard",
          path_rules: [{ path: "/tmp/extra", access: "read_write" }],
        },
      },
    });

    const denied = await config.options.canUseTool("Write", {
      file_path: "/tmp/outside/file.txt",
      content: "x",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-write-outside",
    });
    expect(denied).toMatchObject({ behavior: "deny" });
    expect(String(denied.message || "")).toContain("/tmp/outside/file.txt");

    const allowedWorkspace = await config.options.canUseTool("Write", {
      file_path: "/tmp/workspace/file.txt",
      content: "x",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-write-workspace",
    });
    expect(allowedWorkspace).toMatchObject({ behavior: "allow" });

    const allowedPathRule = await config.options.canUseTool("Edit", {
      file_path: "/tmp/extra/file.txt",
      old_string: "a",
      new_string: "b",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-edit-allow-rule",
    });
    expect(allowedPathRule).toMatchObject({ behavior: "allow" });
  });

  it("denies project-local memory folder access under agent projects", async () => {
    const config = createConfig({
      agent: { agentDir: "/tmp/agent" },
      workspace: "/tmp/workspace",
    });

    const deniedWrite = await config.options.canUseTool("Write", {
      file_path: "/tmp/agent/projects/-Users-demo/memory/MEMORY.md",
      content: "noop",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-project-memory-write",
    });
    expect(deniedWrite).toMatchObject({ behavior: "deny" });
    expect(String(deniedWrite.message || "")).toContain("project-local memory files");

    const deniedRead = await config.options.canUseTool("Read", {
      file_path: "/tmp/agent/projects/-Users-demo/memory/user_role.md",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-project-memory-read",
    });
    expect(deniedRead).toMatchObject({ behavior: "deny" });
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
