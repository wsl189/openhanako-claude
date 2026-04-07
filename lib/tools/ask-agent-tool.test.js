import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannel, getRecentMessages, setChannelAnnouncement } from "../channels/channel-store.js";

const { runAgentSessionMock } = vi.hoisted(() => ({
  runAgentSessionMock: vi.fn(),
}));

vi.mock("../../hub/agent-executor.js", () => ({
  runAgentSession: runAgentSessionMock,
}));

import { createAskAgentTool } from "./ask-agent-tool.js";

describe("ask_agent tool channel posting", () => {
  let tempRoot = "";

  beforeEach(() => {
    vi.clearAllMocks();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ask-agent-tool-test-"));
  });

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("posts reply as target agent when channel is provided", async () => {
    const channelsDir = path.join(tempRoot, "channels");
    createChannel(channelsDir, { id: "ch_team", name: "team", members: ["alpha", "beta"] });
    runAgentSessionMock.mockResolvedValue("beta ready");

    const emit = vi.fn();
    const engine = { channelsDir, _hub: { eventBus: { emit } } };
    const tool = createAskAgentTool({
      agentId: "alpha",
      listAgents: () => [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ],
      engine,
    });

    const result = await tool.execute("tc-1", {
      agent: "beta",
      task: "请直接给出结论",
      channel: "ch_team",
    });

    expect(result?.details?.postedToChannel).toBe(true);
    expect(result?.details?.channel).toBe("ch_team");
    expect(emit).toHaveBeenCalledWith(
      { type: "channel_new_message", channelName: "ch_team", sender: "beta" },
      null,
    );

    const msgs = getRecentMessages(path.join(channelsDir, "ch_team.md"), 20);
    const last = msgs[msgs.length - 1];
    expect(last?.sender).toBe("beta");
    expect(last?.body).toContain("@Alpha");
    expect(last?.body).toContain("beta ready");
  });

  it("does not post when target agent is not a channel member", async () => {
    const channelsDir = path.join(tempRoot, "channels");
    createChannel(channelsDir, { id: "ch_team", name: "team", members: ["alpha"] });
    runAgentSessionMock.mockResolvedValue("should not be posted");

    const emit = vi.fn();
    const engine = { channelsDir, _hub: { eventBus: { emit } } };
    const tool = createAskAgentTool({
      agentId: "alpha",
      listAgents: () => [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ],
      engine,
    });

    const result = await tool.execute("tc-2", {
      agent: "beta",
      task: "请回复",
      channel: "ch_team",
    });

    expect(result?.details).toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
    const msgs = getRecentMessages(path.join(channelsDir, "ch_team.md"), 20);
    expect(msgs).toHaveLength(0);
  });

  it("injects channel announcement into asked agent system append", async () => {
    const channelsDir = path.join(tempRoot, "channels");
    const { filePath } = createChannel(channelsDir, { id: "ch_team", name: "team", members: ["alpha", "beta"] });
    setChannelAnnouncement(filePath, "必须先给结论，再给理由。");
    runAgentSessionMock.mockResolvedValue("beta ready");

    const emit = vi.fn();
    const engine = { channelsDir, _hub: { eventBus: { emit } } };
    const tool = createAskAgentTool({
      agentId: "alpha",
      listAgents: () => [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ],
      engine,
    });

    await tool.execute("tc-ann", {
      agent: "beta",
      task: "请输出结论",
      channel: "ch_team",
    });

    const callArgs = runAgentSessionMock.mock.calls[0] || [];
    const opts = callArgs[2] || {};
    expect(String(opts.systemAppend || "")).toContain("频道公告");
    expect(String(opts.systemAppend || "")).toContain("必须先给结论，再给理由。");
  });

  it("runs in parallel when multiple agents are provided and emits activity events", async () => {
    const channelsDir = path.join(tempRoot, "channels");
    createChannel(channelsDir, { id: "ch_team", name: "team", members: ["alpha", "beta", "gamma"] });
    runAgentSessionMock.mockImplementation(async (targetId) => `${targetId} done`);

    const emit = vi.fn();
    const engine = { channelsDir, _hub: { eventBus: { emit } } };
    const tool = createAskAgentTool({
      agentId: "alpha",
      listAgents: () => [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
        { id: "gamma", name: "Gamma" },
      ],
      engine,
    });

    const longTask = "并行处理\n1. 第一条\n2. 第二条\n3. 第三条 END_MARKER";
    const result = await tool.execute("tc-3", {
      agents: ["beta", "gamma"],
      task: longTask,
      channel: "ch_team",
    });

    expect(runAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(result?.details?.success).toBe(2);
    expect(result?.details?.failed).toBe(0);

    const eventPayloads = emit.mock.calls.map((c) => c[0]);
    expect(eventPayloads).toContainEqual(
      expect.objectContaining({ type: "channel_agent_activity", channelName: "ch_team", agentId: "beta", active: true }),
    );
    expect(eventPayloads).toContainEqual(
      expect.objectContaining({ type: "channel_agent_activity", channelName: "ch_team", agentId: "beta", active: false }),
    );
    expect(eventPayloads).toContainEqual(
      expect.objectContaining({ type: "channel_agent_activity", channelName: "ch_team", agentId: "gamma", active: true }),
    );
    expect(eventPayloads).toContainEqual(
      expect.objectContaining({ type: "channel_agent_activity", channelName: "ch_team", agentId: "gamma", active: false }),
    );
    expect(eventPayloads).toContainEqual(
      expect.objectContaining({ type: "channel_new_message", channelName: "ch_team", sender: "beta" }),
    );
    expect(eventPayloads).toContainEqual(
      expect.objectContaining({ type: "channel_new_message", channelName: "ch_team", sender: "gamma" }),
    );

    const msgs = getRecentMessages(path.join(channelsDir, "ch_team.md"), 20);
    const senders = new Set(msgs.map((m) => m.sender));
    expect(msgs[0]?.sender).toBe("alpha");
    expect(msgs[0]?.body).toContain("@Beta");
    expect(msgs[0]?.body).toContain("@Gamma");
    expect(msgs[0]?.body).toContain("Beta");
    expect(msgs[0]?.body).toContain("Gamma");
    expect(msgs[0]?.body).not.toContain("我已将任务分配给");
    expect(msgs[0]?.body).toContain("END_MARKER");
    const betaReply = msgs.find((m) => m.sender === "beta");
    const gammaReply = msgs.find((m) => m.sender === "gamma");
    expect(String(betaReply?.body || "")).toContain("@Alpha");
    expect(String(gammaReply?.body || "")).toContain("@Alpha");
    expect(senders.has("beta")).toBe(true);
    expect(senders.has("gamma")).toBe(true);
  });
});
