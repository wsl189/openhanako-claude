import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendMessage,
  createChannel,
  getNewMessages,
} from "./channel-store.js";

const tempRoots = [];

afterEach(() => {
  vi.useRealTimers();
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("channel timestamps", () => {
  it("keeps successive messages readable even when they happen in the same millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T10:00:00.000Z"));

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-channel-ts-"));
    tempRoots.push(root);
    const channelsDir = path.join(root, "channels");
    fs.mkdirSync(channelsDir, { recursive: true });

    const { filePath } = createChannel(channelsDir, {
      id: "ch_ts",
      name: "timestamp-test",
      members: ["a", "b"],
    });

    const first = appendMessage(filePath, "a", "first");
    const second = appendMessage(filePath, "user", "second");

    expect(second.timestamp > first.timestamp).toBe(true);

    const unread = getNewMessages(filePath, first.timestamp, "a");
    expect(unread.map((msg) => msg.body)).toEqual(["second"]);
  });
});
