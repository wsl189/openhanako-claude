import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadLocale } from "../../server/i18n.js";
import { adaptCustomTool } from "./custom-tool-adapter.js";
import { createMemorySearchTool } from "../memory/memory-search.js";
import { MemoryService } from "../memory/memory-service.js";
import { createPinnedMemoryTools } from "../tools/pinned-memory.js";
import { createExperienceTools } from "../tools/experience.js";
import { createCronTool } from "../tools/cron-tool.js";
import { CronStore } from "../desk/cron-store.js";
import { createPresentFilesTool } from "../tools/output-file-tool.js";
import { createArtifactTool } from "../tools/artifact-tool.js";
import { createChannelTool } from "../tools/channel-tool.js";
import { createAskAgentTool } from "../tools/ask-agent-tool.js";
import { createDescribeImagesTool } from "../tools/describe-images-tool.js";
import { createGenerateImagesTool } from "../tools/generate-images-tool.js";
import { createNotifyTool } from "../tools/notify-tool.js";
import { createPdf2MdTool } from "../tools/pdf2md-tool.js";
import { createSetupSettingsTool } from "../tools/setup-settings-tool.js";

const cleanupDirs = [];
const cleanupServices = [];

function mktemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function expectValidMcpContent(content) {
  expect(Array.isArray(content)).toBe(true);
  expect(content.length).toBeGreaterThan(0);
  for (const block of content) {
    expect(typeof block?.type).toBe("string");
    if (block.type === "text") {
      expect(typeof block.text).toBe("string");
      continue;
    }
    if (block.type === "image") {
      expect(typeof block.data).toBe("string");
      expect(block.data.length).toBeGreaterThan(0);
      expect(typeof block.mimeType).toBe("string");
      continue;
    }
    throw new Error(`Unexpected block type: ${block.type}`);
  }
}

async function runViaAdapter(toolDef, args = {}, ctx = {}) {
  const adapted = adaptCustomTool(toolDef, {
    createContext: () => ctx,
  });
  const result = await adapted.handler(args, {});
  expect(result).toBeTruthy();
  expectValidMcpContent(result.content);
  return result;
}

function expectToolSuccess(result) {
  expect(result?.isError).not.toBe(true);
  return result;
}

function createMemoryService(prefix = "tool-memory-") {
  const root = mktemp(prefix);
  const agentDir = path.join(root, "agents", "hanako");
  const userDir = path.join(root, "user");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  const service = new MemoryService({
    agentId: "hanako",
    agentDir,
    userDir,
    autoRunJobs: false,
  });
  cleanupServices.push(service);
  return service;
}

beforeAll(() => {
  loadLocale("en");
});

