import { beforeEach, describe, expect, it, vi } from "vitest";

import { BridgeManager } from "./bridge-manager.js";

function createManager() {
  const root = process.cwd();
  const engine = {
    hanakoHome: root,
    getHomeFolder: () => root,
    homeCwd: root,
    cwd: root,
    deskCwd: root,
    agent: { deskManager: { homePath: root }, sessionDir: root },
  };
  const hub = { eventBus: { emit: vi.fn() } };
  return new BridgeManager({ engine, hub });
}

describe("BridgeManager media dispatch guard", () => {
  /** @type {BridgeManager} */
  let manager;

  beforeEach(() => {
    manager = createManager();
  });

  it("dispatches media for normal media requests without strict explicit-send wording", () => {
    expect(manager._hasExplicitMediaSendIntent("生成一张图给我看")).toBe(true);
    expect(manager._shouldDispatchMedia("生成一张图给我看", "图片已准备好")).toBe(true);
    expect(manager._shouldDispatchMedia("把报告导出成pdf", "已生成报告")).toBe(true);
  });

  it("suppresses media only when user explicitly asks not to send", () => {
    expect(manager._hasExplicitMediaSuppressIntent("先别发送图片，告诉我路径就行")).toBe(true);
    expect(manager._hasExplicitMediaSuppressIntent("don't send the file yet")).toBe(true);
    expect(manager._shouldDispatchMedia("先别发送图片，告诉我路径就行", "")).toBe(false);
    expect(manager._shouldDispatchMedia("don't send the file yet", "")).toBe(false);
  });

  it("removes mouth/meta tags from platform reply text", () => {
    const raw = "<mouth>internal</mouth>\n外部可见正文";
    expect(manager._cleanReplyForPlatform(raw)).toBe("外部可见正文");
  });
});
