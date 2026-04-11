import path from "path";
import { createCustomToolsMcpServer } from "../lib/claude/custom-tool-adapter.js";

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

function buildSandboxConfig(mode, pathRules) {
  if (mode === "full-access") {
    return {
      enabled: false,
    };
  }

  const allowRead = uniq(pathRules.map((rule) => rule.path));
  const allowWrite = uniq(pathRules.filter((rule) => rule.access === "read_write").map((rule) => rule.path));

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
  const pathRules = normalizePathRules(toolProfile?.sandbox?.path_rules);
  const builtinEnabled = noTools
    ? []
    : resolveClaudeBuiltinTools(builtinEnabledOverride || toolProfile?.tools?.builtin_enabled || []);
  const customEnabled = noTools
    ? []
    : (customEnabledOverride || toolProfile?.tools?.custom_enabled || []);
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
  const sandboxMode = toolProfile?.sandbox?.mode || "standard";

  return {
    additionalDirectories: buildAdditionalDirectories(cwd, workspace, pathRules),
    mcpServers,
    options: {
      cwd,
      model,
      env,
      mcpServers,
      additionalDirectories: buildAdditionalDirectories(cwd, workspace, pathRules),
      tools: builtinEnabled,
      allowedTools: builtinEnabled,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append,
      },
      sandbox: buildSandboxConfig(sandboxMode, pathRules),
      permissionMode: sandboxMode === "full-access" ? "acceptEdits" : "default",
      settingSources: [],
      includePartialMessages: true,
      persistSession: true,
    },
  };
}
