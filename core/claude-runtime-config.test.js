import fs from "fs";
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

  it("replaces Claude proxy env with the local system proxy", () => {
    const config = createConfig({
      env: {
        http_proxy: "http://localhost:64180",
        https_proxy: "http://localhost:64180",
        all_proxy: "socks5://localhost:64181",
        no_proxy: "localhost,127.0.0.1",
        HTTP_PROXY: "http://localhost:64180",
        HTTPS_PROXY: "http://localhost:64180",
        ALL_PROXY: "socks5://localhost:64181",
        NO_PROXY: "localhost,127.0.0.1",
      },
    });

    expect(config.options.env.http_proxy).toBe("http://127.0.0.1:7897");
    expect(config.options.env.https_proxy).toBe("http://127.0.0.1:7897");
    expect(config.options.env.all_proxy).toBe("socks5h://127.0.0.1:7897");
    expect(config.options.env.HTTP_PROXY).toBe("http://127.0.0.1:7897");
    expect(config.options.env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
    expect(config.options.env.ALL_PROXY).toBe("socks5h://127.0.0.1:7897");
    expect(config.options.env.no_proxy).toBe("localhost,127.0.0.1,::1");
    expect(config.options.env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(config.options.env.BASH_ENV).toBe("/tmp/agent/.hanako-no-proxy/bash_env");
    expect(config.options.env.CURL_HOME).toBe("/tmp/agent/.hanako-no-proxy/curl");
    expect(fs.readFileSync(config.options.env.BASH_ENV, "utf8")).toContain("curl --proxy");
    expect(fs.readFileSync(`${config.options.env.CURL_HOME}/.curlrc`, "utf8")).toContain('proxy = "http://127.0.0.1:7897"');
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

  it("uses non-partial streaming by default and bypass permission mode", () => {
    const config = createConfig();
    expect(config.options.includePartialMessages).toBe(false);
    expect(config.options.permissionMode).toBe("bypassPermissions");
    expect(config.options.allowDangerouslySkipPermissions).toBe(true);
    expect(config.options.settings).toEqual({
      skipWebFetchPreflight: true,
    });
  });

  it("can enable partial SDK messages for chat sessions", () => {
    const config = createConfig({ includePartialMessages: true });
    expect(config.options.includePartialMessages).toBe(true);
  });

  it("disables sandbox even when legacy sandbox modes/path rules are provided", () => {
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

    expect(config.options.sandbox).toEqual({ enabled: false });
    expect(config.options.allowDangerouslySkipPermissions).toBe(true);
  });

  it("keeps sandbox disabled on all platforms", () => {
    const config = createConfig({
      toolProfile: {
        sandbox: {
          mode: "standard",
        },
      },
    });
    expect(config.options.sandbox).toEqual({ enabled: false });
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

  it("filters disabled builtin tools from allowed tool lists", () => {
    const config = createConfig({
      toolProfile: {
        tools: {
          builtin_enabled: ["Read", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
        },
      },
      disabledBuiltinTools: ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
    });

    expect(config.options.allowedTools).toEqual(["Read"]);
    expect(config.options.tools).toEqual(["Read"]);
    expect(config.diagnostics?.builtinEnabled).toEqual(["Read"]);
  });

  it("forces a filtered builtin allowlist when only disabled builtin tools are provided", () => {
    const config = createConfig({
      disabledBuiltinTools: ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
    });

    expect(config.options.allowedTools).toContain("Read");
    expect(config.options.allowedTools).toContain("Bash");
    expect(config.options.allowedTools).not.toContain("AskUserQuestion");
    expect(config.options.allowedTools).not.toContain("EnterPlanMode");
    expect(config.options.allowedTools).not.toContain("ExitPlanMode");
    expect(config.options.tools).toEqual(config.options.allowedTools);
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
          custom_enabled: ["cron", "notify"],
        },
      },
      customTools: [
        { name: "cron", parameters: { type: "object", properties: {} } },
        { name: "notify", parameters: { type: "object", properties: {} } },
      ],
    });

    expect(config.options.allowedTools).toEqual([
      "Read",
      "Glob",
      "mcp__hanako__*",
    ]);
    expect(config.diagnostics?.customToolsLoaded).toEqual(["cron", "notify"]);
    expect(config.diagnostics?.allowedTools).toEqual([
      "Read",
      "Glob",
      "mcp__hanako__*",
    ]);
  });

  it("attaches MiniMax MCP server and allows only enabled MiniMax MCP tools", async () => {
    const config = createConfig({
      toolProfile: {
        tools: {
          builtin_enabled: ["Read"],
          custom_enabled: ["minimax_mcp_web_search", "notify"],
        },
      },
      customTools: [
        { name: "minimax_mcp_web_search", parameters: { type: "object", properties: {} } },
        { name: "minimax_mcp_understand_image", parameters: { type: "object", properties: {} } },
        { name: "notify", parameters: { type: "object", properties: {} } },
      ],
    });

    expect(config.options.mcpServers.MiniMax).toEqual({
      type: "stdio",
      command: "uvx",
      args: ["minimax-coding-plan-mcp"],
    });
    expect(config.options.allowedTools).toContain("mcp__MiniMax__web_search");
    expect(config.options.allowedTools).not.toContain("mcp__MiniMax__understand_image");
    expect(config.diagnostics?.customToolsLoaded).toEqual(["notify"]);
    expect(config.diagnostics?.enabledMiniMaxMcpTools).toEqual(["web_search"]);
    expect(config.diagnostics?.useMiniMaxMcp).toBe(true);

    const allowed = await config.options.canUseTool("mcp__MiniMax__web_search", { query: "latest" }, {
      signal: new AbortController().signal,
      toolUseID: "tool-minimax-web-search",
    });
    expect(allowed).toMatchObject({
      behavior: "allow",
      updatedInput: { query: "latest" },
    });

    const denied = await config.options.canUseTool("mcp__MiniMax__understand_image", { url: "https://example.com/a.png" }, {
      signal: new AbortController().signal,
      toolUseID: "tool-minimax-understand-image",
    });
    expect(denied).toMatchObject({
      behavior: "deny",
    });
  });

  it("does not attach MiniMax MCP server in noTools mode", () => {
    const config = createConfig({
      noTools: true,
      toolProfile: {
        tools: {
          custom_enabled: ["minimax_mcp_web_search", "minimax_mcp_understand_image"],
        },
      },
    });

    expect(config.options.mcpServers.MiniMax).toBeUndefined();
    expect(config.options.allowedTools).toEqual([]);
    expect(config.diagnostics?.useMiniMaxMcp).toBe(false);
  });

  it("attaches configured external MCP servers and allows their tool namespace", async () => {
    const config = createConfig({
      agent: {
        config: {
          mcp: {
            external_servers: {
              context7: {
                type: "stdio",
                command: "npx",
                args: ["-y", "@upstash/context7-mcp"],
                env: { CONTEXT7_API_KEY: "test" },
              },
            },
          },
        },
      },
      toolProfile: {
        tools: {
          builtin_enabled: ["Read"],
        },
      },
    });

    expect(config.options.mcpServers.context7).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: { CONTEXT7_API_KEY: "test" },
    });
    expect(config.options.allowedTools).toEqual(["Read", "mcp__context7__*"]);
    expect(config.diagnostics?.externalMcpServers).toEqual(["context7"]);

    const allowed = await config.options.canUseTool("mcp__context7__resolve-library-id", {
      libraryName: "react",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-context7",
    });
    expect(allowed).toMatchObject({
      behavior: "allow",
      updatedInput: { libraryName: "react" },
    });
  });

  it("attaches global external MCP servers and respects per-agent disabled list", () => {
    const config = createConfig({
      agent: {
        _engine: {
          getExternalMcpServers: () => ({
            context7: {
              type: "stdio",
              command: "npx",
              args: ["-y", "@upstash/context7-mcp"],
            },
            playwright: {
              type: "stdio",
              command: "npx",
              args: ["@playwright/mcp"],
            },
          }),
        },
        config: {
          mcp: {
            disabled_servers: ["context7"],
          },
        },
      },
      toolProfile: {
        tools: {
          builtin_enabled: ["Read"],
        },
      },
    });

    expect(config.options.mcpServers.context7).toBeUndefined();
    expect(config.options.mcpServers.playwright).toEqual({
      type: "stdio",
      command: "npx",
      args: ["@playwright/mcp"],
    });
    expect(config.options.allowedTools).toEqual(["Read", "mcp__playwright__*"]);
    expect(config.diagnostics?.externalMcpServers).toEqual(["playwright"]);
  });

  it("allows a user-configured MiniMax external MCP server", () => {
    const config = createConfig({
      agent: {
        config: {
          mcp: {
            external_servers: {
              MiniMax: {
                type: "stdio",
                command: "uvx",
                args: ["minimax-coding-plan-mcp", "-y"],
                env: {
                  MINIMAX_API_KEY: "test",
                  MINIMAX_API_HOST: "https://api.minimaxi.com",
                },
              },
            },
          },
        },
      },
      toolProfile: {
        tools: {
          builtin_enabled: ["Read"],
          custom_enabled: [],
        },
      },
    });

    expect(config.options.mcpServers.MiniMax).toEqual({
      type: "stdio",
      command: "uvx",
      args: ["minimax-coding-plan-mcp", "-y"],
      env: {
        MINIMAX_API_KEY: "test",
        MINIMAX_API_HOST: "https://api.minimaxi.com",
      },
    });
    expect(config.options.allowedTools).toContain("mcp__MiniMax__*");
    expect(config.diagnostics?.externalMcpServers).toEqual(["MiniMax"]);
  });

  it("skips external MCP servers in noTools mode", () => {
    const config = createConfig({
      noTools: true,
      agent: {
        config: {
          mcp: {
            external_servers: {
              context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
            },
          },
        },
      },
    });

    expect(config.options.mcpServers.context7).toBeUndefined();
    expect(config.options.allowedTools).toEqual([]);
    expect(config.diagnostics?.externalMcpServers).toEqual([]);
  });

  it("keeps tool settings and Skill availability visible in noMemory tool sessions", () => {
    const calls = [];
    const config = createConfig({
      noMemory: true,
      agent: {
        personality: "personality only",
        buildSystemAppendPrompt: (opts) => {
          calls.push(opts);
          return [
            "tool-aware no-memory append",
            "Standard Claude tools available in this session (only these): Skill / Read",
            "Hanako/MCP tools available in this session (only these): notify",
          ].join("\n");
        },
      },
      toolProfile: {
        tools: {
          builtin_enabled: ["Skill", "Read"],
          custom_enabled: ["notify"],
        },
      },
      customTools: [
        { name: "notify", parameters: { type: "object", properties: {} } },
      ],
    });

    expect(calls).toEqual([{
      includeUserProfile: false,
      includeMemory: false,
      includeDateTime: false,
    }]);
    expect(config.options.systemPrompt.append).toContain("tool-aware no-memory append");
    expect(config.options.systemPrompt.append).toContain("Skill / Read");
    expect(config.options.allowedTools).toEqual(["Skill", "Read", "mcp__hanako__*"]);
    expect(config.diagnostics?.customToolsLoaded).toEqual(["notify"]);
  });

  it("uses personality-only prompt for noMemory sessions when tools are disabled", () => {
    let called = false;
    const config = createConfig({
      noMemory: true,
      noTools: true,
      agent: {
        personality: "personality only",
        buildSystemAppendPrompt: () => {
          called = true;
          return "should not appear";
        },
      },
      toolProfile: {
        tools: {
          builtin_enabled: ["Skill", "Read"],
          custom_enabled: ["notify"],
        },
      },
      customTools: [
        { name: "notify", parameters: { type: "object", properties: {} } },
      ],
    });

    expect(called).toBe(false);
    expect(config.options.systemPrompt.append).toBe("personality only");
    expect(config.options.allowedTools).toEqual([]);
  });

  it("allows a user-configured claude_in_chrome external MCP server", () => {
    const config = createConfig({
      agent: {
        config: {
          mcp: {
            external_servers: {
              claude_in_chrome: {
                type: "stdio",
                command: "node",
                args: ["/tmp/custom-browser-mcp.js", "--claude-in-chrome-mcp"],
              },
            },
          },
        },
      },
      toolProfile: {
        tools: {
          builtin_enabled: ["Read"],
          custom_enabled: [],
        },
      },
    });

    expect(config.options.mcpServers.claude_in_chrome).toEqual({
      type: "stdio",
      command: "node",
      args: ["/tmp/custom-browser-mcp.js", "--claude-in-chrome-mcp"],
    });
    expect(config.options.allowedTools).toContain("mcp__claude_in_chrome__*");
    expect(config.options.allowedTools).toContain("Read");
    expect(config.diagnostics?.externalMcpServers).toContain("claude_in_chrome");
  });

  it("does not auto-attach claude_in_chrome MCP without external config", () => {
    const config = createConfig({
      env: {
        HANAKO_BROWSER_PROVIDER: "auto",
        HANAKO_CLAUDE_IN_CHROME_INSTALLED: "1",
      },
    });

    expect(config.options.mcpServers.claude_in_chrome).toBeUndefined();
    expect(config.options.allowedTools || []).not.toContain("mcp__claude_in_chrome__*");
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
    });
    expect(allowed.updatedInput.command).toContain("unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY");
    expect(allowed.updatedInput.command).toContain('export http_proxy="http://127.0.0.1:7897"');
    expect(allowed.updatedInput.command).toContain("npm test");
  });

  it("strips proxy variables from allowed Bash commands", async () => {
    const config = createConfig();
    const decision = await config.options.canUseTool("Bash", {
      command: "curl -v https://mkapi2.dfcfs.com/finskillshub/api/claw/query",
      description: "probe",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-bash-proxy",
    });

    expect(decision).toMatchObject({
      behavior: "allow",
      updatedInput: {
        description: "probe",
      },
    });
    expect(decision.updatedInput.command).toBe([
      'unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; export http_proxy="http://127.0.0.1:7897" https_proxy="http://127.0.0.1:7897" HTTP_PROXY="http://127.0.0.1:7897" HTTPS_PROXY="http://127.0.0.1:7897";',
      "curl -v https://mkapi2.dfcfs.com/finskillshub/api/claw/query",
    ].join("\n"));
  });

  it("allows Bash path access outside legacy workspace/path_rules when sandbox is disabled", async () => {
    const config = createConfig({
      workspace: "/tmp/workspace",
      toolProfile: {
        sandbox: {
          mode: "standard",
          path_rules: [{ path: "/tmp/extra", access: "read_only" }],
        },
      },
    });

    const outside = await config.options.canUseTool("Bash", {
      command: "ls -la /tmp/outside",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-bash-4",
    });
    expect(outside).toMatchObject({ behavior: "allow" });

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

  it("allows Write/Edit paths outside legacy workspace/path_rules when sandbox is disabled", async () => {
    const config = createConfig({
      workspace: "/tmp/workspace",
      toolProfile: {
        sandbox: {
          mode: "standard",
          path_rules: [{ path: "/tmp/extra", access: "read_write" }],
        },
      },
    });

    const outside = await config.options.canUseTool("Write", {
      file_path: "/tmp/outside/file.txt",
      content: "x",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-write-outside",
    });
    expect(outside).toMatchObject({ behavior: "allow" });

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

  it("denies using Read on image files and suggests image understanding tools", async () => {
    const config = createConfig({
      workspace: "/tmp/workspace",
    });

    const deniedPng = await config.options.canUseTool("Read", {
      file_path: "/tmp/workspace/screenshot.png",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-read-image-png",
    });
    expect(deniedPng).toMatchObject({ behavior: "deny" });
    expect(String(deniedPng.message || "")).toContain("image-understanding tool");

    const deniedJpeg = await config.options.canUseTool("Read", {
      file_path: "/tmp/workspace/photo.jpeg",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-read-image-jpeg",
    });
    expect(deniedJpeg).toMatchObject({ behavior: "deny" });
  });

  it("ignores legacy balanced mode and keeps outside path inspection allowed", async () => {
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
