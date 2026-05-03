import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addBookmarkEntry, appendMessage, createChannel, parseChannel, readBookmarks } from "./channel-store.js";
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

function addChannelToFixture(fx, channelName, members = fx.agentIds) {
  createChannel(fx.channelsDir, {
    id: channelName,
    name: channelName,
    members,
  });

  for (const agentId of members) {
    addBookmarkEntry(path.join(fx.agentsDir, agentId, "channels.md"), channelName);
  }

  const channelFile = path.join(fx.channelsDir, `${channelName}.md`);
  appendMessage(channelFile, "user", `hello ${channelName}`);
  return { channelName, channelFile };
}

const tempRoots = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("channel-ticker dispatch policy", () => {
  it("runs different channels in parallel when their agents differ", async () => {
    const fx = setupFixture(["a", "b"]);
    tempRoots.push(fx.root);
    const other = addChannelToFixture(fx, "ch_other");

    let resolveA;
    const executeCheck = vi.fn((agentId) => {
      if (agentId === "a") {
        return new Promise((resolve) => {
          resolveA = () => resolve({ replied: false });
        });
      }
      return Promise.resolve({ replied: false });
    });

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

    await new Promise((r) => setTimeout(r, 30));
    expect(executeCheck.mock.calls.map((c) => `${c[1]}:${c[0]}`)).toEqual([`${fx.channelName}:a`]);

    const second = ticker.triggerImmediate(other.channelName, {
      source: "user",
      mentionedAgents: ["b"],
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(executeCheck.mock.calls.map((c) => `${c[1]}:${c[0]}`)).toContain(`${other.channelName}:b`);

    resolveA?.();
    await Promise.all([first, second]);
    await ticker.stop();
  });

  it("serializes the same agent across different channel queues", async () => {
    const fx = setupFixture(["a"]);
    tempRoots.push(fx.root);
    const other = addChannelToFixture(fx, "ch_other", ["a"]);

    let resolveFirst;
    let callNo = 0;
    const executeCheck = vi.fn(() => {
      callNo += 1;
      if (callNo === 1) {
        return new Promise((resolve) => {
          resolveFirst = () => resolve({ replied: false });
        });
      }
      return Promise.resolve({ replied: false });
    });

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

    await new Promise((r) => setTimeout(r, 30));
    expect(executeCheck).toHaveBeenCalledTimes(1);

    const second = ticker.triggerImmediate(other.channelName, {
      source: "user",
      mentionedAgents: ["a"],
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(executeCheck).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await Promise.all([first, second]);
    await ticker.stop();

    expect(executeCheck).toHaveBeenCalledTimes(2);
    expect(executeCheck.mock.calls.map((c) => c[1])).toEqual([fx.channelName, other.channelName]);
  });

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

  it("dispatches explicit mentions even when cached agent order misses the target", async () => {
    const fx = setupFixture(["a", "b"]);
    tempRoots.push(fx.root);

    const executeCheck = vi.fn(async () => ({ replied: false }));
    const ticker = createChannelTicker({
      channelsDir: fx.channelsDir,
      agentsDir: fx.agentsDir,
      // 模拟缓存滞后：排序里暂时只有 a
      getAgentOrder: () => ["a"],
      executeCheck,
      onMemorySummarize: vi.fn(),
    });
    ticker.start();

    await ticker.triggerImmediate(fx.channelName, {
      source: "agent",
      mentionedAgents: ["b"],
    });
    await ticker.stop();

    expect(executeCheck).toHaveBeenCalledTimes(1);
    expect(executeCheck.mock.calls[0][0]).toBe("b");
    expect(executeCheck.mock.calls[0][4]?.forceReply).toBe(true);
  });

  it("auto-adds missing bookmark for force-reply mentions", async () => {
    const fx = setupFixture(["a", "b"]);
    tempRoots.push(fx.root);

    const bChannelsMd = path.join(fx.agentsDir, "b", "channels.md");
    fs.writeFileSync(bChannelsMd, "# 频道\n\n", "utf-8");

    const executeCheck = vi.fn(async () => ({ replied: false }));
    const ticker = createChannelTicker({
      channelsDir: fx.channelsDir,
      agentsDir: fx.agentsDir,
      // 模拟缓存未包含 b，确保走显式 mention 兜底路径
      getAgentOrder: () => ["a"],
      executeCheck,
      onMemorySummarize: vi.fn(),
    });
    ticker.start();

    await ticker.triggerImmediate(fx.channelName, {
      source: "agent",
      mentionedAgents: ["b"],
    });
    await ticker.stop();

    expect(executeCheck).toHaveBeenCalledTimes(1);
    expect(executeCheck.mock.calls[0][0]).toBe("b");

    const bBookmarks = readBookmarks(bChannelsMd);
    expect(bBookmarks.has(fx.channelName)).toBe(true);
  });

  it("keeps second-hop mentions activatable in agent cascades", async () => {
    const fx = setupFixture(["a", "b", "c"]);
    tempRoots.push(fx.root);

    const COLLIDE_TS = "2099-01-01 00:00:01";
    const appendAtFixedTs = (sender, body) => {
      fs.appendFileSync(
        fx.channelFile,
        `\n### ${sender} | ${COLLIDE_TS}\n\n${body}\n\n---\n`,
        "utf-8",
      );
    };

    const executeCheck = vi.fn(async (agentId) => {
      if (agentId === "a") {
        appendAtFixedTs("a", "@b first hop");
        return { replied: true, replyContent: "@b first hop" };
      }
      if (agentId === "b") {
        appendAtFixedTs("b", "@c second hop");
        return { replied: true, replyContent: "@c second hop" };
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
    await ticker.triggerImmediate(fx.channelName, {
      source: "agent",
      mentionedAgents: ["b"],
    });
    await ticker.triggerImmediate(fx.channelName, {
      source: "agent",
      mentionedAgents: ["c"],
    });
    await ticker.stop();

    const calledAgents = executeCheck.mock.calls.map((call) => call[0]);
    expect(calledAgents).toContain("a");
    expect(calledAgents).toContain("b");
    expect(calledAgents).toContain("c");
  });

  it("activates mentioned members after user mention-all parallel wave", async () => {
    const fx = setupFixture(["a", "b", "c"]);
    tempRoots.push(fx.root);

    const COLLIDE_TS = "2099-01-01 00:00:02";
    const appendAtFixedTs = (sender, body) => {
      fs.appendFileSync(
        fx.channelFile,
        `\n### ${sender} | ${COLLIDE_TS}\n\n${body}\n\n---\n`,
        "utf-8",
      );
    };

    let aPosted = false;
    const executeCheck = vi.fn(async (agentId) => {
      if (agentId === "a") {
        appendAtFixedTs("a", "@b @c follow-up");
        aPosted = true;
        return { replied: true, replyContent: "@b @c follow-up" };
      }
      if (agentId === "b" || agentId === "c") {
        // 模拟 @全体并行时，b/c 在 a 发言之后结束，从而书签可能被推进到 a 的消息时间。
        while (!aPosted) {
          await new Promise((r) => setTimeout(r, 5));
        }
        return { replied: false };
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

    // 第一轮：用户 @全体（并行）
    await ticker.triggerImmediate(fx.channelName, {
      source: "user",
      mentionedAgents: ["a", "b", "c"],
    });
    // 第二轮：a 在上一轮里 @b/@c，应能激活 b/c
    await ticker.triggerImmediate(fx.channelName, {
      source: "agent",
      mentionedAgents: ["b", "c"],
    });
    await ticker.stop();

    const bCalls = executeCheck.mock.calls.filter((call) => call[0] === "b").length;
    const cCalls = executeCheck.mock.calls.filter((call) => call[0] === "c").length;
    expect(bCalls).toBeGreaterThanOrEqual(2);
    expect(cCalls).toBeGreaterThanOrEqual(2);
  });

  it("supports multi-round fanout after user mention-all when every agent mentions all peers", async () => {
    const fx = setupFixture(["a", "b", "c", "d"]);
    tempRoots.push(fx.root);

    const agents = fx.agentIds;
    const rounds = 4;
    let tick = 1;
    const appendAtTick = (sender, body) => {
      const ts = `2099-01-01 00:00:${String(tick).padStart(2, "0")}`;
      tick += 1;
      fs.appendFileSync(
        fx.channelFile,
        `\n### ${sender} | ${ts}\n\n${body}\n\n---\n`,
        "utf-8",
      );
    };

    const calls = new Map(agents.map((id) => [id, 0]));
    const executeCheck = vi.fn(async (agentId) => {
      calls.set(agentId, (calls.get(agentId) || 0) + 1);
      const peers = agents.filter((id) => id !== agentId);
      appendAtTick(agentId, peers.map((id) => `@${id}`).join(" "));
      return { replied: true, replyContent: peers.map((id) => `@${id}`).join(" ") };
    });

    const ticker = createChannelTicker({
      channelsDir: fx.channelsDir,
      agentsDir: fx.agentsDir,
      getAgentOrder: () => agents,
      executeCheck,
      onMemorySummarize: vi.fn(),
    });
    ticker.start();

    await ticker.triggerImmediate(fx.channelName, {
      source: "user",
      mentionedAgents: agents,
    });
    for (let i = 0; i < rounds - 1; i++) {
      await ticker.triggerImmediate(fx.channelName, {
        source: "agent",
        mentionedAgents: agents,
      });
    }
    await ticker.stop();

    for (const id of agents) {
      expect(calls.get(id)).toBe(rounds);
    }
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

  it("does not interrupt unfinished replies when a new user input arrives", async () => {
    const fx = setupFixture(["a"]);
    tempRoots.push(fx.root);

    let firstAborted = false;
    let callNo = 0;
    let resolveFirst;
    const executeCheck = vi.fn((_agentId, _channelName, _newMessages, _allUpdates, opts = {}) => {
      callNo += 1;
      if (callNo === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
          const signal = opts.signal;
          if (!signal) {
            resolve({ replied: false });
            return;
          }
          signal.addEventListener("abort", () => {
            firstAborted = true;
            resolve({ replied: false });
          }, { once: true });
        });
      }
      return Promise.resolve({ replied: false });
    });

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

    await new Promise((r) => setTimeout(r, 30));
    expect(executeCheck).toHaveBeenCalledTimes(1);

    appendMessage(fx.channelFile, "user", "second question");
    const second = ticker.triggerImmediate(fx.channelName, {
      source: "user",
      mentionedAgents: ["a"],
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(executeCheck).toHaveBeenCalledTimes(1);
    expect(firstAborted).toBe(false);

    resolveFirst?.({ replied: false });
    await Promise.all([first, second]);
    await ticker.stop();

    // 核心断言是“未被自动中断”，并且第二条消息会在首轮结束后继续处理。
    expect(executeCheck).toHaveBeenCalledTimes(2);
    expect(firstAborted).toBe(false);
    expect(executeCheck.mock.calls[0][4]?.signal?.aborted).toBe(false);
  });

  it("interrupts unfinished replies only when explicit stop is called", async () => {
    const fx = setupFixture(["a"]);
    tempRoots.push(fx.root);

    let firstAborted = false;
    let callNo = 0;
    const executeCheck = vi.fn((_agentId, _channelName, _newMessages, _allUpdates, opts = {}) => {
      callNo += 1;
      if (callNo === 1) {
        return new Promise((resolve) => {
          const signal = opts.signal;
          if (!signal) {
            resolve({ replied: false });
            return;
          }
          signal.addEventListener("abort", () => {
            firstAborted = true;
            resolve({ replied: false });
          }, { once: true });
        });
      }
      return Promise.resolve({ replied: false });
    });

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

    await new Promise((r) => setTimeout(r, 30));
    expect(executeCheck).toHaveBeenCalledTimes(1);

    appendMessage(fx.channelFile, "user", "second question");
    const second = ticker.triggerImmediate(fx.channelName, {
      source: "user",
      mentionedAgents: ["a"],
    });

    await new Promise((r) => setTimeout(r, 10));
    const stopResult = ticker.stopUnfinishedReplies("test-stop");

    await Promise.all([first, second]);
    await ticker.stop();

    expect(stopResult.version).toBeGreaterThan(0);
    expect(stopResult.aborted).toBe(true);
    expect(executeCheck).toHaveBeenCalledTimes(1);
    expect(firstAborted).toBe(true);
    expect(executeCheck.mock.calls[0][4]?.signal?.aborted).toBe(true);
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

  it("does not block next dispatch on slow memory summarize", async () => {
    const fx = setupFixture(["a", "b"]);
    tempRoots.push(fx.root);

    const executeCheck = vi.fn(async (agentId) => ({
      replied: true,
      replyContent: `reply-${agentId}`,
    }));
    const onMemorySummarize = vi.fn(() => new Promise((resolve) => setTimeout(resolve, 1500)));

    const ticker = createChannelTicker({
      channelsDir: fx.channelsDir,
      agentsDir: fx.agentsDir,
      getAgentOrder: () => fx.agentIds,
      executeCheck,
      onMemorySummarize,
    });
    ticker.start();

    const first = ticker.triggerImmediate(fx.channelName, {
      source: "user",
      mentionedAgents: ["a"],
    });

    // 跨秒后再发 follow-up，避免 timestamp 同秒导致 unread=0。
    await new Promise((r) => setTimeout(r, 1100));
    appendMessage(fx.channelFile, "user", "followup");
    const second = ticker.triggerImmediate(fx.channelName, {
      source: "user",
      mentionedAgents: ["b"],
    });

    await new Promise((r) => setTimeout(r, 200));
    const calledB = executeCheck.mock.calls.some((call) => call[0] === "b");
    expect(calledB).toBe(true);

    await Promise.all([first, second]);
    await ticker.stop();
  });

  it("passes structured memory payload for channel memory pipeline", async () => {
    const fx = setupFixture(["a"]);
    tempRoots.push(fx.root);

    const onMemorySummarize = vi.fn(async () => {});
    const executeCheck = vi.fn(async () => ({
      replied: true,
      replyContent: "ack",
      replyTimestamp: "2026-03-25 01:23:45",
    }));

    const ticker = createChannelTicker({
      channelsDir: fx.channelsDir,
      agentsDir: fx.agentsDir,
      getAgentOrder: () => fx.agentIds,
      executeCheck,
      onMemorySummarize,
    });
    ticker.start();

    await ticker.triggerImmediate(fx.channelName, {
      source: "user",
      mentionedAgents: ["a"],
    });
    await ticker.stop();

    expect(onMemorySummarize).toHaveBeenCalledTimes(1);
    const [agentId, channelName, payload] = onMemorySummarize.mock.calls[0];
    expect(agentId).toBe("a");
    expect(channelName).toBe(fx.channelName);
    expect(Array.isArray(payload.recentMessages)).toBe(true);
    expect(payload.reply).toMatchObject({
      sender: "a",
      body: "ack",
      timestamp: "2026-03-25 01:23:45",
    });
  });
});
