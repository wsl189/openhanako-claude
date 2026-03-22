import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge/telegram-adapter.js", () => ({
  createTelegramAdapter: vi.fn(),
}));
vi.mock("../lib/bridge/feishu-adapter.js", () => ({
  createFeishuAdapter: vi.fn(),
}));
vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
}));
vi.mock("../lib/bridge/media-utils.js", () => ({
  downloadMedia: vi.fn().mockResolvedValue(Buffer.from([0x89, 0x50, 0x4E, 0x47])),
  bufferToBase64: vi.fn(() => "iVBORw0K"),
  detectMime: vi.fn(() => "image/png"),
  splitMediaFromOutput: vi.fn((text) => ({ text, mediaUrls: [] })),
  formatSize: vi.fn(() => "1.0KB"),
  setMediaLocalRoots: vi.fn(),
}));

import { BridgeManager } from "../lib/bridge/bridge-manager.js";

describe("bridge media flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards extracted image attachments to hub.send as images", async () => {
    const adapter = {
      sendReply: vi.fn().mockResolvedValue(undefined),
      sendBlockReply: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    };
    const engine = {
      hanakoHome: "/tmp",
      getPreferences: vi.fn().mockReturnValue({ bridge: { owner: { telegram: "owner123" } } }),
      isBridgeSessionStreaming: vi.fn().mockReturnValue(false),
      abortBridgeSession: vi.fn().mockResolvedValue(false),
      steerBridgeSession: vi.fn().mockReturnValue(false),
      agentName: "TestAgent",
      currentAgentId: "hanako",
    };
    const hub = {
      send: vi.fn().mockResolvedValue("ok"),
      eventBus: { emit: vi.fn() },
    };
    const bm = new BridgeManager({ engine, hub });
    bm.blockStreaming = false;
    bm._platforms.set("telegram", { adapter, status: "connected" });

    bm._handleMessage("telegram", {
      sessionKey: "tg_dm_stranger",
      text: "hi",
      userId: "stranger",
      senderName: "Stranger",
      isGroup: false,
      chatId: "stranger",
      attachments: [{ type: "image", url: "https://example.com/a.png", mimeType: "image/png" }],
    });

    await vi.advanceTimersByTimeAsync(2100);
    expect(hub.send).toHaveBeenCalledOnce();
    expect(hub.send.mock.calls[0][1]).toEqual(expect.objectContaining({
      images: [{ type: "image", data: "iVBORw0K", mimeType: "image/png" }],
    }));
  });
});
