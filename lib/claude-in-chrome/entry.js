#!/usr/bin/env node
import { runChromeNativeHost } from "./chrome-native-host.js";
import { runClaudeInChromeMcpServer } from "./mcp-server.js";
import { ensureNativeHostInstalled } from "./setup.js";

async function main() {
  const mode = process.argv[2] || "";

  if (mode === "--claude-in-chrome-mcp") {
    await runClaudeInChromeMcpServer();
    return;
  }

  if (mode === "--chrome-native-host") {
    await runChromeNativeHost();
    return;
  }

  if (mode === "--install-chrome-native-host") {
    const result = await ensureNativeHostInstalled();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // eslint-disable-next-line no-console
  console.error("Usage: node entry.js [--claude-in-chrome-mcp|--chrome-native-host|--install-chrome-native-host]");
  process.exitCode = 1;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
