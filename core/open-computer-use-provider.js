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

export function resolveOpenComputerUseExternalServer(env = process.env) {
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
  const command = explicitCommand || process.execPath;

  const argsRaw = String(
    env?.HANAKO_OPEN_COMPUTER_USE_ARGS
      || env?.HANA_OPEN_COMPUTER_USE_ARGS
      || "",
  ).trim();
  const args = argsRaw
    ? parseCommandArgs(argsRaw)
    : (explicitCommand ? ["mcp"] : [entryPath, "mcp"]);

  const commandBase = path.basename(command).toLowerCase();
  const looksLikeNodeBinary = commandBase === "node"
    || commandBase === "node.exe"
    || commandBase.startsWith("node-v");
  const shouldRunAsNode = isTruthy(env?.HANAKO_OPEN_COMPUTER_USE_FORCE_RUN_AS_NODE)
    || (!explicitCommand && (
      String(process?.versions?.electron || "").trim().length > 0
      || /electron/i.test(commandBase)
      || !looksLikeNodeBinary
    ));

  const serverEnv = shouldRunAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : undefined;

  return {
    name: "open_computer_use",
    server: {
      type: "stdio",
      command,
      args,
      ...(serverEnv ? { env: serverEnv } : {}),
    },
  };
}
