import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
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

  it("falls back to hanako skills dir when configured skills dir is outside hanako home", async () => {
    const root = mktemp("setup-settings-tool-guard-");
    const externalRoot = mktemp("setup-settings-tool-external-");
    const skillsDir = path.join(root, "skills");
    const agentsDir = path.join(root, "agents");
    const agentDir = path.join(agentsDir, "hanako");
    const skillSrc = path.join(root, "guard-skill-src");
    fs.mkdirSync(path.join(agentDir, "skills"), { recursive: true });
    fs.mkdirSync(skillSrc, { recursive: true });
    fs.writeFileSync(path.join(skillSrc, "SKILL.md"), "---\nname: guard_skill\n---\n\n# guard\n", "utf-8");

    let availableSkills = [];
    const engine = {
      hanakoHome: root,
      userSkillsDir: path.join(externalRoot, "skills"),
      skillsDir,
      agentDir,
      agentsDir,
      config: { skills: { enabled: [] } },
      updateConfig: vi.fn(async () => {}),
      reloadSkills: vi.fn(async () => {
        availableSkills = scanGlobalSkills(skillsDir);
      }),
      getAllSkills: vi.fn(() => availableSkills),
      patchExternalMcpServers: vi.fn(() => {}),
      refreshCurrentSessionTools: vi.fn(async () => {}),
    };
    const tool = createSetupSettingsTool({ engine });

    const result = await tool.execute("tc-guard", {
      skill: {
        source_path: skillSrc,
      },
    });

    expect(result?.content?.[0]?.text || "").toContain("Setup applied");
    expect(fs.existsSync(path.join(skillsDir, "guard_skill", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(externalRoot, "skills", "guard_skill", "SKILL.md"))).toBe(false);
    const guardCheck = (result?.details?.checks || []).find((item) => item.type === "skills_global_dir_guard");
    expect(guardCheck?.ok).toBe(false);
  });

  it("clears memory and pinned memory for target agent", async () => {
    const root = mktemp("setup-settings-tool-memory-");
    const skillsDir = path.join(root, "skills");
    const agentsDir = path.join(root, "agents");
    const activeAgentDir = path.join(agentsDir, "hanako");
    const targetAgentDir = path.join(agentsDir, "beta");
    fs.mkdirSync(path.join(activeAgentDir, "memory"), { recursive: true });
    fs.mkdirSync(path.join(targetAgentDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(targetAgentDir, "memory", "memory.md"), "memory content", "utf-8");
    fs.writeFileSync(path.join(targetAgentDir, "memory", "today.md"), "today content", "utf-8");
    fs.writeFileSync(path.join(targetAgentDir, "pinned.md"), "- keep this\n", "utf-8");

    const tool = createSetupSettingsTool({
      engine: {
        hanakoHome: root,
        userSkillsDir: skillsDir,
        skillsDir,
        agentDir: activeAgentDir,
        agentsDir,
        factStore: { clearAll: vi.fn() },
        updateConfig: vi.fn(async () => {}),
      },
    });

    const result = await tool.execute("tc-memory", {
      memory: {
        action: "clear",
        agent_id: "beta",
        include_pinned: true,
      },
    });

    expect(result?.content?.[0]?.text || "").toContain("Setup applied");
    expect(fs.readFileSync(path.join(targetAgentDir, "memory", "memory.md"), "utf-8")).toBe("");
    expect(fs.readFileSync(path.join(targetAgentDir, "memory", "today.md"), "utf-8")).toBe("");
    expect(fs.readFileSync(path.join(targetAgentDir, "pinned.md"), "utf-8")).toBe("");
  });

  it("supports creating/deleting agents and applying defaults/tools in setup_settings", async () => {
    const root = mktemp("setup-settings-tool-agent-crud-");
    const skillsDir = path.join(root, "skills");
    const agentsDir = path.join(root, "agents");
    const activeAgentDir = path.join(agentsDir, "hanako");
    const createdAgentId = "new_agent";
    fs.mkdirSync(activeAgentDir, { recursive: true });

    const createdAgentUpdate = vi.fn();
    const engine = {
      hanakoHome: root,
      userSkillsDir: skillsDir,
      skillsDir,
      agentDir: activeAgentDir,
      agentsDir,
      createAgent: vi.fn(async () => ({ id: createdAgentId })),
      deleteAgent: vi.fn(async () => {}),
      getAgent: vi.fn((id) => (id === createdAgentId ? { updateConfig: createdAgentUpdate } : null)),
      updateConfig: vi.fn(async () => {}),
    };
    const tool = createSetupSettingsTool({ engine });

    const createResult = await tool.execute("tc-agent-create", {
      agent: {
        action: "create",
        name: "New Agent",
        yuan: "butter",
        default_workspace: "/tmp/workspace-a",
        default_model: "openai/gpt-5",
        tools: { enable_all: true },
      },
    });

    expect(createResult?.content?.[0]?.text || "").toContain("Setup applied");
    expect(engine.createAgent).toHaveBeenCalledWith({ name: "New Agent", yuan: "butter" });
    expect(createdAgentUpdate).toHaveBeenCalledWith({
      desk: { home_folder: "/tmp/workspace-a" },
      models: { chat: "openai/gpt-5" },
      tools: { builtin_enabled: null, custom_enabled: null },
    });

    const deleteResult = await tool.execute("tc-agent-delete", {
      agent: {
        action: "delete",
        agent_id: createdAgentId,
      },
    });
    expect(deleteResult?.content?.[0]?.text || "").toContain("Setup applied");
    expect(engine.deleteAgent).toHaveBeenCalledWith(createdAgentId);
  });

  it("fails fast when agent.action is omitted without target agent_id", async () => {
    const root = mktemp("setup-settings-tool-agent-action-required-");
    const skillsDir = path.join(root, "skills");
    const agentsDir = path.join(root, "agents");
    const activeAgentDir = path.join(agentsDir, "hanako");
    fs.mkdirSync(activeAgentDir, { recursive: true });

    const engine = {
      hanakoHome: root,
      userSkillsDir: skillsDir,
      skillsDir,
      agentDir: activeAgentDir,
      agentsDir,
      createAgent: vi.fn(async () => ({ id: "new_agent" })),
      updateConfig: vi.fn(async () => {}),
    };
    const tool = createSetupSettingsTool({ engine });

    const result = await tool.execute("tc-agent-action-required", {
      agent: {
        name: "Should Be Explicit",
      },
    });

    expect(result?.content?.[0]?.text || "").toContain("setup_settings failed");
    expect(result?.content?.[0]?.text || "").toContain("agent.action is required");
    expect(engine.createAgent).not.toHaveBeenCalled();
    expect(engine.updateConfig).not.toHaveBeenCalled();
  });

  it("updates another target agent config, tools, model/workspace and persona markdown", async () => {
    const root = mktemp("setup-settings-tool-agent-update-");
    const skillsDir = path.join(root, "skills");
    const agentsDir = path.join(root, "agents");
    const activeAgentDir = path.join(agentsDir, "hanako");
    const targetAgentDir = path.join(agentsDir, "beta");
    fs.mkdirSync(activeAgentDir, { recursive: true });
    fs.mkdirSync(targetAgentDir, { recursive: true });
    fs.writeFileSync(path.join(targetAgentDir, "config.yaml"), [
      "agent:",
      "  name: \"Beta\"",
      "  yuan: hanako",
      "tools:",
      "  custom_enabled:",
      "    - notify",
      "models:",
      "  chat: \"\"",
      "desk:",
      "  home_folder: \"\"",
      "",
    ].join("\n"), "utf-8");
    fs.writeFileSync(path.join(targetAgentDir, "identity.md"), "old identity", "utf-8");
    fs.writeFileSync(path.join(targetAgentDir, "ishiki.md"), "old ishiki", "utf-8");

    const tool = createSetupSettingsTool({
      engine: {
        hanakoHome: root,
        userSkillsDir: skillsDir,
        skillsDir,
        agentDir: activeAgentDir,
        agentsDir,
        updateConfig: vi.fn(async () => {}),
      },
    });

    const result = await tool.execute("tc-agent-update", {
      agent: {
        action: "update",
        agent_id: "beta",
        name: "Beta Plus",
        yuan: "ming",
        default_workspace: "/tmp/workspace-b",
        default_model: "openai/gpt-5-mini",
        tools: {
          builtin_enabled: ["Read", "Bash", "Skill"],
          custom_enabled: ["notify", "cron"],
        },
        identity_markdown: "new identity",
        ishiki_markdown: "new ishiki",
      },
    });

    expect(result?.content?.[0]?.text || "").toContain("Setup applied");
    const cfg = YAML.load(fs.readFileSync(path.join(targetAgentDir, "config.yaml"), "utf-8")) || {};
    expect(cfg.agent?.name).toBe("Beta Plus");
    expect(cfg.agent?.yuan).toBe("ming");
    expect(cfg.models?.chat).toBe("openai/gpt-5-mini");
    expect(cfg.desk?.home_folder).toBe("/tmp/workspace-b");
    expect(cfg.tools?.builtin_enabled).toEqual(["Read", "Bash", "Skill"]);
    expect(cfg.tools?.custom_enabled).toEqual(["notify", "cron"]);
    expect(fs.readFileSync(path.join(targetAgentDir, "identity.md"), "utf-8")).toBe("new identity");
    expect(fs.readFileSync(path.join(targetAgentDir, "ishiki.md"), "utf-8")).toBe("new ishiki");
  });
});
