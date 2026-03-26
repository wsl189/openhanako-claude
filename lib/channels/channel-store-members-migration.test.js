import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createChannel,
  getChannelMeta,
  normalizeChannelMembersToAgentIds,
} from "./channel-store.js";

const tempRoots = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("channel members migration", () => {
  it("normalizes display names in members to agent ids", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-channel-migrate-"));
    tempRoots.push(root);
    const channelsDir = path.join(root, "channels");
    fs.mkdirSync(channelsDir, { recursive: true });

    const { filePath } = createChannel(channelsDir, {
      id: "ch_migrate",
      name: "migrate",
      members: ["宏观政策分析师", "TECH", "unknown", "技术结构分析师", "tech"],
    });

    const agents = [
      { id: "macro", name: "宏观政策分析师" },
      { id: "tech", name: "技术结构分析师" },
    ];

    const first = normalizeChannelMembersToAgentIds(filePath, agents);
    expect(first.changed).toBe(true);
    expect(first.members).toEqual(["macro", "tech", "unknown"]);

    const meta = getChannelMeta(filePath);
    expect(meta.members).toEqual(["macro", "tech", "unknown"]);

    const second = normalizeChannelMembersToAgentIds(filePath, agents);
    expect(second.changed).toBe(false);
    expect(second.members).toEqual(["macro", "tech", "unknown"]);
  });
});

