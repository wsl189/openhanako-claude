import { resolveOpenComputerUseExternalServer } from "./open-computer-use-provider.js";

export function getBuiltinExternalMcpServers(env = process.env) {
  const out = {};
  const openComputerUse = resolveOpenComputerUseExternalServer(env);
  if (openComputerUse?.name && openComputerUse?.server) {
    out[openComputerUse.name] = openComputerUse.server;
  }
  return out;
}

export function getBuiltinExternalMcpServerNames(env = process.env) {
  return Object.keys(getBuiltinExternalMcpServers(env));
}
