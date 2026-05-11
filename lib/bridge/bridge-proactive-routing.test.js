import { describe, expect, it, vi } from "vitest";

import { BridgeManager } from "./bridge-manager.js";

function createManager() {
  const root = process.cwd();
  const prefs = { bridge: {} };
  const knownAgents = new Set(["agent_a", "agent_b", "agent_x", "current_agent"]);
  const engine = {
    hanakoHome: root,
    getHomeFolder: () => root,
    homeCwd: root,
    cwd: root,
    deskCwd: root,
    agentName: "Hanako",
    currentAgentId: "current_agent",
    agent: { deskManager: { homePath: root }, sessionDir: root },
    getPreferences: vi.fn(() => prefs),
    getBridgeIndex: vi.fn(() => ({})),
    getAgent: vi.fn((id) => {
      if (id && !knownAgents.has(id)) return null;
      return { sessionDir: root };
    }),
  };
  const hub = { eventBus: { emit: vi.fn() } };
  return new BridgeManager({ engine, hub });
}

describe("BridgeManager proactive routing", () => {
  it("routes proactive notifications only to platforms bound to the same agent", async () => {
    const manager = createManager();
    const sendA = vi.fn(async () => {});
    const sendB = vi.fn(async () => {});

    manager._platforms.set("telegram:botA", {
      status: "connected",
      platform: "telegram",
      adapter: { sendReply: sendA },
      agentId: "agent_a",
    });
    manager._platforms.set("telegram:botB", {
      status: "connected",
      platform: "telegram",
      adapter: { sendReply: sendB },
      agentId: "agent_b",
    });
    manager._pickLatestDmTarget = vi.fn(() => ({ sessionKey: "telegram_dm_1", chatId: "123" }));

    const sent = await manager.sendProactive("定时提醒测试", { agentId: "agent_b" });

    expect(sendA).not.toHaveBeenCalled();
    expect(sendB).toHaveBeenCalledTimes(1);
    expect(manager._pickLatestDmTarget).toHaveBeenCalledWith("telegram:botB", "agent_b");
    expect(sent?.platform).toBe("telegram");
  });

  it("passes agentId into bridge index lookup when selecting latest dm target", () => {
    const manager = createManager();

    manager._pickLatestDmTarget("telegram:botA", "agent_x");

    expect(manager.engine.getBridgeIndex).toHaveBeenCalledWith("agent_x");
  });

  it("honors explicit platform routing when multiple platforms are bound", async () => {
    const manager = createManager();
    const sendTg = vi.fn(async () => {});
    const sendWx = vi.fn(async () => {});

    manager._platforms.set("telegram:botA", {
      status: "connected",
      platform: "telegram",
      adapter: { sendReply: sendTg },
      agentId: "agent_b",
    });
    manager._platforms.set("wechat", {
      status: "connected",
      platform: "wechat",
      adapter: { sendReply: sendWx },
      agentId: "agent_b",
    });
    manager._pickLatestDmTarget = vi.fn(() => ({ sessionKey: "wx_dm_1", chatId: "wx_uin" }));

    const sent = await manager.sendProactive("微信提醒", { agentId: "agent_b", platform: "wechat" });

    expect(sendTg).not.toHaveBeenCalled();
    expect(sendWx).toHaveBeenCalledTimes(1);
    expect(sent?.platform).toBe("wechat");
  });

  it("throws in strict mode when explicit platform has no available dm target", async () => {
    const manager = createManager();
    const sendWx = vi.fn(async () => {});
    manager._platforms.set("wechat", {
      status: "connected",
      platform: "wechat",
      adapter: { sendReply: sendWx },
      agentId: "agent_b",
    });
    manager._pickLatestDmTarget = vi.fn(() => null);

    await expect(manager.sendProactive("微信提醒", {
      agentId: "agent_b",
      platform: "wechat",
      strict: true,
    })).rejects.toThrow(/暂无可用私聊会话|未连接|发送失败/);
  });

  it("prefers bot binding in settings over current agent for routing", () => {
    const manager = createManager();
    manager.engine.getPreferences.mockReturnValue({
      bridge: {
        telegram: {
          bots: [{ id: "botA", agentId: "agent_b" }],
        },
      },
    });

    const resolved = manager._resolveTargetAgentId("telegram:botA", null);

    expect(resolved).toBe("agent_b");
  });

  it("falls back to current agent only when binding is unavailable", () => {
    const manager = createManager();
    manager.engine.getPreferences.mockReturnValue({
      bridge: {
        telegram: {
          bots: [{ id: "botA", agentId: "missing_agent" }],
        },
      },
    });

    const resolved = manager._resolveTargetAgentId("telegram:botA", null);

    expect(resolved).toBe("current_agent");
  });
});
