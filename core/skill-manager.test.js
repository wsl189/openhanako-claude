import { describe, expect, it } from "vitest";
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
      "/Users/test/.hanako/agents/*/skills",
    ]);
  });
});
