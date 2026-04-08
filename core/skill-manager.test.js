import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { SkillManager } from "./skill-manager.js";

describe("SkillManager watch ignore filter", () => {
  const mgr = new SkillManager({
    skillsDir: "/Users/test/.hanako/skills",
    agentsDir: "/Users/test/.hanako/agents",
  });

  it("does not ignore normal paths under ~/.hanako", () => {
    expect(mgr._shouldIgnoreWatchPath("/Users/test/.hanako/skills/my-skill/SKILL.md")).toBe(false);
    expect(mgr._shouldIgnoreWatchPath("/Users/test/.hanako/agents/hanako/skills/my-skill/SKILL.md")).toBe(false);
  });

  it("ignores hidden entries and temp editor files", () => {
    expect(mgr._shouldIgnoreWatchPath("/Users/test/.hanako/skills/.DS_Store")).toBe(true);
    expect(mgr._shouldIgnoreWatchPath("/Users/test/.hanako/skills/my-skill/SKILL.md~")).toBe(true);
    expect(mgr._shouldIgnoreWatchPath("/Users/test/.hanako/skills/my-skill/#SKILL.md#")).toBe(true);
  });

  it("only watches global skills and per-agent skills directories", () => {
    expect(mgr._buildWatchPaths()).toEqual([
      "/Users/test/.hanako/skills",
      "/Users/test/.hanako/agents",
    ]);
  });

  it("filters watched paths to global skills and agents/<id>/skills only", () => {
    expect(mgr._isWatchedSkillPath("/Users/test/.hanako/skills/my-skill/SKILL.md")).toBe(true);
    expect(mgr._isWatchedSkillPath("/Users/test/.hanako/agents/hanako/skills/my-skill/SKILL.md")).toBe(true);
    expect(mgr._isWatchedSkillPath("/Users/test/.hanako/agents/hanako/sessions/2026-01-01.json")).toBe(false);
  });

  it("auto reloads when agent private skills are added", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-skill-watch-"));
    const skillsDir = path.join(root, "skills");
    const agentDir = path.join(root, "agents", "hanako");
    const agentSkillsDir = path.join(agentDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(agentSkillsDir, { recursive: true });

    const testMgr = new SkillManager({
      skillsDir,
      agentsDir: path.join(root, "agents"),
    });

    let reloadCount = 0;
    let onReloadedCount = 0;
    const resourceLoader = {
      getSkills: () => ({ skills: [] }),
      reload: async () => {
        reloadCount += 1;
        resourceLoader.getSkills = () => ({ skills: [] });
      },
    };
    const agents = new Map([["hanako", { agentDir }]]);
    testMgr.init(resourceLoader, agents, new Set());
    testMgr.watch(resourceLoader, agents, () => {
      onReloadedCount += 1;
    });

    const waitFor = async (check, timeoutMs = 7000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("timed out waiting for skill watcher reload");
    };

    try {
      // 给 watcher 一点启动时间，避免在 ready 前创建目录导致漏事件。
      await new Promise((r) => setTimeout(r, 200));
      const skillDir = path.join(agentSkillsDir, "my-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\ndescription: test\n---\n");

      await waitFor(() => reloadCount > 0);
      expect(onReloadedCount).toBeGreaterThan(0);
    } finally {
      testMgr.unwatch();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
