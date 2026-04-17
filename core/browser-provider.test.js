import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { resolveBrowserProvider } from "./browser-provider.js";

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("resolveBrowserProvider", () => {
  it("uses embedded mode when explicitly configured", () => {
    const result = resolveBrowserProvider({
      HANAKO_BROWSER_PROVIDER: "embedded",
    });

    expect(result.requestedProvider).toBe("embedded");
    expect(result.activeProvider).toBe("embedded");
    expect(result.useEmbeddedBrowser).toBe(true);
    expect(result.useClaudeInChrome).toBe(false);
    expect(result.claudeInChromeServer).toBeNull();
  });

  it("auto-enables claude-in-chrome by default", () => {
    const result = resolveBrowserProvider({
      HANAKO_CLAUDE_IN_CHROME_INSTALLED: "1",
    });

    expect(result.activeProvider).toBe("claude-in-chrome");
    expect(result.useClaudeInChrome).toBe(true);
    expect(result.claudeInChromeServer?.type).toBe("stdio");
    expect(result.claudeInChromeServer?.command).toBe(process.execPath);
    expect(result.claudeInChromeServer?.args?.[0]).toContain("/lib/claude-in-chrome/entry.js");
    expect(result.claudeInChromeServer?.args?.[1]).toBe("--claude-in-chrome-mcp");
  });

  it("can require extension presence for auto mode", () => {
    const result = resolveBrowserProvider({
      HANAKO_CLAUDE_IN_CHROME_REQUIRE_EXTENSION: "1",
      HANAKO_CLAUDE_IN_CHROME_INSTALLED: "0",
    });

    expect(result.activeProvider).toBe("embedded");
    expect(result.useClaudeInChrome).toBe(false);
  });

  it("honors explicit env command/args for claude-in-chrome", () => {
    const root = mkTempDir("hanako-browser-provider-");
    try {
      const entryPath = path.join(root, "entry.js");
      fs.writeFileSync(entryPath, "console.log('ok')\n", "utf8");

      const result = resolveBrowserProvider({
        HANAKO_BROWSER_PROVIDER: "claude-in-chrome",
        HANAKO_CLAUDE_IN_CHROME_ENTRY: entryPath,
        HANAKO_CLAUDE_IN_CHROME_COMMAND: "bun",
        HANAKO_CLAUDE_IN_CHROME_ARGS: '["/tmp/custom-entry.js","--claude-in-chrome-mcp"]',
      });

      expect(result.activeProvider).toBe("claude-in-chrome");
      expect(result.claudeInChromeServer).toEqual({
        type: "stdio",
        command: "bun",
        args: ["/tmp/custom-entry.js", "--claude-in-chrome-mcp"],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("can force ELECTRON_RUN_AS_NODE for child mcp process", () => {
    const result = resolveBrowserProvider({
      HANAKO_BROWSER_PROVIDER: "claude-in-chrome",
      HANAKO_CLAUDE_IN_CHROME_FORCE_RUN_AS_NODE: "1",
    });

    expect(result.claudeInChromeServer?.env).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
    });
  });
});
