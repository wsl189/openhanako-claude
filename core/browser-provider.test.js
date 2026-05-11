import { describe, expect, it } from "vitest";
import { resolveBrowserProvider } from "./browser-provider.js";

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

  it("forces embedded mode even when claude-in-chrome is requested", () => {
    const result = resolveBrowserProvider({
      HANAKO_BROWSER_PROVIDER: "claude-in-chrome",
    });

    expect(result.requestedProvider).toBe("embedded");
    expect(result.activeProvider).toBe("embedded");
    expect(result.useClaudeInChrome).toBe(false);
    expect(result.useEmbeddedBrowser).toBe(true);
    expect(result.claudeInChromeServer).toBeNull();
  });

  it("stays embedded in auto mode", () => {
    const result = resolveBrowserProvider({
      HANAKO_BROWSER_PROVIDER: "auto",
    });

    expect(result.activeProvider).toBe("embedded");
    expect(result.useClaudeInChrome).toBe(false);
  });
});
