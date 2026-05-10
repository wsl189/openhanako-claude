import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

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

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function resolveOpenComputerUseEntryPath(env = {}) {
  const explicitEntry = String(
    env?.HANAKO_OPEN_COMPUTER_USE_ENTRY
      || env?.HANA_OPEN_COMPUTER_USE_ENTRY
      || "",
  ).trim();
  if (explicitEntry) return path.resolve(explicitEntry);

  try {
    return require.resolve("open-computer-use/bin/open-computer-use");
  } catch {
    return "";
  }
}

function resolveOpenComputerUseWindowsExecutable(entryPath, runtime = process) {
  const platform = String(runtime?.platform || "").trim();
  if (platform !== "win32") return "";

  const arch = String(runtime?.arch || "").trim().toLowerCase();
  const archDir = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : "";
  if (!archDir) return "";

  const binDir = path.dirname(entryPath);
  const packageRoot = path.resolve(binDir, "..");
  const executablePath = path.join(packageRoot, "dist", "windows", archDir, "open-computer-use.exe");
  return fs.existsSync(executablePath) ? executablePath : "";
}

export function resolveOpenComputerUseExternalServer(env = process.env, runtime = process) {
  if (isTruthy(env?.HANAKO_OPEN_COMPUTER_USE_DISABLED || env?.HANA_OPEN_COMPUTER_USE_DISABLED)) {
    return null;
  }

  const entryPath = resolveOpenComputerUseEntryPath(env);
  if (!entryPath || !fs.existsSync(entryPath)) return null;

  const explicitCommand = String(
    env?.HANAKO_OPEN_COMPUTER_USE_COMMAND
      || env?.HANA_OPEN_COMPUTER_USE_COMMAND
      || "",
  ).trim();
  const defaultCommand = String(runtime?.execPath || process.execPath);

  const argsRaw = String(
    env?.HANAKO_OPEN_COMPUTER_USE_ARGS
      || env?.HANA_OPEN_COMPUTER_USE_ARGS
      || "",
  ).trim();
  const explicitArgs = argsRaw ? parseCommandArgs(argsRaw) : [];
  const defaultWindowsExecutable = (!explicitCommand && explicitArgs.length === 0)
    ? resolveOpenComputerUseWindowsExecutable(entryPath, runtime)
    : "";
  const command = explicitCommand || defaultWindowsExecutable || defaultCommand;
  const args = explicitArgs.length > 0
    ? explicitArgs
    : (explicitCommand || defaultWindowsExecutable ? ["mcp"] : [entryPath, "mcp"]);

  const commandBase = path.basename(command).toLowerCase();
  const looksLikeNodeBinary = commandBase === "node"
    || commandBase === "node.exe"
    || commandBase.startsWith("node-v");
  const shouldRunAsNode = isTruthy(env?.HANAKO_OPEN_COMPUTER_USE_FORCE_RUN_AS_NODE)
    || (!defaultWindowsExecutable && !explicitCommand && (
      String(runtime?.versions?.electron || "").trim().length > 0
      || /electron/i.test(commandBase)
      || !looksLikeNodeBinary
    ));

  const serverEnv = {};
  if (shouldRunAsNode) serverEnv.ELECTRON_RUN_AS_NODE = "1";
  const normalizedServerEnv = Object.keys(serverEnv).length > 0 ? serverEnv : undefined;

  return {
    name: "open_computer_use",
    server: {
      type: "stdio",
      command,
      args,
      ...(normalizedServerEnv ? { env: normalizedServerEnv } : {}),
    },
  };
}
