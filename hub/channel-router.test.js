import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLocale } from "../server/i18n.js";
import { createChannel } from "../lib/channels/channel-store.js";
import { ChannelRouter } from "./channel-router.js";

const tempRoots = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

describe("ChannelRouter member identity briefs", () => {
  it("injects other members' identity briefs without ishiki content", () => {
    loadLocale("zh");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-channel-router-"));
    tempRoots.push(root);
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });

    createChannel(channelsDir, {
      id: "ch_team",
      name: "Team",
      members: ["alpha", "beta", "gamma"],
    });

    fs.mkdirSync(path.join(agentsDir, "alpha"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "beta"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "gamma"), { recursive: true });

    fs.writeFileSync(
      path.join(agentsDir, "beta", "identity.md"),
      "# Beta\n\n职责：宏观策略分析\n擅长：政策与行业解读\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(agentsDir, "beta", "ishiki.md"),
      "绝密意识：这段文本不应进入频道身份简介。",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(agentsDir, "gamma", "identity.md"),
      "# Gamma\n\n负责执行与落地\n",
      "utf-8",
    );

    const engine = {
      channelsDir,
      agentsDir,
      userName: "Alice",
      listAgents: () => [
        { id: "alpha", name: "Alpha", identity: "负责协同与最终整合" },
        { id: "beta", name: "Beta", identity: "宏观策略分析师" },
        { id: "gamma", name: "Gamma", identity: "执行与落地负责人" },
      ],
      getAgent: (id) => (id === "alpha" ? { agentName: "Alpha", userName: "Alice" } : null),
      agents: new Map(),
    };
    const hub = { engine };
    const router = new ChannelRouter({ hub });

    const roleContext = router._buildChannelRoleContext("alpha", "ch_team");

    expect(roleContext).toContain("# 频道成员身份简介（协作参考）");
    expect(roleContext).toContain("Beta(beta)：职责：宏观策略分析；擅长：政策与行业解读");
    expect(roleContext).toContain("Gamma(gamma)：负责执行与落地");
    expect(roleContext).not.toContain("- Alpha(alpha)：");
    expect(roleContext).not.toContain("绝密意识");
  });
});

describe("ChannelRouter agent post behavior", () => {
  it("does not dispatch mention-triggered replies for agent posts", () => {
    const emit = vi.fn();
    const hub = {
      engine: {},
      eventBus: { emit },
    };
    const router = new ChannelRouter({ hub });
    const triggerSpy = vi.spyOn(router, "triggerImmediate").mockReturnValue(Promise.resolve());

    router._handleAgentPost("ch_team", "alpha", "@beta 请处理这个", { source: "tool" });

    expect(emit).toHaveBeenCalledWith(
      { type: "channel_new_message", channelName: "ch_team", sender: "alpha" },
      null,
    );
    expect(triggerSpy).not.toHaveBeenCalled();
  });
});
