import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { createCustomToolsMcpServer } from "../lib/claude/custom-tool-adapter.js";
import {
  MINIMAX_MCP_UNDERSTAND_IMAGE_SWITCH,
  MINIMAX_MCP_WEB_SEARCH_SWITCH,
} from "../lib/tools/minimax-mcp-tools.js";
import { CLAUDE_IN_CHROME_SWITCH } from "../lib/tools/claude-in-chrome-tool.js";
import { extractGuardPaths } from "../lib/sandbox/tool-wrapper.js";
import { resolveBrowserProvider } from "./browser-provider.js";

const require = createRequire(import.meta.url);

export const CLAUDE_BUILTIN_TOOL_NAMES = [
  "Task",
  "AskUserQuestion",
  "Bash",
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
  skill: "Skill",
};

export const CLAUDE_INTERACTIVE_BUILTIN_TOOL_NAMES = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
];

const MINIMAX_MCP_SERVER_KEY = "MiniMax";
const RESERVED_MCP_SERVER_KEYS = new Set([
  "hanako",
  "claude_in_chrome",
]);
const MINIMAX_MCP_TOOL_BY_SWITCH = {
  [MINIMAX_MCP_WEB_SEARCH_SWITCH]: "web_search",
  [MINIMAX_MCP_UNDERSTAND_IMAGE_SWITCH]: "understand_image",
};
const CLAUDE_PROXY_ENV_KEYS = [
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
];
const CLAUDE_NO_PROXY_ENV_KEYS = [
  "no_proxy",
  "NO_PROXY",
];
const DEFAULT_LOCAL_PROXY_URL = "http://127.0.0.1:7897";
const CLAUDE_PROXY_UNSET_COMMAND = [
  `unset ${CLAUDE_PROXY_ENV_KEYS.join(" ")}`,
  `export http_proxy="${DEFAULT_LOCAL_PROXY_URL}" https_proxy="${DEFAULT_LOCAL_PROXY_URL}" HTTP_PROXY="${DEFAULT_LOCAL_PROXY_URL}" HTTPS_PROXY="${DEFAULT_LOCAL_PROXY_URL}"`,
].join("; ");
const CLAUDE_NO_PROXY_BASH_ENV = [
  `unset ${CLAUDE_PROXY_ENV_KEYS.join(" ")}`,
  'export no_proxy="localhost,127.0.0.1,::1"',
  'export NO_PROXY="localhost,127.0.0.1,::1"',
  `if nc -z 127.0.0.1 7897 >/dev/null 2>&1; then`,
  `  export http_proxy="${DEFAULT_LOCAL_PROXY_URL}"`,
  `  export https_proxy="${DEFAULT_LOCAL_PROXY_URL}"`,
  `  export HTTP_PROXY="${DEFAULT_LOCAL_PROXY_URL}"`,
  `  export HTTPS_PROXY="${DEFAULT_LOCAL_PROXY_URL}"`,
  `  export all_proxy="socks5h://127.0.0.1:7897"`,
  `  export ALL_PROXY="socks5h://127.0.0.1:7897"`,
  `  curl() { command curl --proxy '${DEFAULT_LOCAL_PROXY_URL}' "$@"; }`,
  "else",
  '  export no_proxy="*"',
  '  export NO_PROXY="*"',
  '  curl() { command curl --noproxy \'*\' "$@"; }',
  "fi",
  "export -f curl >/dev/null 2>&1 || true",
  "",
].join("\n");
const CLAUDE_CURLRC = [
  `proxy = "${DEFAULT_LOCAL_PROXY_URL}"`,
  'noproxy = "localhost,127.0.0.1,::1"',
  "",
].join("\n");
const IMAGE_FILE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".svg",
  ".ico",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
  ".avif",
]);

function uniq(list = []) {
  return [...new Set((list || []).filter(Boolean))];
}

