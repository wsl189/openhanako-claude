import path from "path";
import { createCustomToolsMcpServer } from "../lib/claude/custom-tool-adapter.js";
import { extractGuardPaths } from "../lib/sandbox/tool-wrapper.js";

export const CLAUDE_BUILTIN_TOOL_NAMES = [
  "Task",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "ListMcpResourcesTool",
  "NotebookEdit",
  "Read",
  "ReadMcpResourceTool",
  "RemoteTrigger",
  "Skill",
  "TaskOutput",
  "TaskStop",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
];

export const HANAKO_TO_CLAUDE_BUILTIN = {
  read: "Read",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
};

function uniq(list = []) {
  return [...new Set((list || []).filter(Boolean))];
}

function normalizeBuiltinToolName(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  if (CLAUDE_BUILTIN_TOOL_NAMES.includes(raw)) return raw;
  return HANAKO_TO_CLAUDE_BUILTIN[raw] || null;
}

function normalizePathRules(pathRules = []) {
  return (Array.isArray(pathRules) ? pathRules : [])
    .map((rule) => ({
      path: String(rule?.path || "").trim(),
      access: rule?.access === "read_write" ? "read_write" : "read_only",
    }))
    .filter((rule) => path.isAbsolute(rule.path));
}

function resolveClaudeBuiltinTools(enabledBuiltin = []) {
  return uniq(
    enabledBuiltin
      .map((name) => normalizeBuiltinToolName(name))
      .filter(Boolean),
  );
}

function normalizeAbsolutePath(rawPath) {
  const p = String(rawPath || "").trim();
  if (!p || !path.isAbsolute(p)) return null;
  return p;
}

function buildSandboxConfig(mode, workspace, pathRules) {
  if (mode === "full-access") {
    return {
      enabled: false,
    };
  }

  const workspacePath = normalizeAbsolutePath(workspace);
  const allowRead = uniq([
    workspacePath,
    ...pathRules.map((rule) => rule.path),
  ].filter(Boolean));
  const allowWrite = uniq([
    workspacePath,
    ...pathRules.filter((rule) => rule.access === "read_write").map((rule) => rule.path),
  ].filter(Boolean));

  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: mode === "balanced",
    filesystem: {
      allowRead: allowRead.length ? allowRead : undefined,
      allowWrite: allowWrite.length ? allowWrite : undefined,
    },
  };
}

function buildAdditionalDirectories(cwd, workspace, pathRules) {
  return uniq([
    cwd,
    workspace,
    ...pathRules.map((rule) => rule.path),
  ]).filter(Boolean);
}

function parseSettingSources(raw = "") {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim();
  if (!normalized) return null;
  if (/^(none|off|disabled)$/i.test(normalized)) return [];
  return uniq(
    normalized
      .split(/[,\s]+/)
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item === "user" || item === "project"),
  );
}

function resolveSettingSources(agent) {
  const fromAgent = Array.isArray(agent?.config?.claude?.setting_sources)
    ? uniq(
      agent.config.claude.setting_sources
        .map((item) => String(item || "").trim().toLowerCase())
        .filter((item) => item === "user" || item === "project"),
    )
    : null;
  if (fromAgent && fromAgent.length > 0) return fromAgent;

  const fromEnv = parseSettingSources(process.env.HANAKO_CLAUDE_SETTING_SOURCES);
  if (Array.isArray(fromEnv)) return fromEnv;

  // Proma 同款默认来源：加载 user + project 配置，避免 SDK 处于“无设置来源”异常状态。
  return ["user", "project"];
}

function shouldForceToolsOption() {
  return /^(1|true|yes|on)$/i.test(String(process.env.HANAKO_FORCE_SDK_TOOLS_OPTION || "").trim());
}

function resolvePermissionStrategy(agent) {
  const fromAgent = String(agent?.config?.claude?.permission_strategy || "").trim().toLowerCase();
  if (fromAgent === "none" || fromAgent === "auto_allow") return fromAgent;
  const fromEnv = String(process.env.HANAKO_CLAUDE_PERMISSION_STRATEGY || "").trim().toLowerCase();
  if (fromEnv === "none" || fromEnv === "auto_allow") return fromEnv;
  // Hanako 目前未实现 Proma 的权限交互弹窗链路，默认用 auto_allow 避免 SDK 授权等待死锁。
  return "auto_allow";
}

function isPathInside(target, base) {
  return target === base || target.startsWith(base + path.sep);
}

function resolveAllowedRoots(workspace, pathRules = []) {
  return uniq([
    normalizeAbsolutePath(workspace),
    ...(Array.isArray(pathRules) ? pathRules : []).map((rule) => normalizeAbsolutePath(rule?.path)),
  ].filter(Boolean)).map((p) => path.resolve(p));
}

function findDisallowedBashPath(command, cwd, allowedRoots = []) {
  const roots = Array.isArray(allowedRoots) ? allowedRoots : [];
  if (roots.length === 0) return null;
  const guardPaths = extractGuardPaths(String(command || ""), cwd);
  for (const rawPath of guardPaths) {
    const resolved = path.resolve(String(rawPath || ""));
    const allowed = roots.some((root) => isPathInside(resolved, root));
    if (!allowed) return resolved;
  }
  return null;
}

