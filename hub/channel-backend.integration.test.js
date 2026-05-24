import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAskAgentTool } from "../lib/tools/ask-agent-tool.js";
import { appendMessage, createChannel, parseChannel } from "../lib/channels/channel-store.js";
import { loadLocale } from "../server/i18n.js";

const { runtimeCtorMock } = vi.hoisted(() => ({
  runtimeCtorMock: vi.fn(),
}));

vi.mock("../core/claude-session-runtime.js", () => ({
  ClaudeSessionRuntime: class {
    constructor(opts) {
      return runtimeCtorMock(opts);
    }
  },
}));

import { Hub } from "./index.js";

const tempRoots = [];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMessages(channelFile, predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const parsed = parseChannel(fs.readFileSync(channelFile, "utf-8"));
    if (predicate(parsed.messages)) return parsed.messages;
    await wait(20);
  }
  const parsed = parseChannel(fs.readFileSync(channelFile, "utf-8"));
  throw new Error(`Timed out waiting for channel messages:\n${parsed.messages.map((m) => `${m.sender}: ${m.body}`).join("\n")}`);
}

function makeAgent(engine, id, name) {
  const agentDir = path.join(engine.agentsDir, id);
  fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "identity.md"), `# ${name}\n\n职责：${name} 测试角色\n`, "utf-8");
  fs.writeFileSync(path.join(agentDir, "ishiki.md"), `${name} 的测试意识。`, "utf-8");
  fs.writeFileSync(path.join(agentDir, "memory", "memory.md"), "", "utf-8");

  const agent = {
    agentDir,
    agentName: name,
    userName: "用户",
    personality: `${name} personality`,
    systemPrompt: `${name} system`,
    config: {
      locale: "zh-CN",
      agent: { name },
      user: { name: "用户" },
      desk: { home_folder: engine.workspaceDir },
      models: { overrides: null },
    },
    tools: [],
    refreshSystemPrompt: vi.fn(),
    buildSystemAppendPrompt: vi.fn(() => `${name} append`),
  };
  engine.agents.set(id, agent);
  return agent;
}

function setupBackend(agentDefs, channelId, opts = {}) {
  loadLocale("zh");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-channel-backend-"));
  tempRoots.push(root);

  const engine = {
    hanakoHome: root,
    productDir: root,
    agentsDir: path.join(root, "agents"),
    userDir: path.join(root, "user"),
    channelsDir: path.join(root, "channels"),
    workspaceDir: path.join(root, "workspace"),
    userName: "用户",
    agent: null,
    agents: new Map(),
    _eventBus: null,
    setEventBus(bus) {
      this._eventBus = bus;
    },
    getAgent(id) {
      return this.agents.get(id) || null;
    },
    listAgents() {
      return agentDefs.map(({ id, name }) => ({ id, name, identity: `${name} 测试角色` }));
    },
    getHomeFolder() {
      return this.workspaceDir;
    },
    createSessionContext() {
      return {
        resolveModel: () => ({ id: "fake-claude", contextWindow: 200_000 }),
      };
    },
    getAgentPermissionConfig() {
      return {
        sandbox: { mode: "standard", path_rules: [] },
        tools: { builtin_enabled: [], custom_enabled: ["ask_agent"] },
      };
    },
    getChannelMemoryEnabled() {
      return true;
    },
    resolveUtilityConfig() {
      return {};
    },
    setSessionPendingImages: vi.fn(),
    clearSessionPendingImages: vi.fn(),
    dispose: vi.fn(async () => {}),
  };

  fs.mkdirSync(engine.agentsDir, { recursive: true });
  fs.mkdirSync(engine.userDir, { recursive: true });
  fs.mkdirSync(engine.channelsDir, { recursive: true });
  fs.mkdirSync(engine.workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(engine.userDir, "user.md"), "用户偏好：需要简洁明确。", "utf-8");

  const channel = createChannel(engine.channelsDir, {
    id: channelId,
    name: channelId,
    members: agentDefs.map((a) => a.id),
    leaders: opts.leaders,
  });
  const actualChannelId = channel.id;

  for (const def of agentDefs) {
    const agent = makeAgent(engine, def.id, def.name);
    fs.writeFileSync(
      path.join(agent.agentDir, "channels.md"),
      `# 频道\n\n- ${actualChannelId} (last: never)\n`,
      "utf-8",
    );
  }
  engine.agent = engine.agents.get(agentDefs[0]?.id) || null;

  for (const [agentId, agent] of engine.agents) {
    agent.tools = [
      createAskAgentTool({
        agentId,
        listAgents: () => engine.listAgents(),
        engine,
      }),
    ];
  }

  const hub = new Hub({ engine });
  hub.channelRouter.start();
  hub.channelRouter.setupPostHandler();
  return { root, engine, hub, channelFile: channel.filePath, channelId: actualChannelId };
}

