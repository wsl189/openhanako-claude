import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isChromeExtensionInstalled } from "../lib/claude-in-chrome/common.js";
import { ensureNativeHostInstalled } from "../lib/claude-in-chrome/setup.js";

const PROVIDER_ALIAS = {
  "": "auto",
  auto: "auto",
  embedded: "embedded",
  builtin: "embedded",
  browser: "embedded",
  "claude-in-chrome": "claude-in-chrome",
  claude_in_chrome: "claude-in-chrome",
  claudeinchrome: "claude-in-chrome",
  chrome_plugin: "claude-in-chrome",
  "chrome-plugin": "claude-in-chrome",
};

const DEFAULT_CIC_ENTRY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "lib",
  "claude-in-chrome",
  "entry.js",
);

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

function resolveClaudeInChromeEntryPath(env = {}) {
  const explicitEntry = String(
    env?.HANAKO_CLAUDE_IN_CHROME_ENTRY
      || env?.HANA_CLAUDE_IN_CHROME_ENTRY
      || "",
  ).trim();
  if (explicitEntry) {
    return path.resolve(explicitEntry);
  }
  return DEFAULT_CIC_ENTRY_PATH;
}

function resolveClaudeInChromeServer(env = {}) {
  const entryPath = resolveClaudeInChromeEntryPath(env);

  const explicitCommand = String(
    env?.HANAKO_CLAUDE_IN_CHROME_COMMAND
      || env?.HANA_CLAUDE_IN_CHROME_COMMAND
      || "",
  ).trim();
  const command = explicitCommand || process.execPath;
  const commandBase = path.basename(String(command || "")).toLowerCase();
  const looksLikeNodeBinary = commandBase === "node"
    || commandBase === "node.exe"
    || commandBase.startsWith("node-v");
  const shouldRunAsNode = /^(1|true|yes|on)$/i.test(
    String(env?.HANAKO_CLAUDE_IN_CHROME_FORCE_RUN_AS_NODE || "").trim(),
  )
    || (!explicitCommand && (
      String(process?.versions?.electron || "").trim().length > 0
      || /electron/i.test(commandBase)
      || !looksLikeNodeBinary
    ));

  const argsRaw = String(env?.HANAKO_CLAUDE_IN_CHROME_ARGS || "").trim();
  const args = parseCommandArgs(argsRaw);
  const commandEnv = shouldRunAsNode
    ? { ELECTRON_RUN_AS_NODE: "1" }
    : null;

  const config = {
    type: "stdio",
    command,
    args: args.length > 0 ? args : [entryPath, "--claude-in-chrome-mcp"],
    ...(commandEnv ? { env: commandEnv } : {}),
  };

  return {
    available: fs.existsSync(entryPath),
    source: args.length > 0 ? "env-explicit" : "hanako-builtin",
    entryPath,
    commandEnv,
    config,
  };
}

function shouldUseClaudeInChromeInAutoMode(claudeInChrome, extensionInstalled, env = {}) {
  const requireInstalled = /^(1|true|yes|on)$/i.test(
    String(env?.HANAKO_CLAUDE_IN_CHROME_REQUIRE_EXTENSION || "").trim(),
  );
  if (requireInstalled) return claudeInChrome.available && extensionInstalled;
  return claudeInChrome.available;
}

export function normalizeBrowserProvider(raw) {
  const normalized = String(raw || "").trim().toLowerCase();
  return PROVIDER_ALIAS[normalized] || "auto";
}

export function resolveBrowserProvider(env = process.env, opts = {}) {
  const requestedProvider = normalizeBrowserProvider(
    env?.HANAKO_BROWSER_PROVIDER || env?.HANA_BROWSER_PROVIDER,
  );

  const claudeInChrome = resolveClaudeInChromeServer(env);
  const extensionInstalled = isChromeExtensionInstalled(env);

  const useClaudeInChrome = requestedProvider === "claude-in-chrome"
    ? claudeInChrome.available
    : requestedProvider === "auto"
      ? shouldUseClaudeInChromeInAutoMode(claudeInChrome, extensionInstalled, env)
      : false;

  if (useClaudeInChrome && claudeInChrome.available) {
    void ensureNativeHostInstalled({
      entryPath: claudeInChrome.entryPath,
      env,
      cwd: opts?.cwd,
      workspace: opts?.workspace,
    }).catch(() => {
      // Install is best-effort; tool call path will still surface clear errors.
    });
  }

  return {
    requestedProvider,
    activeProvider: useClaudeInChrome ? "claude-in-chrome" : "embedded",
    useClaudeInChrome,
    useEmbeddedBrowser: !useClaudeInChrome,
    claudeInChromeDetected: claudeInChrome.available,
    claudeInChromeSource: claudeInChrome.source,
    claudeInChromeEntryPath: claudeInChrome.entryPath,
    claudeInChromeCommandEnv: claudeInChrome.commandEnv,
    claudeInChromeServer: useClaudeInChrome ? claudeInChrome.config : null,
    fallbackClaudeInChromeServer: claudeInChrome.config,
    chromeExtensionInstalled: extensionInstalled,
  };
}

export function resolveClaudeInChromeExternalServer(env = process.env) {
  const resolved = resolveClaudeInChromeServer(env);
  if (!resolved?.available || !resolved?.config) return null;
  return {
    name: "claude_in_chrome",
    server: { ...resolved.config },
  };
}