function removeClaudeProxyEnv(env = {}) {
  for (const key of CLAUDE_PROXY_ENV_KEYS) {
    delete env[key];
  }
  for (const key of CLAUDE_NO_PROXY_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

function withClaudeProxyEnvUnset(command = "") {
  const raw = String(command || "");
  if (!raw.trim()) return raw;
  if (raw.trimStart().startsWith(CLAUDE_PROXY_UNSET_COMMAND)) return raw;
  return `${CLAUDE_PROXY_UNSET_COMMAND};\n${raw}`;
}

function writeFileIfChanged(filePath, content) {
  try {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === content) {
      return true;
    }
    fs.writeFileSync(filePath, content, "utf8");
    return true;
  } catch {
    return false;
  }
}

function applyClaudeNoProxyRuntimeEnv(env = {}, baseDir = "") {
  removeClaudeProxyEnv(env);
  env.http_proxy = DEFAULT_LOCAL_PROXY_URL;
  env.https_proxy = DEFAULT_LOCAL_PROXY_URL;
  env.HTTP_PROXY = DEFAULT_LOCAL_PROXY_URL;
  env.HTTPS_PROXY = DEFAULT_LOCAL_PROXY_URL;
  env.all_proxy = "socks5h://127.0.0.1:7897";
  env.ALL_PROXY = "socks5h://127.0.0.1:7897";
  env.no_proxy = "localhost,127.0.0.1,::1";
  env.NO_PROXY = "localhost,127.0.0.1,::1";

  const rootDir = normalizeAbsolutePath(baseDir);
  if (!rootDir) return env;

  const shimDir = path.join(rootDir, ".hanako-no-proxy");
  const curlHome = path.join(shimDir, "curl");
  try {
    fs.mkdirSync(curlHome, { recursive: true });
  } catch {
    return env;
  }

  const bashEnvPath = path.join(shimDir, "bash_env");
  const curlRcPath = path.join(curlHome, ".curlrc");
  if (writeFileIfChanged(bashEnvPath, CLAUDE_NO_PROXY_BASH_ENV)) {
    env.BASH_ENV = bashEnvPath;
  }
  if (writeFileIfChanged(curlRcPath, CLAUDE_CURLRC)) {
    env.CURL_HOME = curlHome;
  }
  return env;
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

function filterDisabledBuiltinTools(enabledBuiltin = [], disabledBuiltinTools = []) {
  const disabled = new Set(resolveClaudeBuiltinTools(disabledBuiltinTools));
  if (disabled.size === 0) return enabledBuiltin;
  return enabledBuiltin.filter((name) => !disabled.has(name));
}

function resolveRuntimeBuiltinTools(rawEnabledBuiltin = [], disabledBuiltinTools = []) {
  const disabled = resolveClaudeBuiltinTools(disabledBuiltinTools);
  const source = Array.isArray(rawEnabledBuiltin) && rawEnabledBuiltin.length > 0
    ? rawEnabledBuiltin
    : (disabled.length > 0 ? CLAUDE_BUILTIN_TOOL_NAMES : []);
  return filterDisabledBuiltinTools(resolveClaudeBuiltinTools(source), disabled);
}

function normalizeAbsolutePath(rawPath) {
  const p = String(rawPath || "").trim();
  if (!p || !path.isAbsolute(p)) return null;
  return p;
}

function parseCommandArgs(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item || "").trim()).filter(Boolean);
      }
    } catch {
      // Fallback to whitespace split below.
    }
  }
  return text.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function resolveClaudeCodeCliPath(env = {}) {
  const explicitPath = String(
    env?.HANAKO_CLAUDE_CODE_CLI_PATH
      || env?.HANAKO_CLAUDE_CODE_ENTRY
      || env?.HANA_CLAUDE_CODE_CLI_PATH
      || env?.HANA_CLAUDE_CODE_ENTRY
      || "",
  ).trim();
  if (explicitPath) return path.resolve(explicitPath);
  try {
    const sdkEntryPath = require.resolve("@anthropic-ai/claude-agent-sdk");
    const candidate = path.join(path.dirname(sdkEntryPath), "cli.js");
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // Fallback below.
  }
  try {
    const pkgJsonPath = require.resolve("@anthropic-ai/claude-agent-sdk/package.json");
    const candidate = path.join(path.dirname(pkgJsonPath), "cli.js");
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // Fallback below.
  }
  try {
    return require.resolve("@anthropic-ai/claude-agent-sdk/cli.js");
  } catch {
    return null;
  }
}

