import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendMessage,
  createChannel,
  getRecentMessages,
} from "./channel-store.js";

const tempRoots = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("getRecentMessages self message retention", () => {
  it("keeps only the latest N self messages when configured", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-channel-recent-self-"));
    tempRoots.push(root);
    const channelsDir = path.join(root, "channels");
    fs.mkdirSync(channelsDir, { recursive: true });

    const { filePath } = createChannel(channelsDir, {
      id: "ch_recent",
      name: "recent",
      members: ["a", "b"],
    });

    appendMessage(filePath, "user", "u1");
    appendMessage(filePath, "a", "a1");
    appendMessage(filePath, "b", "b1");
    appendMessage(filePath, "a", "a2");
    appendMessage(filePath, "a", "a3");
    appendMessage(filePath, "b", "b2");
    appendMessage(filePath, "a", "a4");

    const noSelf = getRecentMessages(filePath, 20, "a");
    expect(noSelf.map((m) => m.body)).toEqual(["u1", "b1", "b2"]);

    const keepLastTwoSelf = getRecentMessages(filePath, 20, "a", { keepSelfRecentCount: 2 });
    expect(keepLastTwoSelf.map((m) => m.body)).toEqual(["u1", "b1", "a3", "b2", "a4"]);

    const tail3 = getRecentMessages(filePath, 3, "a", { keepSelfRecentCount: 2 });
    expect(tail3.map((m) => m.body)).toEqual(["a3", "b2", "a4"]);
  });
});