afterEach(() => {
  for (const service of cleanupServices.splice(0, cleanupServices.length)) {
    try { service.close(); } catch {}
  }
  for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("custom tools MCP output smoke test", () => {
  it("search_memory", async () => {
    const service = createMemoryService("tool-search-memory-");
    const evidence = service.recordEvidence({
      origin: "session",
      scope: "agent",
      sourceType: "test",
      sourceId: "custom-tools-smoke",
      sessionId: "session-1",
      content: "用户偏好先给结论再展开细节",
    });
    service.addFacts([{
      fact: "用户偏好先给结论再展开细节",
      tags: ["沟通", "偏好"],
      time: "2026-05-29T10:00",
      origin: "session",
      scope: "agent",
      source_refs: [{ layer: "evidence", id: evidence.id }],
    }]);
    const tool = createMemorySearchTool(service);
    const result = expectToolSuccess(await runViaAdapter(tool, { query: "结论", scope: "agent" }));
    expect(result.content[0].text).toContain("用户偏好先给结论");
  });

  it("pin_memory / unpin_memory", async () => {
    const service = createMemoryService("tool-pin-");
    const [pinTool, unpinTool] = createPinnedMemoryTools(service);
    expectToolSuccess(await runViaAdapter(pinTool, { content: "remember this" }));
    expect(service.listMarks({ activeOnly: true }).map((item) => item.text)).toContain("remember this");
    expectToolSuccess(await runViaAdapter(unpinTool, { keyword: "remember" }));
    expect(service.listMarks({ activeOnly: true })).toHaveLength(0);
  });

  it("recall_experience / record_experience", async () => {
    const service = createMemoryService("tool-exp-");
    const [recallTool, recordTool] = createExperienceTools(service);
    expectToolSuccess(await runViaAdapter(recordTool, {
      category: "coding",
      trigger: "修复回归 bug 后",
      wrong_path: "只手动验证，不补自动化测试",
      root_cause: "缺少回归测试会让同类问题复发",
      fix_steps: "为触发 bug 的路径补最小测试，再运行相关测试套件",
      validation: "相关测试失败后变绿，且覆盖新增断言",
    }));
    const result = expectToolSuccess(await runViaAdapter(recallTool, { category: "coding" }));
    expect(result.content[0].text).toContain("修复回归 bug 后");
    expect(result.content[0].text).toContain("wrong_path");
  });

  it("recall_experience / record_experience respect channel memory scope", async () => {
    const service = createMemoryService("tool-exp-channel-");
    const [recallTool, recordTool] = createExperienceTools(service);
    const channelCtx = { executionMode: "channel", memoryScope: "channel", channelName: "team" };

    expectToolSuccess(await runViaAdapter(recordTool, {
      category: "coordination",
      trigger: "频道内分工出现争议时",
      wrong_path: "把频道协作经验写入私聊 agent 经验",
      root_cause: "频道经验只对该频道协作上下文有效",
      fix_steps: "在频道上下文调用时写入 channel scope，并只在频道召回",
      validation: "私聊 recall 不显示该经验，频道 recall 可以显示",
    }, channelCtx));

    expect(service.listPlaybooks({ activeOnly: true, scope: "agent" })).toHaveLength(0);
    expect(service.listPlaybooks({ activeOnly: true, scope: "channel" })).toHaveLength(1);

    const privateResult = expectToolSuccess(await runViaAdapter(recallTool, { category: "coordination" }));
    expect(privateResult.content[0].text).not.toContain("频道内分工出现争议时");

    const channelResult = expectToolSuccess(await runViaAdapter(recallTool, { category: "coordination" }, channelCtx));
    expect(channelResult.content[0].text).toContain("频道内分工出现争议时");
  });

  it("cron", async () => {
    const dir = mktemp("tool-cron-");
    const store = new CronStore(path.join(dir, "cron-jobs.json"), path.join(dir, "cron-runs"));
    const tool = createCronTool(store, { autoApprove: true });
    await runViaAdapter(tool, { action: "list" });
  });

  it("present_files", async () => {
    const tool = createPresentFilesTool();
    await runViaAdapter(tool, {});
  });

  it("create_artifact", async () => {
    const tool = createArtifactTool();
    await runViaAdapter(tool, { type: "markdown", title: "Demo", content: "# demo" });
  });

  it("channel", async () => {
    const root = mktemp("tool-channel-");
    const channelsDir = path.join(root, "channels");
    const agentsDir = path.join(root, "agents");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "alpha"), { recursive: true });
    const tool = createChannelTool({
      channelsDir,
      agentsDir,
      agentId: "alpha",
      listAgents: () => [{ id: "alpha", name: "Alpha" }],
    });
    await runViaAdapter(tool, { action: "read", channel: "missing-channel" });
  });

  it("ask_agent", async () => {
    const tool = createAskAgentTool({
      agentId: "alpha",
      listAgents: () => [{ id: "alpha", name: "Alpha" }],
      engine: {},
    });
    await runViaAdapter(tool, { task: "do something" });
  });

  it("describe_images", async () => {
    const tool = createDescribeImagesTool({
      getSessionImages: () => [],
      getCurrentSessionPath: () => null,
      getLatestSessionImages: () => [],
      getSessionMessages: () => [],
      resolveVisionModel: () => ({}),
    });
    await runViaAdapter(tool, {});
  });

  it("generate_images", async () => {
    const tool = createGenerateImagesTool({
      getSessionImages: () => [],
      getCurrentSessionPath: () => null,
      getLatestSessionImages: () => [],
      getSessionMessages: () => [],
      resolveImageGenerationModel: () => ({ provider: "minimax" }),
    });
    await runViaAdapter(tool, {});
  });

  it("notify", async () => {
    const tool = createNotifyTool({
      onNotify: vi.fn(async () => ({ delivered: true })),
    });
    await runViaAdapter(tool, { title: "Title", body: "Body" });
  });

  it("setup_settings", async () => {
    const root = mktemp("tool-setup-settings-");
    const tool = createSetupSettingsTool({
      engine: {
        hanakoHome: root,
        userSkillsDir: path.join(root, "skills"),
        skillsDir: path.join(root, "skills"),
        agentDir: path.join(root, "agents", "hanako"),
      },
    });
    await runViaAdapter(tool, {
      dry_run: true,
      tutorial: JSON.stringify({
        mcp: {
          name: "demo",
          type: "stdio",
          command: "sh",
          args: ["-lc", "echo ok"],
        },
      }),
    });
  });

  it("pdf2md", async () => {
    const tool = createPdf2MdTool({ env: {} });
    await runViaAdapter(tool, { file_path: "/tmp/missing.pdf" });
  });
});
