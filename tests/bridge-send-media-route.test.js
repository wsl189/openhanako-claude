import fs from "fs";
import os from "os";
import path from "path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import bridgeRoute from "../server/routes/bridge.js";

describe("bridge send-media route", () => {
  it("sends allowed file via bridge manager", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hana-send-media-"));
    const deskHome = path.join(tmp, "desk");
    fs.mkdirSync(deskHome, { recursive: true });
    const media = path.join(deskHome, "hello.txt");
    fs.writeFileSync(media, "hello", "utf-8");

    const app = Fastify();
    const sendMediaFile = vi.fn().mockResolvedValue(undefined);
    const engine = {
      hanakoHome: tmp,
      agent: { deskManager: { homePath: deskHome }, sessionDir: tmp },
      getPreferences: () => ({}),
      savePreferences: () => {},
      getBridgeIndex: () => ({}),
      saveBridgeIndex: () => {},
    };
    const bridgeManager = {
      sendMediaFile,
      getStatus: () => ({}),
      getMessages: () => [],
      startPlatformFromConfig: () => {},
      stopPlatform: () => {},
    };
    await bridgeRoute(app, { engine, bridgeManager });

    const res = await app.inject({
      method: "POST",
      url: "/api/bridge/send-media",
      payload: { platform: "telegram", chatId: "123", filePath: media },
    });
    expect(res.statusCode).toBe(200);
    expect(sendMediaFile).toHaveBeenCalledWith("telegram", "123", fs.realpathSync(media));

    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects file outside allowed roots", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hana-send-media-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-send-media-outside-"));
    const outside = path.join(outsideRoot, "outside.txt");
    fs.writeFileSync(outside, "oops", "utf-8");

    const app = Fastify();
    const engine = {
      hanakoHome: tmp,
      agent: { deskManager: { homePath: path.join(tmp, "desk") }, sessionDir: tmp },
      getPreferences: () => ({}),
      savePreferences: () => {},
      getBridgeIndex: () => ({}),
      saveBridgeIndex: () => {},
    };
    const bridgeManager = {
      sendMediaFile: vi.fn(),
      getStatus: () => ({}),
      getMessages: () => [],
      startPlatformFromConfig: () => {},
      stopPlatform: () => {},
    };
    await bridgeRoute(app, { engine, bridgeManager });

    const res = await app.inject({
      method: "POST",
      url: "/api/bridge/send-media",
      payload: { platform: "telegram", chatId: "123", filePath: outside },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("outside allowed roots");

    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });
});
