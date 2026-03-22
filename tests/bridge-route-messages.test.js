import fs from "fs";
import os from "os";
import path from "path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

describe("bridge session message route", () => {
  it("keeps image-only messages with a placeholder text", async () => {
    const { default: bridgeRoute } = await import("../server/routes/bridge.js");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-route-"));
    const sessionDir = path.join(tmpRoot, "sessions");
    const bridgeDir = path.join(sessionDir, "bridge");
    fs.mkdirSync(bridgeDir, { recursive: true });

    const fileName = "demo.jsonl";
    const filePath = path.join(bridgeDir, fileName);
    const lines = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "image", source: { data: "abc", media_type: "image/png" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "收到图片" }],
        },
      },
    ];
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");

    const app = Fastify();
    const engine = {
      agent: { sessionDir },
      getBridgeIndex: () => ({ demo: fileName }),
      getPreferences: () => ({}),
      saveBridgeIndex: () => {},
      savePreferences: () => {},
    };
    const bridgeManager = {
      getStatus: () => ({}),
      getMessages: () => [],
      stopPlatform: () => {},
      startPlatformFromConfig: () => {},
    };

    await bridgeRoute(app, { engine, bridgeManager });

    const res = await app.inject({
      method: "GET",
      url: "/api/bridge/sessions/demo/messages",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      messages: [
        { role: "user", content: "[图片 x1]" },
        { role: "assistant", content: "收到图片" },
      ],
    });

    await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});
