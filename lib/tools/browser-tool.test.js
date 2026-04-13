import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadLocale } from "../../server/i18n.js";

const mockBrowser = {
  isRunning: false,
  currentUrl: null,
  launch: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  navigate: vi.fn(async () => ({ title: "Mock", url: "https://example.com", snapshot: "ok" })),
  snapshot: vi.fn(async () => "snapshot"),
  screenshot: vi.fn(async () => ({ base64: "ZmFrZS1zY3JlZW5zaG90", mimeType: "image/png" })),
  click: vi.fn(async () => "click snapshot"),
  type: vi.fn(async () => "type snapshot"),
  scroll: vi.fn(async () => "scroll snapshot"),
  select: vi.fn(async () => "select snapshot"),
  pressKey: vi.fn(async () => "key snapshot"),
  wait: vi.fn(async () => "wait snapshot"),
  evaluate: vi.fn(async () => "42"),
  show: vi.fn(async () => {}),
  thumbnail: vi.fn(async () => "thumb"),
};

vi.mock("../browser/browser-manager.js", () => ({
  BrowserManager: {
    instance: () => mockBrowser,
  },
}));

import { createBrowserTool } from "./browser-tool.js";

beforeAll(() => {
  loadLocale("en");
});

describe("browser-tool", () => {
  it("returns MCP image block for screenshot action", async () => {
    const tool = createBrowserTool();
    const result = await tool.execute("tc_1", { action: "screenshot" });

    expect(result.content).toEqual([{
      type: "image",
      data: "ZmFrZS1zY3JlZW5zaG90",
      mimeType: "image/png",
    }]);
    expect(result.details?.action).toBe("screenshot");
    expect(result.details?.thumbnail).toBe("ZmFrZS1zY3JlZW5zaG90");
  });
});