function resolveClaudeSdkProcessConfig(runtimeEnv = {}) {
  const explicitExecutable = String(
    runtimeEnv?.HANAKO_CLAUDE_CODE_EXECUTABLE
      || runtimeEnv?.HANAKO_CLAUDE_EXECUTABLE
      || runtimeEnv?.HANA_CLAUDE_CODE_EXECUTABLE
      || runtimeEnv?.HANA_CLAUDE_EXECUTABLE
      || "",
  ).trim();
  const executable = explicitExecutable || process.execPath;
  const executableArgsRaw = String(
    runtimeEnv?.HANAKO_CLAUDE_CODE_EXECUTABLE_ARGS
      || runtimeEnv?.HANAKO_CLAUDE_EXECUTABLE_ARGS
      || runtimeEnv?.HANA_CLAUDE_CODE_EXECUTABLE_ARGS
      || runtimeEnv?.HANA_CLAUDE_EXECUTABLE_ARGS
      || "",
  ).trim();
  const executableArgs = parseCommandArgs(executableArgsRaw);
  const pathToClaudeCodeExecutable = resolveClaudeCodeCliPath(runtimeEnv);

  const resolvedEnv = {
    ...(runtimeEnv || {}),
  };
  const executableBase = path.basename(String(executable || "")).toLowerCase();
  const looksLikeNodeBinary = executableBase === "node"
    || executableBase === "node.exe"
    || executableBase.startsWith("node-v");
  const shouldRunAsNode = !looksLikeNodeBinary && (
    String(process?.versions?.electron || "").trim().length > 0
    || /electron/i.test(executableBase)
    || /hanako/i.test(executableBase)
  );
  if (shouldRunAsNode) {
    resolvedEnv.ELECTRON_RUN_AS_NODE = "1";
  }

  return {
    executable,
    executableArgs,
    pathToClaudeCodeExecutable,
    env: resolvedEnv,
  };
}

function buildSandboxConfig(mode, workspace, pathRules) {
  return {
    enabled: false,
  };
}

function buildAdditionalDirectories(cwd, workspace, pathRules) {
  return uniq([
    cwd,
    workspace,
    ...pathRules.map((rule) => rule.path),
  ]).filter(Boolean);
}

function toMcpAllowedPrefix(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  // Keep tool permission prefixes deterministic and ASCII-safe.
  const normalized = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  return normalized ? `mcp__${normalized}__*` : "";
}

function toMcpServerName(name) {
  return String(name || "").trim().replace(/[^A-Za-z0-9_]/g, "_");
}

function toMcpToolName(serverName, toolName) {
  const server = toMcpServerName(serverName);
  const tool = toMcpServerName(toolName);
  if (!server || !tool) return "";
  return `mcp__${server}__${tool}`;
}

function buildMcpExactAllowedTools(serverName, toolNames = []) {
  const serverRaw = String(serverName || "").trim();
  const variants = uniq([
    serverRaw,
    serverRaw.toLowerCase(),
  ].filter(Boolean));
  const out = [];
  for (const variant of variants) {
    for (const toolName of toolNames) {
      const full = toMcpToolName(variant, toolName);
      if (full) out.push(full);
    }
  }
  return uniq(out);
}

function normalizeExternalMcpServerConfig(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.disabled === true || raw.enabled === false) return null;

  const type = String(raw.type || (raw.url ? "sse" : "stdio")).trim() || "stdio";
  if (type === "stdio") {
    const command = String(raw.command || "").trim();
    if (!command) return null;
    const args = Array.isArray(raw.args)
      ? raw.args.map((item) => String(item || "").trim()).filter(Boolean)
      : parseCommandArgs(raw.args);
    const env = {};
    if (raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)) {
      for (const [key, value] of Object.entries(raw.env)) {
        const envKey = String(key || "").trim();
        if (!envKey) continue;
        env[envKey] = String(value ?? "");
      }
    }
    return {
      type: "stdio",
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  if (type === "sse" || type === "http") {
    const url = String(raw.url || "").trim();
    if (!url) return null;
    const headers = {};
    if (raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
      for (const [key, value] of Object.entries(raw.headers)) {
        const headerKey = String(key || "").trim();
        if (!headerKey) continue;
        headers[headerKey] = String(value ?? "");
      }
    }
    return {
      type,
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }

  return null;
}

export function resolveExternalMcpServers(rawConfig = {}, opts = {}) {
  const globalConfigured = opts.externalServers || rawConfig?._globalMcp?.external_servers || {};
  const localConfigured = rawConfig?.mcp?.external_servers || rawConfig?.external_mcp?.servers || {};
  const configured = {
    ...(globalConfigured && typeof globalConfigured === "object" && !Array.isArray(globalConfigured) ? globalConfigured : {}),
    ...(localConfigured && typeof localConfigured === "object" && !Array.isArray(localConfigured) ? localConfigured : {}),
  };
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
    return { servers: {}, allowedTools: [] };
  }

  const disabledServers = new Set(
    Array.isArray(rawConfig?.mcp?.disabled_servers)
      ? rawConfig.mcp.disabled_servers.map(toMcpServerName).filter(Boolean)
      : [],
  );
  const servers = {};
  const allowedTools = [];
  for (const [rawName, rawServer] of Object.entries(configured)) {
    const key = toMcpServerName(rawName);
    if (!key || RESERVED_MCP_SERVER_KEYS.has(key)) continue;
    if (disabledServers.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(servers, key)) continue;
    const server = normalizeExternalMcpServerConfig(rawServer);
    if (!server) continue;
    servers[key] = server;
    const prefix = toMcpAllowedPrefix(key);
    if (prefix) allowedTools.push(prefix);
  }
  return { servers, allowedTools: uniq(allowedTools) };
}

