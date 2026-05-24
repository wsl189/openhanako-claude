import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SessionSummaryManager, validateSummary } from "./session-summary.js";

const tempRoots = [];
const openDbs = [];
let warnedNativeAbiMismatch = false;

function isNativeAbiMismatchError(err) {
  const msg = String(err?.message || "");
  return msg.includes("better_sqlite3.node") && msg.includes("NODE_MODULE_VERSION");
}

function createManager() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-summary-"));
  tempRoots.push(root);
  return new SessionSummaryManager(root);
}

function createDbManager() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-summary-db-"));
  const summariesDir = path.join(root, "summaries");
  const dbPath = path.join(root, "facts.db");
  tempRoots.push(root);
  fs.mkdirSync(summariesDir, { recursive: true });
  try {
    const db = new Database(dbPath);
    openDbs.push(db);
    return {
      root,
      summariesDir,
      db,
      manager: new SessionSummaryManager(summariesDir, { db }),
    };
  } catch (err) {
    if (isNativeAbiMismatchError(err)) {
      if (!warnedNativeAbiMismatch) {
        warnedNativeAbiMismatch = true;
        console.warn("[session-summary.test] skip due to better-sqlite3 ABI mismatch in current runtime");
      }
      return null;
    }
    throw err;
  }
}

afterEach(() => {
  while (openDbs.length > 0) {
    const db = openDbs.pop();
    try { db.close(); } catch {}
  }
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("summary validation", () => {
  it("rejects malformed inventory-style summaries", () => {
    const result = validateSummary("我目前有以下技能可用：\n- pdf\n- docx", { isZh: true });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("bad_start");
    expect(result.reasons).toContain("tool_or_skill_inventory");
  });

  it("rejects repeated summary segments", () => {
    const text = [
      "## 重要事实",
      "用户身份被确认为WSL。",
      "用户身份被确认为WSL。",
      "用户身份被确认为WSL。",
      "用户身份被确认为WSL。",
      "## 事情经过",
      "01:00 用户打招呼。",
    ].join("\n");
    const result = validateSummary(text, { isZh: true });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((reason) => reason.startsWith("repeated_segment"))).toBe(true);
  });

  it("repairs invalid LLM output before saving", async () => {
    const manager = createManager();
    manager._callRollingLLM = async () => "我目前有以下技能可用：\n- pdf";
    manager._repairSummaryLLM = async () => "## 重要事实\n无\n\n## 事情经过\n01:00 用户打招呼，助手回应。";

    const summary = await manager.rollingSummary(
      "s1",
      [{ role: "user", content: "你好", timestamp: "2026-05-04T01:00:00.000Z" }],
      { model: "mock", api: "mock", api_key: "", base_url: "mock" },
    );

    expect(summary).toMatch(/^## 重要事实/);
    expect(manager.getSummary("s1").summary).toBe(summary);
  });

  it("keeps previous summary when repair fails", async () => {
    const manager = createManager();
    manager.saveSummary("s1", {
      session_id: "s1",
      created_at: "2026-05-04T00:00:00.000Z",
      updated_at: "2026-05-04T00:00:00.000Z",
      summary: "## 重要事实\n无\n\n## 事情经过\n00:00 初始摘要。",
      snapshot: "",
      snapshot_at: null,
    });
    manager._callRollingLLM = async () => "bad";
    manager._repairSummaryLLM = async () => "still bad";

    const summary = await manager.rollingSummary(
      "s1",
      [{ role: "user", content: "你好", timestamp: "2026-05-04T01:00:00.000Z" }],
      { model: "mock", api: "mock", api_key: "", base_url: "mock" },
    );

    expect(summary).toContain("初始摘要");
    expect(manager.getSummary("s1").summary).toContain("初始摘要");
  });

  it("migrates legacy summary files into DB and keeps future writes in DB", () => {
    const fixture = createDbManager();
    if (!fixture) return;

    const { summariesDir, db } = fixture;
    const legacyPath = path.join(summariesDir, "legacy-session.json");
    fs.writeFileSync(legacyPath, JSON.stringify({
      session_id: "legacy-session",
      created_at: "2026-05-04T00:00:00.000Z",
      updated_at: "2026-05-04T01:00:00.000Z",
      summary: "## 重要事实\n已迁移\n\n## 事情经过\n01:00 旧摘要文件。",
      snapshot: "",
      snapshot_at: null,
    }, null, 2));

    const manager = new SessionSummaryManager(summariesDir, { db });
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(manager.getSummary("legacy-session")?.summary).toContain("已迁移");

    manager.saveSummary("db-session", {
      session_id: "db-session",
      created_at: "2026-05-04T02:00:00.000Z",
      updated_at: "2026-05-04T02:30:00.000Z",
      summary: "## 重要事实\n只写 DB\n\n## 事情经过\n02:30 新摘要。",
      snapshot: "",
      snapshot_at: null,
    });

    const row = db.prepare(`
      SELECT summary
      FROM memory_summaries
      WHERE session_id = ?
    `).get("db-session");
    expect(row?.summary).toContain("只写 DB");
    expect(fs.existsSync(path.join(summariesDir, "db-session.json"))).toBe(false);
  });
});
