/**
 * fact-store.js — 深度记忆存储（元事实 + 标签）
 *
 * v2 记忆系统的 archival 层。每条记忆是一个"元事实"，
 * 附带标签和时间，通过标签匹配 + FTS5 全文搜索检索。
 *
 * 替代 v1 的 store.js（SQLite + sqlite-vec 向量搜索）。
 * 不使用 embedding / 向量 / score / decay / hit_count。
 */

import Database from "better-sqlite3";
import { scrubPII } from "../pii-guard.js";

/**
 * 当前 schema 版本。每次改表结构时递增，
 * 并在 _migrate() 里添加对应的迁移逻辑。
 */
const SCHEMA_VERSION = 5;
const DEFAULT_EPHEMERAL_TTL_DAYS = 14;
const MIN_TTL_DAYS = 1;
const MAX_TTL_DAYS = 180;
const TIMELINESS_SET = new Set(["persistent", "stateful", "ephemeral"]);
const FACT_SCOPE_SET = new Set(["agent", "channel", "profile"]);
const FACT_ORIGIN_SET = new Set(["assistant", "session", "channel", "import", "system", "tool"]);
const MEMORY_KIND_SET = new Set([
  "semantic",
  "profile_identity",
  "profile_preference",
  "profile_constraint",
  "state",
  "decision",
  "background",
  "working_note",
]);
const EPISODE_KIND_SET = new Set([
  "conversation",
  "decision_process",
  "channel_coordination",
  "research_trace",
]);

function buildSearchTerms(query) {
  const text = String(query || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return [];
  const terms = new Set();
  const push = (value) => {
    const next = String(value || "").trim();
    if (next.length < 2 || terms.size >= 24) return;
    terms.add(next);
  };

  for (const token of text.match(/[a-z0-9_]+/g) || []) {
    push(token);
  }

  for (const run of text.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length <= 4) {
      push(run);
      continue;
    }
    for (const size of [4, 3, 2]) {
      for (let i = 0; i <= run.length - size && terms.size < 24; i++) {
        push(run.slice(i, i + size));
      }
    }
  }

  if (terms.size === 0) push(text);
  if (terms.size < 24) push(text);
  return [...terms];
}

function normalizeScope(value) {
  if (typeof value !== "string") return "agent";
  const next = value.trim().toLowerCase();
  return FACT_SCOPE_SET.has(next) ? next : "agent";
}

function normalizeOrigin(value) {
  if (typeof value !== "string") return "assistant";
  const next = value.trim().toLowerCase();
  return FACT_ORIGIN_SET.has(next) ? next : "assistant";
}

function toJson(value, fallback = []) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function createFactsTableSql() {
  return `
    CREATE TABLE IF NOT EXISTS facts (
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
      memory_kind   TEXT NOT NULL DEFAULT 'semantic',
      decision_key  TEXT,
      staleness_hint TEXT,
      hash          TEXT NOT NULL DEFAULT '',
      updated_at    TEXT NOT NULL,
      invalidated_by TEXT,
      CHECK (origin <> 'channel' OR scope <> 'profile')
    )
  `;
}

function normalizeTimeliness(value) {
  return TIMELINESS_SET.has(value) ? value : "persistent";
}

function normalizeMemoryKind(value) {
  if (typeof value !== "string") return "semantic";
  const next = value.trim().toLowerCase();
  return MEMORY_KIND_SET.has(next) ? next : "semantic";
}

function normalizeStateKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim().replace(/\s+/g, " ");
  return key ? key.slice(0, 120) : null;
}

function normalizeDecisionKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim().replace(/\s+/g, " ");
  return key ? key.slice(0, 120) : null;
}

function normalizeEpisodeKind(value) {
  if (typeof value !== "string") return "conversation";
  const next = value.trim().toLowerCase();
  return EPISODE_KIND_SET.has(next) ? next : "conversation";
}

function normalizeTtlDays(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_EPHEMERAL_TTL_DAYS;
  return Math.max(MIN_TTL_DAYS, Math.min(MAX_TTL_DAYS, n));
}

