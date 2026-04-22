import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { BridgeSessionManager } from "./bridge-session-manager.js";

function makeTempAgent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-bridge-session-"));
  const agentDir = path.join(root, "agent-a");
  const sessionDir = path.join(agentDir, "sessions");
  fs.mkdirSync(path.join(sessionDir, "bridge", "owner"), { recursive: true });
  return {
    root,
    agent: {
      id: "agent-a",
      agentDir,
      sessionDir,
      config: {
        desk: { home_folder: root },
      },
    },
  };
}

describe("BridgeSessionManager legacy metadata compatibility", () => {
  it("recreates metadata when bridge index points to legacy jsonl transcript", () => {
    const { root, agent } = makeTempAgent();
    const manager = new BridgeSessionManager({
      getAgent: () => agent,
      getHomeCwd: () => root,
    });

    const sessionKey = "qq:bot123::qq_dm_user123";
    const legacyRel = path.join("owner", "legacy-transcript.jsonl");
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const legacyAbs = path.join(bridgeDir, legacyRel);

    fs.writeFileSync(legacyAbs, [
      JSON.stringify({ type: "session", version: 3, id: "legacy", timestamp: new Date().toISOString(), cwd: root }),
      JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
    ].join("\n") + "\n", "utf-8");

    fs.writeFileSync(
      path.join(bridgeDir, "bridge-sessions.json"),
      JSON.stringify({ [sessionKey]: { file: legacyRel, name: "User" } }, null, 2) + "\n",
      "utf-8",
    );

    const resolved = manager._resolveBridgeMetadata({
      agent,
      sessionKey,
      meta: { name: "User", userId: "user123" },
    });

    expect(resolved.sessionPath).not.toBe(legacyAbs);
    expect(resolved.sessionPath.endsWith(".session.json")).toBe(true);
    expect(fs.existsSync(resolved.sessionPath)).toBe(true);
    expect(resolved.existingFile).toBeNull();
    expect(resolved.metadata?.bridge).toEqual({ name: "User", userId: "user123" });
  });

  it("resolves bridge chat model when config uses legacy object ref", () => {
    const { root, agent } = makeTempAgent();
    agent.config.models = {
      chat: { id: "MiniMax-M2.7", provider: "minimax" },
    };
    const manager = new BridgeSessionManager({
      getAgent: () => agent,
      getHomeCwd: () => root,
    });
    const mm = {
      defaultModel: null,
      findAvailableModel: (ref) => (ref === "minimax/MiniMax-M2.7"
        ? { id: "MiniMax-M2.7", provider: "minimax", name: "MiniMax M2.7" }
        : null),
    };

    const resolved = manager._resolveBridgeModel(mm, agent);
    expect(resolved?.provider).toBe("minimax");
    expect(resolved?.id).toBe("MiniMax-M2.7");
  });
});
