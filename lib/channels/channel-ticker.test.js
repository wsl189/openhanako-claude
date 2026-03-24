import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendMessage, createChannel, parseChannel, readBookmarks } from "./channel-store.js";
import { createChannelTicker } from "./channel-ticker.js";

function setupFixture(agentIds = ["a", "b", "c"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-channel-ticker-"));
  const channelsDir = path.join(root, "channels");
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(channelsDir, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });

  const channelName = "ch_test";
  createChannel(channelsDir, {
    id: channelName,
    name: "Test Channel",
    members: agentIds,
  });

  for (const agentId of agentIds) {
    const agentDir = path.join(agentsDir, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "channels.md"),
      `# 频道\n\n- ${channelName} (last: never)\n`,
      "utf-8",
    );
  }

  const channelFile = path.join(channelsDir, `${channelName}.md`);
  appendMessage(channelFile, "user", "hello");

  return { root, channelsDir, agentsDir, channelName, channelFile, agentIds };
}

const tempRoots = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("channel-ticker dispatch policy", () => {
  it("runs explicit mentions in parallel and bypasses triage", async () => {
    const fx = setupFixture(["a", "b", "c"]);
    tempRoots.push(fx.root);

    const resolvers = new Map();
    const executeCheck = vi.fn((agentId, _channelName, _newMessages, _allUpdates, opts = {}) =>
      new Promise((resolve) => {
        resolvers.set(agentId, () => resolve({ replied: false, opts }));
      }),
    );

    const ticker = createChannelTicker({
      channelsDir: fx.channelsDir,
      agentsDir: fx.agentsDir,
      getAgentOrder: () => fx.agentIds,
      executeCheck,
      onMemorySummarize: vi.fn(),
    });
    ticker.start();

    const run = ticker.triggerImmediate(fx.channelName, {
      source: "user",
      mentionedAgents: ["a", "b"],
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(executeCheck).toHaveBeenCalledTimes(2);
    expect([...resolvers.keys()].sort()).toEqual(["a", "b"]);
    for (const call of executeCheck.mock.calls) {
      expect(call[4]?.forceReply).toBe(true);
    }

    resolvers.get("a")?.();
    resolvers.get("b")?.();
    await run;
    await ticker.stop();
  });

  it("only runs sequential triage for user message without mentions", async () => {
    const fx = setupFixture(["a", "b", "c"]);
    tempRoots.push(fx.root);

    const executeCheck = vi.fn(async () => ({ replied: false }));
    const ticker = createChannelTicker({
      channelsDir: fx.channelsDir,
      agentsDir: fx.agentsDir,
      getAgentOrder: () => fx.agentIds,
      executeCheck,
      onMemorySummarize: vi.fn(),
    });
    ticker.start();

    await ticker.triggerImmediate(fx.channelName, {
      source: "user",
      mentionedAgents: [],
    });
    await ticker.stop();

    expect(executeCheck.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
    for (const call of executeCheck.mock.calls) {
      expect(call[4]?.forceReply).toBe(false);
    }
  });

  it("does not trigger sequential triage for agent message without mentions", async () => {
    const fx = setupFixture(["a", "b"]);
    tempRoots.push(fx.root);

    const executeCheck = vi.fn(async () => ({ replied: false }));
    const ticker = createChannelTicker({
      channelsDir: fx.channelsDir,
      agentsDir: fx.agentsDir,
      getAgentOrder: () => fx.agentIds,
      executeCheck,
      onMemorySummarize: vi.fn(),
    });
    ticker.start();

    await ticker.triggerImmediate(fx.channelName, {
      source: "agent",
      mentionedAgents: [],
    });
    await ticker.stop();

    expect(executeCheck).not.toHaveBeenCalled();
  });

  it("queues new events and never interrupts running agents", async () => {
    const fx = setupFixture(["a"]);
    tempRoots.push(fx.root);

    let resolveFirst;
    const executeCheck = vi.fn(() =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );

    const ticker = createChannelTicker({
      channelsDir: fx.channelsDir,
      agentsDir: fx.agentsDir,
      getAgentOrder: () => fx.agentIds,
      executeCheck,
      onMemorySummarize: vi.fn(),
    });
    ticker.start();

    const first = ticker.triggerImmediate(fx.channelName, {
      source: "user",
      mentionedAgents: ["a"],
    });
    let secondFinished = false;
    const second = ticker
      .triggerImmediate(fx.channelName, {
        source: "user",
        mentionedAgents: ["a"],
      })
      .then(() => {
        secondFinished = true;
      });

    await new Promise((r) => setTimeout(r, 30));
    expect(executeCheck).toHaveBeenCalledTimes(1);
    expect(secondFinished).toBe(false);

    resolveFirst({ replied: false });
    await first;
    await second;
    await ticker.stop();
  });

  it("marks unmentioned agents to dispatch-start timestamp so cascaded mentions remain unread", async () => {
    const fx = setupFixture(["a", "b"]);
    tempRoots.push(fx.root);

    const executeCheck = vi.fn(async (agentId) => {
      if (agentId === "a") {
        // 确保新回复时间戳晚于触发时刻，便于断言 bookmark 不应推进到这里。
        await new Promise((r) => setTimeout(r, 1100));
        appendMessage(fx.channelFile, "a", "@b please reply");
        return { replied: true, replyContent: "@b please reply" };
      }
      return { replied: false };
    });

    const ticker = createChannelTicker({
      channelsDir: fx.channelsDir,
      agentsDir: fx.agentsDir,
      getAgentOrder: () => fx.agentIds,
      executeCheck,
      onMemorySummarize: vi.fn(),
    });
    ticker.start();

    await ticker.triggerImmediate(fx.channelName, {
      source: "user",
      mentionedAgents: ["a"],
    });
    await ticker.stop();

    const { messages } = parseChannel(fs.readFileSync(fx.channelFile, "utf-8"));
    const latestTs = messages[messages.length - 1]?.timestamp || "";
    const bBookmarks = readBookmarks(path.join(fx.agentsDir, "b", "channels.md"));
    const bTs = bBookmarks.get(fx.channelName) || "";

    expect(latestTs).toBeTruthy();
    expect(bTs).toBeTruthy();
    expect(bTs < latestTs).toBe(true);
  });
});
