import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createChannel,
  getChannelMemoryEnabled,
  setChannelMemoryEnabled,
} from "./channel-store.js";

const tempRoots = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("channel memory switch", () => {
  it("persists and parses per-channel memory_enabled frontmatter", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-channel-memory-"));
    tempRoots.push(root);
    const channelsDir = path.join(root, "channels");
    fs.mkdirSync(channelsDir, { recursive: true });

    const { filePath } = createChannel(channelsDir, {
      id: "ch_memory",
      name: "memory",
      members: ["a", "b"],
    });

    expect(getChannelMemoryEnabled(filePath)).toBe(true);

    const disabledChanged = setChannelMemoryEnabled(filePath, false);
    expect(disabledChanged).toBe(true);
    expect(getChannelMemoryEnabled(filePath)).toBe(false);
    const contentAfterDisable = fs.readFileSync(filePath, "utf-8");
    expect(contentAfterDisable).toContain("memory_enabled: false");

    const enabledChanged = setChannelMemoryEnabled(filePath, true);
    expect(enabledChanged).toBe(true);
    expect(getChannelMemoryEnabled(filePath)).toBe(true);
    const contentAfterEnable = fs.readFileSync(filePath, "utf-8");
    expect(contentAfterEnable).not.toContain("memory_enabled:");
  });
});
