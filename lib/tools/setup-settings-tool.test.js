import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSetupSettingsTool, _setupSettingsToolInternals } from "./setup-settings-tool.js";

const cleanupDirs = [];

function mktemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function scanGlobalSkills(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const md = path.join(skillsDir, entry.name, "SKILL.md");
    if (fs.existsSync(md)) out.push({ name: entry.name, baseDir: path.join(skillsDir, entry.name) });
  }
  return out;
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("setup-settings-tool", () => {
  it("normalizes and detects cross-platform absolute paths", () => {
    const unixPath = "/Users/demo/skills/demo";
    const winPath = "C:\\Users\\demo\\skills\\demo";
    const fileUrl = "file:///tmp/abc";
    expect(_setupSettingsToolInternals.isAbsolutePathAnyPlatform(unixPath)).toBe(true);
    expect(_setupSettingsToolInternals.isAbsolutePathAnyPlatform(winPath)).toBe(true);
    const normalizedUrl = _setupSettingsToolInternals.normalizeInputPath(fileUrl);
    expect(_setupSettingsToolInternals.isAbsolutePathAnyPlatform(normalizedUrl)).toBe(true);
  });

  it("installs skill to global and current agent locations, and writes MCP config", async () => {
    const root = mktemp("setup-settings-tool-");
    const skillsDir = path.join(root, "skills");
    const agentsDir = path.join(root, "agents");
    const agentDir = path.join(agentsDir, "hanako");
    const skillSrc = path.join(root, "demo-skill-src");
    fs.mkdirSync(path.join(agentDir, "skills"), { recursive: true });
    fs.mkdirSync(skillSrc, { recursive: true });
    fs.writeFileSync(path.join(skillSrc, "SKILL.md"), "---\nname: demo_skill\ndescription: test\n---\n\n# demo\n", "utf-8");

    let config = { skills: { enabled: [] } };
    let mcpServers = {};
    let availableSkills = [];
    const engine = {
      hanakoHome: root,
      userSkillsDir: skillsDir,
      skillsDir,
      agentDir,
      agentsDir,
      config,
      updateConfig: vi.fn(async (partial) => {
        if (partial?.skills?.enabled) {
          config = {
            ...config,
            skills: { ...(config.skills || {}), enabled: [...partial.skills.enabled] },
          };
          engine.config = config;
        }
      }),
      reloadSkills: vi.fn(async () => {
        availableSkills = scanGlobalSkills(skillsDir);
      }),
      getAllSkills: vi.fn(() => availableSkills),
      patchExternalMcpServers: vi.fn((patch) => {
        mcpServers = { ...mcpServers, ...patch };
      }),
      refreshCurrentSessionTools: vi.fn(async () => {}),
    };
    const tool = createSetupSettingsTool({ engine });

    const result = await tool.execute("tc1", {
      tutorial: JSON.stringify({
        skill: {
          source_path: skillSrc,
        },
        mcp: {
          name: "demo_mcp",
          type: "stdio",
          command: "sh",
          args: ["-lc", "echo ok"],
          env: { DEMO: "1" },
        },
      }),
    });

    expect(result?.content?.[0]?.text || "").toContain("Setup applied");
    const globalInstalled = path.join(skillsDir, "demo_skill", "SKILL.md");
    const agentInstalled = path.join(agentDir, "skills", "demo_skill", "SKILL.md");
    expect(fs.existsSync(globalInstalled)).toBe(true);
    expect(fs.existsSync(agentInstalled)).toBe(true);
    expect(engine.updateConfig).toHaveBeenCalledWith({ skills: { enabled: ["demo_skill"] } });
    expect(mcpServers.demo_mcp).toMatchObject({
      type: "stdio",
      command: "sh",
      args: ["-lc", "echo ok"],
      env: { DEMO: "1" },
    });
  });

  it("supports dry-run validation with tutorial json", async () => {
    const root = mktemp("setup-settings-tool-dryrun-");
    const tool = createSetupSettingsTool({
      engine: {
        hanakoHome: root,
        userSkillsDir: path.join(root, "skills"),
        skillsDir: path.join(root, "skills"),
        agentDir: path.join(root, "agents", "hanako"),
      },
    });
    const result = await tool.execute("tc2", {
      dry_run: true,
      tutorial: JSON.stringify({
        mcp: {
          name: "demo",
          type: "stdio",
          command: "sh",
        },
      }),
    });
    expect(result?.content?.[0]?.text || "").toContain("Dry run passed");
  });
});
