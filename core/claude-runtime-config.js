import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { createCustomToolsMcpServer } from "../lib/claude/custom-tool-adapter.js";
import { getBuiltinExternalMcpServers } from "./builtin-mcp-servers.js";
import {
  MINIMAX_MCP_UNDERSTAND_IMAGE_SWITCH,
  MINIMAX_MCP_WEB_SEARCH_SWITCH,
} from "../lib/tools/minimax-mcp-tools.js";
import { extractDeleteTargets, extractGuardPaths } from "../lib/sandbox/tool-wrapper.js";
import { readSessionMessageEntries, readSessionMessagesFromLog } from "./session-message-log.js";
import { readSessionMetadata } from "./claude-session-store.js";
import { buildSessionMessagesFromSession, readClaudeTranscriptEntries } from "./claude-transcript.js";

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
const HIGH_RISK_TEXT_CONFIRM_TTL_MS = 10 * 60 * 1000;
const HIGH_RISK_PENDING_TEXT_CONFIRM = new Map();
const HIGH_RISK_CODE_LABELS = {
  destructive_delete: "删除类危险操作",
  irreversible_git: "不可逆 Git 操作",
  privileged_system: "系统权限类操作",
  data_exfiltration: "可能的数据外传操作",
  sensitive_write: "敏感路径写入",
  cron_mutation: "定时任务变更",
};

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
  const forceLocalProxy = /^(1|true|yes|on)$/i.test(
    String(env?.HANAKO_FORCE_LOCAL_PROXY || process.env.HANAKO_FORCE_LOCAL_PROXY || "").trim(),
  );
  const hasExplicitProxy = CLAUDE_PROXY_ENV_KEYS.some(
    (key) => String(env?.[key] || "").trim().length > 0,
  );

  // Default behavior: keep existing proxy settings if user configured them;
  // otherwise run direct network access to avoid hard-failing on localhost proxy.
  if (!hasExplicitProxy) {
    removeClaudeProxyEnv(env);
  }
  if (forceLocalProxy) {
    env.http_proxy = DEFAULT_LOCAL_PROXY_URL;
    env.https_proxy = DEFAULT_LOCAL_PROXY_URL;
    env.HTTP_PROXY = DEFAULT_LOCAL_PROXY_URL;
    env.HTTPS_PROXY = DEFAULT_LOCAL_PROXY_URL;
    env.all_proxy = "socks5h://127.0.0.1:7897";
    env.ALL_PROXY = "socks5h://127.0.0.1:7897";
  }
  if (!String(env.no_proxy || "").trim()) env.no_proxy = "localhost,127.0.0.1,::1";
  if (!String(env.NO_PROXY || "").trim()) env.NO_PROXY = "localhost,127.0.0.1,::1";

  const rootDir = normalizeAbsolutePath(baseDir);
  if (!rootDir || !forceLocalProxy) return env;

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

