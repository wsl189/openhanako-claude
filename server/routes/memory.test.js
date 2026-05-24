import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import memoryRoute from "./memory.js";
import { MemoryService } from "../../lib/memory/memory-service.js";

function createEngine(overrides = {}) {
  return {
    currentAgentId: "agent-a",
    agent: {
      memoryMasterEnabled: true,
      resolvedMemoryModel: { model: "utility" },
    },
    getAgent: () => null,
    ...overrides,
  };
}

describe("/api/memory", () => {
  const apps = [];
  const originalFromEngine = MemoryService.fromEngine;

  afterEach(async () => {
    MemoryService.fromEngine = originalFromEngine;
    while (apps.length > 0) {
      const app = apps.pop();
      await app.close();
    }
  });

  it("uses the requested agent when computing memory status", async () => {
    const getStatus = vi.fn((opts) => opts);
    MemoryService.fromEngine = vi.fn(() => ({ getStatus }));

    const engine = createEngine({
      getAgent: (id) => (id === "agent-b"
        ? { memoryMasterEnabled: false, resolvedMemoryModel: null }
        : null),
    });
    const app = Fastify();
    apps.push(app);
    await app.register(memoryRoute, { engine });

    const res = await app.inject({ method: "GET", url: "/api/memory/status?agentId=agent-b" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: false,
      needsUtilityModel: true,
    });
    expect(getStatus).toHaveBeenCalledWith({
      enabled: false,
      needsUtilityModel: true,
    });
  });

  it("preserves full bundle imports and does not synchronously run cross-db jobs", async () => {
    const importBundle = vi.fn((payload) => ({
      importedFacts: Array.isArray(payload.facts) ? payload.facts.length : 0,
      importedEvidence: Array.isArray(payload.evidence) ? payload.evidence.length : 0,
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
    await app.register(memoryRoute, { engine: createEngine() });

    const payload = {
      version: 4,
      facts: [{ fact: "保留事实" }],
      evidence: [{ id: "evidence-1", content: "证据" }],
      profile: { content: "全局画像" },
      summary: { content: "摘要投影" },
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/memory/import?agentId=agent-b",
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(importBundle).toHaveBeenCalledWith(payload);
    expect(runJobs).not.toHaveBeenCalled();
  });

  it("rejects whole-list mark replacement on the new semantic endpoint", async () => {
    MemoryService.fromEngine = vi.fn(() => ({ getStatus: vi.fn() }));

    const app = Fastify();
    apps.push(app);
    await app.register(memoryRoute, { engine: createEngine() });

    const res = await app.inject({
      method: "PUT",
      url: "/api/memory/marks",
      payload: { items: [] },
    });

    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("whole-list mark replacement"),
    });
  });

  it("rejects whole-list playbook replacement on the new semantic endpoint", async () => {
    MemoryService.fromEngine = vi.fn(() => ({ getStatus: vi.fn() }));

    const app = Fastify();
    apps.push(app);
    await app.register(memoryRoute, { engine: createEngine() });

    const res = await app.inject({
      method: "PUT",
      url: "/api/memory/playbooks",
      payload: { items: [] },
    });

    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("whole-list playbook replacement"),
    });
  });

  it("restores archived memories through the semantic restore endpoint", async () => {
    const restore = vi.fn((ids) => ({ restoredToDefaultView: true, affectedIds: ids }));
    MemoryService.fromEngine = vi.fn(() => ({ restore }));

    const app = Fastify();
    apps.push(app);
    await app.register(memoryRoute, { engine: createEngine() });

    const res = await app.inject({
      method: "POST",
      url: "/api/memory/restore",
      payload: { ids: ["inactive:fact:1"] },
    });

    expect(res.statusCode).toBe(200);
    expect(restore).toHaveBeenCalledWith(["inactive:fact:1"]);
    expect(res.json()).toMatchObject({
      restoredToDefaultView: true,
      affectedIds: ["inactive:fact:1"],
    });
  });
});
