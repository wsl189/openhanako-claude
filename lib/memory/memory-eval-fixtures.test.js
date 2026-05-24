import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryService } from "./memory-service.js";
import { MEMORY_EVAL_FIXTURES } from "./memory-eval-fixtures.js";

const tempRoots = [];
let warnedNativeAbiMismatch = false;

function isNativeAbiMismatchError(err) {
  const msg = String(err?.message || "");
  return msg.includes("better_sqlite3.node") && msg.includes("NODE_MODULE_VERSION");
}

function createService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-memory-eval-"));
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
        console.warn("[memory-eval-fixtures.test] skip due to better-sqlite3 ABI mismatch in current runtime");
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

describe("memory eval fixtures", () => {
  it("covers the fixed retrieval and projection scenarios", () => {
    const service = createService();
    if (!service) return;

    try {
      const metrics = {
        long_term_precision: 0,
        state_staleness_error_rate: 0,
        duplicate_fact_rate: 0,
        conflict_resolution_accuracy: 0,
        playbook_precision: 0,
        retrieval_intent_hit_rate: 0,
      };

      for (const fixture of MEMORY_EVAL_FIXTURES) {
        const context = fixture.context || {
          origin: "session",
          scope: "agent",
          sessionId: `eval-${fixture.id}`,
          channelName: null,
        };
        const evidence = service.recordEvidence({
          origin: context.origin,
          scope: context.scope,
          sourceType: "fixture",
          sourceId: fixture.id,
          sessionId: context.sessionId,
          content: fixture.evidence,
        });
        service.applyExtractionBundle(fixture.bundle, {
          ...context,
          sourceRefs: [{ layer: "evidence", id: evidence.id }],
        });

        if (fixture.checks.profileContains) {
          expect(service.renderProfilePrompt()).toContain(fixture.checks.profileContains);
          metrics.long_term_precision += 1;
        }
        if (fixture.checks.channelProjectionContains) {
          const projection = service.rebuildSummaryProjection({ sourceScope: "channel" }).content;
          expect(projection).toContain(fixture.checks.channelProjectionContains);
          expect(projection).not.toContain("用户长期偏好先给结论再展开分析");
          metrics.conflict_resolution_accuracy += 1;
        }
        if (fixture.checks.retrieval) {
          const result = service.searchMemories({
            query: fixture.checks.retrieval.query,
            intent: fixture.checks.retrieval.intent,
            layers: fixture.checks.retrieval.layers || "auto",
            scope: fixture.checks.retrieval.scope || "auto",
            limit: 5,
          });
          expect(result.length).toBeGreaterThan(0);
          if (fixture.checks.retrieval.expectedItemType) {
            expect(result[0].itemType).toBe(fixture.checks.retrieval.expectedItemType);
          }
          if (fixture.checks.retrieval.expectedMemoryKind) {
            expect(result[0].memory_kind || result[0].memoryKind).toBe(fixture.checks.retrieval.expectedMemoryKind);
          }
          metrics.retrieval_intent_hit_rate += 1;
          if (fixture.checks.retrieval.intent === "playbook") metrics.playbook_precision += 1;
          if (fixture.checks.retrieval.intent === "state") metrics.state_staleness_error_rate += 1;
        }
        if (fixture.checks.diagnosticEvent) {
          const diagnostic = service.localDb.prepare(`
            SELECT event_type
            FROM memory_diagnostics
            WHERE event_type = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          `).get(fixture.checks.diagnosticEvent);
          expect(diagnostic?.event_type).toBe(fixture.checks.diagnosticEvent);
        }
      }

      const seenFacts = new Set();
      let duplicateFacts = 0;
      for (const row of service.factStore.getAll().filter((item) => item.is_active)) {
        const key = [
          row.scope || "agent",
          row.memory_kind || "semantic",
          row.state_key || "",
          row.decision_key || "",
          row.fact,
        ].join("::");
        if (seenFacts.has(key)) duplicateFacts += 1;
        else seenFacts.add(key);
      }
      metrics.duplicate_fact_rate = duplicateFacts;

      expect(metrics).toMatchObject({
        long_term_precision: 1,
        state_staleness_error_rate: 2,
        duplicate_fact_rate: 0,
        conflict_resolution_accuracy: 1,
        playbook_precision: 1,
        retrieval_intent_hit_rate: 5,
      });
    } finally {
      service.close();
    }
  });
});
