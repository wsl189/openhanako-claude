import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { runMemoryDoctor } from "./memory-doctor.js";
import { MemoryService } from "./memory-service.js";

const tempRoots = [];
let warnedNativeAbiMismatch = false;

function isNativeAbiMismatchError(err) {
  const msg = String(err?.message || "");
  return msg.includes("better_sqlite3.node") && msg.includes("NODE_MODULE_VERSION");
}

function createDoctorFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-memory-doctor-"));
  const agentDir = path.join(root, "agents", "hanako");
  const userDir = path.join(root, "user");
  tempRoots.push(root);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "config.yaml"), "id: hanako\n");
  try {
    const service = new MemoryService({
      agentId: "hanako",
      agentDir,
      userDir,
      autoRunJobs: false,
    });
    return { root, agentDir, userDir, service };
  } catch (err) {
    if (isNativeAbiMismatchError(err)) {
      if (!warnedNativeAbiMismatch) {
        warnedNativeAbiMismatch = true;
        console.warn("[memory-doctor.test] skip due to better-sqlite3 ABI mismatch in current runtime");
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

describe("memory-doctor", () => {
  it("flags missing channel summary projections when channel memory exists", () => {
    const fixture = createDoctorFixture();
    if (!fixture) return;
    const { root, service } = fixture;

    try {
      const evidence = service.recordEvidence({
        origin: "channel",
        scope: "channel",
        sourceType: "test",
        sourceId: "doctor-channel-summary",
        sessionId: "channel-session",
        content: "频道决定由 Alice 负责 API 重构。",
      });
      service.addFacts([{
        fact: "频道决定由 Alice 负责 API 重构",
        tags: ["API", "分工"],
        origin: "channel",
        scope: "channel",
        memory_kind: "decision",
        decision_key: "project/api/owner",
        source_refs: [{ layer: "evidence", id: evidence.id }],
      }]);
      service.localDb.prepare(`
        DELETE FROM memory_projections
        WHERE key = 'current_summary_channel'
      `).run();
    } finally {
      service.close();
    }

    const report = runMemoryDoctor({ hanakoHome: root, dryRun: true });
    const issues = report.agents[0]?.projections?.issues || [];
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "missing_channel_summary_projection",
        fact: "current_summary_channel",
        action: "reproject",
      }),
    ]));
  });

  it("flags channel summary projection rows stored with the wrong source scope", () => {
    const fixture = createDoctorFixture();
    if (!fixture) return;
    const { root, service } = fixture;

    try {
      const evidence = service.recordEvidence({
        origin: "channel",
        scope: "channel",
        sourceType: "test",
        sourceId: "doctor-channel-scope",
        sessionId: "channel-session",
        content: "频道沉淀了一条协作规则。",
      });
      service.addFacts([{
        fact: "频道沉淀了一条协作规则",
        tags: ["协作", "规则"],
        origin: "channel",
        scope: "channel",
        memory_kind: "background",
        source_refs: [{ layer: "evidence", id: evidence.id }],
      }]);
      service.rebuildSummaryProjection({ sourceScope: "channel" });
      service.localDb.prepare(`
        UPDATE memory_projections
        SET source_scope = 'agent'
        WHERE key = 'current_summary_channel'
      `).run();
    } finally {
      service.close();
    }

    const report = runMemoryDoctor({ hanakoHome: root, dryRun: true });
    const issues = report.agents[0]?.projections?.issues || [];
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "channel_summary_scope_drift",
        fact: "current_summary_channel",
        action: "reproject",
      }),
    ]));
  });
});
