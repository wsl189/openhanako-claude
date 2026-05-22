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

describe("Agent shared dependency prompt", () => {
  it("enforces shared environment rules for skill dependency installation", () => {
    const root = mktemp("agent-shared-deps-prompt-");
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
          builtin_enabled: ["Read"],
          custom_enabled: ["setup_settings"],
        },
      }),
      getHomeFolder: () => "",
    };
    agent._setupSettingsTool = { name: "setup_settings" };

    const prompt = agent.buildSystemAppendPrompt({
      includeUserProfile: false,
      includeMemory: false,
      includeWorkspace: false,
      includeDateTime: false,
    });

    expect(prompt).toContain("Skill 依赖共享环境约束");
    expect(prompt).toContain("共享环境固定路径：`~/.hanako/runtime/shared`");
    expect(prompt).toContain("禁止按 skill 单独创建 Python venv 或单独 node_modules");
    expect(prompt).toContain("必须安装到上述共享环境路径下");
    expect(prompt).toContain("仅补齐缺失依赖");
    expect(prompt).toContain("先明确报告冲突，不要擅自强行覆盖现有共享依赖");
    expect(prompt).toContain("配置脚本运行环境或安装依赖时，优先使用国内镜像源");
    expect(prompt).toContain("临时执行脚本");
    expect(prompt).toContain("禁止为单次脚本临时创建独立 venv 或独立 node_modules");
    expect(prompt).toContain("安装或更新 skill/MCP 后，必须执行一次最小可用性测试");
    expect(prompt).toContain("必须明确回复失败原因");
    expect(prompt).toContain("先修复并重试");
    expect(prompt).toContain("如果用户明确要求“在某个指定目录新建环境”，按用户指定目录执行");
  });
});