function resolveWindowsGitBashPath(runtimeEnv = {}) {
  if (process.platform !== "win32") return "";
  const explicit = String(runtimeEnv?.CLAUDE_CODE_GIT_BASH_PATH || "").trim();
  if (explicit && fs.existsSync(explicit)) return explicit;

  const candidates = [];
  const push = (p) => {
    const normalized = String(p || "").trim();
    if (!normalized || candidates.includes(normalized)) return;
    candidates.push(normalized);
  };

  const programFiles = [
    runtimeEnv?.ProgramFiles,
    runtimeEnv?.["ProgramFiles(x86)"],
    runtimeEnv?.ProgramW6432,
  ].filter(Boolean);
  for (const base of programFiles) {
    push(path.join(base, "Git", "bin", "bash.exe"));
    push(path.join(base, "Git", "usr", "bin", "bash.exe"));
  }

  const localAppData = String(runtimeEnv?.LOCALAPPDATA || "").trim();
  if (localAppData) {
    push(path.join(localAppData, "Programs", "Git", "bin", "bash.exe"));
    push(path.join(localAppData, "Programs", "Git", "usr", "bin", "bash.exe"));
  }

  const resourcesPath = String(process.resourcesPath || "").trim();
  if (resourcesPath) {
    push(path.join(resourcesPath, "git", "usr", "bin", "bash.exe"));
    push(path.join(resourcesPath, "git", "bin", "bash.exe"));
  }

  // Source/dev fallback: vendor/git-portable downloaded by prepare:win
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  push(path.join(repoRoot, "vendor", "git-portable", "usr", "bin", "bash.exe"));
  push(path.join(repoRoot, "vendor", "git-portable", "bin", "bash.exe"));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function ensureWindowsGitBashEnv(runtimeEnv = {}) {
  if (process.platform !== "win32") return runtimeEnv;
  if (String(runtimeEnv?.CLAUDE_CODE_GIT_BASH_PATH || "").trim()) return runtimeEnv;
  const detected = resolveWindowsGitBashPath(runtimeEnv);
  if (detected) runtimeEnv.CLAUDE_CODE_GIT_BASH_PATH = detected;
  return runtimeEnv;
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

function resolveBundledClaudeCodeExecutable(env = {}) {
  const normalizedArch = String(
    env?.HANAKO_CLAUDE_CODE_BINARY_ARCH
      || env?.HANAKO_CLAUDE_BINARY_ARCH
      || env?.HANA_CLAUDE_CODE_BINARY_ARCH
      || env?.HANA_CLAUDE_BINARY_ARCH
      || "",
  ).trim().toLowerCase();

  const candidatePackageIds = [];
  const pushPkg = (pkg) => {
    if (!pkg || candidatePackageIds.includes(pkg)) return;
    candidatePackageIds.push(pkg);
  };

  if (process.platform === "win32") {
    const preferredArchs = [];
    if (normalizedArch === "x64" || normalizedArch === "arm64") preferredArchs.push(normalizedArch);
    if (process.arch === "arm64") {
      preferredArchs.push("arm64", "x64");
    } else if (process.arch === "x64") {
      preferredArchs.push("x64", "arm64");
    } else {
      preferredArchs.push(process.arch);
    }
    for (const arch of preferredArchs) {
      pushPkg(`@anthropic-ai/claude-agent-sdk-win32-${arch}`);
    }
  } else if (process.platform === "darwin") {
    const preferredArchs = [];
    if (normalizedArch === "x64" || normalizedArch === "arm64") preferredArchs.push(normalizedArch);
    preferredArchs.push(process.arch, process.arch === "arm64" ? "x64" : "arm64");
    for (const arch of preferredArchs) {
      pushPkg(`@anthropic-ai/claude-agent-sdk-darwin-${arch}`);
    }
  } else if (process.platform === "linux") {
    const preferredArchs = [];
    if (normalizedArch === "x64" || normalizedArch === "arm64") preferredArchs.push(normalizedArch);
    preferredArchs.push(process.arch, process.arch === "arm64" ? "x64" : "arm64");
    for (const arch of preferredArchs) {
      pushPkg(`@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`);
      pushPkg(`@anthropic-ai/claude-agent-sdk-linux-${arch}`);
    }
  }

  for (const pkgId of candidatePackageIds) {
    try {
      return require.resolve(`${pkgId}/claude${process.platform === "win32" ? ".exe" : ""}`);
    } catch {
      try {
        const pkgJsonPath = require.resolve(`${pkgId}/package.json`);
        const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
        const candidate = path.join(path.dirname(pkgJsonPath), binaryName);
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // try next candidate
      }
    }
  }
  return null;
}

function resolveClaudeCodeCliPath(env = {}) {
  const explicitPath = String(
    env?.HANAKO_CLAUDE_CODE_CLI_PATH
      || env?.HANAKO_CLAUDE_CODE_ENTRY
      || env?.HANA_CLAUDE_CODE_CLI_PATH
      || env?.HANA_CLAUDE_CODE_ENTRY
      || "",
  ).trim();
  if (explicitPath) {
    const resolvedExplicitPath = path.resolve(explicitPath);
    if (fs.existsSync(resolvedExplicitPath)) return resolvedExplicitPath;
  }

  const bundledExecutable = resolveBundledClaudeCodeExecutable(env);
  if (bundledExecutable) return bundledExecutable;

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

function normalizeToolNameForPolicy(toolName = "") {
  const raw = String(toolName || "").trim();
  if (!raw) return "";
  if (CLAUDE_BUILTIN_TOOL_NAMES.includes(raw)) return raw;
  const lowered = raw.toLowerCase();
  const alias = {
    bash: "Bash",
    read: "Read",
    write: "Write",
    edit: "Edit",
    grep: "Grep",
    glob: "Glob",
    find: "Glob",
    ls: "Glob",
  };
  if (alias[lowered]) return alias[lowered];
  const mcpMatch = raw.match(/^mcp__[a-z0-9_-]+__([a-z0-9_-]+)$/i);
  if (mcpMatch?.[1]) {
    const suffix = String(mcpMatch[1] || "").trim().toLowerCase();
    if (alias[suffix]) return alias[suffix];
    if (suffix === "cron") return "cron";
    return mcpMatch[1];
  }
  return raw;
}

function resolveToolTargetPath(toolName, input = {}, cwd = process.cwd()) {
  const payload = (input && typeof input === "object") ? input : {};
  const normalizedTool = normalizeToolNameForPolicy(toolName);
  const readWriteTools = new Set(["Read", "Write", "Edit"]);
  const treeTools = new Set(["Glob", "Grep"]);
  let rawPath = "";
  if (readWriteTools.has(normalizedTool)) {
    rawPath = String(payload.file_path || payload.path || "").trim();
  } else if (treeTools.has(normalizedTool)) {
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
  if (normalizeToolNameForPolicy(toolName) !== "Bash") return null;
  const payload = (input && typeof input === "object") ? input : {};
  const command = String(payload.command || "");
  const strictSandbox = opts.strictSandbox === true;
  const cwd = normalizeAbsolutePath(opts.cwd || process.cwd()) || process.cwd();
  const allowedRoots = Array.isArray(opts.allowedRoots) ? opts.allowedRoots : [];

  // Prevent explicit sandbox escape attempts through Bash tool input.
  if (payload.dangerouslyDisableSandbox === true) {
    return "Bash command denied: disabling sandbox is not allowed.";
  }

  if (strictSandbox) {
    const disallowedPath = findDisallowedBashPath(command, cwd, allowedRoots);
    if (disallowedPath) {
      return `Bash command denied: path is outside strict sandbox scope (${disallowedPath}).`;
    }
  }

  return null;
}

function normalizeExecutionMode(mode = "") {
  const normalized = String(mode || "").trim().toLowerCase();
  if (normalized === "chat" || normalized === "platform" || normalized === "channel") {
    return normalized;
  }
  return "";
}

function resolveSessionExecutionMode({ sessionPath = "", executionMode = "" } = {}) {
  const explicit = normalizeExecutionMode(executionMode);
  if (explicit) return explicit;

  const normalized = String(sessionPath || "").replace(/\\/g, "/").toLowerCase();
  if (
    normalized.includes("/sessions/bridge/")
    || normalized.includes("/bridge/owner/")
  ) return "platform";
  if (normalized.includes("/sessions/channel/")) return "channel";
  return "chat";
}

function truncateText(text = "", max = 160) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

function isCronMutationOperation(payload = {}) {
  const action = String(payload.action || payload.operation || "").trim().toLowerCase();
  if (["add", "create", "remove", "delete", "toggle", "enable", "disable", "pause", "resume", "update"].includes(action)) {
    return true;
  }
  const command = String(payload.command || "").trim().toLowerCase();
  if (!command) return false;
  return /\bcron\s+(add|create|remove|delete|toggle|enable|disable|pause|resume|update)\b/.test(command);
}

function isCronToolName(toolName = "") {
  const name = String(toolName || "").trim().toLowerCase();
  return name === "cron" || name.endsWith("__cron");
}

function isSensitiveWritePath(targetPath = "") {
  const normalized = path.resolve(String(targetPath || ""));
  if (!normalized) return false;

  const unixRules = [
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/var",
    "/private/etc",
    "/private/var",
    "/System",
  ];
  if (process.platform !== "win32") {
    if (unixRules.some((base) => isPathInside(normalized, base) || normalized === base)) return true;
  }

  const home = String(process.env.HOME || "").trim();
  if (home) {
    const homeSensitive = [
      path.join(home, ".ssh"),
      path.join(home, ".gnupg"),
      path.join(home, ".aws"),
      path.join(home, ".config"),
      path.join(home, ".kube"),
      path.join(home, ".docker"),
    ];
    if (homeSensitive.some((base) => isPathInside(normalized, base) || normalized === base)) return true;
  }

  if (process.platform === "win32") {
    const winPath = normalized.toLowerCase();
    const markers = [
      "\\windows\\",
      "\\program files\\",
      "\\program files (x86)\\",
      "\\system32\\",
      "\\users\\default\\",
      "\\appdata\\roaming\\",
      "\\appdata\\local\\",
      "\\.ssh\\",
    ];
    if (markers.some((marker) => winPath.includes(marker))) return true;
  }

  return false;
}

function makeHighRiskDecision(code, summary, signature) {
  return {
    highRisk: true,
    code,
    label: HIGH_RISK_CODE_LABELS[code] || "高风险操作",
    summary: truncateText(summary, 220),
    signature: String(signature || summary || code || "").trim(),
  };
}

function formatZhCount(n = 0) {
  const num = Number.isFinite(Number(n)) ? Math.max(0, Number(n)) : 0;
  if (num === 2) return "两";
  const zh = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  if (num >= 0 && num <= 10 && Number.isInteger(num)) return zh[num];
  return String(num);
}

function isScreenshotLikeFilePath(targetPath = "") {
  const base = path.basename(String(targetPath || "")).toLowerCase();
  if (!base) return false;
  const hasScreenshotName = /(截屏|屏幕快照|screenshot|screen\s*shot|截图)/i.test(base);
  const hasImageExt = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif|svg)$/i.test(base);
  return hasScreenshotName && hasImageExt;
}

function trimTrailingPathSeparators(rawPath = "") {
  const text = String(rawPath || "");
  if (!text) return text;
  if (/^[A-Za-z]:[\\/]{0,1}$/.test(text)) return text;
  if (text === "/" || text === "\\") return text;
  return text.replace(/[\\/]+$/g, "");
}

function inferDeleteTargetKindZh(targetPath = "") {
  const p = String(targetPath || "").trim();
  if (!p) return "文件/文件夹";
  if (isScreenshotLikeFilePath(p)) return "截屏";

  try {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) return "文件夹";
    if (stat.isFile()) return "文件";
  } catch {
    // fallback to heuristic
  }

  const normalized = trimTrailingPathSeparators(p);
  const base = path.basename(normalized);
  if (!base) return "文件/文件夹";
  if (path.extname(base)) return "文件";
  return "文件夹";
}

function buildDeleteTargetLabelZh(targetPath = "") {
  const p = String(targetPath || "").trim();
  const normalized = trimTrailingPathSeparators(p);
  const base = path.basename(normalized) || normalized || p;
  const display = truncateText(base, 36);
  const kind = inferDeleteTargetKindZh(p);
  return `${kind}“${display}”`;
}

function buildDestructiveDeleteConfirmTextZh(deleteTargets = []) {
  const targets = Array.isArray(deleteTargets)
    ? [...new Set(deleteTargets.filter(Boolean).map((item) => String(item).trim()).filter(Boolean))]
    : [];
  if (targets.length === 0) return "删除文件/文件夹";
  const labels = targets.map((item) => buildDeleteTargetLabelZh(item));
  if (labels.length <= 2) {
    return `删除${labels.join("、")}`;
  }
  const shown = labels.slice(0, 2).join("、");
  return `删除${shown}等${formatZhCount(labels.length)}项`;
}

function buildIrreversibleGitConfirmTextZh(command = "") {
  const cmd = String(command || "").trim();
  if (!cmd) return "执行不可逆的 Git 变更";
  if (/\bgit\s+reset\s+--hard\b/i.test(cmd)) return "执行 Git 强制回退（reset --hard）";
  if (/\bgit\s+checkout\s+--\s+/i.test(cmd)) return "执行 Git 文件覆盖恢复（checkout --）";
  if (/\bgit\s+restore\b[^\n\r;]*\s--source\b/i.test(cmd)) return "执行 Git 指定来源覆盖恢复（restore --source）";
  if (/\bgit\s+clean\b[^\n\r;]*\b-f\b/i.test(cmd)) return "清理未跟踪文件（git clean -f）";
  return "执行不可逆的 Git 变更";
}

function buildPrivilegedSystemConfirmTextZh(command = "") {
  const cmd = String(command || "").trim();
  if (!cmd) return "执行系统级高权限命令";

  const systemctlMatch = cmd.match(/\bsystemctl\s+(restart|start|stop|enable|disable)\s+([A-Za-z0-9_.@-]+)/i);
  if (systemctlMatch?.[1] && systemctlMatch?.[2]) {
    const op = String(systemctlMatch[1]).toLowerCase();
    const service = String(systemctlMatch[2]).trim();
    const opLabel = ({
      restart: "重启",
      start: "启动",
      stop: "停止",
      enable: "启用",
      disable: "禁用",
    })[op] || "变更";
    return `${opLabel}系统服务 ${service}`;
  }

  if (/\bchmod\b/i.test(cmd)) return "修改文件权限（chmod）";
  if (/\bchown\b/i.test(cmd)) return "修改文件所有者（chown）";
  if (/\bschtasks\b/i.test(cmd)) return "修改系统计划任务（schtasks）";
  if (/\breg\b\s+(?:add|delete)\b/i.test(cmd)) return "修改系统注册表（reg）";
  if (/\bsudo\b/i.test(cmd) || /\bsu(?:\s|$)/i.test(cmd) || /\bdoas\b/i.test(cmd) || /\bpkexec\b/i.test(cmd)) {
    return "执行提权命令";
  }
  return "执行系统级高权限命令";
}

function buildDataExfiltrationConfirmTextZh(command = "") {
  const cmd = String(command || "").trim();
  if (!cmd) return "执行可能外传数据的网络命令";
  if (/\bcurl\b[^\n\r;]*(?:\s-F\s+['"]?@|\s--form\s+['"]?@|\s--data-binary\s+@|\s--upload-file\s+)/i.test(cmd)) {
    return "通过 curl 上传文件到网络地址";
  }
  if (/\bwget\b[^\n\r;]*\s--post-file=/i.test(cmd)) return "通过 wget 上传文件到网络地址";
  if (/\bscp\b/i.test(cmd)) return "通过 scp 传输文件到远程主机";
  if (/\brsync\b[^\n\r;]*\b(?:@|:\/\/)/i.test(cmd)) return "通过 rsync 同步文件到远程目标";
  return "执行可能外传数据的网络命令";
}

function buildSensitiveWriteConfirmTextZh(targetPath = "") {
  const target = String(targetPath || "").trim();
  if (!target) return "写入敏感路径";
  const base = path.basename(target);
  if (/^id_rsa|id_ed25519|authorized_keys$/i.test(base)) return "修改 SSH 密钥相关文件";
  if (/^config$/i.test(base) && /\/\.ssh\//i.test(target.replace(/\\/g, "/"))) return "修改 SSH 配置";
  return "写入敏感路径文件";
}

function buildCronMutationConfirmTextZh(action = "") {
  const a = String(action || "").trim().toLowerCase();
  if (/\b(add|create)\b/.test(a)) return "新增定时任务";
  if (/\b(remove|delete)\b/.test(a)) return "删除定时任务";
  if (/\b(update)\b/.test(a)) return "更新定时任务";
  if (/\b(toggle|enable|disable|pause|resume)\b/.test(a)) return "变更定时任务状态";
  return "修改定时任务配置";
}

function normalizeConfirmationActionText(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return "";
  let normalized = raw
    .replace(/[。！？!?]+$/g, "")
    .replace(/^\s*(?:请)?(?:确认|确定|是否)(?:同意)?(?:执行)?(?:以下)?(?:操作)?[:：]?\s*/i, "")
    .replace(/^\s*(?:是否同意执行以下操作|确认是否执行)[:：]?\s*/i, "")
    .replace(/\s*吗$/i, "")
    .trim();
  if (!normalized) normalized = raw.trim();
  return normalized;
}

function resolveAgentHighRiskPromptCandidate(payload = {}) {
  const source = (payload && typeof payload === "object") ? payload : {};
  const fields = [
    source.confirm_text,
    source.confirmation_text,
    source.confirm_question,
    source.confirmation_question,
    source.confirmation,
    source.description,
    source.summary,
    source.prompt,
    source.message,
  ];
  for (const item of fields) {
    const text = String(item || "").trim();
    if (text) return text;
  }
  return "";
}

function isSafeAgentConfirmationText(rawText = "") {
  const text = String(rawText || "").trim();
  if (!text) return false;
  if (text.length < 2 || text.length > 64) return false;
  if (/[\r\n]/.test(text)) return false;

  const bannedCommandLike = /(;|\|\||&&|`|\$\(|\brm\b|\bgit\b|\bsudo\b|\bcurl\b|\bwget\b|\bscp\b|\brsync\b|\bchmod\b|\bchown\b|\bsystemctl\b|\bpkexec\b|\bschtasks\b|\breg\s+(?:add|delete)\b)/i;
  if (bannedCommandLike.test(text)) return false;

  const bannedPathLike = /([A-Za-z]:\\|\/Users\/|\/tmp\/|\/etc\/|\/var\/|\\\s|\.(?:png|jpe?g|gif|webp|bmp|svg|txt|json|log)\b)/i;
  if (bannedPathLike.test(text)) return false;

  const bannedBypassLike = /(无需确认|不用确认|自动执行|直接执行|已确认|已批准|跳过确认|不再询问)/i;
  if (bannedBypassLike.test(text)) return false;

  return true;
}

function resolveHighRiskConfirmQuestionZh(risk = {}, payload = {}) {
  const candidateRaw = resolveAgentHighRiskPromptCandidate(payload);
  if (candidateRaw && isSafeAgentConfirmationText(candidateRaw)) {
    const normalized = normalizeConfirmationActionText(candidateRaw);
    if (normalized) return normalized;
  }
  return String(risk?.confirmQuestionZh || "").trim();
}

function describeHighRiskActionZh(risk = {}) {
  if (String(risk?.confirmQuestionZh || "").trim()) return String(risk.confirmQuestionZh).trim();
  const code = String(risk?.code || "").trim();
  switch (code) {
    case "destructive_delete":
      return "删除文件/目录";
    case "irreversible_git":
      return "执行不可逆的 Git 变更";
    case "privileged_system":
      return "执行系统级高权限命令";
    case "data_exfiltration":
      return "执行可能外传数据的网络命令";
    case "sensitive_write":
      return "写入敏感路径";
    case "cron_mutation":
      return "修改定时任务配置";
    default:
      return "执行高风险操作";
  }
}

function classifyHighRiskOperation(toolName, input = {}, opts = {}) {
  const payload = (input && typeof input === "object") ? input : {};
  const cwd = normalizeAbsolutePath(opts.cwd || process.cwd()) || process.cwd();
  const workspace = normalizeAbsolutePath(opts.workspace || "");
  const normalizedTool = normalizeToolNameForPolicy(toolName);

  if (normalizedTool === "Bash") {
    const command = String(payload.command || "").trim();
    if (!command) return { highRisk: false };

    const deleteTargets = extractDeleteTargets(command, cwd);
    if (deleteTargets.length > 0 || /\brm\s+-[^\n\r;]*\b(?:r|R)[^\n\r;]*\b(?:f|F)\b/i.test(command)) {
      const decision = makeHighRiskDecision(
        "destructive_delete",
        `Bash delete command: ${truncateText(command)}`,
        `bash:delete:${command}`,
      );
      decision.confirmQuestionZh = resolveHighRiskConfirmQuestionZh({
        ...decision,
        confirmQuestionZh: buildDestructiveDeleteConfirmTextZh(deleteTargets),
      }, payload);
      return decision;
    }

    if (
      /\bgit\s+reset\s+--hard\b/i.test(command)
      || /\bgit\s+checkout\s+--\s+/i.test(command)
      || /\bgit\s+restore\b[^\n\r;]*\s--source\b/i.test(command)
      || /\bgit\s+clean\b[^\n\r;]*\b-f\b/i.test(command)
    ) {
      const decision = makeHighRiskDecision(
        "irreversible_git",
        `Bash git operation: ${truncateText(command)}`,
        `bash:git:${command}`,
      );
      decision.confirmQuestionZh = resolveHighRiskConfirmQuestionZh({
        ...decision,
        confirmQuestionZh: buildIrreversibleGitConfirmTextZh(command),
      }, payload);
      return decision;
    }

    if (
      /\bsudo\b/i.test(command)
      || /\bsu(?:\s|$)/i.test(command)
      || /\bdoas\b/i.test(command)
      || /\bpkexec\b/i.test(command)
      || /\bchmod\b/i.test(command)
      || /\bchown\b/i.test(command)
      || /\bsystemctl\b/i.test(command)
      || /\bsc\b\s+(?:create|delete|start|stop)\b/i.test(command)
      || /\bschtasks\b/i.test(command)
      || /\breg\b\s+(?:add|delete)\b/i.test(command)
    ) {
      const decision = makeHighRiskDecision(
        "privileged_system",
        `Bash privileged/system command: ${truncateText(command)}`,
        `bash:privileged:${command}`,
      );
      decision.confirmQuestionZh = resolveHighRiskConfirmQuestionZh({
        ...decision,
        confirmQuestionZh: buildPrivilegedSystemConfirmTextZh(command),
      }, payload);
      return decision;
    }

    if (
      /\bscp\b/i.test(command)
      || /\brsync\b[^\n\r;]*\b(?:@|:\/\/)/i.test(command)
      || /\bcurl\b[^\n\r;]*(?:\s-F\s+['"]?@|\s--form\s+['"]?@|\s--data-binary\s+@|\s--upload-file\s+)/i.test(command)
      || /\bwget\b[^\n\r;]*\s--post-file=/i.test(command)
    ) {
      const decision = makeHighRiskDecision(
        "data_exfiltration",
        `Bash network transfer command: ${truncateText(command)}`,
        `bash:exfil:${command}`,
      );
      decision.confirmQuestionZh = resolveHighRiskConfirmQuestionZh({
        ...decision,
        confirmQuestionZh: buildDataExfiltrationConfirmTextZh(command),
      }, payload);
      return decision;
    }
  }

  if (normalizedTool === "Write" || normalizedTool === "Edit") {
    const targetPath = resolveToolTargetPath(normalizedTool, payload, cwd);
    if (targetPath) {
      if ((workspace && !isPathInside(targetPath, workspace)) || isSensitiveWritePath(targetPath)) {
        const decision = makeHighRiskDecision(
          "sensitive_write",
          `${normalizedTool} target path: ${targetPath}`,
          `${normalizedTool.toLowerCase()}:${targetPath}`,
        );
        decision.confirmQuestionZh = resolveHighRiskConfirmQuestionZh({
          ...decision,
          confirmQuestionZh: buildSensitiveWriteConfirmTextZh(targetPath),
        }, payload);
        return decision;
      }
    }
  }

  if (isCronToolName(normalizedTool) && isCronMutationOperation(payload)) {
    const action = String(payload.action || payload.operation || payload.command || "cron mutation").trim();
    const decision = makeHighRiskDecision(
      "cron_mutation",
      `Cron change: ${truncateText(action)}`,
      `cron:${action}`,
    );
    decision.confirmQuestionZh = resolveHighRiskConfirmQuestionZh({
      ...decision,
      confirmQuestionZh: buildCronMutationConfirmTextZh(action),
    }, payload);
    return decision;
  }

  return { highRisk: false };
}

function getPendingTextConfirmation(sessionPath = "") {
  const key = String(sessionPath || "").trim();
  if (!key) return null;
  const pending = HIGH_RISK_PENDING_TEXT_CONFIRM.get(key) || null;
  if (!pending) return null;
  if (pending.expiresAt <= Date.now()) {
    HIGH_RISK_PENDING_TEXT_CONFIRM.delete(key);
    return null;
  }
  return pending;
}

function setPendingTextConfirmation(sessionPath = "", value = null) {
  const key = String(sessionPath || "").trim();
  if (!key) return;
  if (!value) {
    HIGH_RISK_PENDING_TEXT_CONFIRM.delete(key);
    return;
  }
  HIGH_RISK_PENDING_TEXT_CONFIRM.set(key, value);
}

function extractTextFromMessageBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function extractUserTextsFromSessionLog(sessionPath = "") {
  const messages = readSessionMessagesFromLog(sessionPath, { limit: 120 });
  const out = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || String(message.role || "").toLowerCase() !== "user") continue;
    const text = extractTextFromMessageBlocks(message.content);
    if (text) out.push(text);
  }
  return out;
}

function toMillis(rawTs) {
  const ms = Date.parse(String(rawTs || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function extractUserTextEntriesFromSessionLog(sessionPath = "", { afterTs = 0 } = {}) {
  const entries = readSessionMessageEntries(sessionPath, { limit: 240 });
  const out = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const message = entry?.message;
    if (!message || String(message.role || "").toLowerCase() !== "user") continue;
    const ts = toMillis(entry?.timestamp || message?.timestamp);
    if (afterTs > 0 && ts > 0 && ts < afterTs) continue;
    const text = extractTextFromMessageBlocks(message.content);
    if (!text) continue;
    out.push({ text, timestamp: ts });
  }
  return out;
}

function extractUserTextsFromTranscript(sessionPath = "") {
  const fp = String(sessionPath || "").trim();
  if (!fp) return [];
  try {
    const meta = readSessionMetadata(fp);
    const sessionId = String(meta?.sessionId || "").trim();
    const cwd = String(meta?.cwd || "").trim();
    if (!sessionId) return [];
    const messages = buildSessionMessagesFromSession({
      sessionId,
      cwd,
      limit: 120,
    });
    const out = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message || String(message.role || "").toLowerCase() !== "user") continue;
      const text = extractTextFromMessageBlocks(message.content);
      if (text) out.push(text);
    }
    return out;
  } catch {
    return [];
  }
  return [];
}

function extractUserTextEntriesFromTranscript(sessionPath = "", { afterTs = 0 } = {}) {
  const fp = String(sessionPath || "").trim();
  if (!fp) return [];
  try {
    const meta = readSessionMetadata(fp);
    const sessionId = String(meta?.sessionId || "").trim();
    const cwd = String(meta?.cwd || "").trim();
    if (!sessionId) return [];
    const entries = readClaudeTranscriptEntries({
      sessionId,
      cwd,
      limit: 240,
    });
    const out = [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      const message = entry?.message;
      if (!message || String(message.role || "").toLowerCase() !== "user") continue;
      const ts = toMillis(entry?.timestamp || message?.timestamp);
      if (afterTs > 0 && ts > 0 && ts < afterTs) continue;
      const text = extractTextFromMessageBlocks(message.content);
      if (!text) continue;
      // Ignore synthetic/internal SDK control text.
      if (/^\[request interrupted by user(?: for tool use)?\]$/i.test(text.trim())) continue;
      out.push({ text, timestamp: ts });
    }
    return out;
  } catch {
    return [];
  }
}

function resolvePlainTextConfirmationDecision(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (/(不要执行|不执行|不同意|拒绝|取消|停止|算了|cancel|reject|deny|stop|\bno\b)/i.test(raw)) {
    return "reject";
  }
  if (/(确认|同意|继续|可以执行|执行吧|confirm|approve|allow|proceed|\byes\b|\bok\b|\bokay\b)/i.test(raw)) {
    return "approve";
  }
  return null;
}

function resolveSessionPlainTextConfirmationDecision(sessionPath = "", { createdAt = 0 } = {}) {
  const logEntries = extractUserTextEntriesFromSessionLog(sessionPath, { afterTs: createdAt });
  const transcriptEntries = extractUserTextEntriesFromTranscript(sessionPath, { afterTs: createdAt });
  const candidates = [...logEntries, ...transcriptEntries];
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  for (const item of candidates) {
    const decision = resolvePlainTextConfirmationDecision(item.text);
    if (decision) return decision;
  }
  return null;
}

async function waitForHighRiskAskUserConfirmation({
  confirmStore,
  emitToolEvent,
  sessionPath,
  risk,
}) {
  if (!confirmStore || typeof confirmStore.create !== "function") {
    return { action: "rejected" };
  }
  return waitForAskUserConfirmation({
    confirmStore,
    emitToolEvent,
    sessionPath,
    input: {
      questions: [
        {
          id: "high_risk_approval",
          header: "高风险操作确认",
          question: `是否同意执行以下操作：${describeHighRiskActionZh(risk)}？`,
          options: [
            {
              label: "同意执行 (Recommended)",
              description: "允许本次高风险操作继续执行。",
            },
            {
              label: "拒绝执行",
              description: "阻止本次操作。",
            },
          ],
        },
      ],
    },
  });
}

function isRejectLikeText(text = "") {
  const value = String(text || "").trim();
  if (!value) return false;
  return /(拒绝|不执行|不同意|reject|deny|cancel|stop|no)/i.test(value);
}

function isApproveLikeText(text = "") {
  const value = String(text || "").trim();
  if (!value) return false;
  return /(同意|执行|确认|approve|confirm|allow|yes|ok)/i.test(value);
}

function resolveHighRiskAskUserDecision(decision) {
  if (decision?.action !== "confirmed") return "reject";
  const answerRaw = decision?.value?.high_risk_approval;
  const answer = String(answerRaw || "").trim();
  if (!answer) return "approve";
  if (isRejectLikeText(answer)) return "reject";
  if (isApproveLikeText(answer)) return "approve";
  return "approve";
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

function buildToolUseDecisionEvaluator(permissionStrategy, opts = {}) {
  if (permissionStrategy !== "auto_allow") return undefined;
  const strictSandbox = false;
  const allowedRoots = strictSandbox ? resolveAllowedRoots(opts.workspace, opts.pathRules) : [];
  const cwd = opts.cwd;
  const workspace = opts.workspace;
  const agentDir = opts.agentDir;
  const allowedToolMatcher = createAllowedToolMatcher(opts.allowedTools);
  const confirmStore = opts.confirmStore;
  const sessionPath = opts.sessionPath || null;
  const executionMode = normalizeExecutionMode(opts.executionMode);
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

    const risk = classifyHighRiskOperation(toolName, payload, {
      cwd,
      workspace,
      agentDir,
    });
    if (risk.highRisk) {
      const mode = resolveSessionExecutionMode({
        sessionPath: sessionPath || "",
        executionMode,
      });
      const fingerprint = `${toolName}:${risk.code}:${risk.signature}`;
      if (mode === "chat") {
        const decision = await waitForHighRiskAskUserConfirmation({
          confirmStore,
          emitToolEvent,
          sessionPath,
          risk,
        });
        if (resolveHighRiskAskUserDecision(decision) === "approve") {
          return {
            behavior: "allow",
            updatedInput: payload,
          };
        }
        return {
          behavior: "deny",
          message: `用户拒绝了高风险操作（${risk.label}）。`,
        };
      }

      const existing = getPendingTextConfirmation(sessionPath || "");
      if (existing && existing.fingerprint === fingerprint) {
        const decision = resolveSessionPlainTextConfirmationDecision(sessionPath || "", {
          createdAt: Number(existing.createdAt || 0),
        });
        if (decision === "approve") {
          setPendingTextConfirmation(sessionPath || "", null);
          return {
            behavior: "allow",
            updatedInput: payload,
          };
        }
        if (decision === "reject") {
          setPendingTextConfirmation(sessionPath || "", null);
          return {
            behavior: "deny",
            message: `用户已取消高风险操作（${risk.label}）。`,
          };
        }
        return {
          behavior: "deny",
          message: [
            `高风险操作正在等待用户的明确文本确认（${risk.label}）。`,
            `请用户回复：“确认”或“取消”。`,
            `待确认事项：${describeHighRiskActionZh(risk)}`,
          ].join("\n"),
        };
      }

      setPendingTextConfirmation(sessionPath || "", {
        fingerprint,
        createdAt: Date.now(),
        expiresAt: Date.now() + HIGH_RISK_TEXT_CONFIRM_TTL_MS,
      });
      return {
        behavior: "deny",
        message: [
          `执行该高风险操作前需要用户明确文本确认（${risk.label}）。`,
          `请先让用户回复：“确认”或“取消”，再重试同一操作。`,
          `待确认事项：${describeHighRiskActionZh(risk)}`,
        ].join("\n"),
      };
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

function buildCanUseToolHandler(toolUseDecisionEvaluator) {
  if (typeof toolUseDecisionEvaluator !== "function") return undefined;
  return async (toolName, input = {}) => toolUseDecisionEvaluator(toolName, input);
}

function buildPreToolUseHooks(toolUseDecisionEvaluator) {
  if (typeof toolUseDecisionEvaluator !== "function") return undefined;
  return {
    PreToolUse: [
      {
        hooks: [
          async (hookInput = {}) => {
            const toolName = String(hookInput?.tool_name || "").trim();
            const rawInput = hookInput?.tool_input;
            const payload = (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput))
              ? rawInput
              : {};
            const decision = await toolUseDecisionEvaluator(toolName, payload);
            if (decision?.behavior === "allow") {
              return {
                continue: true,
                decision: "approve",
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "allow",
                  ...(decision.updatedInput && typeof decision.updatedInput === "object"
                    ? { updatedInput: decision.updatedInput }
                    : {}),
                },
              };
            }
            return {
              continue: true,
              decision: "block",
              reason: String(
                decision?.message || "Tool call denied by session policy.",
              ),
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: String(
                  decision?.message || "Tool call denied by session policy.",
                ),
              },
            };
          },
        ],
      },
    ],
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
  executionMode = "",
  includePartialMessages = false,
} = {}) {
  const explicitClaudeConfigDir = String(env?.CLAUDE_CONFIG_DIR || "").trim();
  let runtimeEnv = {
    ...process.env,
    ...(env || {}),
  };
  ensureWindowsGitBashEnv(runtimeEnv);
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
      MINIMAX_MCP_WEB_SEARCH_SWITCH,
      MINIMAX_MCP_UNDERSTAND_IMAGE_SWITCH,
    ].includes(String(toolDef?.name || "")));
  const mcpServerKey = "hanako";
  const mcpServerName = "hanako";
  // Claude Agent SDK MCP docs recommend allowing MCP tools via server-level
  // wildcard (mcp__<server>__*). Keep both key/name prefixes for compatibility
  // across SDK variants that may resolve server names differently.
  const customAllowedTools = filteredCustomTools.length > 0
    ? uniq([
      toMcpAllowedPrefix(mcpServerKey),
      toMcpAllowedPrefix(mcpServerName),
    ].filter(Boolean))
    : [];
  const minimaxMcpAllowedTools = useMiniMaxMcp
    ? buildMcpExactAllowedTools(MINIMAX_MCP_SERVER_KEY, enabledMiniMaxMcpTools)
    : [];
  const configuredExternalServers = agent?._engine?.getExternalMcpServers?.() || {};
  const builtinExternalServers = getBuiltinExternalMcpServers(runtimeEnv);
  const mergedExternalServers = {
    ...(configuredExternalServers && typeof configuredExternalServers === "object" ? configuredExternalServers : {}),
    ...(builtinExternalServers && typeof builtinExternalServers === "object" ? builtinExternalServers : {}),
  };
  const externalMcp = noTools
    ? { servers: {}, allowedTools: [] }
    : resolveExternalMcpServers(agent?.config || {}, {
      externalServers: mergedExternalServers,
    });
  const allowedTools = uniq([
    ...builtinEnabled,
    ...customAllowedTools,
    ...minimaxMcpAllowedTools,
    ...externalMcp.allowedTools,
  ]);
  const toolUseDecisionEvaluator = buildToolUseDecisionEvaluator(permissionStrategy, {
    sandboxMode,
    workspace,
    pathRules,
    cwd,
    agentDir: agent?.agentDir,
    confirmStore,
    sessionPath,
    executionMode,
    emitToolEvent,
    allowedTools,
  });
  const canUseTool = buildCanUseToolHandler(toolUseDecisionEvaluator);
  const hooks = buildPreToolUseHooks(toolUseDecisionEvaluator);
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
    ...(hooks ? { hooks } : {}),
    settingSources,
    includePartialMessages: includePartialMessages === true,
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
      hasPreToolUseHooks: !!hooks?.PreToolUse?.length,
      customToolsLoaded: filteredCustomTools.map((toolDef) => toolDef?.name).filter(Boolean),
      mcpServerKey,
      mcpServerName,
      customAllowedTools,
      minimaxMcpAllowedTools,
      externalMcpAllowedTools: externalMcp.allowedTools,
      externalMcpServers: Object.keys(externalMcp.servers),
      useMiniMaxMcp,
      enabledMiniMaxMcpTools,
      claudeCodeExecutable: claudeSdkProcessConfig.executable,
      claudeCodeExecutableArgs: claudeSdkProcessConfig.executableArgs,
      claudeCodeCliPath: claudeSdkProcessConfig.pathToClaudeCodeExecutable,
    },
  };
}
