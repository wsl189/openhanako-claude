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

describe("Agent pdf2md prompt", () => {
  it("tells the agent to call pdf2md instead of probing localhost", () => {
    const root = mktemp("agent-pdf2md-prompt-");
    const agentDir = path.join(root, "agents", "hana");
    const productDir = path.join(root, "product");
    const userDir = path.join(root, "user");

    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(productDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(productDir, "identity.example.md"), "");
    fs.writeFileSync(path.join(productDir, "ishiki.example.md"), "");

    const agent = new Agent({ agentDir, productDir, userDir });
    agent._config = {
      locale: "zh",
      agent: { name: "Hanako" },
      tools: { custom_enabled: ["pdf2md"] },
    };
    agent._engine = {
      getAgentPermissionConfig: () => ({
        tools: {
          builtin_enabled: ["bash"],
          custom_enabled: ["pdf2md"],
        },
      }),
      getHomeFolder: () => "",
    };
    agent._pdf2MdTool = { name: "pdf2md" };

    const prompt = agent.buildSystemAppendPrompt({
      includeUserProfile: false,
      includeMemory: false,
      includeSettings: false,
      includeWorkspace: false,
      includeDateTime: false,
    });

    expect(prompt).toContain("mcp__hanako__pdf2md");
    expect(prompt).toContain("服务地址由 Hanako 内部配置");
    expect(prompt).toContain("不要用 Bash/curl 访问 127.0.0.1:9280");
    expect(prompt).toContain("不要因为本地 9280 不通就改用 pypdf");
  });
});