function getAgentIdFromSessionPath(sessionPath, engine) {
  const normalized = path.resolve(sessionPath || "");
  for (const [agentId, agent] of engine.agents) {
    const agentRoot = path.resolve(agent.agentDir) + path.sep;
    if (normalized.startsWith(agentRoot)) return agentId;
  }
  return "unknown";
}

function installScriptedRuntime(engine, handler) {
  const activeCounts = new Map();
  const maxActive = new Map();
  const calls = [];

  runtimeCtorMock.mockImplementation((opts) => {
    const agentId = getAgentIdFromSessionPath(opts.sessionPath, engine);
    let subscriber = null;
    const emit = (event) => subscriber?.(event);
    return {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => true),
      subscribe: vi.fn((cb) => {
        subscriber = cb;
        return () => {
          subscriber = null;
        };
      }),
      prompt: vi.fn(async (text) => {
        const active = (activeCounts.get(agentId) || 0) + 1;
        activeCounts.set(agentId, active);
        maxActive.set(agentId, Math.max(maxActive.get(agentId) || 0, active));
        calls.push({ agentId, text });
        try {
          const result = await handler({ agentId, text, engine });
          const output = String(result || "");
          emit({
            type: "assistant",
            message: { content: [{ type: "text", text: output }] },
          });
          emit({ type: "result", result: output });
        } finally {
          activeCounts.set(agentId, Math.max(0, (activeCounts.get(agentId) || 1) - 1));
        }
      }),
      sessionManager: {
        getSessionFile: () => opts.sessionPath,
        getSessionId: () => `${agentId}-session`,
        getCwd: () => engine.workspaceDir,
      },
      _emit: vi.fn(),
      _recordToolEvent: vi.fn(),
    };
  });

  return { calls, maxActive };
}

async function ask(engine, fromAgentId, args) {
  const tool = engine.getAgent(fromAgentId).tools.find((t) => t.name === "ask_agent");
  const result = await tool.execute(`test-${Date.now()}`, args);
  return result;
}

