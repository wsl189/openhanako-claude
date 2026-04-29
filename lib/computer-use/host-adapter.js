import { createCliExecutor } from "./executor.js";
import { getChicagoEnabled, getChicagoSubGates } from "./gates.js";
import { normalizeOsPermissions } from "./permissions.js";
import { callPythonHelper } from "./python-bridge.js";

const DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.HANAKO_COMPUTER_USE_DEBUG || "").trim());

class DebugLogger {
  debug(message, ...args) {
    if (DEBUG) console.debug(`[computer-use] ${message}`, ...args);
  }
  silly(message, ...args) {
    if (DEBUG) console.debug(`[computer-use] ${message}`, ...args);
  }
  info(message, ...args) {
    console.info(`[computer-use] ${message}`, ...args);
  }
  warn(message, ...args) {
    console.warn(`[computer-use] ${message}`, ...args);
  }
  error(message, ...args) {
    console.error(`[computer-use] ${message}`, ...args);
  }
}

let cached;

export function getComputerUseHostAdapter() {
  if (cached) return cached;

  cached = {
    serverName: "computer_use",
    logger: new DebugLogger(),
    executor: createCliExecutor(),
    ensureOsPermissions: async () => {
      const rawPerms = await callPythonHelper("check_permissions", {});
      const perms = normalizeOsPermissions(rawPerms || {});
      return perms.granted
        ? { granted: true }
        : {
          granted: false,
          accessibility: perms.accessibility,
          screenRecording: perms.screenRecording,
        };
    },
    isDisabled: () => !getChicagoEnabled(),
    getSubGates: getChicagoSubGates,
    getAutoUnhideEnabled: () => true,
    cropRawPatch: () => null,
  };

  return cached;
}
