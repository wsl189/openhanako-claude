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

describe("Agent memory prompt", () => {
  it("warns that time-sensitive memories must not be treated as current facts", () => {
    const root = mktemp("agent-memory-prompt-");
    const agentDir = path.join(root, "agents", "hana");
    const productDir = path.join(root, "product");
    const userDir = path.join(root, "user");

    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    fs.mkdirSync(productDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(productDir, "identity.example.md"), "");
    fs.writeFileSync(path.join(productDir, "ishiki.example.md"), "");
    fs.writeFileSync(
      path.join(agentDir, "memory", "memory.md"),
      "## 重要事实\n\n- [2026-04-01 10:00] (stateful) 用户持有徐工机械\n",
    );

    const agent = new Agent({ agentDir, productDir, userDir });
    agent._config = { locale: "zh", agent: { name: "Hanako" }, memory: { enabled: true } };
    agent.userName = "用户";
    agent.agentName = "Hanako";

    const prompt = agent.buildSystemAppendPrompt({
      includeUserProfile: false,
      includeSettings: false,
      includeToolAvailability: false,
      includeWorkspace: false,
      includeDateTime: false,
    });

    expect(prompt).toContain("每条记忆都必须结合记录时间判断是否仍然有效");
    expect(prompt).toContain("股票/基金/仓位/账户余额");
    expect(prompt).toContain("不要把它直接当成现在事实");
    expect(prompt).toContain("用户持有徐工机械");
  });
});
