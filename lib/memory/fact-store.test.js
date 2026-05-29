import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { FactStore } from "./fact-store.js";

const tempRoots = [];
let warnedNativeAbiMismatch = false;

function isNativeAbiMismatchError(err) {
  const msg = String(err?.message || "");
  return msg.includes("better_sqlite3.node") && msg.includes("NODE_MODULE_VERSION");
}

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-fact-store-"));
  tempRoots.push(root);
  const dbPath = path.join(root, "facts.db");
  try {
    return new FactStore(dbPath);
  } catch (err) {
    if (isNativeAbiMismatchError(err)) {
      if (!warnedNativeAbiMismatch) {
        warnedNativeAbiMismatch = true;
        console.warn("[fact-store.test] skip due to better-sqlite3 ABI mismatch in current runtime");
      }
      return null;
    }
    throw err;
  }
}

function createLegacyDb(seedRows = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-fact-store-legacy-"));
  tempRoots.push(root);
  const dbPath = path.join(root, "facts.db");
  let db;
  try {
    db = new Database(dbPath);
  } catch (err) {
    if (isNativeAbiMismatchError(err)) {
      if (!warnedNativeAbiMismatch) {
        warnedNativeAbiMismatch = true;
        console.warn("[fact-store.test] skip due to better-sqlite3 ABI mismatch in current runtime");
      }
      return null;
    }
    throw err;
  }
  db.exec(`
    CREATE TABLE facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fact TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      time TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.pragma("user_version = 2");
  const insert = db.prepare(`
    INSERT INTO facts (fact, tags, time, session_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const row of seedRows) {
    insert.run(
      row.fact,
      JSON.stringify(row.tags || []),
      row.time || null,
      row.session_id || null,
      row.created_at || new Date().toISOString(),
    );
  }
  db.close();
  return { root, dbPath };
}

function createInterruptedModernDb(seedRows = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-fact-store-interrupted-"));
  tempRoots.push(root);
  const dbPath = path.join(root, "facts.db");
  let db;
  try {
    db = new Database(dbPath);
  } catch (err) {
    if (isNativeAbiMismatchError(err)) {
      if (!warnedNativeAbiMismatch) {
        warnedNativeAbiMismatch = true;
        console.warn("[fact-store.test] skip due to better-sqlite3 ABI mismatch in current runtime");
      }
      return null;
    }
    throw err;
  }

  db.exec(`
    CREATE TABLE facts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      fact          TEXT NOT NULL,
      tags          TEXT NOT NULL DEFAULT '[]',
      time          TEXT,
      timeliness    TEXT NOT NULL DEFAULT 'persistent',
      state_key     TEXT,
      valid_from    TEXT,
      valid_to      TEXT,
      is_active     INTEGER NOT NULL DEFAULT 1,
      session_id    TEXT,
      created_at    TEXT NOT NULL,
      scope         TEXT NOT NULL DEFAULT 'agent',
      origin        TEXT NOT NULL DEFAULT 'assistant',
      source_refs   TEXT NOT NULL DEFAULT '[]',
      truth_time    TEXT,
      confidence    REAL,
      importance    REAL,
      subject_id    TEXT,
      hash          TEXT NOT NULL DEFAULT '',
      updated_at    TEXT NOT NULL,
      invalidated_by TEXT,
      CHECK (origin <> 'channel' OR scope <> 'profile')
    );

    CREATE TABLE facts_legacy_v2 (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      fact       TEXT NOT NULL,
      tags       TEXT NOT NULL DEFAULT '[]',
      time       TEXT,
      timeliness TEXT NOT NULL DEFAULT 'persistent',
      state_key  TEXT,
      valid_from TEXT,
      valid_to   TEXT,
      is_active  INTEGER NOT NULL DEFAULT 1,
      session_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE episodes (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      scope TEXT NOT NULL,
      session_id TEXT,
      channel_name TEXT,
      anchor_text TEXT NOT NULL,
      source_refs TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE playbooks (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL DEFAULT '',
      trigger TEXT NOT NULL,
      wrong_path TEXT NOT NULL,
      root_cause TEXT NOT NULL,
      fix_steps TEXT NOT NULL,
      validation TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      origin TEXT NOT NULL DEFAULT 'assistant',
      source_refs TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      invalidated_by TEXT
    );
  `);

  const insertLegacy = db.prepare(`
    INSERT INTO facts_legacy_v2 (fact, tags, time, timeliness, state_key, valid_from, valid_to, is_active, session_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of seedRows) {
    insertLegacy.run(
      row.fact,
      JSON.stringify(row.tags || []),
      row.time || null,
      row.timeliness || "persistent",
      row.state_key || null,
      row.valid_from || row.time || null,
      row.valid_to || null,
      row.is_active ?? 1,
      row.session_id || null,
      row.created_at || new Date().toISOString(),
    );
  }
  db.pragma("user_version = 4");
  db.close();
  return { root, dbPath };
}

function createSchemaDriftDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-fact-store-drift-"));
  tempRoots.push(root);
  const dbPath = path.join(root, "facts.db");
  let db;
  try {
    db = new Database(dbPath);
  } catch (err) {
    if (isNativeAbiMismatchError(err)) {
      if (!warnedNativeAbiMismatch) {
        warnedNativeAbiMismatch = true;
        console.warn("[fact-store.test] skip due to better-sqlite3 ABI mismatch in current runtime");
      }
      return null;
    }
    throw err;
  }

  db.exec(`
    CREATE TABLE facts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      fact          TEXT NOT NULL,
      tags          TEXT NOT NULL DEFAULT '[]',
      time          TEXT,
      timeliness    TEXT NOT NULL DEFAULT 'persistent',
      state_key     TEXT,
      valid_from    TEXT,
      valid_to      TEXT,
      is_active     INTEGER NOT NULL DEFAULT 1,
      session_id    TEXT,
      created_at    TEXT NOT NULL,
      scope         TEXT NOT NULL DEFAULT 'agent',
      origin        TEXT NOT NULL DEFAULT 'assistant',
      source_refs   TEXT NOT NULL DEFAULT '[]',
      truth_time    TEXT,
      confidence    REAL,
      importance    REAL,
      subject_id    TEXT,
      hash          TEXT NOT NULL DEFAULT '',
      updated_at    TEXT NOT NULL,
      invalidated_by TEXT,
      memory_kind TEXT NOT NULL DEFAULT 'semantic',
      decision_key TEXT,
      staleness_hint TEXT
    );

    CREATE TABLE evidence (
      id          TEXT PRIMARY KEY,
      origin      TEXT NOT NULL,
      scope       TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id   TEXT,
      session_id  TEXT,
      episode_id  TEXT,
      content     TEXT NOT NULL,
      preview     TEXT NOT NULL,
      source_refs TEXT NOT NULL DEFAULT '[]',
      redaction   TEXT NOT NULL DEFAULT '{}',
      hash        TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
  `);
  db.pragma("user_version = 5");
  db.close();
  return { root, dbPath };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("fact-store timeliness", () => {
  it("migrates legacy facts into the unified schema and preserves legacy table", () => {
    const legacy = createLegacyDb([{
      fact: "用户喜欢直接结论",
      tags: ["偏好", "沟通"],
      time: "2026-05-01T08:30:00.000Z",
      session_id: "legacy-session",
      created_at: "2026-05-01T08:30:00.000Z",
    }]);
    if (!legacy) return;
    const { dbPath } = legacy;

    const store = new FactStore(dbPath);
    try {
      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        fact: "用户喜欢直接结论",
        scope: "agent",
        origin: "import",
        session_id: "legacy-session",
      });
      const hasLegacy = !!store.db.prepare(`
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table' AND name = 'facts_legacy_v2'
      `).get();
      expect(hasLegacy).toBe(true);
      expect(store.db.pragma("user_version", { simple: true })).toBe(5);
    } finally {
      store.close();
    }
  });

  it("rolls back facts migration when replacement fails", () => {
    const legacy = createLegacyDb([{
      fact: "旧记忆仍应保留",
      tags: ["迁移"],
      time: "2026-05-02T10:00:00.000Z",
      created_at: "2026-05-02T10:00:00.000Z",
    }]);
    if (!legacy) return;
    const { dbPath } = legacy;

    const originalBackfill = FactStore.prototype._backfillLegacyFacts;
    FactStore.prototype._backfillLegacyFacts = function patchedBackfill() {
      throw new Error("forced migration failure");
    };

    try {
      expect(() => new FactStore(dbPath)).toThrow("forced migration failure");
    } finally {
      FactStore.prototype._backfillLegacyFacts = originalBackfill;
    }

    let db;
    try {
      db = new Database(dbPath);
    } catch (err) {
      if (isNativeAbiMismatchError(err)) return;
      throw err;
    }
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(2);
      const hasLegacy = !!db.prepare(`
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table' AND name = 'facts_legacy_v2'
      `).get();
      expect(hasLegacy).toBe(false);

      const columns = db.prepare(`PRAGMA table_info(facts)`).all().map((row) => row.name);
      expect(columns).not.toContain("scope");

      const rows = db.prepare(`SELECT fact FROM facts`).all();
      expect(rows).toEqual([{ fact: "旧记忆仍应保留" }]);
    } finally {
      db.close();
    }
  });

  it("resumes v5 migration when legacy backup exists beside an empty v4 facts table", () => {
    const legacy = createInterruptedModernDb([{
      fact: "当前持有徐工机械",
      tags: ["徐工机械", "持仓"],
      time: "2026-05-20T10:00:00.000Z",
      timeliness: "stateful",
      state_key: "portfolio/xcmg/holding",
      session_id: "resume-session",
      created_at: "2026-05-20T10:00:00.000Z",
    }]);
    if (!legacy) return;

    const store = new FactStore(legacy.dbPath);
    try {
      expect(store.db.pragma("user_version", { simple: true })).toBe(5);

      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        fact: "当前持有徐工机械",
        timeliness: "stateful",
        state_key: "portfolio/xcmg/holding",
        session_id: "resume-session",
      });

      const factColumns = store.db.prepare(`PRAGMA table_info(facts)`).all().map((row) => row.name);
      expect(factColumns).toContain("memory_kind");
      expect(factColumns).toContain("decision_key");
      expect(factColumns).toContain("staleness_hint");

      const episodeColumns = store.db.prepare(`PRAGMA table_info(episodes)`).all().map((row) => row.name);
      expect(episodeColumns).toContain("episode_kind");
      expect(episodeColumns).toContain("tags");

      const playbookColumns = store.db.prepare(`PRAGMA table_info(playbooks)`).all().map((row) => row.name);
      expect(playbookColumns).toContain("scope");
    } finally {
      store.close();
    }
  });

  it("repairs schema drift when user_version is current but evidence columns are missing", () => {
    const drift = createSchemaDriftDb();
    if (!drift) return;

    const store = new FactStore(drift.dbPath);
    try {
      const evidenceColumns = store.db.prepare(`PRAGMA table_info(evidence)`).all().map((row) => row.name);
      expect(evidenceColumns).toContain("retention_class");
      expect(evidenceColumns).toContain("archive_after");
      expect(evidenceColumns).toContain("purge_after");

      const archiveIndex = store.db.prepare(`
        SELECT 1
        FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_evidence_archive_after'
      `).get();
      const purgeIndex = store.db.prepare(`
        SELECT 1
        FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_evidence_purge_after'
      `).get();
      expect(archiveIndex).toBeTruthy();
      expect(purgeIndex).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it("keeps only latest active fact for same state_key", () => {
    const store = createStore();
    if (!store) return;
    try {
      const now = Date.now();
      const t1 = new Date(now - 2 * 86400000).toISOString().slice(0, 16);
      const t2 = new Date(now - 1 * 86400000).toISOString().slice(0, 16);

      store.add({
        fact: "当前持有中国核建",
        tags: ["中国核建", "持仓"],
        time: t1,
        timeliness: "stateful",
        state_key: "投资组合/中国核建/持仓状态",
        session_id: "s1",
      });
      store.add({
        fact: "当前不再持有中国核建",
        tags: ["中国核建", "持仓", "状态变更"],
        time: t2,
        timeliness: "stateful",
        state_key: "投资组合/中国核建/持仓状态",
        session_id: "s2",
      });

      const active = store.searchByTags(["中国核建"], undefined, 20);
      expect(active).toHaveLength(1);
      expect(active[0].fact).toContain("不再持有");
      expect(active[0].is_active).toBe(true);

      const all = store.searchByTags(["中国核建"], undefined, 20, { includeInactive: true });
      expect(all).toHaveLength(2);
      expect(all.filter((x) => x.is_active)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("does not cross-deactivate state or decision facts across scopes", () => {
    const store = createStore();
    if (!store) return;
    try {
      store.add({
        fact: "当前持有中国核建",
        tags: ["中国核建", "持仓"],
        time: "2026-05-20T10:00",
        timeliness: "stateful",
        state_key: "投资组合/中国核建/持仓状态",
        scope: "agent",
        session_id: "agent-state",
      });
      store.add({
        fact: "频道里还在讨论中国核建持仓",
        tags: ["中国核建", "持仓", "频道"],
        time: "2026-05-20T10:30",
        timeliness: "stateful",
        state_key: "投资组合/中国核建/持仓状态",
        scope: "channel",
        origin: "channel",
        session_id: "channel-state",
      });
      store.add({
        fact: "已决定继续跟踪中国核建",
        tags: ["中国核建", "决策"],
        time: "2026-05-20T11:00",
        memory_kind: "decision",
        decision_key: "投资组合/中国核建/跟踪策略",
        scope: "agent",
        session_id: "agent-decision",
      });
      store.add({
        fact: "频道决定由 Alice 跟踪中国核建",
        tags: ["中国核建", "决策", "频道"],
        time: "2026-05-20T11:30",
        memory_kind: "decision",
        decision_key: "投资组合/中国核建/跟踪策略",
        scope: "channel",
        origin: "channel",
        session_id: "channel-decision",
      });

      const activeRows = store.getAll().filter((row) => row.is_active);
      expect(activeRows.filter((row) => row.scope === "agent" && row.state_key === "投资组合/中国核建/持仓状态")).toHaveLength(1);
      expect(activeRows.filter((row) => row.scope === "channel" && row.state_key === "投资组合/中国核建/持仓状态")).toHaveLength(1);
      expect(activeRows.filter((row) => row.scope === "agent" && row.decision_key === "投资组合/中国核建/跟踪策略")).toHaveLength(1);
      expect(activeRows.filter((row) => row.scope === "channel" && row.decision_key === "投资组合/中国核建/跟踪策略")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("stores memory kind and decision metadata", () => {
    const store = createStore();
    if (!store) return;
    try {
      store.add({
        fact: "已决定继续长期持有贵州茅台",
        tags: ["贵州茅台", "决策"],
        time: "2026-05-20T10:00",
        timeliness: "persistent",
        memory_kind: "decision",
        decision_key: "投资组合/贵州茅台/长期策略",
        staleness_hint: "需要后续确认是否变化",
        session_id: "s-decision",
      });

      const row = store.getAll()[0];
      expect(row).toMatchObject({
        memory_kind: "decision",
        decision_key: "投资组合/贵州茅台/长期策略",
        staleness_hint: "需要后续确认是否变化",
      });
    } finally {
      store.close();
    }
  });

  it("expires ephemeral facts by ttl", () => {
    const store = createStore();
    if (!store) return;
    try {
      store.add({
        fact: "这周临时改为晚间复盘",
        tags: ["临时安排", "复盘"],
        time: "2020-01-01T00:00",
        timeliness: "ephemeral",
        ttl_days: 2,
        session_id: "s1",
      });

      const active = store.searchByTags(["临时安排"], undefined, 20);
      expect(active).toHaveLength(0);

      const all = store.searchByTags(["临时安排"], undefined, 20, { includeInactive: true });
      expect(all).toHaveLength(1);
      expect(all[0].is_active).toBe(false);
      expect(all[0].valid_to).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it("deactivates legacy facts when a stateful replacement arrives", () => {
    const store = createStore();
    if (!store) return;
    try {
      const now = Date.now();
      const t1 = new Date(now - 3 * 86400000).toISOString().slice(0, 16);
      const t2 = new Date(now - 1 * 86400000).toISOString().slice(0, 16);

      // 模拟历史数据：没有 timeliness/state_key 的旧事实
      store.add({
        fact: "当前持有中国核建",
        tags: ["中国核建", "持仓"],
        time: t1,
        session_id: "legacy",
      });

      store.add({
        fact: "当前不再持有中国核建",
        tags: ["中国核建", "持仓", "状态变更"],
        time: t2,
        timeliness: "stateful",
        state_key: "投资组合/中国核建/持仓状态",
        session_id: "s2",
      });

      const active = store.searchByTags(["中国核建"], undefined, 20);
      expect(active).toHaveLength(1);
      expect(active[0].fact).toContain("不再持有");
    } finally {
      store.close();
    }
  });

  it("falls back when SQLite FTS5 is unavailable", () => {
    const originalExec = Database.prototype.exec;
    Database.prototype.exec = function patchedExec(sql, ...args) {
      if (typeof sql === "string" && sql.includes("CREATE VIRTUAL TABLE facts_fts USING fts5")) {
        throw new Error("no such module: fts5");
      }
      return originalExec.call(this, sql, ...args);
    };

    let store = null;
    try {
      store = createStore();
      if (!store) return;

      expect(store._ftsEnabled).toBe(false);

      store.add({
        fact: "Windows ARM64 启动兼容修复",
        tags: ["Windows", "ARM64"],
        session_id: "s1",
      });

      const results = store.searchFullText("ARM64", 10);
      expect(results).toHaveLength(1);
      expect(results[0].fact).toContain("ARM64");

      expect(() => store.clearAll()).not.toThrow();
      expect(store.size).toBe(0);
    } finally {
      Database.prototype.exec = originalExec;
      store?.close();
    }
  });
});
