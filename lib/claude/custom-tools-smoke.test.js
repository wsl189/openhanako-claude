import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadLocale } from "../../server/i18n.js";
import { adaptCustomTool } from "./custom-tool-adapter.js";
import { createMemorySearchTool } from "../memory/memory-search.js";
import { createPinnedMemoryTools } from "../tools/pinned-memory.js";
import { createExperienceTools } from "../tools/experience.js";
import { createCronTool } from "../tools/cron-tool.js";
import { CronStore } from "../desk/cron-store.js";
import { createPresentFilesTool } from "../tools/output-file-tool.js";
import { createArtifactTool } from "../tools/artifact-tool.js";
import { createChannelTool } from "../tools/channel-tool.js";
import { createAskAgentTool } from "../tools/ask-agent-tool.js";
import { createBrowserTool } from "../tools/browser-tool.js";
import { createDescribeImagesTool } from "../tools/describe-images-tool.js";
import { createGenerateImagesTool } from "../tools/generate-images-tool.js";
import { createNotifyTool } from "../tools/notify-tool.js";
import { createPdf2MdTool } from "../tools/pdf2md-tool.js";

const cleanupDirs = [];

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

async function runViaAdapter(toolDef, args = {}) {
  const adapted = adaptCustomTool(toolDef);
  const result = await adapted.handler(args, {});
  expect(result).toBeTruthy();
  expectValidMcpContent(result.content);
  return result;
}

beforeAll(() => {
  loadLocale("en");
});

afterEach(() => {
  for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("custom tools MCP output smoke test", () => {
  it("search_memory", async () => {
    const tool = createMemorySearchTool({ size: 0 });
    await runViaAdapter(tool, { query: "hello" });
  });

  it("pin_memory / unpin_memory", async () => {
    const agentDir = mktemp("tool-pin-");
    const [pinTool, unpinTool] = createPinnedMemoryTools(agentDir);
    await runViaAdapter(pinTool, { content: "remember this" });
    await runViaAdapter(unpinTool, { keyword: "remember" });
  });

  it("recall_experience / record_experience", async () => {
    const agentDir = mktemp("tool-exp-");
    const [recallTool, recordTool] = createExperienceTools(agentDir);
    await runViaAdapter(recallTool, {});
    await runViaAdapter(recordTool, { category: "coding", content: "write tests for regressions" });
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

  it("browser", async () => {
    const tool = createBrowserTool();
    await runViaAdapter(tool, { action: "invalid-action" });
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

  it("pdf2md", async () => {
    const tool = createPdf2MdTool({ env: {} });
    await runViaAdapter(tool, { file_path: "/tmp/missing.pdf" });
  });
});