function detectBashBypassAttempt(toolName, input = {}, opts = {}) {
  if (toolName !== "Bash") return null;
  const payload = (input && typeof input === "object") ? input : {};
  const command = String(payload.command || "");
  const strictSandbox = opts.strictSandbox === true;
  const cwd = normalizeAbsolutePath(opts.cwd || process.cwd()) || process.cwd();
  const allowedRoots = Array.isArray(opts.allowedRoots) ? opts.allowedRoots : [];

  // Prevent explicit sandbox escape attempts through Bash tool input.
  if (payload.dangerouslyDisableSandbox === true) {
    return "Bash command denied: disabling sandbox is not allowed.";
  }

  const privilegeEscalationPatterns = [
    /\bsudo\b/i,
    /\bsu(?:\s|$)/i,
    /\bdoas\b/i,
    /\bpkexec\b/i,
  ];
  if (privilegeEscalationPatterns.some((pattern) => pattern.test(command))) {
    return "Bash command denied: privileged escalation commands are not allowed.";
  }

  if (strictSandbox) {
    const disallowedPath = findDisallowedBashPath(command, cwd, allowedRoots);
    if (disallowedPath) {
      return `Bash command denied: path is outside strict sandbox scope (${disallowedPath}).`;
    }
  }

  return null;
}

function buildCanUseToolHandler(permissionStrategy, opts = {}) {
  if (permissionStrategy !== "auto_allow") return undefined;
  const strictSandbox = opts.sandboxMode === "standard";
  const allowedRoots = strictSandbox ? resolveAllowedRoots(opts.workspace, opts.pathRules) : [];
  const cwd = opts.cwd;
  return async (toolName, input = {}) => {
    const denyReason = detectBashBypassAttempt(toolName, input, {
      strictSandbox,
      allowedRoots,
      cwd,
    });
    if (denyReason) return { behavior: "deny", message: denyReason };
    return {
      behavior: "allow",
      updatedInput: (input && typeof input === "object") ? input : {},
    };
  };
}

export function buildClaudeRuntimeConfig({
  agent,
  cwd,
  workspace,
  toolProfile,
  customTools = [],
  builtinEnabledOverride = null,
  customEnabledOverride = null,
  createToolContext,
  emitToolEvent,
  systemAppend,
  noTools = false,
  noMemory = false,
  model,
  env = {},
} = {}) {
  const runtimeEnv = {
    ...process.env,
    ...(env || {}),
  };
  const sandboxMode = toolProfile?.sandbox?.mode || "standard";
  const pathRules = normalizePathRules(toolProfile?.sandbox?.path_rules);
  const permissionStrategy = resolvePermissionStrategy(agent);
  const canUseTool = buildCanUseToolHandler(permissionStrategy, {
    sandboxMode,
    workspace,
    pathRules,
    cwd,
  });
  const settingSources = resolveSettingSources(agent);
  const builtinEnabled = noTools
    ? []
    : resolveClaudeBuiltinTools(builtinEnabledOverride || toolProfile?.tools?.builtin_enabled || []);
  const customEnabled = noTools
    ? []
    : uniq(customEnabledOverride || toolProfile?.tools?.custom_enabled || []);
  const filteredCustomTools = (customTools || []).filter((toolDef) => customEnabled.includes(toolDef?.name));
  const mcpServers = {};
  if (filteredCustomTools.length > 0) {
    mcpServers.hanako = createCustomToolsMcpServer(
      `hanako-${path.basename(agent?.agentDir || "agent")}-tools`,
      filteredCustomTools,
      {
        createContext: createToolContext,
        onToolStart: emitToolEvent,
        onToolEnd: emitToolEvent,
      },
    );
  }

  const baseAppend = noMemory ? agent?.personality : agent?.buildSystemAppendPrompt?.();
  const append = [baseAppend, systemAppend].filter(Boolean).join("\n\n");
  const strictSandbox = sandboxMode === "standard";
  const additionalDirectories = buildAdditionalDirectories(cwd, workspace, pathRules);
  const shouldForceTools = shouldForceToolsOption();
  const options = {
    cwd,
    model,
    env: runtimeEnv,
    mcpServers,
    additionalDirectories,
    ...(builtinEnabled.length > 0 || noTools ? { allowedTools: builtinEnabled } : {}),
    ...(shouldForceTools || noTools ? { tools: builtinEnabled } : {}),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append,
    },
    sandbox: buildSandboxConfig(sandboxMode, workspace, pathRules),
    permissionMode: "acceptEdits",
    allowDangerouslySkipPermissions: !strictSandbox,
    ...(canUseTool ? { canUseTool } : {}),
    settingSources,
    includePartialMessages: false,
    persistSession: true,
  };

  return {
    additionalDirectories,
    mcpServers,
    options,
    diagnostics: {
      settingSources,
      builtinEnabled,
      customEnabled,
      forcedToolsOption: shouldForceTools || noTools,
      permissionStrategy,
      hasCanUseTool: typeof canUseTool === "function",
      customToolsLoaded: filteredCustomTools.map((toolDef) => toolDef?.name).filter(Boolean),
    },
  };
}
