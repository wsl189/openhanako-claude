import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("renders DB memory projection and ignores direct compatibility file edits", () => {
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
    agent._memoryService = {
      renderMemoryPrompt: () => "## 重要事实\n\n- [2026-04-01 10:00] (stateful) 用户持有徐工机械\n",
    };

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

    fs.writeFileSync(
      path.join(agentDir, "memory", "memory.md"),
      "## 重要事实\n\n- [2026-04-02 09:00] (stateful) 用户已经清仓\n",
    );

    const nextPrompt = agent.buildSystemAppendPrompt({
      includeUserProfile: false,
      includeSettings: false,
      includeToolAvailability: false,
      includeWorkspace: false,
      includeDateTime: false,
    });

    expect(nextPrompt).toContain("用户持有徐工机械");
    expect(nextPrompt).not.toContain("用户已经清仓");
  });

  it("keeps user profile injection while skipping memory sections when memory master is off", () => {
    const root = mktemp("agent-memory-master-off-");
    const agentDir = path.join(root, "agents", "hana");
    const productDir = path.join(root, "product");
    const userDir = path.join(root, "user");

    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    fs.mkdirSync(productDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(productDir, "identity.example.md"), "");
    fs.writeFileSync(path.join(productDir, "ishiki.example.md"), "");

    const agent = new Agent({ agentDir, productDir, userDir });
    agent._config = { locale: "zh", agent: { name: "Hanako" }, memory: { enabled: false } };
    agent.userName = "用户";
    agent.agentName = "Hanako";
    agent._memoryMasterEnabled = false;
    agent._memorySessionEnabled = true;
    agent._memoryService = {
      renderProfilePrompt: () => "## 长期偏好\n\n- 用户偏好先给结论",
      renderPinnedPrompt: () => "- 置顶记忆：始终简洁",
      renderMemoryPrompt: () => "## 重要事实\n\n- 当前仍持有徐工机械",
      renderReflectionPrompt: () => "## 已验证经验\n\n- 状态查询先看 freshness guard",
    };

    const prompt = agent.buildSystemAppendPrompt({
      includeSettings: false,
      includeToolAvailability: false,
      includeWorkspace: false,
      includeDateTime: false,
    });

    expect(prompt).toContain("# 用户档案");
    expect(prompt).toContain("用户偏好先给结论");
    expect(prompt).not.toContain("# 置顶记忆");
    expect(prompt).not.toContain("# 记忆");
    expect(prompt).not.toContain("# 反思");
  });

  it("asks the profile renderer to exclude pinned content from the user profile section", () => {
    const root = mktemp("agent-profile-pinned-dedupe-");
    const agentDir = path.join(root, "agents", "hana");
    const productDir = path.join(root, "product");
    const userDir = path.join(root, "user");

    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    fs.mkdirSync(productDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(productDir, "identity.example.md"), "");
    fs.writeFileSync(path.join(productDir, "ishiki.example.md"), "");

    const agent = new Agent({ agentDir, productDir, userDir });
    agent._config = { locale: "zh", agent: { name: "Hanako" }, memory: { enabled: true } };
    agent.userName = "用户";
    agent.agentName = "Hanako";
    agent._memoryMasterEnabled = true;
    agent._memorySessionEnabled = true;
    const renderProfilePrompt = vi.fn(() => "## 长期偏好\n\n- 用户偏好先给结论");
    agent._memoryService = {
      renderProfilePrompt,
      renderPinnedPrompt: () => "- 置顶记忆：始终简洁",
      renderMemoryPrompt: () => "",
      renderReflectionPrompt: () => "",
    };

    const prompt = agent.buildSystemAppendPrompt({
      includeSettings: false,
      includeToolAvailability: false,
      includeWorkspace: false,
      includeDateTime: false,
    });

    expect(renderProfilePrompt).toHaveBeenCalledWith({ includePinned: false });
    expect(prompt).toContain("# 用户档案");
    expect(prompt).toContain("# 置顶记忆");
  });
});
