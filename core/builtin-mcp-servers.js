import { resolveOpenComputerUseExternalServer } from "./open-computer-use-provider.js";

export function getBuiltinExternalMcpServers(env = process.env, runtime = process) {
  const out = {};
  const isWindowsRuntime = String(runtime?.platform || "").trim() === "win32";
  if (isWindowsRuntime) return out;
  const openComputerUse = resolveOpenComputerUseExternalServer(env);
  if (openComputerUse?.name && openComputerUse?.server) {
    out[openComputerUse.name] = openComputerUse.server;
  }
  return out;
}

export function getBuiltinExternalMcpServerNames(env = process.env, runtime = process) {
  return Object.keys(getBuiltinExternalMcpServers(env, runtime));
}
