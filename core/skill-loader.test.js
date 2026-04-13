import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { scanSkillsInPaths } from "./skill-loader.js";

function withTempDir(prefix, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeSkill(root, name, content) {
  const skillDir = path.join(root, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), content, "utf-8");
}

describe("scanSkillsInPaths description extraction", () => {
  it("prefers YAML frontmatter description", () => withTempDir("hanako-skill-loader-", (root) => {
    writeSkill(root, "frontmatter-skill", [
      "---",
      "name: frontmatter-skill",
      "description: Skill description from frontmatter",
      "---",
      "",
      "# Heading should not override description",
    ].join("\n"));

    const skills = scanSkillsInPaths([root]);
    const skill = skills.find((s) => s.name === "frontmatter-skill");
    expect(skill?.description).toBe("Skill description from frontmatter");
  }));

  it("falls back to body text when no frontmatter exists", () => withTempDir("hanako-skill-loader-", (root) => {
    writeSkill(root, "body-skill", [
      "",
      "# Useful Body Title",
      "",
      "Details about this skill.",
    ].join("\n"));

    const skills = scanSkillsInPaths([root]);
    const skill = skills.find((s) => s.name === "body-skill");
    expect(skill?.description).toBe("Useful Body Title");
  }));

  it("does not leak frontmatter delimiter as description", () => withTempDir("hanako-skill-loader-", (root) => {
    writeSkill(root, "delimiter-skill", [
      "---",
      "name: delimiter-skill",
      "---",
      "",
      "# Body Description",
    ].join("\n"));

    const skills = scanSkillsInPaths([root]);
    const skill = skills.find((s) => s.name === "delimiter-skill");
    expect(skill?.description).toBe("Body Description");
    expect(skill?.description).not.toBe("---");
  }));
});
