import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import configRoute from "./config.js";
import { MemoryService } from "../../lib/memory/memory-service.js";

function createEngine(overrides = {}) {
  return {
    currentAgentId: "hanako",
    agentDir: "/tmp/hanako-test/agents/hanako",
    agentsDir: "/tmp/hanako-test/agents",
    userDir: "/tmp/hanako-test/user",
    configPath: "/tmp/hanako-test/config.yaml",
    config: {},
    getAgent: () => null,
    readFavorites: () => [],
    getAllProviders: () => ({}),
    updateConfig: async () => {},
    emitDevLog: () => {},
    resolveUtilityConfig: () => ({}),
    patchExternalMcpServers: () => {},
    refreshCurrentSessionTools: async () => {},
    ...overrides,
  };
}

describe("/api/memories/import compatibility wrapper", () => {
  const apps = [];
  const originalFromEngine = MemoryService.fromEngine;

  afterEach(async () => {
    MemoryService.fromEngine = originalFromEngine;
    while (apps.length > 0) {
      const app = apps.pop();
      await app.close();
    }
  });

  it("forwards the full v4 bundle instead of truncating it to facts-only", async () => {
    const importBundle = vi.fn(() => ({
      importedFacts: 1,
      importedEvidence: 1,
      queuedProfileImport: true,
    }));
    const runJobs = vi.fn();
    MemoryService.fromEngine = vi.fn(() => ({
      importBundle,
      runJobs,
      _isDetached: false,
    }));

    const app = Fastify();
    apps.push(app);
    await app.register(configRoute, { engine: createEngine() });

    const payload = {
      version: 4,
      facts: [{ fact: "兼容导入事实" }],
      evidence: [{ id: "evidence-1", content: "兼容导入证据" }],
      playbooks: [{
        trigger: "兼容经验",
        wrongPath: "旧接口截断字段",
        rootCause: "compat wrapper 只看 facts",
        fixSteps: "保持 bundle 原样转发",
        validation: "playbook 字段仍可落库",
      }],
      profile: { content: "共享画像" },
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/memories/import?agentId=agent-b",
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(importBundle).toHaveBeenCalledWith(payload);
    expect(runJobs).not.toHaveBeenCalled();
    expect(res.json()).toMatchObject({
      ok: true,
      imported: 1,
      importedEvidence: 1,
      queuedProfileImport: true,
    });
  });
});
