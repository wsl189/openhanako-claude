import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "./agent.js";

const cleanupDirs = [];

function mktemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Agent tool and skill boundary prompt", () => {
  it("distinguishes the Skill tool from concrete skills", () => {
    const root = mktemp("agent-skill-tool-boundary-");
    const agentDir = path.join(root, "agents", "hana");
    const productDir = path.join(root, "product");
    const userDir = path.join(root, "user");

    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(productDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(productDir, "identity.example.md"), "");
    fs.writeFileSync(path.join(productDir, "ishiki.example.md"), "");

    const agent = new Agent({ agentDir, productDir, userDir });
    agent._config = { locale: "zh", agent: { name: "Hanako" }, memory: { enabled: false } };
    agent.userName = "用户";
    agent.agentName = "Hanako";
    agent._engine = {
      getAgentPermissionConfig: () => ({
        tools: {
          builtin_enabled: ["Skill", "Read"],
          custom_enabled: ["notify"],
        },
      }),
      getHomeFolder: () => "",
    };
    agent._notifyTool = { name: "notify" };
    agent.setEnabledSkills([
      { name: "pdf-review", description: "Review PDF documents with a structured checklist." },
    ]);

    const prompt = agent.buildSystemAppendPrompt({
      includeUserProfile: false,
      includeMemory: false,
      includeSettings: false,
      includeWorkspace: false,
      includeDateTime: false,
    });

    expect(prompt).toContain("当前会话可用的标准 Claude 工具（仅以下）：Skill / Read");
    expect(prompt).toContain("Skill（大写）如果出现在标准 Claude 工具列表里，只表示");
    expect(prompt).toContain("不要把具体技能名称说成工具");
    expect(prompt).toContain("在给出最终回复前，必须再检查一次 TodoWrite 清单");
    expect(prompt).toContain("当前可加载技能（skills）：");
    expect(prompt).toContain("pdf-review: Review PDF documents with a structured checklist.");
  });
});