function inferMiniMaxApiHost(baseUrl = "") {
  const input = String(baseUrl || "").trim();
  if (!input) return "";
  try {
    const parsed = new URL(input);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
}

function resolveMiniMaxMcpEnv(runtimeEnv = {}, agent = null) {
  const out = {};
  const explicitApiKey = String(runtimeEnv?.MINIMAX_API_KEY || "").trim();
  const explicitApiHost = String(runtimeEnv?.MINIMAX_API_HOST || "").trim();
  const explicitBasePath = String(runtimeEnv?.MINIMAX_MCP_BASE_PATH || "").trim();
  const explicitResourceMode = String(runtimeEnv?.MINIMAX_API_RESOURCE_MODE || "").trim();

  let apiKey = explicitApiKey;
  let apiHost = explicitApiHost;
  if (!apiKey || !apiHost) {
    const resolveCreds = agent?._engine?.resolveProviderCredentials;
    if (typeof resolveCreds === "function") {
      for (const provider of ["minimax", "minimax-oauth"]) {
        const creds = resolveCreds.call(agent._engine, provider, agent?.config);
        if (!apiKey) {
          const candidate = String(creds?.api_key || "").trim();
          if (candidate) apiKey = candidate;
        }
        if (!apiHost) {
          const candidate = inferMiniMaxApiHost(creds?.base_url || "");
          if (candidate) apiHost = candidate;
        }
        if (apiKey && apiHost) break;
      }
    }
  }

  if (apiKey) out.MINIMAX_API_KEY = apiKey;
  if (apiHost) out.MINIMAX_API_HOST = apiHost;
  if (explicitBasePath) out.MINIMAX_MCP_BASE_PATH = explicitBasePath;
  if (explicitResourceMode) out.MINIMAX_API_RESOURCE_MODE = explicitResourceMode;
  return out;
}

function resolveMiniMaxMcpServer(runtimeEnv = {}, agent = null) {
  const command = String(
    runtimeEnv?.HANAKO_MINIMAX_MCP_COMMAND
      || runtimeEnv?.HANA_MINIMAX_MCP_COMMAND
      || "uvx",
  ).trim();
  if (!command) return null;
  const argsRaw = String(
    runtimeEnv?.HANAKO_MINIMAX_MCP_ARGS
      || runtimeEnv?.HANA_MINIMAX_MCP_ARGS
      || "",
  ).trim();
  const args = argsRaw ? parseCommandArgs(argsRaw) : ["minimax-coding-plan-mcp"];
  const env = resolveMiniMaxMcpEnv(runtimeEnv, agent);
  return {
    type: "stdio",
    command,
    args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

const VALID_SETTING_SOURCES = new Set(["user", "project", "local"]);

function normalizeSettingSources(rawSources) {
  const list = Array.isArray(rawSources)
    ? rawSources
    : String(rawSources || "").split(",");
  const out = [];
  const seen = new Set();
  for (const source of list) {
    const normalized = String(source || "").trim().toLowerCase();
    if (!VALID_SETTING_SOURCES.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function resolveSettingSources(agent, runtimeEnv = {}) {
  const fromAgent = normalizeSettingSources(agent?.config?.claude?.setting_sources);
  if (fromAgent.length > 0) return fromAgent;

  const fromEnv = normalizeSettingSources(runtimeEnv?.HANAKO_CLAUDE_SETTING_SOURCES);
  if (fromEnv.length > 0) return fromEnv;

  // SDK isolation mode would disable all filesystem settings.
  // Default to "user" so each agent can discover its own skills via CLAUDE_CONFIG_DIR.
  return ["user"];
}

function shouldForceToolsOption() {
  const raw = String(process.env.HANAKO_FORCE_SDK_TOOLS_OPTION || "").trim();
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  // Default to strict tool list injection so provider-side built-ins
  // cannot leak in through compatibility layers.
  return true;
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

function resolveToolTargetPath(toolName, input = {}, cwd = process.cwd()) {
  const payload = (input && typeof input === "object") ? input : {};
  const readWriteTools = new Set(["Read", "Write", "Edit"]);
  const treeTools = new Set(["Glob", "Grep"]);
  let rawPath = "";
  if (readWriteTools.has(toolName)) {
    rawPath = String(payload.file_path || payload.path || "").trim();
  } else if (treeTools.has(toolName)) {
    rawPath = String(payload.path || "").trim();
  }
  if (!rawPath) return null;
  return path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(cwd, rawPath);
}

function resolveReadTargetPath(input = {}, cwd = process.cwd()) {
  const payload = (input && typeof input === "object") ? input : {};
  const rawPath = String(payload.file_path || payload.path || "").trim();
  if (!rawPath) return "";
  return path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(cwd, rawPath);
}

function isImagePath(filePath = "") {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return IMAGE_FILE_EXTENSIONS.has(ext);
}

function isAgentProjectMemoryPath(targetPath, agentDir) {
  const base = normalizeAbsolutePath(agentDir);
  const target = normalizeAbsolutePath(targetPath);
  if (!base || !target) return false;
  const projectsRoot = path.resolve(base, "projects");
  if (!isPathInside(target, projectsRoot)) return false;
  const rel = path.relative(projectsRoot, target);
  if (!rel || rel.startsWith("..")) return false;
  const parts = rel.split(path.sep).filter(Boolean);
  // 仅屏蔽 projects/<project>/memory/**（历史遗留冗余目录）
  return parts.length >= 2 && parts[1].toLowerCase() === "memory";
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

function createAllowedToolMatcher(allowedTools = []) {
  const exact = new Set();
  const prefix = [];
  for (const item of Array.isArray(allowedTools) ? allowedTools : []) {
    const name = String(item || "").trim();
    if (!name) continue;
    if (name.endsWith("*")) {
      prefix.push(name.slice(0, -1));
      continue;
    }
    exact.add(name);
  }
  return (exact.size > 0 || prefix.length > 0)
    ? { exact, prefix }
    : null;
}

function isToolAllowedByMatcher(toolName, matcher) {
  if (!matcher) return true;
  const name = String(toolName || "").trim();
  if (!name) return false;
  if (matcher.exact.has(name)) return true;
  return matcher.prefix.some((p) => name.startsWith(p));
}

function parseAllowedPrompts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      tool: String(item.tool || "Bash"),
      prompt: String(item.prompt || "").trim(),
    }))
    .filter((item) => item.prompt.length > 0);
}

function parseAskUserQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === "object")
    .map((item, index) => {
      const id = String(item.id || "").trim() || `q_${index + 1}`;
      const question = String(item.question || "").trim();
      const header = String(item.header || "").trim();
      const options = Array.isArray(item.options)
        ? item.options
          .filter((option) => option && typeof option === "object")
          .map((option) => ({
            label: String(option.label || "").trim(),
            description: String(option.description || "").trim(),
          }))
          .filter((option) => option.label.length > 0)
        : [];
      return {
        id,
        question,
        header,
        options,
        multiSelect: item.multiSelect === true,
      };
    })
    .filter((item) => item.question.length > 0 || item.header.length > 0);
}

async function waitForPlanModeConfirmation({
  confirmStore,
  emitToolEvent,
  sessionPath,
  phase,
  input,
}) {
  if (!confirmStore || typeof confirmStore.create !== "function") {
    return { action: "confirmed" };
  }
  const payload = {
    phase,
    prompt: String(input?.prompt || "").trim(),
    allowedPrompts: phase === "exit"
      ? parseAllowedPrompts(input?.allowedPrompts)
      : [],
  };
  const { confirmId, promise } = confirmStore.create(
    "plan_mode",
    payload,
    sessionPath || null,
  );
  if (typeof emitToolEvent === "function") {
    emitToolEvent({
      type: "plan_mode_confirmation",
      confirmId,
      phase,
      prompt: payload.prompt,
      allowedPrompts: payload.allowedPrompts,
    });
  }
  return promise;
}

async function waitForAskUserConfirmation({
  confirmStore,
  emitToolEvent,
  sessionPath,
  input,
}) {
  if (!confirmStore || typeof confirmStore.create !== "function") {
    return { action: "confirmed", value: {} };
  }
  const questions = parseAskUserQuestions(input?.questions);
  const { confirmId, promise } = confirmStore.create(
    "ask_user",
    { questions },
    sessionPath || null,
  );
  if (typeof emitToolEvent === "function") {
    emitToolEvent({
      type: "ask_user_confirmation",
      confirmId,
      questions,
    });
  }
  return promise;
}

function buildCanUseToolHandler(permissionStrategy, opts = {}) {
  if (permissionStrategy !== "auto_allow") return undefined;
  const strictSandbox = false;
  const allowedRoots = strictSandbox ? resolveAllowedRoots(opts.workspace, opts.pathRules) : [];
  const cwd = opts.cwd;
  const agentDir = opts.agentDir;
  const allowedToolMatcher = createAllowedToolMatcher(opts.allowedTools);
  const confirmStore = opts.confirmStore;
  const sessionPath = opts.sessionPath || null;
  const emitToolEvent = opts.emitToolEvent;
  let planModeEntered = false;

  return async (toolName, input = {}) => {
    const payload = (input && typeof input === "object") ? input : {};
    if (!isToolAllowedByMatcher(toolName, allowedToolMatcher)) {
      return {
        behavior: "deny",
        message: `Tool "${String(toolName || "").trim()}" is not allowed by current session policy.`,
      };
    }

    if (toolName === "Read") {
      const readTargetPath = resolveReadTargetPath(payload, cwd);
      if (readTargetPath && isImagePath(readTargetPath)) {
        return {
          behavior: "deny",
          message: `Tool "Read" denied for image file (${readTargetPath}). Use an available image-understanding tool instead of reading image bytes as text.`,
        };
      }
    }

    const targetPath = resolveToolTargetPath(toolName, payload, cwd);
    if (targetPath && isAgentProjectMemoryPath(targetPath, agentDir)) {
      return {
        behavior: "deny",
        message: `Tool "${toolName}" denied: writing/reading project-local memory files is disabled (${targetPath}).`,
      };
    }
    if (strictSandbox && targetPath) {
      const allowed = allowedRoots.some((root) => isPathInside(targetPath, root));
      if (!allowed) {
        return {
          behavior: "deny",
          message: `Tool "${toolName}" denied: path is outside strict sandbox scope (${targetPath}).`,
        };
      }
    }

    if (toolName === "AskUserQuestion") {
      const decision = await waitForAskUserConfirmation({
        confirmStore,
        emitToolEvent,
        sessionPath,
        input: payload,
      });
      if (decision?.action === "confirmed") {
        const answers = decision?.value && typeof decision.value === "object"
          ? decision.value
          : {};
        return {
          behavior: "allow",
          updatedInput: {
            ...payload,
            answers,
          },
        };
      }
      return {
        behavior: "deny",
        message: "AskUserQuestion was rejected by the user.",
      };
    }

    if (toolName === "EnterPlanMode") {
      const decision = await waitForPlanModeConfirmation({
        confirmStore,
        emitToolEvent,
        sessionPath,
        phase: "enter",
        input: payload,
      });
      if (decision?.action === "confirmed") {
        planModeEntered = true;
        return {
          behavior: "allow",
          updatedInput: payload,
        };
      }
      return {
        behavior: "deny",
        message: "Entering plan mode was rejected by the user.",
      };
    }

    if (toolName === "ExitPlanMode") {
      if (!planModeEntered) {
        return {
          behavior: "allow",
          updatedInput: payload,
        };
      }
      const decision = await waitForPlanModeConfirmation({
        confirmStore,
        emitToolEvent,
        sessionPath,
        phase: "exit",
        input: payload,
      });
      if (decision?.action === "confirmed") {
        planModeEntered = false;
        return {
          behavior: "allow",
          updatedInput: payload,
        };
      }
      return {
        behavior: "deny",
        message: "Exiting plan mode was rejected by the user.",
      };
    }

    const denyReason = detectBashBypassAttempt(toolName, input, {
      strictSandbox,
      allowedRoots,
      cwd,
    });
    if (denyReason) return { behavior: "deny", message: denyReason };
    if (toolName === "Bash") {
      return {
        behavior: "allow",
        updatedInput: {
          ...payload,
          command: withClaudeProxyEnvUnset(payload.command),
        },
      };
    }
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
  disabledBuiltinTools = [],
  createToolContext,
  emitToolEvent,
  systemAppend,
  noTools = false,
  noMemory = false,
  model,
  env = {},
  confirmStore = null,
  sessionPath = null,
} = {}) {
  const explicitClaudeConfigDir = String(env?.CLAUDE_CONFIG_DIR || "").trim();
  let runtimeEnv = {
    ...process.env,
    ...(env || {}),
  };
  const agentConfigDir = normalizeAbsolutePath(agent?.agentDir);
  applyClaudeNoProxyRuntimeEnv(runtimeEnv, agentConfigDir || cwd || workspace);
  if (!explicitClaudeConfigDir && agentConfigDir) {
    // Route Claude's user-level customizations (including Skill tool discovery)
    // to the current agent directory, where Hanako stores per-agent skills.
    runtimeEnv.CLAUDE_CONFIG_DIR = agentConfigDir;
  }
  const claudeSdkProcessConfig = resolveClaudeSdkProcessConfig(runtimeEnv);
  runtimeEnv = claudeSdkProcessConfig.env;
  const sandboxMode = "full-access";
  const pathRules = [];
  const permissionStrategy = resolvePermissionStrategy(agent);
  const settingSources = resolveSettingSources(agent, runtimeEnv);
  const builtinEnabled = noTools
    ? []
    : resolveRuntimeBuiltinTools(
      builtinEnabledOverride || toolProfile?.tools?.builtin_enabled || [],
      disabledBuiltinTools,
    );
  const customEnabled = noTools
    ? []
    : uniq(customEnabledOverride || toolProfile?.tools?.custom_enabled || []);
  const browserProvider = resolveBrowserProvider(runtimeEnv, { cwd, workspace });
  const useClaudeInChrome = !noTools
    && customEnabled.includes(CLAUDE_IN_CHROME_SWITCH)
    && browserProvider.useClaudeInChrome === true;
  const enabledMiniMaxMcpTools = !noTools
    ? uniq(
      customEnabled
        .map((name) => MINIMAX_MCP_TOOL_BY_SWITCH[name])
        .filter(Boolean),
    )
    : [];
  const useMiniMaxMcp = enabledMiniMaxMcpTools.length > 0;
  const filteredCustomTools = (customTools || [])
    .filter((toolDef) => customEnabled.includes(toolDef?.name))
    .filter((toolDef) => ![
      CLAUDE_IN_CHROME_SWITCH,
      MINIMAX_MCP_WEB_SEARCH_SWITCH,
      MINIMAX_MCP_UNDERSTAND_IMAGE_SWITCH,
    ].includes(String(toolDef?.name || "")));
  const mcpServerKey = "hanako";
  const mcpServerName = "hanako";
  // IMPORTANT: Claude Agent SDK can crash the Claude subprocess when an MCP
  // server key contains '-' (e.g. "claude-in-chrome"), leading to:
  // "Claude Code process exited with code 1".
  // Use an underscore-only key and expose matching tool prefixes.
  const claudeInChromeServerKey = "claude_in_chrome";
  // Claude Agent SDK MCP docs recommend allowing MCP tools via server-level
  // wildcard (mcp__<server>__*). Keep both key/name prefixes for compatibility
  // across SDK variants that may resolve server names differently.
  const customAllowedTools = filteredCustomTools.length > 0
    ? uniq([
      toMcpAllowedPrefix(mcpServerKey),
      toMcpAllowedPrefix(mcpServerName),
    ].filter(Boolean))
    : [];
  const claudeInChromeAllowedTools = useClaudeInChrome
    ? [toMcpAllowedPrefix(claudeInChromeServerKey)].filter(Boolean)
    : [];
  const minimaxMcpAllowedTools = useMiniMaxMcp
    ? buildMcpExactAllowedTools(MINIMAX_MCP_SERVER_KEY, enabledMiniMaxMcpTools)
    : [];
  const externalMcp = noTools
    ? { servers: {}, allowedTools: [] }
    : resolveExternalMcpServers(agent?.config || {}, {
      externalServers: agent?._engine?.getExternalMcpServers?.() || {},
    });
  const allowedTools = uniq([
    ...builtinEnabled,
    ...customAllowedTools,
    ...claudeInChromeAllowedTools,
    ...minimaxMcpAllowedTools,
    ...externalMcp.allowedTools,
  ]);
  const canUseTool = buildCanUseToolHandler(permissionStrategy, {
    sandboxMode,
    workspace,
    pathRules,
    cwd,
    agentDir: agent?.agentDir,
    confirmStore,
    sessionPath,
    emitToolEvent,
    allowedTools,
  });
  const mcpServers = {};
  if (filteredCustomTools.length > 0) {
    mcpServers[mcpServerKey] = createCustomToolsMcpServer(
      mcpServerName,
      filteredCustomTools,
      {
        createContext: createToolContext,
        onToolStart: emitToolEvent,
        onToolEnd: emitToolEvent,
      },
    );
  }
  if (useClaudeInChrome && browserProvider.claudeInChromeServer) {
    mcpServers[claudeInChromeServerKey] = browserProvider.claudeInChromeServer;
  }
  if (useMiniMaxMcp) {
    const minimaxMcpServer = resolveMiniMaxMcpServer(runtimeEnv, agent);
    if (minimaxMcpServer) {
      mcpServers[MINIMAX_MCP_SERVER_KEY] = minimaxMcpServer;
    }
  }
  for (const [serverKey, serverConfig] of Object.entries(externalMcp.servers)) {
    if (!Object.prototype.hasOwnProperty.call(mcpServers, serverKey)) {
      mcpServers[serverKey] = serverConfig;
    }
  }

  const baseAppend = noMemory
    ? (
      noTools
        ? agent?.personality
        : agent?.buildSystemAppendPrompt?.({
          includeUserProfile: false,
          includeMemory: false,
          includeDateTime: false,
        }) || agent?.personality
    )
    : agent?.buildSystemAppendPrompt?.();
  const append = [baseAppend, systemAppend].filter(Boolean).join("\n\n");
  const strictSandbox = false;
  const additionalDirectories = buildAdditionalDirectories(cwd, workspace, pathRules);
  const shouldForceTools = shouldForceToolsOption();
  const options = {
    cwd,
    model,
    executable: claudeSdkProcessConfig.executable,
    ...(claudeSdkProcessConfig.executableArgs.length > 0
      ? { executableArgs: claudeSdkProcessConfig.executableArgs }
      : {}),
    ...(claudeSdkProcessConfig.pathToClaudeCodeExecutable
      ? { pathToClaudeCodeExecutable: claudeSdkProcessConfig.pathToClaudeCodeExecutable }
      : {}),
    env: runtimeEnv,
    settings: {
      // Default to skipping WebFetch preflight blocklist checks so
      // enterprise/restricted networks can still attempt runtime fetches.
      skipWebFetchPreflight: true,
    },
    mcpServers,
    additionalDirectories,
    ...(allowedTools.length > 0 || noTools ? { allowedTools } : {}),
    ...(shouldForceTools || noTools ? { tools: builtinEnabled } : {}),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append,
    },
    sandbox: buildSandboxConfig(sandboxMode, workspace, pathRules),
    permissionMode: "bypassPermissions",
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
      allowedTools,
      forcedToolsOption: shouldForceTools || noTools,
      permissionStrategy,
      hasCanUseTool: typeof canUseTool === "function",
      customToolsLoaded: filteredCustomTools.map((toolDef) => toolDef?.name).filter(Boolean),
      mcpServerKey,
      mcpServerName,
      customAllowedTools,
      claudeInChromeAllowedTools,
      minimaxMcpAllowedTools,
      externalMcpAllowedTools: externalMcp.allowedTools,
      externalMcpServers: Object.keys(externalMcp.servers),
      browserProvider,
      useClaudeInChrome,
      useMiniMaxMcp,
      enabledMiniMaxMcpTools,
      claudeCodeExecutable: claudeSdkProcessConfig.executable,
      claudeCodeExecutableArgs: claudeSdkProcessConfig.executableArgs,
      claudeCodeCliPath: claudeSdkProcessConfig.pathToClaudeCodeExecutable,
    },
  };
}
