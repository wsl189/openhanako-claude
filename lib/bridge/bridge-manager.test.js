import { beforeEach, describe, expect, it, vi } from "vitest";

import { BridgeManager } from "./bridge-manager.js";
import { normalizeQQAttachments } from "./qq-adapter.js";

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

describe("QQ voice attachments", () => {
  /** @type {BridgeManager} */
  let manager;

  beforeEach(() => {
    manager = createManager();
  });

  it("preserves QQ built-in ASR text and wav download URL", () => {
    const attachments = normalizeQQAttachments({
      attachments: [{
        content_type: "voice",
        filename: "voice.silk",
        voice_wav_url: "https://qq.example/voice.wav",
        asr_refer_text: "明天深圳天气怎么样",
        duration: 4,
      }],
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      type: "audio",
      url: "https://qq.example/voice.wav",
      voiceWavUrl: "https://qq.example/voice.wav",
      asrReferText: "明天深圳天气怎么样",
      mimeType: "audio/wav",
    });
  });

  it("recognizes voice metadata from QQ media payloads", () => {
    const attachments = normalizeQQAttachments({
      media: {
        content_type: "voice",
        voice_wav_url: "https://qq.example/media.wav",
        asr_refer_text: "把这个想法写到待办里",
      },
    });

    expect(attachments[0]).toMatchObject({
      type: "audio",
      url: "https://qq.example/media.wav",
      voiceWavUrl: "https://qq.example/media.wav",
      asrReferText: "把这个想法写到待办里",
      mimeType: "audio/wav",
    });
  });

  it("injects QQ ASR text without requiring an audio download", async () => {
    const downloadAttachment = vi.fn();
    manager._platforms.set("qq", {
      adapter: { downloadAttachment },
      platform: "qq",
      platformKey: "qq",
    });

    const resolved = await manager._resolveAttachments("qq", [{
      type: "audio",
      voiceWavUrl: "https://qq.example/voice.wav",
      asrReferText: "帮我记录一下今天的想法",
      duration: 3,
    }]);

    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(resolved.images).toEqual([]);
    expect(resolved.textNotes).toContain("[收到语音 3秒]");
    expect(resolved.textNotes).toContain("[语音转写] 帮我记录一下今天的想法");
  });
});
