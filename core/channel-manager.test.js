import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createChannel } from "../lib/channels/channel-store.js";
import { writeSessionMetadata } from "./claude-session-store.js";
import { ChannelManager } from "./channel-manager.js";

const tempRoots = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("ChannelManager channel sessions", () => {
  function writeChannelSession(sessionPath, sessionId, cwd, agentId) {
    writeSessionMetadata(sessionPath, {
      version: 1,
      kind: "claude-agent-session",
      sessionId,
      cwd,
      agentId,
      title: "ch_team",
      archiveState: "active",
      memoryEnabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  it("removes per-agent channel sessions when deleting a channel", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-channel-manager-"));
    tempRoots.push(root);
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    fs.mkdirSync(path.join(agentsDir, "alpha", "sessions", "channel"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "beta", "sessions", "channel"), { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });

    createChannel(channelsDir, {
      id: "ch_team",
      name: "Team",
      members: ["alpha", "beta"],
    });

    const alphaSession = path.join(agentsDir, "alpha", "sessions", "channel", "ch_team.session.json");
    const betaSession = path.join(agentsDir, "beta", "sessions", "channel", "ch_team.session.json");
    writeChannelSession(alphaSession, "alpha-sdk-session", root, "alpha");
    writeChannelSession(betaSession, "beta-sdk-session", root, "beta");

    const manager = new ChannelManager({
      channelsDir,
      agentsDir,
      userDir,
      getHub: () => null,
    });

    manager.deleteChannelByName("ch_team");

    expect(fs.existsSync(path.join(channelsDir, "ch_team.md"))).toBe(false);
    expect(fs.existsSync(alphaSession)).toBe(false);
    expect(fs.existsSync(betaSession)).toBe(false);
  });

  it("can reset per-agent channel sessions without deleting the channel", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-channel-manager-"));
    tempRoots.push(root);
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    const userDir = path.join(root, "user");
    fs.mkdirSync(path.join(agentsDir, "alpha", "sessions", "channel"), { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });

    createChannel(channelsDir, {
      id: "ch_team",
      name: "Team",
      members: ["alpha"],
    });

    const alphaSession = path.join(agentsDir, "alpha", "sessions", "channel", "ch_team.session.json");
    writeChannelSession(alphaSession, "alpha-sdk-session", root, "alpha");

    const manager = new ChannelManager({
      channelsDir,
      agentsDir,
      userDir,
      getHub: () => null,
    });

    manager.resetChannelSessions("ch_team");

    expect(fs.existsSync(path.join(channelsDir, "ch_team.md"))).toBe(true);
    expect(fs.existsSync(alphaSession)).toBe(false);
  });
});
