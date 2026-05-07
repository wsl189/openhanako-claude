import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addBookmarkEntry, appendMessage, createChannel, getRecentMessages } from "../channels/channel-store.js";
import { createChannelTool } from "./channel-tool.js";

describe("channel tool readability and name resolution", () => {
  let tempRoot = "";

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "channel-tool-test-"));
  });

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function setup() {
    const channelsDir = path.join(tempRoot, "channels");
    const agentsDir = path.join(tempRoot, "agents");
    const chiefId = "chief_analyst";
    const helperId = "assistant";
    fs.mkdirSync(path.join(agentsDir, chiefId), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, helperId), { recursive: true });

    const { filePath, id } = createChannel(channelsDir, {
      id: "ch_92f76e",
      name: "A股大盘分析",
      members: [chiefId, helperId],
      leaders: [chiefId],
      mode: "command",
    });

    const channelsMdPath = path.join(agentsDir, chiefId, "channels.md");
    addBookmarkEntry(channelsMdPath, id);
    return { channelsDir, agentsDir, chiefId, helperId, channelId: id, channelFile: filePath };
  }

  it("lists joined channels with readable name and id", async () => {
    const fx = setup();
    const tool = createChannelTool({
      channelsDir: fx.channelsDir,
      agentsDir: fx.agentsDir,
      agentId: fx.chiefId,
      listAgents: () => [
        { id: fx.chiefId, name: "首席分析师" },
        { id: fx.helperId, name: "助手" },
      ],
    });

    const result = await tool.execute("tc-list", { action: "list" });
    const text = String(result?.content?.[0]?.text || "");

    expect(text).toContain("A股大盘分析");
    expect(text).toContain(`[${fx.channelId}]`);
    expect(text).toContain("last: never");
    expect(result?.details?.channels?.[0]?.id).toBe(fx.channelId);
    expect(result?.details?.channels?.[0]?.isLeader).toBe(true);
    expect(result?.details?.channels?.[0]?.isMember).toBe(true);
  });

  it("resolves channel by display name for read and post", async () => {
    const fx = setup();
    appendMessage(fx.channelFile, "user", "今天A股怎么看？");
    const onPost = vi.fn();
    const tool = createChannelTool({
      channelsDir: fx.channelsDir,
      agentsDir: fx.agentsDir,
      agentId: fx.chiefId,
      listAgents: () => [
        { id: fx.chiefId, name: "首席分析师" },
        { id: fx.helperId, name: "助手" },
      ],
      onPost,
    });

    const readResult = await tool.execute("tc-read", {
      action: "read",
      channel: "A股大盘分析",
      count: 10,
    });
    expect(readResult?.details?.channel).toBe(fx.channelId);
    expect(readResult?.details?.channelName).toBe("A股大盘分析");
    expect(String(readResult?.content?.[0]?.text || "")).toContain("今天A股怎么看");

    await tool.execute("tc-post", {
      action: "post",
      channel: "A股大盘分析",
      content: "先看量能和权重板块的联动。",
    });
    expect(onPost).toHaveBeenCalledWith(fx.channelId, fx.chiefId, "先看量能和权重板块的联动。");

    const messages = getRecentMessages(fx.channelFile, 10);
    const last = messages[messages.length - 1];
    expect(last?.sender).toBe(fx.chiefId);
    expect(last?.body).toContain("先看量能和权重板块的联动。");
  });
});