function toIso(value) {
  if (!value || typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  let date = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    date = new Date(`${raw}T00:00:00`);
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) {
    date = new Date(`${raw}:00`);
  } else {
    date = new Date(raw);
  }

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function addDaysIso(baseIso, days) {
  const base = new Date(baseIso);
  if (Number.isNaN(base.getTime())) return null;
  return new Date(base.getTime() + days * 86400000).toISOString();
}

export class FactStore {
  /**
   * @param {string} dbPath - facts.db 的路径
   */
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this._ftsEnabled = false;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -16000");     // 16MB（默认 ~2MB）
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("mmap_size = 30000000");    // 30MB mmap I/O
    this._migrate();
    this._initSchema();
    this._ensureFactWritePathHealthy();
    this._prepareStatements();
    this._tagSearchCache = new Map();          // tag 数量 → prepared statement
  }

  _releaseWriteProbeSavepoint() {
    try {
      this.db.exec("ROLLBACK TO facts_write_probe");
    } catch {}
    try {
      this.db.exec("RELEASE facts_write_probe");
    } catch {}
  }

  _repairFactsFtsArtifacts() {
    this.db.transaction(() => {
      this._dropFtsArtifacts();
      this._initFtsStrict();
      this.db.exec(`INSERT INTO facts_fts(facts_fts) VALUES('rebuild')`);
    })();
  }

  _ensureFactWritePathHealthy({ repaired = false } = {}) {
    if (!this._ftsEnabled) return;
    const now = new Date().toISOString();
    try {
      this.db.exec("SAVEPOINT facts_write_probe");
      const probe = this.db.prepare(`
        INSERT INTO facts (
          fact, tags, time, timeliness, state_key, valid_from, valid_to, is_active, session_id,
          created_at, scope, origin, source_refs, truth_time, confidence, importance, subject_id,
          hash, updated_at, invalidated_by
        )
        VALUES (?, '[]', ?, 'persistent', NULL, ?, NULL, 1, '__fts_probe__',
                ?, 'agent', 'system', '[]', ?, NULL, NULL, NULL, '__fts_probe__', ?, NULL)
      `).run(`__hanako_fts_probe__${now}`, now, now, now, now, now);
      const probeId = Number(probe.lastInsertRowid);
      this.db.prepare(`UPDATE facts SET updated_at = ? WHERE id = ?`).run(now, probeId);
      this.db.prepare(`DELETE FROM facts WHERE id = ?`).run(probeId);
      this._releaseWriteProbeSavepoint();
    } catch (err) {
      this._releaseWriteProbeSavepoint();
      const message = String(err?.message || err || "");
      if (!repaired && /database disk image is malformed|malformed/i.test(message)) {
        console.warn("[FactStore] detected malformed FTS write path, rebuilding facts_fts artifacts");
        this._repairFactsFtsArtifacts();
        this._ensureFactWritePathHealthy({ repaired: true });
        return;
      }
      throw err;
    }
  }

  _initSchema() {
    this.db.exec(createFactsTableSql());
    this._createFactsIndexes();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evidence (
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
      CREATE INDEX IF NOT EXISTS idx_evidence_origin_scope ON evidence(origin, scope, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_evidence_session_id ON evidence(session_id, created_at DESC);
      CREATE TRIGGER IF NOT EXISTS evidence_reject_channel_profile_insert
      BEFORE INSERT ON evidence
      WHEN NEW.origin = 'channel' AND NEW.scope = 'profile'
      BEGIN
        SELECT RAISE(ABORT, 'origin=channel cannot write scope=profile');
      END;
      CREATE TRIGGER IF NOT EXISTS evidence_reject_channel_profile_update
      BEFORE UPDATE ON evidence
      WHEN NEW.origin = 'channel' AND NEW.scope = 'profile'
      BEGIN
        SELECT RAISE(ABORT, 'origin=channel cannot write scope=profile');
      END;

      CREATE TABLE IF NOT EXISTS episodes (
        id          TEXT PRIMARY KEY,
        origin      TEXT NOT NULL,
        scope       TEXT NOT NULL,
        session_id  TEXT,
        channel_name TEXT,
        anchor_text TEXT NOT NULL,
        episode_kind TEXT NOT NULL DEFAULT 'conversation',
        tags        TEXT NOT NULL DEFAULT '[]',
        source_refs TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_episodes_session_id ON episodes(session_id, updated_at DESC);
      CREATE TRIGGER IF NOT EXISTS episodes_reject_channel_profile_insert
      BEFORE INSERT ON episodes
      WHEN NEW.origin = 'channel' AND NEW.scope = 'profile'
      BEGIN
        SELECT RAISE(ABORT, 'origin=channel cannot write scope=profile');
      END;
      CREATE TRIGGER IF NOT EXISTS episodes_reject_channel_profile_update
      BEFORE UPDATE ON episodes
      WHEN NEW.origin = 'channel' AND NEW.scope = 'profile'
      BEGIN
        SELECT RAISE(ABORT, 'origin=channel cannot write scope=profile');
      END;

      CREATE TABLE IF NOT EXISTS playbooks (
        id           TEXT PRIMARY KEY,
        category     TEXT NOT NULL DEFAULT '',
        trigger      TEXT NOT NULL,
        wrong_path   TEXT NOT NULL,
        root_cause   TEXT NOT NULL,
        fix_steps    TEXT NOT NULL,
        validation   TEXT NOT NULL,
        active       INTEGER NOT NULL DEFAULT 1,
        origin       TEXT NOT NULL DEFAULT 'assistant',
        scope        TEXT NOT NULL DEFAULT 'agent',
        source_refs  TEXT NOT NULL DEFAULT '[]',
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        archived_at  TEXT,
        invalidated_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_playbooks_active ON playbooks(active, updated_at DESC);

      CREATE TABLE IF NOT EXISTS fact_links (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        fact_id     INTEGER NOT NULL,
        evidence_id TEXT,
        episode_id  TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fact_links_fact_id ON fact_links(fact_id);
      CREATE INDEX IF NOT EXISTS idx_fact_links_evidence_id ON fact_links(evidence_id);

      CREATE TABLE IF NOT EXISTS retrieval_logs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        query           TEXT NOT NULL,
        layer           TEXT NOT NULL DEFAULT 'facts',
        ranking_version TEXT NOT NULL,
        config_snapshot TEXT NOT NULL DEFAULT '{}',
        result_ids      TEXT NOT NULL DEFAULT '[]',
        sampled         INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_retrieval_logs_created_at ON retrieval_logs(created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_marks (
        id             TEXT PRIMARY KEY,
        kind           TEXT NOT NULL DEFAULT 'pinned',
        text           TEXT NOT NULL,
        fact_id        INTEGER,
        active         INTEGER NOT NULL DEFAULT 1,
        source_refs    TEXT NOT NULL DEFAULT '[]',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        archived_at    TEXT,
        invalidated_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_marks_active ON memory_marks(active, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_jobs (
        id            TEXT PRIMARY KEY,
        job_key       TEXT NOT NULL UNIQUE,
        job_type      TEXT NOT NULL,
        payload       TEXT NOT NULL,
        status        TEXT NOT NULL,
        lease_until   TEXT,
        attempts      INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 5,
        last_error    TEXT,
        available_at  TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        dead_letter_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_jobs_status ON memory_jobs(status, available_at, updated_at);

      CREATE TABLE IF NOT EXISTS memory_projections (
        key          TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        content      TEXT NOT NULL,
        source_scope TEXT,
        generated_at TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_summaries (
        session_id       TEXT PRIMARY KEY,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        summary          TEXT NOT NULL,
        snapshot         TEXT NOT NULL DEFAULT '',
        snapshot_at      TEXT,
        invalid          INTEGER NOT NULL DEFAULT 0,
        invalid_at       TEXT,
        invalid_reasons  TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_memory_summaries_updated_at ON memory_summaries(updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_diagnostics (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type  TEXT NOT NULL,
        payload     TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_diagnostics_event_type ON memory_diagnostics(event_type, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_archives (
        layer       TEXT NOT NULL,
        item_id     TEXT NOT NULL,
        preview     TEXT NOT NULL DEFAULT '',
        truth_time  TEXT,
        origin      TEXT,
        scope       TEXT,
        payload     TEXT NOT NULL DEFAULT '{}',
        archived_at TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (layer, item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_archives_archived_at ON memory_archives(archived_at DESC, updated_at DESC);
    `);
    this._initFts();
  }

  _createFactsIndexes() {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_facts_time ON facts(time);
      CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id);
      CREATE INDEX IF NOT EXISTS idx_facts_state_key ON facts(state_key);
      CREATE INDEX IF NOT EXISTS idx_facts_decision_key ON facts(decision_key);
      CREATE INDEX IF NOT EXISTS idx_facts_memory_kind ON facts(memory_kind, is_active);
      CREATE INDEX IF NOT EXISTS idx_facts_valid_to ON facts(valid_to);
      CREATE INDEX IF NOT EXISTS idx_facts_is_active ON facts(is_active);
      CREATE INDEX IF NOT EXISTS idx_facts_scope_origin ON facts(scope, origin, is_active);
      CREATE INDEX IF NOT EXISTS idx_facts_hash ON facts(hash);
    `);
  }

  _initFts() {
    const hasFtsTable = !!this.db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'facts_fts'
      LIMIT 1
    `).get();

    if (!hasFtsTable) {
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE facts_fts USING fts5(
            fact,
            content=facts,
            content_rowid=id,
            tokenize='unicode61'
          );
        `);
      } catch (err) {
        console.warn(`[FactStore] FTS5 unavailable, falling back to LIKE search: ${err.message}`);
        this._ftsEnabled = false;
        return;
      }
    }

    try {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
          INSERT INTO facts_fts(rowid, fact) VALUES (new.id, new.fact);
        END;
        CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
          INSERT INTO facts_fts(facts_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
        END;
        CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
          INSERT INTO facts_fts(facts_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
          INSERT INTO facts_fts(rowid, fact) VALUES (new.id, new.fact);
        END;
      `);
      this._ftsEnabled = true;
    } catch (err) {
      console.warn(`[FactStore] FTS triggers unavailable, falling back to LIKE search: ${err.message}`);
      this._ftsEnabled = false;
    }
  }

  _initFtsStrict() {
    const hasFtsTable = !!this.db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'facts_fts'
      LIMIT 1
    `).get();

    if (!hasFtsTable) {
      this.db.exec(`
        CREATE VIRTUAL TABLE facts_fts USING fts5(
          fact,
          content=facts,
          content_rowid=id,
          tokenize='unicode61'
        );
      `);
    }

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, fact) VALUES (new.id, new.fact);
      END;
      CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
      END;
      CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
        INSERT INTO facts_fts(rowid, fact) VALUES (new.id, new.fact);
      END;
    `);
    this._ftsEnabled = true;
  }

  /**
   * Schema 迁移：读取 user_version，逐级执行迁移函数。
   * 每次改表结构时：
   *   1. SCHEMA_VERSION += 1
   *   2. 在 switch 里加一个 case
   */
  _migrate() {
    const current = this.db.pragma("user_version", { simple: true });
    if (current >= SCHEMA_VERSION) return;

    this.db.transaction(() => {
      this._dropFtsArtifacts();
      this._migrateFactsTable();
      this._ensureFactsColumns();
      this._ensureEpisodeColumns();
      this._ensurePlaybookColumns();
      this._createFactsIndexes();
      this._initFts();
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();

    console.log(`[FactStore] schema migrated: v${current} → v${SCHEMA_VERSION}`);
  }

  _dropFtsArtifacts() {
    this.db.exec(`
      DROP TRIGGER IF EXISTS facts_ai;
      DROP TRIGGER IF EXISTS facts_ad;
      DROP TRIGGER IF EXISTS facts_au;
      DROP TABLE IF EXISTS facts_fts;
    `);
  }

  _migrateFactsTable() {
    const hasFacts = !!this.db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'facts'
      LIMIT 1
    `).get();
    const hasLegacy = !!this.db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'facts_legacy_v2'
      LIMIT 1
    `).get();

    if (!hasFacts && !hasLegacy) {
      this.db.exec(createFactsTableSql());
      return;
    }

    if (hasFacts && this._hasUnifiedFactsSchema()) {
      return;
    }

    if (!hasFacts && hasLegacy) {
      this.db.exec(createFactsTableSql());
      this._backfillLegacyFacts("facts_legacy_v2");
      return;
    }

    if (hasLegacy) {
      throw new Error("facts_legacy_v2 already exists while facts is not in unified schema");
    }

    this.db.exec(`ALTER TABLE facts RENAME TO facts_legacy_v2`);
    this.db.exec(createFactsTableSql());
    this._backfillLegacyFacts("facts_legacy_v2");
  }

  _ensureColumn(tableName, columnName, sqlDef) {
    const hasColumn = this.db.prepare(`PRAGMA table_info(${tableName})`).all().some((row) => row.name === columnName);
    if (!hasColumn) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqlDef}`);
    }
  }

  _ensureFactsColumns() {
    const hasFacts = !!this.db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'facts'
      LIMIT 1
    `).get();
    if (!hasFacts) return;
    this._ensureColumn("facts", "memory_kind", "TEXT NOT NULL DEFAULT 'semantic'");
    this._ensureColumn("facts", "decision_key", "TEXT");
    this._ensureColumn("facts", "staleness_hint", "TEXT");
    this.db.exec(`
      UPDATE facts
      SET memory_kind = CASE
        WHEN COALESCE(memory_kind, '') <> '' THEN memory_kind
        WHEN timeliness = 'stateful' THEN 'state'
        WHEN scope = 'profile' AND timeliness = 'persistent' THEN 'profile_preference'
        ELSE 'background'
      END
    `);
  }

  _ensureEpisodeColumns() {
    const hasEpisodes = !!this.db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'episodes'
      LIMIT 1
    `).get();
    if (!hasEpisodes) return;
    this._ensureColumn("episodes", "episode_kind", "TEXT NOT NULL DEFAULT 'conversation'");
    this._ensureColumn("episodes", "tags", "TEXT NOT NULL DEFAULT '[]'");
    this.db.exec(`
      UPDATE episodes
      SET episode_kind = COALESCE(NULLIF(TRIM(episode_kind), ''), 'conversation'),
          tags = COALESCE(NULLIF(tags, ''), '[]')
    `);
  }

  _ensurePlaybookColumns() {
    const hasPlaybooks = !!this.db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'playbooks'
      LIMIT 1
    `).get();
    if (!hasPlaybooks) return;
    this._ensureColumn("playbooks", "scope", "TEXT NOT NULL DEFAULT 'agent'");
    this.db.exec(`
      UPDATE playbooks
      SET scope = COALESCE(NULLIF(TRIM(scope), ''), 'agent')
    `);
  }

  _hasUnifiedFactsSchema() {
    const rows = this.db.prepare(`PRAGMA table_info(facts)`).all();
    const cols = new Set(rows.map((row) => row.name));
    const required = [
      "fact",
      "tags",
      "time",
      "timeliness",
      "state_key",
      "valid_from",
      "valid_to",
      "is_active",
      "session_id",
      "created_at",
      "scope",
      "origin",
      "source_refs",
      "truth_time",
      "confidence",
      "importance",
      "subject_id",
      "memory_kind",
      "decision_key",
      "staleness_hint",
      "hash",
      "updated_at",
      "invalidated_by",
    ];
    return required.every((name) => cols.has(name));
  }

  _backfillLegacyFacts(legacyTableName) {
    const columns = this.db.prepare(`PRAGMA table_info(${legacyTableName})`).all().map((row) => row.name);
    const has = (name) => columns.includes(name);
    const legacyMemoryKind = has("memory_kind") ? "NULLIF(TRIM(memory_kind), '')" : "NULL";
    const sourceSql = `
      INSERT INTO facts (
        id, fact, tags, time, timeliness, state_key, valid_from, valid_to, is_active, session_id,
        created_at, scope, origin, source_refs, truth_time, confidence, importance, subject_id,
        memory_kind, decision_key, staleness_hint, hash, updated_at, invalidated_by
      )
      SELECT
        id,
        fact,
        COALESCE(tags, '[]'),
        time,
        COALESCE(${has("timeliness") ? "timeliness" : "'persistent'"}, 'persistent'),
        ${has("state_key") ? "state_key" : "NULL"},
        ${has("valid_from") ? "valid_from" : "COALESCE(time, created_at)"},
        ${has("valid_to") ? "valid_to" : "NULL"},
        CASE
          WHEN ${has("is_active") ? "COALESCE(is_active, 1)" : "1"} = 0 THEN 0
          WHEN ${has("valid_to") ? "valid_to IS NOT NULL AND valid_to < CURRENT_TIMESTAMP" : "0"} THEN 0
          ELSE 1
        END,
        ${has("session_id") ? "session_id" : "NULL"},
        COALESCE(created_at, CURRENT_TIMESTAMP),
        COALESCE(${has("scope") ? "scope" : "'agent'"}, 'agent'),
        COALESCE(${has("origin") ? "origin" : "'import'"}, 'import'),
        COALESCE(${has("source_refs") ? "source_refs" : "'[]'"}, '[]'),
        ${has("time") ? "time" : "NULL"},
        ${has("confidence") ? "confidence" : "NULL"},
        ${has("importance") ? "importance" : "NULL"},
        ${has("subject_id") ? "subject_id" : "NULL"},
        CASE
          WHEN ${legacyMemoryKind} IS NOT NULL THEN ${legacyMemoryKind}
          WHEN COALESCE(${has("timeliness") ? "timeliness" : "'persistent'"}, 'persistent') = 'stateful' THEN 'state'
          WHEN COALESCE(${has("scope") ? "scope" : "'agent'"}, 'agent') = 'profile'
               AND COALESCE(${has("timeliness") ? "timeliness" : "'persistent'"}, 'persistent') = 'persistent' THEN 'profile_preference'
          ELSE 'background'
        END,
        ${has("decision_key") ? "decision_key" : "NULL"},
        ${has("staleness_hint") ? "staleness_hint" : "NULL"},
        COALESCE(${has("hash") ? "hash" : "''"}, ''),
        COALESCE(${has("updated_at") ? "updated_at" : "created_at"}, CURRENT_TIMESTAMP),
        ${has("invalidated_by") ? "invalidated_by" : "NULL"}
      FROM ${legacyTableName}
    `;
    this.db.exec(sourceSql);

    const legacyCount = this.db.prepare(`SELECT COUNT(*) AS cnt FROM ${legacyTableName}`).get().cnt;
    const newCount = this.db.prepare(`SELECT COUNT(*) AS cnt FROM facts`).get().cnt;
    if (legacyCount !== newCount) {
      throw new Error(`facts migration count mismatch: legacy=${legacyCount}, new=${newCount}`);
    }
  }

  _prepareStatements() {
    this._stmts = {
      insert: this.db.prepare(`
        INSERT INTO facts (
          fact, tags, time, timeliness, state_key, valid_from, valid_to, is_active, session_id,
          created_at, scope, origin, source_refs, truth_time, confidence, importance, subject_id,
          memory_kind, decision_key, staleness_hint, hash, updated_at, invalidated_by
        )
        VALUES (
          @fact, @tags, @time, @timeliness, @stateKey, @validFrom, @validTo, @isActive, @sessionId,
          @createdAt, @scope, @origin, @sourceRefs, @truthTime, @confidence, @importance, @subjectId,
          @memoryKind, @decisionKey, @stalenessHint, @hash, @updatedAt, @invalidatedBy
        )
      `),
      deactivateByStateKey: this.db.prepare(`
        UPDATE facts
        SET is_active = 0,
            valid_to = COALESCE(valid_to, @validTo),
            updated_at = @validTo,
            invalidated_by = COALESCE(invalidated_by, @invalidatedBy)
        WHERE state_key = @stateKey AND scope = @scope AND is_active = 1
      `),
      deactivateByDecisionKey: this.db.prepare(`
        UPDATE facts
        SET is_active = 0,
            valid_to = COALESCE(valid_to, @validTo),
            updated_at = @validTo,
            invalidated_by = COALESCE(invalidated_by, @invalidatedBy)
        WHERE decision_key = @decisionKey AND scope = @scope AND is_active = 1
      `),
      deactivateById: this.db.prepare(`
        UPDATE facts
        SET is_active = 0,
            valid_to = COALESCE(valid_to, @validTo),
            updated_at = @validTo,
            invalidated_by = COALESCE(invalidated_by, @invalidatedBy)
        WHERE id = @id AND is_active = 1
      `),
      getAll: this.db.prepare(`SELECT * FROM facts ORDER BY COALESCE(truth_time, time, updated_at, created_at) DESC, id DESC`),
      getById: this.db.prepare(`SELECT * FROM facts WHERE id = ?`),
      getBySession: this.db.prepare(`SELECT * FROM facts WHERE session_id = ? ORDER BY time DESC`),
      count: this.db.prepare(`SELECT COUNT(*) as cnt FROM facts WHERE is_active = 1`),
      deleteById: this.db.prepare(`
        UPDATE facts
        SET is_active = 0,
            valid_to = COALESCE(valid_to, @validTo),
            updated_at = @updatedAt,
            invalidated_by = COALESCE(invalidated_by, @invalidatedBy)
        WHERE id = @id AND is_active = 1
      `),
      deleteAll: this.db.prepare(`
        UPDATE facts
        SET is_active = 0,
            valid_to = COALESCE(valid_to, @validTo),
            updated_at = @updatedAt,
            invalidated_by = COALESCE(invalidated_by, @invalidatedBy)
        WHERE is_active = 1
      `),
    };

    if (this._ftsEnabled) {
      this._stmts.ftsSearch = this.db.prepare(`
        SELECT f.*, rank
        FROM facts_fts fts
        JOIN facts f ON f.id = fts.rowid
        WHERE facts_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `);
      this._stmts.ftsSearchActive = this.db.prepare(`
        SELECT f.*, rank
        FROM facts_fts fts
        JOIN facts f ON f.id = fts.rowid
        WHERE facts_fts MATCH ?
          AND f.is_active = 1
          AND (f.valid_from IS NULL OR f.valid_from <= ?)
          AND (f.valid_to IS NULL OR f.valid_to >= ?)
        ORDER BY rank
        LIMIT ?
      `);
    }
  }

  /**
   * 新增一条元事实
   * @param {{
   *  fact: string,
   *  tags: string[],
   *  time?: string,
   *  session_id?: string,
   *  timeliness?: "persistent"|"stateful"|"ephemeral",
   *  state_key?: string,
   *  ttl_days?: number,
   *  valid_from?: string,
   *  valid_to?: string,
   *  scope?: "agent"|"channel"|"profile",
   *  origin?: "assistant"|"session"|"channel"|"import"|"system"|"tool",
   *  source_refs?: Array<string|{ type?: string, id?: string, layer?: string }>,
   *  truth_time?: string,
   *  confidence?: number,
   *  importance?: number,
   *  subject_id?: string,
   *  hash?: string,
   *  invalidated_by?: string
   * }} entry
   * @returns {{ id: number }}
   */
  add(entry) {
    const { cleaned, detected } = scrubPII(entry.fact);
    if (detected.length > 0) {
      console.warn(`[FactStore] PII detected (${detected.join(", ")}), redacted before storage`);
    }

   const now = new Date().toISOString();
   const timeliness = normalizeTimeliness(entry.timeliness);
    const memoryKind = normalizeMemoryKind(entry.memory_kind);
    const stateKey = timeliness === "stateful" ? normalizeStateKey(entry.state_key) : null;
    const decisionKey = normalizeDecisionKey(entry.decision_key);
    const scope = normalizeScope(entry.scope);
    const origin = normalizeOrigin(entry.origin);

    if (origin === "channel" && scope === "profile") {
      throw new Error("origin=channel cannot write scope=profile");
    }

    const validFrom = toIso(entry.valid_from || entry.time || now);
    let validTo = toIso(entry.valid_to);

    if (timeliness === "ephemeral" && !validTo) {
      const ttlDays = normalizeTtlDays(entry.ttl_days);
      validTo = addDaysIso(validFrom || now, ttlDays);
    }

    if (stateKey) {
      // 同一状态键的新事实到来时，自动让旧事实失效（通用“新状态覆盖旧状态”规则）。
      this._stmts.deactivateByStateKey.run({
        stateKey,
        scope,
        validTo: validFrom || now,
        invalidatedBy: entry.invalidated_by || `state_key:${stateKey}`,
      });

      // 兼容旧数据：对没有 state_key 的历史事实做一次保守失效。
      // 条件：标签重合度足够高（>=2），避免误伤无关事实。
      const tags = Array.isArray(entry.tags) ? entry.tags.filter(Boolean) : [];
      if (tags.length >= 2) {
        const legacy = this.searchByTags(tags, undefined, 100, { includeInactive: true })
          .filter((r) => r.is_active && !r.state_key && r.scope === scope && (r.matchCount || 0) >= 2);
        for (const r of legacy) {
          this._stmts.deactivateById.run({
            id: r.id,
            validTo: validFrom || now,
            invalidatedBy: entry.invalidated_by || `state_key:${stateKey}`,
          });
        }
      }
    }

    if (memoryKind === "decision" && decisionKey) {
      this._stmts.deactivateByDecisionKey.run({
        decisionKey,
        scope,
        validTo: validFrom || now,
        invalidatedBy: entry.invalidated_by || `decision_key:${decisionKey}`,
      });
    }

    const isActive = validTo && validTo < now ? 0 : 1;
    const result = this._stmts.insert.run({
      fact: cleaned,
      tags: JSON.stringify(entry.tags || []),
      time: entry.time || null,
      timeliness,
      stateKey,
      validFrom,
      validTo,
      isActive,
      sessionId: entry.session_id || null,
      createdAt: now,
      scope,
      origin,
      sourceRefs: toJson(entry.source_refs, []),
      truthTime: toIso(entry.truth_time || entry.time),
      confidence: Number.isFinite(entry.confidence) ? Number(entry.confidence) : null,
      importance: Number.isFinite(entry.importance) ? Number(entry.importance) : null,
      subjectId: typeof entry.subject_id === "string" ? entry.subject_id.trim() || null : null,
      memoryKind,
      decisionKey,
      stalenessHint: typeof entry.staleness_hint === "string" ? entry.staleness_hint.trim() || null : null,
      hash: typeof entry.hash === "string" ? entry.hash : "",
      updatedAt: now,
      invalidatedBy: entry.invalidated_by || null,
    });
    return { id: Number(result.lastInsertRowid) };
  }

  /**
   * 批量新增（事务）
   * @param {Array<{ fact: string, tags: string[], time?: string, session_id?: string, timeliness?: string, state_key?: string, ttl_days?: number, valid_from?: string, valid_to?: string }>} entries
   * @returns {number} 写入条数
   */
  addBatch(entries) {
    const run = this.db.transaction(() => {
      for (const entry of entries) {
        this.add(entry);
      }
    });
    run();
    return entries.length;
  }

  /**
   * 按标签搜索（精确匹配，OR 逻辑，按匹配数降序）
   *
   * 使用 json_each 精确匹配标签值，避免 LIKE 子串误匹配
   *
   * @param {string[]} queryTags - 查询标签
   * @param {{ from?: string, to?: string }} [dateRange] - 可选日期范围（YYYY-MM-DD 或 YYYY-MM-DDTHH:MM）
   * @param {number} [limit=20] - 最大返回数
   * @param {{ includeInactive?: boolean }} [opts]
   * @returns {Array<{ id, fact, tags, time, session_id, created_at, matchCount }>}
   */
  searchByTags(queryTags, dateRange, limit = 20, opts = {}) {
    if (!queryTags || queryTags.length === 0) return [];
    const includeInactive = opts.includeInactive === true;

    const stmt = this._getTagSearchStmt(queryTags.length, dateRange, includeInactive);

    const params = { limit };
    for (let i = 0; i < queryTags.length; i++) {
      params[`tag${i}`] = queryTags[i];
    }
    if (dateRange?.from) params.dateFrom = dateRange.from;
    if (dateRange?.to) params.dateTo = dateRange.to;
    if (!includeInactive) params.nowIso = new Date().toISOString();

    const rows = stmt.all(params);
    return rows.map((row) => this._rowToFact(row));
  }

  /** 按 (tagCount, dateRangeType, includeInactive) 缓存 prepared statement */
  _getTagSearchStmt(tagCount, dateRange, includeInactive = false) {
    // dateRange 类型编码：0=无, 1=from, 2=to, 3=both
    const dateKey = (dateRange?.from ? 1 : 0) | (dateRange?.to ? 2 : 0);
    const activeKey = includeInactive ? 1 : 0;
    const cacheKey = `${tagCount}:${dateKey}:${activeKey}`;

    let stmt = this._tagSearchCache.get(cacheKey);
    if (stmt) return stmt;

    const placeholders = Array.from({ length: tagCount }, (_, i) => `@tag${i}`).join(", ");
    let dateWhere = "";
    if (dateKey & 1) dateWhere += ` AND f.time >= @dateFrom`;
    if (dateKey & 2) dateWhere += ` AND f.time <= @dateTo`;
    const activeWhere = includeInactive
      ? ""
      : `
        AND f.is_active = 1
        AND (f.valid_from IS NULL OR f.valid_from <= @nowIso)
        AND (f.valid_to IS NULL OR f.valid_to >= @nowIso)
      `;

    const sql = `
      SELECT f.*, COUNT(DISTINCT je.value) as matchCount
      FROM facts f, json_each(f.tags) je
      WHERE je.value IN (${placeholders})${dateWhere}${activeWhere}
      GROUP BY f.id
      ORDER BY matchCount DESC, f.time DESC
      LIMIT @limit
    `;

    stmt = this.db.prepare(sql);
    this._tagSearchCache.set(cacheKey, stmt);
    return stmt;
  }

  /**
   * 全文搜索（FTS5）
   *
   * @param {string} query - 搜索查询
   * @param {number} [limit=20]
   * @param {{ includeInactive?: boolean }} [opts]
   * @returns {Array<{ id, fact, tags, time, session_id, created_at }>}
   */
  searchFullText(query, limit = 20, opts = {}) {
    if (!query || !query.trim()) return [];
    const includeInactive = opts.includeInactive === true;
    const rows = [];
    const seen = new Set();
    const terms = buildSearchTerms(query);

    if (this._ftsEnabled) {
      try {
        const ftsTerms = terms.length > 0 ? terms : [query.trim()];
        const ftsQuery = ftsTerms
          .map((term) => `"${term.replace(/"/g, '""')}"`)
          .join(" OR ");

        const nowIso = new Date().toISOString();
        const ftsRows = includeInactive
          ? this._stmts.ftsSearch.all(ftsQuery, limit)
          : this._stmts.ftsSearchActive.all(ftsQuery, nowIso, nowIso, limit);
        for (const row of ftsRows) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          rows.push(row);
        }
      } catch {}
    }

    for (const row of this._likeFallbackRows(query, limit, { includeInactive, terms })) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }

    return rows.slice(0, limit).map((row) => this._rowToFact(row));
  }

  /**
   * LIKE 降级搜索（FTS 失败时使用）
   */
  _likeFallback(query, limit, opts = {}) {
    return this._likeFallbackRows(query, limit, opts).map((row) => this._rowToFact(row));
  }

  _likeFallbackRows(query, limit, opts = {}) {
    const includeInactive = opts.includeInactive === true;
    const terms = Array.isArray(opts.terms) && opts.terms.length > 0
      ? opts.terms
      : buildSearchTerms(query);
    if (terms.length === 0) return [];
    const nowIso = new Date().toISOString();
    const likeWhere = terms.map(() => `fact LIKE '%' || ? || '%'`).join(" OR ");
    const orderBy = `ORDER BY COALESCE(truth_time, time, updated_at, created_at) DESC, id DESC`;
    if (includeInactive) {
      return this.db.prepare(`
        SELECT *
        FROM facts
        WHERE ${likeWhere}
        ${orderBy}
        LIMIT ?
      `).all(...terms, limit);
    }
    return this.db.prepare(`
        SELECT *
        FROM facts
        WHERE (${likeWhere})
          AND is_active = 1
          AND (valid_from IS NULL OR valid_from <= ?)
          AND (valid_to IS NULL OR valid_to >= ?)
        ${orderBy}
        LIMIT ?
      `).all(...terms, nowIso, nowIso, limit);
  }

  /** 获取所有元事实（按时间降序） */
  getAll() {
    return this._stmts.getAll.all().map((row) => this._rowToFact(row));
  }

  /** 按 session_id 查询 */
  getBySession(sessionId) {
    return this._stmts.getBySession.all(sessionId).map((row) => this._rowToFact(row));
  }

  /** 按 id 查询 */
  getById(id) {
    const row = this._stmts.getById.get(id);
    return row ? this._rowToFact(row) : null;
  }

  get size() {
    return this._stmts.count.get().cnt;
  }

  /** 删除单条 */
  delete(id) {
    const now = new Date().toISOString();
    return this._stmts.deleteById.run({
      id,
      validTo: now,
      updatedAt: now,
      invalidatedBy: "delete",
    }).changes > 0;
  }

  /** 清空所有 */
  clearAll() {
    const now = new Date().toISOString();
    this._stmts.deleteAll.run({
      validTo: now,
      updatedAt: now,
      invalidatedBy: "clear_all",
    });
  }

  /** 导出所有（不含内部字段），供 API 使用 */
  exportAll() {
    return this.getAll();
  }

  /**
   * 批量导入
   * @param {Array<{ fact, tags, time?, session_id?, timeliness?, state_key?, ttl_days?, valid_from?, valid_to?, scope?, origin?, source_refs?, truth_time?, confidence?, importance?, subject_id?, memory_kind?, decision_key?, staleness_hint?, hash?, invalidated_by? }>} entries
   */
  importAll(entries) {
    const run = this.db.transaction(() => {
      for (const entry of entries) {
        this.add({
          fact: entry.fact,
          tags: entry.tags || [],
          time: entry.time || null,
          timeliness: entry.timeliness,
          state_key: entry.state_key || null,
          ttl_days: entry.ttl_days ?? null,
          valid_from: entry.valid_from || null,
          valid_to: entry.valid_to || null,
          session_id: entry.session_id || null,
          scope: entry.scope || "agent",
          origin: entry.origin || "import",
          source_refs: entry.source_refs || [],
          truth_time: entry.truth_time || entry.time || null,
          confidence: entry.confidence ?? null,
          importance: entry.importance ?? null,
          subject_id: entry.subject_id || null,
          memory_kind: entry.memory_kind || null,
          decision_key: entry.decision_key || null,
          staleness_hint: entry.staleness_hint || null,
          hash: entry.hash || "",
          invalidated_by: entry.invalidated_by || null,
        });
      }
    });
    run();
  }

  /** 关闭数据库连接 */
  close() {
    if (this.db?.open) this.db.close();
  }

  /** 行 → 对象 */
  _rowToFact(row) {
    return {
      id: row.id,
      fact: row.fact,
      tags: (() => {
        try { return JSON.parse(row.tags); } catch { return []; }
      })(),
      time: row.time,
      timeliness: row.timeliness || "persistent",
      state_key: row.state_key || null,
      valid_from: row.valid_from || null,
      valid_to: row.valid_to || null,
      is_active: row.is_active === 1,
      session_id: row.session_id,
      created_at: row.created_at,
      scope: row.scope || "agent",
      origin: row.origin || "assistant",
      source_refs: (() => {
        try { return JSON.parse(row.source_refs || "[]"); } catch { return []; }
      })(),
      truth_time: row.truth_time || null,
      confidence: row.confidence ?? null,
      importance: row.importance ?? null,
      subject_id: row.subject_id || null,
      memory_kind: normalizeMemoryKind(row.memory_kind),
      decision_key: row.decision_key || null,
      staleness_hint: row.staleness_hint || null,
      hash: row.hash || "",
      updated_at: row.updated_at || row.created_at,
      invalidated_by: row.invalidated_by || null,
      matchCount: row.matchCount ?? undefined,
      rank: row.rank ?? undefined,
    };
  }
}