afterEach(async () => {
  vi.clearAllMocks();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("channel backend integration scenarios", () => {
  it("uses channel-scoped memory projection when preparing a channel reply", async () => {
    const fx = setupBackend([
      { id: "ideator", name: "Ideator" },
    ], "memory_scope");

    const agent = fx.engine.getAgent("ideator");
    const renderMemoryPrompt = vi.fn(() => "频道记忆");
    const renderProfilePrompt = vi.fn(() => "");
    agent.memoryService = {
      renderMemoryPrompt,
      renderProfilePrompt,
    };

    installScriptedRuntime(fx.engine, async () => "收到。");

    await fx.hub.channelRouter._executeCheck(
      "ideator",
      fx.channelId,
      [{ sender: "用户", body: "请直接回复这条消息", timestamp: "2026-05-24T10:00:00.000Z" }],
      [],
      { forceReply: true },
    );

    expect(renderMemoryPrompt).toHaveBeenCalledWith({ sourceScope: "channel" });
    expect(renderProfilePrompt).not.toHaveBeenCalled();
  });

  it("runs a brainstorm with nested asks and serializes a busy teammate revision queue", async () => {
    const fx = setupBackend([
      { id: "ideator", name: "Ideator" },
      { id: "critic", name: "Critic" },
      { id: "synth", name: "Synth" },
    ], "brainstorm");

    const seen = new Map();
    const runtimeStats = installScriptedRuntime(fx.engine, async ({ agentId, engine }) => {
      const n = (seen.get(agentId) || 0) + 1;
      seen.set(agentId, n);

      if (agentId === "ideator") {
        if (n > 1) {
          return "Ideator 监督总结：我已看到成员汇报，Synth 的修订版已经让方案收敛到满意状态。";
        }
        await ask(engine, "ideator", {
          agents: ["critic", "synth"],
          task: "围绕桌面 AI agent 的频道协作做头脑风暴：先提出方案，再互相挑错并收敛到满意版本。",
          channel: fx.channelId,
          supervise: true,
        });
        return "我先设定目标：请 Critic 和 Synth 并行发散，然后互相收敛。";
      }

      if (agentId === "critic") {
        await ask(engine, "critic", {
          agent: "synth",
          task: "根据 Critic 的反馈修订：方案必须包含用户价值、实现风险和一句口号。",
          channel: fx.channelId,
        });
        return "Critic 反馈：方向有潜力，但需要更聚焦用户价值和实现风险。我已请 Synth 修订。";
      }

      if (agentId === "synth" && n === 1) {
        await wait(120);
        return "Synth 初稿：做一个频道内的灵感白板，让 agent 自动补充角度。";
      }

      if (agentId === "synth" && n === 2) {
        return "Synth 修订版：用户价值是更快收敛共识；风险是多 agent 循环；口号：让想法自己开会。我满意这个版本。";
      }

      return `${agentId} done`;
    });

    appendMessage(fx.channelFile, "user", "@Ideator 组织一次头脑风暴，互相交流直到满意。");
    await fx.hub.triggerChannelTriage(fx.channelId, {
      source: "user",
      mentionedAgents: ["ideator"],
    });

    const messages = await waitForMessages(
      fx.channelFile,
      (items) =>
        items.some((m) => m.sender === "ideator" && m.body.includes("监督总结"))
        && items.filter((m) => m.sender === "synth").length === 2,
    );

    expect(messages.some((m) => m.sender === "ideator" && m.body.includes("@Critic"))).toBe(true);
    expect(messages.some((m) => m.sender === "critic" && m.body.includes("我已请 Synth 修订"))).toBe(true);
    expect(messages.filter((m) => m.sender === "synth")).toHaveLength(2);
    expect(runtimeStats.maxActive.get("synth")).toBe(1);

    await fx.hub.dispose();
  });

  it("lets a leader inspect reports and re-dispatch a correction after teammates finish", async () => {
    const fx = setupBackend([
      { id: "lead", name: "Leader" },
      { id: "research", name: "Research" },
      { id: "builder", name: "Builder" },
      { id: "reviewer", name: "Reviewer" },
    ], "delivery", { leaders: ["lead"] });

    const seen = new Map();
    const runtimeStats = installScriptedRuntime(fx.engine, async ({ agentId, engine }) => {
      const n = (seen.get(agentId) || 0) + 1;
      seen.set(agentId, n);

      if (agentId === "lead" && n === 1) {
        await ask(engine, "lead", {
          agents: ["research", "builder", "reviewer"],
          task: "准备频道异步派工方案：Research 找依据，Builder 给流程，Reviewer 找风险。",
          channel: fx.channelId,
        });
        return "Leader：我已分配三条线，等他们在频道汇报后我会检查是否需要纠偏。";
      }

      if (agentId === "research") {
        return "Research 汇报：tmux-style 的关键是 inbox、busy queue、完成后回频道汇报。";
      }

      if (agentId === "builder" && n === 1) {
        return "Builder 汇报：初版流程只覆盖派发，没有覆盖失败重试和验收标准。";
      }

      if (agentId === "reviewer") {
        return "Reviewer 汇报：发现缺口，Builder 的方案需要补失败兜底、队列上限和最终验收。";
      }

      if (agentId === "lead" && n === 2) {
        await ask(engine, "lead", {
          agent: "builder",
          task: "根据 Research 和 Reviewer 的汇报重做：补失败兜底、队列上限、最终验收标准。",
          channel: fx.channelId,
        });
        return "Leader：检查后发现 Builder 初版不够完整，已要求 Builder 按 Reviewer 的风险点返工。";
      }

      if (agentId === "builder" && n === 2) {
        return "Builder 修正版：新增失败兜底、队列上限、验收标准；每个被派发任务必须最终在频道交付可审查结果。";
      }

      if (agentId === "lead" && n === 3) {
        return "Leader 最终确认：Research、Reviewer、Builder 的输出都已闭环，当前方案可以接受。";
      }

      return `${agentId} done`;
    });

    appendMessage(fx.channelFile, "user", "@Leader 请派发任务并监督交付。");
    await fx.hub.triggerChannelTriage(fx.channelId, {
      source: "user",
      mentionedAgents: ["lead"],
    });

    await waitForMessages(
      fx.channelFile,
      (items) => items.some((m) => m.sender === "reviewer" && m.body.includes("最终验收")),
    );

    await waitForMessages(
      fx.channelFile,
      (items) => items.some((m) => m.sender === "builder" && m.body.includes("Builder 修正版")),
    );

    const messages = await waitForMessages(
      fx.channelFile,
      (items) => items.some((m) => m.sender === "lead" && m.body.includes("当前方案可以接受")),
    );

    expect(messages.some((m) => m.sender === "lead" && m.body.includes("@Research"))).toBe(true);
    expect(messages.some((m) => m.sender === "research" && m.body.includes("@Leader"))).toBe(true);
    expect(messages.some((m) => m.sender === "reviewer" && m.body.includes("@Leader"))).toBe(true);
    expect(messages.some((m) => m.sender === "lead" && m.body.includes("已要求 Builder"))).toBe(true);
    expect(messages.some((m) => m.sender === "builder" && m.body.includes("失败兜底"))).toBe(true);
    expect(runtimeStats.maxActive.get("builder")).toBe(1);

    await fx.hub.dispose();
  });
});
