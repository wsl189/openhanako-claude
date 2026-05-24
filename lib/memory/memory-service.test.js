import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_RANKING_VERSION, MemoryService } from "./memory-service.js";

const tempRoots = [];
let warnedNativeAbiMismatch = false;

function isNativeAbiMismatchError(err) {
  const msg = String(err?.message || "");
  return msg.includes("better_sqlite3.node") && msg.includes("NODE_MODULE_VERSION");
}

function createService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-memory-service-"));
  const agentDir = path.join(root, "agents", "hanako");
  const userDir = path.join(root, "user");
  tempRoots.push(root);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  try {
    return new MemoryService({
      agentId: "hanako",
      agentDir,
      userDir,
      autoRunJobs: false,
    });
  } catch (err) {
    if (isNativeAbiMismatchError(err)) {
      if (!warnedNativeAbiMismatch) {
        warnedNativeAbiMismatch = true;
        console.warn("[memory-service.test] skip due to better-sqlite3 ABI mismatch in current runtime");
      }
      return null;
    }
    throw err;
  }
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("memory-service", () => {
  it("rebuilds the current summary projection after archiving facts", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "archive-summary",
        sessionId: "session-1",
        content: "用户偏好简洁结论。",
      });
      service.addFacts([{
        fact: "用户偏好简洁结论",
        tags: ["偏好", "沟通"],
        time: "2026-05-10T09:00",
        origin: "session",
        scope: "agent",
        source_refs: [{ layer: "evidence", id: evidence.id }],
      }]);
      service.setSummaryProjection("stale summary still mentions 用户偏好简洁结论", { sourceScope: "agent" });

      const factId = service.getLibraryPage({ layer: "facts" }).items[0]?.id;
      expect(factId).toBeTruthy();

      service.archive([factId]);

      const summary = service.getSummaryProjection().content;
      const memoryPath = path.join(service.memoryDir, "memory.md");
      expect(summary).not.toContain("stale summary");
      expect(summary).not.toContain("用户偏好简洁结论");
      expect(fs.readFileSync(memoryPath, "utf-8")).toBe(summary);
    } finally {
      service.close();
    }
  });

  it("restores archived inactive items back to default view", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "restore-memory",
        sessionId: "session-restore",
        content: "用于恢复测试的事实",
      });
      service.addFacts([{
        fact: "用于恢复测试的事实",
        tags: ["恢复", "测试"],
        origin: "session",
        scope: "agent",
        source_refs: [{ layer: "evidence", id: evidence.id }],
      }]);

      const factId = service.getLibraryPage({ layer: "facts" }).items[0]?.id;
      expect(factId).toBeTruthy();
      service.archive([factId]);

      const inactive = service.getLibraryPage({ layer: "inactive" }).items;
      expect(inactive.length).toBeGreaterThan(0);
      const inactiveFact = inactive.find((item) => item.itemType === "fact");
      expect(inactiveFact?.id).toBeTruthy();

      const result = service.restore([inactiveFact.id]);
      expect(result).toMatchObject({
        restoredToDefaultView: true,
      });
      expect(result.affectedIds.length).toBeGreaterThan(0);

      const activeFacts = service.getLibraryPage({ layer: "facts" }).items;
      expect(activeFacts.some((item) => item.id === factId)).toBe(true);
      const nextInactive = service.getLibraryPage({ layer: "inactive" }).items;
      expect(nextInactive.some((item) => item.id === inactiveFact.id)).toBe(false);
    } finally {
      service.close();
    }
  });

  it("lists archived playbooks in the inactive layer and resolves their details", () => {
    const service = createService();
    if (!service) return;

    try {
      service.addPlaybook({
        category: "General",
        trigger: "保持现有方案",
        wrong_path: "没有问题时仍重写整套逻辑",
        root_cause: "把局部问题误判成全局设计问题",
        fix_steps: "先定位最小改动面，再补测试",
        validation: "确认原功能与修复点都通过",
      });
      const archived = service.addPlaybook({
        category: "Memory",
        trigger: "查看停用经验详情",
        wrong_path: "inactive 详情仍按 fact 解析",
        root_cause: "inactive id 没有保留底层类型",
        fix_steps: "对 inactive id 先解开类型再分派详情查询",
        validation: "停用 playbook 详情可正常打开",
      });
      service.archive([`playbook:${archived.id}`]);

      const page = service.getLibraryPage({ layer: "inactive", limit: 1 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        id: `inactive:playbook:${archived.id}`,
        layer: "inactive",
        itemType: "playbook",
      });

      const detail = service.getDetails(page.items[0].id, page.items[0].layer);
      expect(detail.layer).toBe("inactive");
      expect(detail.content).toContain("查看停用经验详情");
      expect(detail.auditTrail).toMatchObject({
        category: "Memory",
        active: false,
      });
    } finally {
      service.close();
    }
  });

  it("rebuilds the summary projection from imported facts when no summary is provided", () => {
    const service = createService();
    if (!service) return;

    try {
      const result = service.importBundle({
        facts: [{
          fact: "导入后仍应保留事实投影",
          tags: ["导入", "摘要"],
          time: "2026-05-11T14:30",
        }],
      });

      expect(result).toMatchObject({
        importedFacts: 1,
        queuedProfileImport: false,
      });
      expect(service.getSummaryProjection().content).toContain("导入后仍应保留事实投影");
      expect(fs.readFileSync(path.join(service.memoryDir, "memory.md"), "utf-8"))
        .toContain("导入后仍应保留事实投影");
    } finally {
      service.close();
    }
  });

  it("does not let an older queued profile import overwrite a newer profile version", async () => {
    const service = createService();
    if (!service) return;

    try {
      const initial = service.upsertProfile("初始画像");
      expect(initial).toMatchObject({ applied: true, version: 1 });

      const result = service.importBundle({
        profile: { content: "旧导入画像", version: 9 },
      });
      expect(result.queuedProfileImport).toBe(true);

      const newer = service.upsertProfile("较新人工画像");
      expect(newer).toMatchObject({ applied: true, version: 2 });

      await service.runJobs();

      expect(service.getProfile()).toMatchObject({
        content: "较新人工画像",
        version: 2,
      });

      const diagnostic = service.localDb.prepare(`
        SELECT event_type, payload
        FROM memory_diagnostics
        WHERE event_type = 'profile_job_skipped_newer_version'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get();
      expect(diagnostic?.event_type).toBe("profile_job_skipped_newer_version");
      expect(JSON.parse(diagnostic.payload)).toMatchObject({
        expectedVersion: 1,
        actualVersion: 2,
      });
    } finally {
      service.close();
    }
  });

  it("records retrieval log metadata and prunes expired rows", () => {
    const service = createService();
    if (!service) return;

    try {
      service.localDb.prepare(`
        INSERT INTO retrieval_logs (query, layer, ranking_version, config_snapshot, result_ids, sampled, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `).run(
        "old-query",
        "facts",
        "legacy",
        JSON.stringify({ samplingRate: 0.5 }),
        JSON.stringify(["fact:old"]),
        "2000-01-01T00:00:00.000Z",
      );

      service.recordRetrievalLog({
        query: "new-query",
        layer: "facts",
        configSnapshot: { strategy: "tags_then_fts" },
        resultIds: ["fact:1"],
      });

      const rows = service.localDb.prepare(`
        SELECT query, ranking_version, config_snapshot
        FROM retrieval_logs
        ORDER BY created_at ASC, id ASC
      `).all();

      expect(rows).toHaveLength(1);
      expect(rows[0].query).toBe("new-query");
      expect(rows[0].ranking_version).toBe(MEMORY_RANKING_VERSION);
      expect(JSON.parse(rows[0].config_snapshot)).toMatchObject({
        strategy: "ranked_blend",
        components: ["bm25", "tag", "entity", "recency", "confidence", "importance"],
        samplingRate: 1,
        retentionDays: 30,
      });
    } finally {
      service.close();
    }
  });

  it("auto-links playbooks to evidence when source refs are omitted", () => {
    const service = createService();
    if (!service) return;

    try {
      const playbook = service.addPlaybook({
        category: "Memory",
        trigger: "抽取经验",
        wrong_path: "只依赖 summary",
        root_cause: "没有 evidence 链接",
        fix_steps: "先落 evidence，再提经验",
        validation: "playbook 可追溯到 evidence",
      });
      expect(Array.isArray(playbook.sourceRefs)).toBe(true);
      expect(playbook.sourceRefs.length).toBeGreaterThan(0);
      expect(playbook.sourceRefs[0]).toMatchObject({ layer: "evidence" });
      const refId = playbook.sourceRefs[0].id;
      const row = service.localDb.prepare(`
        SELECT id
        FROM evidence
        WHERE id = ?
      `).get(refId);
      expect(row?.id).toBe(refId);
    } finally {
      service.close();
    }
  });

  it("normalizes legacy frontmatter mark text into readable content", () => {
    const service = createService();
    if (!service) return;

    try {
      const mark = service.addMark({
        text: `---\nname: user_name\ndescription: User's personal name\ntype: user\n---\n\n用户姓王，名字是老王。(persistent)`,
      });
      expect(mark.text).toBe("用户姓王，名字是老王。(persistent)");
    } finally {
      service.close();
    }
  });

  it("rejects playbook refs that point to missing evidence ids", () => {
    const service = createService();
    if (!service) return;

    try {
      expect(() => {
        service.addPlaybook({
          category: "Memory",
          trigger: "校验 source refs",
          wrong_path: "允许悬空 evidence 引用",
          root_cause: "未验证 source refs",
          fix_steps: "写入前检查 evidence id 是否存在",
          validation: "missing evidence 会报错",
          sourceRefs: [{ layer: "evidence", id: "evidence_missing" }],
        });
      }).toThrow("missing evidence source ref");
    } finally {
      service.close();
    }
  });

  it("rejects unsupported memory origin values", () => {
    const service = createService();
    if (!service) return;

    try {
      expect(() => {
        service.recordEvidence({
          origin: "legacy_origin",
          scope: "agent",
          sourceType: "test",
          sourceId: "invalid-origin",
          sessionId: "session-1",
          content: "should fail",
        });
      }).toThrow("must be one of");
    } finally {
      service.close();
    }
  });

  it("stores per-result ranking component scores in retrieval logs", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "rank-components",
        sessionId: "session-rank",
        content: "用户偏好简洁回答",
      });
      service.addFacts([{
        fact: "用户偏好简洁回答",
        tags: ["偏好", "回答风格"],
        time: "2026-05-20T08:00:00.000Z",
        origin: "session",
        scope: "agent",
        confidence: 0.9,
        importance: 0.8,
        source_refs: [{ layer: "evidence", id: evidence.id }],
      }]);

      const rows = service.searchIndex({
        query: "简洁回答",
        tags: ["偏好"],
        limit: 5,
      });
      expect(rows.length).toBeGreaterThan(0);

      const log = service.localDb.prepare(`
        SELECT config_snapshot
        FROM retrieval_logs
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get();
      const snapshot = JSON.parse(log.config_snapshot);
      expect(snapshot.finalOrder?.[0]?.componentScores).toMatchObject({
        bm25: expect.any(Number),
        tag: expect.any(Number),
        entity: expect.any(Number),
        recency: expect.any(Number),
        confidence: expect.any(Number),
        importance: expect.any(Number),
      });
    } finally {
      service.close();
    }
  });
});
