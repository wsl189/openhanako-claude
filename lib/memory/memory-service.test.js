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
  it("repairs facts FTS artifacts once when a write reports malformed sqlite data", () => {
    const service = createService();
    if (!service) return;

    try {
      let attempts = 0;
      let repairs = 0;
      const originalRepair = service.factStore.repairMalformedFtsArtifacts.bind(service.factStore);
      service.factStore.repairMalformedFtsArtifacts = () => {
        repairs += 1;
      };
      try {
        const result = service._runWithMalformedFtsRepair(() => {
          attempts += 1;
          if (attempts === 1) throw new Error("database disk image is malformed");
          return "ok";
        });
        expect(result).toBe("ok");
        expect(attempts).toBe(2);
        expect(repairs).toBe(1);
      } finally {
        service.factStore.repairMalformedFtsArtifacts = originalRepair;
      }
    } finally {
      service.close();
    }
  });

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

  it("removes inactive facts from storage instead of only hiding them again", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "remove-fact",
        sessionId: "session-remove",
        content: "用于彻底删除测试的事实",
      });
      service.addFacts([{
        fact: "用于彻底删除测试的事实",
        tags: ["删除", "测试"],
        origin: "session",
        scope: "agent",
        source_refs: [{ layer: "evidence", id: evidence.id }],
      }]);

      const factId = service.getLibraryPage({ layer: "facts" }).items[0]?.id;
      expect(factId).toBeTruthy();
      service.archive([factId]);

      const inactiveFact = service.getLibraryPage({ layer: "inactive" }).items.find((item) => item.itemType === "fact");
      expect(inactiveFact?.id).toBeTruthy();

      const result = service.remove([inactiveFact.id]);
      expect(result).toMatchObject({
        removedFromArchive: true,
      });
      expect(result.affectedIds).toContain(inactiveFact.id);

      expect(service.getLibraryPage({ layer: "facts" }).items.some((item) => item.id === factId)).toBe(false);
      expect(service.getLibraryPage({ layer: "inactive" }).items.some((item) => item.id === inactiveFact.id)).toBe(false);
      expect(() => service.getDetails(factId, "fact")).toThrow(/fact not found/);
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

  it("returns related memory items for cross-layer drill-down", () => {
    const service = createService();
    if (!service) return;

    try {
      const episode = service.upsertEpisode({
        origin: "session",
        scope: "agent",
        sessionId: "session-related",
        anchorText: "讨论徐工机械持仓与后续动作",
      });
      const evidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "related-items",
        sessionId: "session-related",
        episodeId: episode.id,
        content: "当前仍持有徐工机械，需要继续跟踪仓位状态。",
      });
      service.addFacts([
        {
          fact: "当前仍持有徐工机械",
          tags: ["股票", "持仓"],
          origin: "session",
          scope: "agent",
          memory_kind: "state",
          timeliness: "stateful",
          state_key: "投资组合/徐工机械/持仓状态",
          source_refs: [
            { layer: "evidence", id: evidence.id },
            { layer: "episode", id: episode.id },
          ],
        },
        {
          fact: "需要继续跟踪徐工机械仓位状态",
          tags: ["股票", "跟踪"],
          origin: "session",
          scope: "agent",
          memory_kind: "state",
          timeliness: "stateful",
          state_key: "投资组合/徐工机械/持仓状态",
          source_refs: [{ layer: "evidence", id: evidence.id }],
        },
      ]);
      service.addPlaybook({
        category: "Memory",
        trigger: "追查状态事实来源",
        wrong_path: "只看单条事实",
        root_cause: "没有沿 evidence 和 episode 向下钻取",
        fix_steps: "查看关联证据、锚点和同 state_key 事实",
        validation: "能从事实详情继续打开相关记忆",
        sourceRefs: [{ layer: "evidence", id: evidence.id }],
      });

      const factId = service.getLibraryPage({ layer: "inactive" }).items.find((item) => item.preview.includes("当前仍持有徐工机械"))?.id;
      expect(factId).toBeTruthy();

      const detail = service.getDetails(factId, "fact");
      const related = Array.isArray(detail.relatedItems) ? detail.relatedItems : [];
      const entityLinks = Array.isArray(detail.entityLinks) ? detail.entityLinks : [];

      expect(related.some((item) => item.id === `evidence:${evidence.id}` && item.reason === "source_evidence")).toBe(true);
      expect(related.some((item) => item.id === `episode:${episode.id}` && item.reason === "source_episode")).toBe(true);
      expect(related.some((item) => item.itemType === "fact" && item.reason === "same_state_key")).toBe(true);
      expect(related.some((item) => item.itemType === "playbook" && item.reason === "shared_source_refs")).toBe(true);
      expect(entityLinks.some((item) => item.kind === "state" && item.value === "投资组合/徐工机械/持仓状态")).toBe(true);
    } finally {
      service.close();
    }
  });

  it("lists archive candidates across all active memory layers", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "archive-candidates-evidence",
        sessionId: "session-candidates",
        content: "归档候选中的证据",
      });
      const episode = service.upsertEpisode({
        origin: "session",
        scope: "agent",
        sessionId: "session-candidates",
        anchorText: "归档候选中的事件锚点",
        episodeKind: "conversation",
      });
      service.addFacts([{
        fact: "归档候选中的事实",
        tags: ["归档", "候选"],
        origin: "session",
        scope: "agent",
        source_refs: [{ layer: "evidence", id: evidence.id }],
      }]);
      const mark = service.addMark({ text: "归档候选中的置顶记忆" });
      const playbook = service.addPlaybook({
        category: "Memory",
        trigger: "归档候选中的经验",
        wrong_path: "只归档部分层",
        root_cause: "前后端候选集合不一致",
        fix_steps: "按层统一归档 candidate 枚举",
        validation: "事实、锚点、证据、置顶、经验都能一起归档",
      });

      const ids = new Set(service.listArchiveCandidateIds());
      const factId = service.getLibraryPage({ layer: "facts" }).items[0]?.id;

      expect(ids.has(factId)).toBe(true);
      expect(ids.has(`episode:${episode.id}`)).toBe(true);
      expect(ids.has(`evidence:${evidence.id}`)).toBe(true);
      expect(ids.has(`mark:${mark.id}`)).toBe(true);
      expect(ids.has(`playbook:${playbook.id}`)).toBe(true);
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

  it("rebuilds the channel summary projection from imported channel-scoped memory when no channel summary is provided", () => {
    const service = createService();
    if (!service) return;

    try {
      const result = service.importBundle({
        facts: [{
          fact: "频道决定由 Alice 负责 API 重构",
          tags: ["API", "分工"],
          time: "2026-05-11T14:30",
          scope: "channel",
          origin: "channel",
          memory_kind: "decision",
          decision_key: "项目/API/owner",
        }],
        playbooks: [{
          category: "Channel",
          trigger: "频道协作规则",
          wrongPath: "把频道经验混入私聊经验",
          rootCause: "没有 scope 隔离",
          fixSteps: "按 scope 写入和投影",
          validation: "频道经验只出现在 channel projection",
          scope: "channel",
          origin: "channel",
        }],
      });

      expect(result).toMatchObject({
        importedFacts: 1,
        importedPlaybooks: 1,
      });
      expect(service.getSummaryProjection({ sourceScope: "channel" }).content).toContain("Alice 负责 API 重构");
      expect(service.getSummaryProjection({ sourceScope: "channel" }).content).toContain("频道协作规则");
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
        strategy: "tags_then_fts",
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
        intent_match: expect.any(Number),
        scope_match: expect.any(Number),
        freshness_guard: expect.any(Number),
      });
    } finally {
      service.close();
    }
  });

  it("lists retrieval logs with resolved result previews", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "retrieval-list",
        sessionId: "session-retrieval-list",
        content: "当前仍持有徐工机械",
      });
      service.addFacts([{
        fact: "当前仍持有徐工机械",
        tags: ["股票", "持仓"],
        origin: "session",
        scope: "agent",
        memory_kind: "state",
        timeliness: "stateful",
        state_key: "投资组合/徐工机械/持仓状态",
        source_refs: [{ layer: "evidence", id: evidence.id }],
      }]);

      service.searchIndex({
        query: "现在还持有徐工机械吗",
        tags: ["持仓"],
        intent: "state",
        limit: 5,
      });

      const logs = service.listRetrievalLogs({ limit: 5, layer: "facts", query: "徐工机械" });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toMatchObject({
        layer: "facts",
      });
      expect(logs[0].results[0]).toMatchObject({
        id: expect.stringMatching(/^fact:/),
        preview: "当前仍持有徐工机械",
        componentScores: expect.any(Object),
      });
    } finally {
      service.close();
    }
  });

  it("applies extraction bundles across profile, state, decision, playbook, and episode layers", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "bundle-route",
        sessionId: "session-bundle",
        content: "用户长期偏好直接结论；当前持有贵州茅台；本周决定继续长期持有。",
      });

      const result = service.applyExtractionBundle({
        facts: [
          {
            fact: "用户长期偏好直接给结论",
            tags: ["偏好", "沟通"],
            memory_kind: "profile_preference",
            timeliness: "persistent",
          },
          {
            fact: "当前持有贵州茅台",
            tags: ["贵州茅台", "持仓"],
            memory_kind: "state",
            state_key: "投资组合/贵州茅台/持仓状态",
            timeliness: "stateful",
          },
          {
            fact: "本周决定继续长期持有贵州茅台",
            tags: ["贵州茅台", "决策"],
            memory_kind: "decision",
            decision_key: "投资组合/贵州茅台/长期策略",
            timeliness: "persistent",
          },
        ],
        playbooks: [{
          category: "Memory",
          trigger: "处理重复记忆抽取",
          wrong_path: "只记事实不记根因",
          root_cause: "缺少分类路由",
          fix_steps: "先分类，再决定写入层",
          validation: "提取结果能稳定分流到 facts 和 playbooks",
        }],
        episode_patch: {
          episode_kind: "decision_process",
          tags: ["投资", "偏好", "决策"],
          anchor_text: "用户更新了持仓并确认了继续长期持有的决定。",
        },
      }, {
        origin: "session",
        scope: "agent",
        sessionId: "session-bundle",
        sourceRefs: [{ layer: "evidence", id: evidence.id }],
      });

      expect(result).toMatchObject({
        factsAdded: 3,
        playbooksAdded: 1,
      });

      const profileFacts = service.factStore.getAll().filter((row) => row.scope === "profile");
      expect(profileFacts.some((row) => row.memory_kind === "profile_preference")).toBe(true);

      const episode = service.getEpisodeBySession("session-bundle");
      expect(episode).toMatchObject({
        episodeKind: "decision_process",
      });
      expect(episode.tags).toContain("投资");

      const profileProjection = service.renderProfilePrompt();
      expect(profileProjection).toContain("用户长期偏好直接给结论");
      expect(service.listPlaybooks({ activeOnly: true })).toHaveLength(1);
    } finally {
      service.close();
    }
  });

  it("routes retrieval by intent and scope", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "search-routing",
        sessionId: "session-search",
        content: "用户偏好简洁回答；当前持有徐工机械；已决定继续关注工程机械板块。",
      });
      service.addFacts([
        {
          fact: "用户偏好简洁回答",
          tags: ["偏好", "回答风格"],
          time: "2026-05-20T08:00:00.000Z",
          origin: "session",
          scope: "profile",
          memory_kind: "profile_preference",
          source_refs: [{ layer: "evidence", id: evidence.id }],
        },
        {
          fact: "当前持有徐工机械",
          tags: ["股票", "持仓"],
          time: "2026-05-21T08:00:00.000Z",
          origin: "session",
          scope: "agent",
          memory_kind: "state",
          timeliness: "stateful",
          state_key: "投资组合/徐工机械/持仓状态",
          source_refs: [{ layer: "evidence", id: evidence.id }],
        },
        {
          fact: "已决定继续关注工程机械板块",
          tags: ["工程机械", "决策"],
          time: "2026-05-22T08:00:00.000Z",
          origin: "session",
          scope: "agent",
          memory_kind: "decision",
          decision_key: "行业/工程机械/关注策略",
          source_refs: [{ layer: "evidence", id: evidence.id }],
        },
      ]);
      service.addPlaybook({
        category: "Memory",
        trigger: "修复状态记忆召回",
        wrong_path: "忽略时效性",
        root_cause: "只按相似度排序",
        fix_steps: "增加 intent 和 freshness guard",
        validation: "state 查询优先最新状态",
        sourceRefs: [{ layer: "evidence", id: evidence.id }],
      });

      const profileResults = service.searchMemories({
        query: "偏好 简洁",
        intent: "profile",
        scope: "profile",
        limit: 5,
      });
      expect(profileResults[0]).toMatchObject({
        itemType: "fact",
        scope: "profile",
      });

      const stateResults = service.searchMemories({
        query: "现在持有吗",
        tags: ["持仓"],
        intent: "state",
        scope: "agent",
        limit: 5,
      });
      expect(stateResults[0]).toMatchObject({
        itemType: "fact",
        memory_kind: "state",
      });

      const playbookResults = service.searchMemories({
        query: "修复状态记忆召回",
        intent: "playbook",
        layers: "playbooks",
        limit: 5,
      });
      expect(playbookResults[0]).toMatchObject({
        itemType: "playbook",
      });
    } finally {
      service.close();
    }
  });

  it("records routed retrieval logs for playbook-only searches", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "playbook-log",
        sessionId: "session-playbook-log",
        content: "状态召回误用了旧事实，需要增加 freshness guard。",
      });
      service.addPlaybook({
        category: "Memory",
        trigger: "状态召回误用旧事实",
        wrong_path: "只按相似度排序",
        root_cause: "没有时效保护",
        fix_steps: "增加 freshness guard 和 intent 路由",
        validation: "state 查询优先返回最新状态",
        sourceRefs: [{ layer: "evidence", id: evidence.id }],
      });

      const results = service.searchMemories({
        query: "状态召回误用旧事实",
        intent: "playbook",
        layers: "playbooks",
        limit: 5,
      });
      expect(results[0]).toMatchObject({
        itemType: "playbook",
      });

      const log = service.localDb.prepare(`
        SELECT layer, config_snapshot, result_ids
        FROM retrieval_logs
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get();
      expect(log.layer).toBe("playbooks");
      expect(JSON.parse(log.config_snapshot)).toMatchObject({
        strategy: "routed_layers",
        requestedIntent: "playbook",
        resolvedIntent: "playbook",
        requestedLayer: "playbooks",
      });
      expect(JSON.parse(log.result_ids)[0]).toMatch(/^playbook:/);
    } finally {
      service.close();
    }
  });

  it("records structured entity matches in retrieval audit snapshots", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "structured-audit",
        sessionId: "session-structured-audit",
        content: "当前仍持有徐工机械，需要继续跟踪仓位状态。",
      });
      service.addFacts([{
        fact: "当前仍持有徐工机械",
        tags: ["股票", "持仓"],
        origin: "session",
        scope: "agent",
        memory_kind: "state",
        timeliness: "stateful",
        state_key: "投资组合/徐工机械/持仓状态",
        subject_id: "portfolio/xcmg",
        source_refs: [{ layer: "evidence", id: evidence.id }],
      }]);

      const results = service.searchMemories({
        query: "徐工机械 持仓状态",
        intent: "state",
        scope: "agent",
        limit: 5,
      });
      expect(results[0]).toMatchObject({
        itemType: "fact",
      });

      const log = service.localDb.prepare(`
        SELECT config_snapshot
        FROM retrieval_logs
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get();
      const snapshot = JSON.parse(log.config_snapshot);
      expect(snapshot.finalOrder[0].componentScores.structured_entity).toBeGreaterThan(0);
      expect(snapshot.finalOrder[0].entityMatches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "state" }),
        ]),
      );
    } finally {
      service.close();
    }
  });

  it("auto-routes retrieval intent from the query and records the resolved route", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "search-auto-routing",
        sessionId: "session-auto-search",
        content: "用户偏好简洁回答；当前持有徐工机械；已决定继续关注工程机械板块。",
      });
      service.addFacts([
        {
          fact: "用户偏好简洁回答",
          tags: ["偏好", "回答风格"],
          time: "2026-05-20T08:00:00.000Z",
          origin: "session",
          scope: "profile",
          memory_kind: "profile_preference",
          source_refs: [{ layer: "evidence", id: evidence.id }],
        },
        {
          fact: "当前持有徐工机械",
          tags: ["股票", "持仓"],
          time: "2026-05-21T08:00:00.000Z",
          origin: "session",
          scope: "agent",
          memory_kind: "state",
          timeliness: "stateful",
          state_key: "投资组合/徐工机械/持仓状态",
          source_refs: [{ layer: "evidence", id: evidence.id }],
        },
        {
          fact: "已决定继续关注工程机械板块",
          tags: ["工程机械", "决策"],
          time: "2026-05-22T08:00:00.000Z",
          origin: "session",
          scope: "agent",
          memory_kind: "decision",
          decision_key: "行业/工程机械/关注策略",
          source_refs: [{ layer: "evidence", id: evidence.id }],
        },
      ]);

      const stateResults = service.searchMemories({
        query: "现在还持有徐工机械吗",
        limit: 5,
      });
      expect(stateResults[0]).toMatchObject({
        itemType: "fact",
        memory_kind: "state",
      });

      const profileResults = service.searchMemories({
        query: "你了解我什么偏好",
        limit: 5,
      });
      expect(profileResults[0]).toMatchObject({
        itemType: "fact",
        scope: "profile",
      });

      const log = service.localDb.prepare(`
        SELECT config_snapshot
        FROM retrieval_logs
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get();
      const snapshot = JSON.parse(log.config_snapshot);
      expect(snapshot).toMatchObject({
        requestedIntent: "auto",
        resolvedIntent: "profile",
        requestedScope: "auto",
        resolvedScope: "profile",
      });
    } finally {
      service.close();
    }
  });

  it("keeps agent/profile and channel projections separated by scope", () => {
    const service = createService();
    if (!service) return;

    try {
      const agentEvidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "agent-scope",
        sessionId: "session-agent",
        content: "用户偏好先给结论。",
      });
      const channelEvidence = service.recordEvidence({
        origin: "channel",
        scope: "channel",
        sourceType: "test",
        sourceId: "channel-scope",
        sessionId: "channel-project",
        content: "频道内决定由 Alice 负责 API 重构。",
      });

      service.addFacts([
        {
          fact: "用户偏好先给结论",
          tags: ["偏好", "沟通"],
          origin: "session",
          scope: "profile",
          memory_kind: "profile_preference",
          source_refs: [{ layer: "evidence", id: agentEvidence.id }],
        },
        {
          fact: "频道决定由 Alice 负责 API 重构",
          tags: ["API", "分工"],
          origin: "channel",
          scope: "channel",
          memory_kind: "decision",
          decision_key: "项目/API/owner",
          source_refs: [{ layer: "evidence", id: channelEvidence.id }],
        },
      ]);
      service.addPlaybook({
        category: "Channel",
        trigger: "频道协作规则",
        wrong_path: "把频道经验混入私聊经验",
        root_cause: "没有 scope 隔离",
        fix_steps: "给 playbook 增加 scope 并按 scope 投影",
        validation: "频道经验只出现在 channel scope",
        origin: "channel",
        scope: "channel",
        sourceRefs: [{ layer: "evidence", id: channelEvidence.id }],
      });

      const agentProjection = service.rebuildSummaryProjection({ sourceScope: "agent" }).content;
      const channelProjection = service.rebuildSummaryProjection({ sourceScope: "channel" }).content;

      expect(agentProjection).toContain("用户偏好先给结论");
      expect(agentProjection).not.toContain("Alice 负责 API 重构");
      expect(agentProjection).not.toContain("频道协作规则");
      expect(channelProjection).toContain("Alice 负责 API 重构");
      expect(channelProjection).not.toContain("用户偏好先给结论");
      expect(channelProjection).toContain("频道协作规则");
    } finally {
      service.close();
    }
  });

  it("does not reuse agent summary sections when rebuilding channel projections", () => {
    const service = createService();
    if (!service) return;

    try {
      service.setSummaryProjection(`## 重要事实

### 当前状态
- 当前持有徐工机械

## 今天

[10:00] 用户更新了徐工机械持仓状态。

## 最近一周

本周聚焦工程机械板块。

## 长期情况

长期关注工程机械。`, { sourceScope: "agent" });

      const evidence = service.recordEvidence({
        origin: "channel",
        scope: "channel",
        sourceType: "test",
        sourceId: "channel-rebuild-scope",
        sessionId: "channel-memory",
        content: "频道决定由 Alice 负责 API 重构。",
      });
      service.addFacts([{
        fact: "频道决定由 Alice 负责 API 重构",
        tags: ["API", "分工"],
        origin: "channel",
        scope: "channel",
        memory_kind: "decision",
        decision_key: "项目/API/owner",
        source_refs: [{ layer: "evidence", id: evidence.id }],
      }]);

      const channelProjection = service.rebuildSummaryProjection({ sourceScope: "channel" }).content;
      expect(channelProjection).toContain("Alice 负责 API 重构");
      expect(channelProjection).not.toContain("徐工机械");
      expect(channelProjection).not.toContain("工程机械板块");
      expect(channelProjection).not.toContain("长期关注工程机械");
    } finally {
      service.close();
    }
  });

  it("projects verified experience even when no active facts exist", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "playbook-only-projection",
        sessionId: "session-playbook-only",
        content: "状态召回误用了旧事实，需要增加 freshness guard。",
      });
      service.addPlaybook({
        category: "Memory",
        trigger: "状态召回误用旧事实",
        wrong_path: "只按相似度排序",
        root_cause: "没有时效保护",
        fix_steps: "增加 freshness guard 和 intent 路由",
        validation: "state 查询优先返回最新状态",
        sourceRefs: [{ layer: "evidence", id: evidence.id }],
      });

      const projection = service.rebuildSummaryProjection({ sourceScope: "agent" }).content;
      expect(projection).toContain("已验证经验");
      expect(projection).toContain("状态召回误用旧事实");
    } finally {
      service.close();
    }
  });

  it("stops treating legacy profile text as the truth source once structured profile memory exists", () => {
    const service = createService();
    if (!service) return;

    try {
      service.upsertProfile("旧人工画像：用户喜欢长篇铺垫。");
      const evidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "profile-projection-source",
        sessionId: "session-profile-source",
        content: "用户长期偏好先给结论再展开分析。",
      });
      service.addFacts([{
        fact: "用户长期偏好先给结论再展开分析",
        tags: ["偏好", "沟通"],
        origin: "session",
        scope: "profile",
        memory_kind: "profile_preference",
        source_refs: [{ layer: "evidence", id: evidence.id }],
      }]);

      const projection = service.renderProfilePrompt();
      expect(projection).toContain("用户长期偏好先给结论再展开分析");
      expect(projection).not.toContain("旧人工画像");
    } finally {
      service.close();
    }
  });

  it("exposes profile blocks while keeping manual profile supplemental", () => {
    const service = createService();
    if (!service) return;

    try {
      service.upsertProfile("旧人工画像：用户喜欢长篇铺垫。");
      const evidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "profile-blocks",
        sessionId: "session-profile-blocks",
        content: "用户长期偏好先给结论，并明确禁止在回答中自造事实。",
      });
      service.addFacts([
        {
          fact: "用户长期偏好先给结论",
          tags: ["偏好", "沟通"],
          origin: "session",
          scope: "profile",
          memory_kind: "profile_preference",
          source_refs: [{ layer: "evidence", id: evidence.id }],
        },
        {
          fact: "禁止在回答中自造事实",
          tags: ["约束", "回答"],
          origin: "session",
          scope: "profile",
          memory_kind: "profile_constraint",
          source_refs: [{ layer: "evidence", id: evidence.id }],
        },
      ]);
      service.addMark({ text: "称呼用户时优先直接进入结论" });

      const promptBlocks = service.getProfileBlocks();
      expect(promptBlocks.map((item) => item.kind)).toEqual(
        expect.arrayContaining(["preferences", "constraints", "pinned"]),
      );
      expect(promptBlocks.some((item) => item.kind === "manual_profile")).toBe(false);

      const viewerBlocks = service.getProfileBlocks({ includeManualSupplement: true });
      expect(viewerBlocks.some((item) => item.kind === "manual_profile")).toBe(true);
      expect(service.renderProfilePrompt({ includePinned: false })).not.toContain("置顶记忆");
    } finally {
      service.close();
    }
  });

  it("builds reflection blocks from active state, decisions, and playbooks", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "reflection-blocks",
        sessionId: "session-reflection-blocks",
        content: "当前仍持有徐工机械，并决定继续关注工程机械板块。",
      });
      service.addFacts([
        {
          fact: "当前仍持有徐工机械",
          tags: ["股票", "持仓"],
          origin: "session",
          scope: "agent",
          memory_kind: "state",
          timeliness: "stateful",
          state_key: "投资组合/徐工机械/持仓状态",
          source_refs: [{ layer: "evidence", id: evidence.id }],
        },
        {
          fact: "决定继续关注工程机械板块",
          tags: ["工程机械", "决策"],
          origin: "session",
          scope: "agent",
          memory_kind: "decision",
          decision_key: "行业/工程机械/关注策略",
          source_refs: [{ layer: "evidence", id: evidence.id }],
        },
      ]);
      service.addPlaybook({
        category: "Memory",
        trigger: "状态召回误用旧事实",
        wrong_path: "只按相似度排序",
        root_cause: "没有时效保护",
        fix_steps: "增加 freshness guard",
        validation: "state 查询优先返回最新状态",
        sourceRefs: [{ layer: "evidence", id: evidence.id }],
      });

      const projection = service.getReflectionProjection();
      expect(projection.blocks.map((item) => item.kind)).toEqual(
        expect.arrayContaining(["state_watch", "decision_watch", "verified_experience"]),
      );
      expect(service.renderReflectionPrompt()).toContain("近期状态关注点");
      expect(service.renderReflectionPrompt()).toContain("已验证经验");
    } finally {
      service.close();
    }
  });

  it("keeps agent and channel summary projections isolated and does not overwrite agent memory.md", () => {
    const service = createService();
    if (!service) return;

    try {
      service.setSummaryProjection("## 重要事实\n\nagent-memory", { sourceScope: "agent" });
      service.setSummaryProjection("## 重要事实\n\nchannel-memory", { sourceScope: "channel" });

      expect(service.renderMemoryPrompt()).toContain("agent-memory");
      expect(service.renderMemoryPrompt({ sourceScope: "channel" })).toContain("channel-memory");
      expect(service.getSummaryProjection().sourceScope).toBe("agent");
      expect(service.getSummaryProjection({ sourceScope: "channel" }).sourceScope).toBe("channel");
      expect(fs.readFileSync(path.join(service.memoryDir, "memory.md"), "utf-8")).toContain("agent-memory");
      expect(fs.readFileSync(path.join(service.memoryDir, "memory.md"), "utf-8")).not.toContain("channel-memory");
    } finally {
      service.close();
    }
  });

  it("refreshes the channel summary projection when channel-scoped playbooks are archived, restored, and removed", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "channel",
        scope: "channel",
        sourceType: "test",
        sourceId: "channel-playbook-summary-refresh",
        sessionId: "channel-playbook-summary-refresh",
        content: "频道协作规则需要单独留在 channel projection。",
      });
      const playbook = service.addPlaybook({
        category: "Channel",
        trigger: "频道协作规则",
        wrong_path: "把频道经验混入私聊经验",
        root_cause: "没有 scope 隔离",
        fix_steps: "给 playbook 增加 scope 并按 scope 投影",
        validation: "频道经验只出现在 channel projection",
        origin: "channel",
        scope: "channel",
        sourceRefs: [{ layer: "evidence", id: evidence.id }],
      });

      expect(service.rebuildSummaryProjection({ sourceScope: "channel" }).content).toContain("频道协作规则");

      service.archive([`playbook:${playbook.id}`]);
      expect(service.getSummaryProjection({ sourceScope: "channel" }).content).not.toContain("频道协作规则");

      const archived = service.getLibraryPage({ layer: "inactive" }).items.find((item) => item.id === `inactive:playbook:${playbook.id}`);
      expect(archived?.id).toBeTruthy();
      service.restore([archived.id]);
      expect(service.getSummaryProjection({ sourceScope: "channel" }).content).toContain("频道协作规则");

      service.archive([`playbook:${playbook.id}`]);
      const archivedAgain = service.getLibraryPage({ layer: "inactive" }).items.find((item) => item.id === `inactive:playbook:${playbook.id}`);
      expect(archivedAgain?.id).toBeTruthy();
      service.remove([archivedAgain.id]);
      expect(service.getSummaryProjection({ sourceScope: "channel" }).content).not.toContain("频道协作规则");
    } finally {
      service.close();
    }
  });

  it("does not promote repeated channel facts into profile memory", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidenceA = service.recordEvidence({
        origin: "channel",
        scope: "channel",
        sourceType: "test",
        sourceId: "channel-pref-a",
        sessionId: "channel-pref-a",
        content: "频道里反复提到要先给结论。",
      });
      const evidenceB = service.recordEvidence({
        origin: "channel",
        scope: "channel",
        sourceType: "test",
        sourceId: "channel-pref-b",
        sessionId: "channel-pref-b",
        content: "频道里再次强调要先给结论。",
      });

      service.addFacts([
        {
          fact: "偏好先给结论",
          tags: ["偏好", "沟通"],
          origin: "channel",
          scope: "channel",
          source_refs: [{ layer: "evidence", id: evidenceA.id }],
        },
        {
          fact: "偏好先给结论",
          tags: ["偏好", "沟通"],
          origin: "channel",
          scope: "channel",
          source_refs: [{ layer: "evidence", id: evidenceB.id }],
        },
      ]);

      const promotion = service.promotePatterns();
      expect(promotion.promotedProfileFacts).toBe(0);
      expect(service.factStore.getAll().filter((row) => row.scope === "profile")).toHaveLength(0);
    } finally {
      service.close();
    }
  });

  it("requires independent evidence before promoting repeated patterns", () => {
    const service = createService();
    if (!service) return;

    try {
      const sharedEvidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "shared-pattern-evidence",
        sessionId: "shared-pattern-session",
        content: "用户偏好先给结论，同类修复依赖 freshness guard。",
      });

      service.addFacts([
        {
          fact: "用户偏好先给结论",
          tags: ["偏好", "沟通"],
          origin: "session",
          scope: "agent",
          source_refs: [{ layer: "evidence", id: sharedEvidence.id }],
        },
        {
          fact: "用户偏好先给结论",
          tags: ["偏好", "沟通"],
          origin: "session",
          scope: "agent",
          source_refs: [{ layer: "evidence", id: sharedEvidence.id }],
          time: "2026-05-24T10:00:00.000Z",
        },
        {
          fact: "状态召回误用旧事实导致错误",
          tags: ["错误", "排障"],
          origin: "session",
          scope: "agent",
          source_refs: [{ layer: "evidence", id: sharedEvidence.id }],
        },
        {
          fact: "状态召回误用旧事实导致错误",
          tags: ["错误", "排障"],
          origin: "session",
          scope: "agent",
          source_refs: [{ layer: "evidence", id: sharedEvidence.id }],
          time: "2026-05-24T10:05:00.000Z",
        },
      ]);

      const firstPromotion = service.promotePatterns();
      expect(firstPromotion.promotedProfileFacts).toBe(0);
      expect(firstPromotion.promotedPlaybooks).toBe(0);

      const evidenceB = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "test",
        sourceId: "independent-pattern-evidence",
        sessionId: "independent-pattern-session",
        content: "用户再次明确先给结论，并再次出现旧状态召回错误。",
      });
      service.addFacts([
        {
          fact: "用户偏好先给结论",
          tags: ["偏好", "沟通"],
          origin: "session",
          scope: "agent",
          source_refs: [{ layer: "evidence", id: evidenceB.id }],
          time: "2026-05-24T11:00:00.000Z",
        },
        {
          fact: "状态召回误用旧事实导致错误",
          tags: ["错误", "排障"],
          origin: "session",
          scope: "agent",
          source_refs: [{ layer: "evidence", id: evidenceB.id }],
          time: "2026-05-24T11:05:00.000Z",
        },
      ]);

      const secondPromotion = service.promotePatterns();
      expect(secondPromotion.promotedProfileFacts).toBe(1);
      expect(secondPromotion.promotedPlaybooks).toBe(1);
    } finally {
      service.close();
    }
  });

  it("skips empty successful tool evidence instead of storing noise rows", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "tool",
        scope: "agent",
        sourceType: "tool_result",
        sourceId: "tool-empty-success",
        sessionId: "session-tool-empty",
        content: "tool: Bash\nsuccess: true",
      });
      expect(evidence).toBeNull();
      expect(service.getLibraryPage({ layer: "evidence" }).items).toHaveLength(0);
    } finally {
      service.close();
    }
  });

  it("classifies successful tool evidence as short-lived tool noise", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "tool",
        scope: "agent",
        sourceType: "tool_result",
        sourceId: "tool-success-noise",
        sessionId: "session-tool-noise",
        content: "tool: Bash\nsuccess: true\n\nSlides: 11 (10 closing) Done!",
      });
      expect(evidence).toMatchObject({
        retentionClass: "tool_noise",
      });
      expect(evidence.archiveAfter).toBeTruthy();
      expect(evidence.purgeAfter).toBeTruthy();
    } finally {
      service.close();
    }
  });

  it("classifies failed tool evidence as longer-lived tool debug evidence", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "tool",
        scope: "agent",
        sourceType: "tool_result",
        sourceId: "tool-failed-debug",
        sessionId: "session-tool-debug",
        content: "tool: Bash\nsuccess: false\n\nstderr: command failed with exit code 1",
      });
      expect(evidence).toMatchObject({
        retentionClass: "tool_debug",
      });
      expect(evidence.archiveAfter).toBeTruthy();
      expect(evidence.purgeAfter).toBeTruthy();
    } finally {
      service.close();
    }
  });

  it("archives then purges stale unreferenced evidence", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "tool",
        scope: "agent",
        sourceType: "tool_result",
        sourceId: "tool-stale-evidence",
        sessionId: "session-stale-evidence",
        content: "tool: Bash\nsuccess: true\n\nstdout: generated temporary slide html",
      });
      expect(evidence?.id).toBeTruthy();

      service.localDb.prepare(`
        UPDATE evidence
        SET archive_after = ?, purge_after = ?
        WHERE id = ?
      `).run("2000-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z", evidence.id);

      const archived = service.runEvidenceCleanup({ trigger: "test" });
      expect(archived).toMatchObject({
        archivedEvidence: 1,
        purgedEvidence: 0,
      });
      expect(service.getLibraryPage({ layer: "evidence" }).items.some((item) => item.id === `evidence:${evidence.id}`)).toBe(false);
      expect(service.getLibraryPage({ layer: "inactive" }).items.some((item) => item.id === `inactive:evidence:${evidence.id}`)).toBe(true);

      service.localDb.prepare(`
        UPDATE evidence
        SET purge_after = ?
        WHERE id = ?
      `).run("2000-01-01T00:00:00.000Z", evidence.id);

      const purged = service.runEvidenceCleanup({ trigger: "test" });
      expect(purged).toMatchObject({
        archivedEvidence: 0,
        purgedEvidence: 1,
      });
      const row = service.localDb.prepare(`SELECT id FROM evidence WHERE id = ?`).get(evidence.id);
      expect(row).toBeUndefined();
    } finally {
      service.close();
    }
  });

  it("does not auto-clean evidence that is still referenced by active facts", () => {
    const service = createService();
    if (!service) return;

    try {
      const evidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "assistant_message",
        sourceId: "protected-evidence",
        sessionId: "session-protected-evidence",
        content: "用户确认当前仍持有徐工机械。",
      });
      service.addFacts([{
        fact: "当前仍持有徐工机械",
        tags: ["股票", "持仓"],
        origin: "session",
        scope: "agent",
        memory_kind: "state",
        timeliness: "stateful",
        state_key: "投资组合/徐工机械/持仓状态",
        source_refs: [{ layer: "evidence", id: evidence.id }],
      }]);
      service.localDb.prepare(`
        UPDATE evidence
        SET archive_after = ?, purge_after = ?
        WHERE id = ?
      `).run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", evidence.id);

      const result = service.runEvidenceCleanup({ trigger: "test" });
      expect(result).toMatchObject({
        archivedEvidence: 0,
        purgedEvidence: 0,
      });
      expect(result.skippedProtectedCount).toBeGreaterThan(0);
      expect(service.getLibraryPage({ layer: "evidence" }).items.some((item) => item.id === `evidence:${evidence.id}`)).toBe(true);
    } finally {
      service.close();
    }
  });

  it("protects evidence referenced by active facts, playbooks, marks, episodes, and live evidence refs", () => {
    const service = createService();
    if (!service) return;

    try {
      const factEvidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "assistant_message",
        sourceId: "protected-fact-evidence",
        sessionId: "session-protected-fact",
        content: "用户确认当前仍持有徐工机械。",
      });
      const playbookEvidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "assistant_message",
        sourceId: "protected-playbook-evidence",
        sessionId: "session-protected-playbook",
        content: "这次报错的根因是忘记校验 utility model。",
      });
      const markEvidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "assistant_message",
        sourceId: "protected-mark-evidence",
        sessionId: "session-protected-mark",
        content: "用户希望先给结论，再解释。",
      });
      const episodeEvidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "assistant_message",
        sourceId: "protected-episode-evidence",
        sessionId: "session-protected-episode",
        content: "本轮讨论聚焦证据清理策略。",
      });
      const referencedEvidence = service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "assistant_message",
        sourceId: "protected-ref-target",
        sessionId: "session-protected-ref",
        content: "这是被其他证据继续引用的基础证据。",
      });

      service.addFacts([{
        fact: "当前仍持有徐工机械",
        tags: ["股票", "持仓"],
        origin: "session",
        scope: "agent",
        memory_kind: "state",
        timeliness: "stateful",
        state_key: "投资组合/徐工机械/持仓状态",
        source_refs: [{ layer: "evidence", id: factEvidence.id }],
      }]);
      service.addPlaybook({
        category: "Memory",
        trigger: "utility model 缺失导致提炼失败",
        wrong_path: "未检查工具模型配置",
        root_cause: "utility model 没有配置",
        fix_steps: "先校验 utility model，再运行提炼任务",
        validation: "提炼任务恢复成功",
        sourceRefs: [{ layer: "evidence", id: playbookEvidence.id }],
      });
      service.addMark({
        text: "回答时先给结论",
        sourceRefs: [{ layer: "evidence", id: markEvidence.id }],
      });
      service.upsertEpisode({
        origin: "session",
        scope: "agent",
        sessionId: "session-protected-episode",
        anchorText: "证据清理策略讨论",
        sourceRefs: [{ layer: "evidence", id: episodeEvidence.id }],
      });
      service.recordEvidence({
        origin: "session",
        scope: "agent",
        sourceType: "assistant_message",
        sourceId: "protected-ref-child",
        sessionId: "session-protected-ref-child",
        content: "这条证据继续引用上一条基础证据。",
        sourceRefs: [{ layer: "evidence", id: referencedEvidence.id }],
      });

      for (const item of [
        factEvidence,
        playbookEvidence,
        markEvidence,
        episodeEvidence,
        referencedEvidence,
      ]) {
        service.localDb.prepare(`
          UPDATE evidence
          SET archive_after = ?, purge_after = ?
          WHERE id = ?
        `).run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", item.id);
      }

      const result = service.runEvidenceCleanup({ trigger: "test" });
      expect(result).toMatchObject({
        archivedEvidence: 0,
        purgedEvidence: 0,
      });
      expect(result.skippedProtectedCount).toBeGreaterThanOrEqual(5);

      for (const item of [
        factEvidence,
        playbookEvidence,
        markEvidence,
        episodeEvidence,
        referencedEvidence,
      ]) {
        const row = service.localDb.prepare(`SELECT id FROM evidence WHERE id = ?`).get(item.id);
        expect(row).toBeTruthy();
      }
    } finally {
      service.close();
    }
  });
});
