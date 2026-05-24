import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { FactStore } from "./fact-store.js";
import { assemble, buildFactsProjection } from "./compile.js";
import { scrubPII } from "../pii-guard.js";

export const MEMORY_LAYERS = ["facts", "episodes", "evidence", "playbooks", "inactive"];
export const MEMORY_RANKING_VERSION = "rank_v1";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const SUMMARY_PROJECTION_KEY = "current_summary";
const PROFILE_KEY = "default";
const JOB_STATUS_PENDING = "pending";
const JOB_STATUS_RUNNING = "running";
const JOB_STATUS_DONE = "done";
const JOB_STATUS_RETRY = "retry";
const JOB_STATUS_DEAD = "dead";
const RETRIEVAL_LOG_SAMPLE_RATE = 1;
const RETRIEVAL_LOG_RETENTION_DAYS = 30;
const MEMORY_ORIGIN_SET = new Set(["assistant", "session", "channel", "import", "system", "tool"]);
const MEMORY_RANKING_WEIGHTS = {
  bm25: 0.35,
  tag: 0.2,
  entity: 0.15,
  recency: 0.15,
  confidence: 0.075,
  importance: 0.075,
};

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeTextAtomic(filePath, content) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, safeText(content), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function safeText(value) {
  return typeof value === "string" ? value : "";
}

function trimText(value) {
  return safeText(value).trim();
}

function normalizeMarkText(value) {
  const text = trimText(value);
  if (!text) return "";

  const fmMatch = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*([\s\S]*)$/);
  if (!fmMatch) return text;

  const body = trimText(fmMatch[2]);
  if (body) return body;

  const meta = {};
  for (const rawLine of fmMatch[1].split(/\r?\n/)) {
    const line = trimText(rawLine);
    if (!line || !line.includes(":")) continue;
    const idx = line.indexOf(":");
    const key = trimText(line.slice(0, idx)).toLowerCase();
    const val = trimText(line.slice(idx + 1));
    if (!key || !val) continue;
    meta[key] = val.replace(/^["']|["']$/g, "");
  }

  return trimText(meta.description || meta.name || text);
}

function previewText(value, max = 180) {
  const text = trimText(value).replace(/\s+/g, " ");
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringifyJson(value, fallback = {}) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function encodeMemoryId(layer, rawId) {
  return `${layer}:${rawId}`;
}

function decodeMemoryId(id, fallbackLayer = "") {
  const raw = trimText(id);
  if (!raw) return { layer: fallbackLayer, rawId: "" };
  const idx = raw.indexOf(":");
  if (idx === -1) return { layer: fallbackLayer, rawId: raw };
  return {
    layer: raw.slice(0, idx),
    rawId: raw.slice(idx + 1),
  };
}

function normalizePageSize(limit) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, parsed));
}

function decodeCursor(cursor) {
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function toEpochMs(value) {
  const text = trimText(value);
  if (!text) return 0;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function tokenizeText(value) {
  const text = String(value || "").toLowerCase().trim();
  if (!text) return [];
  const set = new Set();
  const latin = text.match(/[a-z0-9_]+/g) || [];
  for (const token of latin) {
    if (token.length >= 2) set.add(token);
  }
  const cjk = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const token of cjk) set.add(token);
  if (set.size === 0 && text.length >= 2) set.add(text);
  return [...set];
}

function normalizeBm25Score(rawRank) {
  const n = Number(rawRank);
  if (!Number.isFinite(n)) return 0;
  const normalized = 1 / (1 + Math.abs(n));
  return clamp01(normalized);
}

function normalizeSourceRef(ref) {
  if (typeof ref === "string") {
    const text = ref.trim();
    if (!text) return null;
    return { layer: "evidence", id: text };
  }
  if (!ref || typeof ref !== "object") return null;
  const layer = trimText(ref.layer || ref.type || "");
  const id = trimText(ref.id || ref.refId || ref.value || "");
  if (!id) return null;
  return {
    layer: layer || "evidence",
    id,
  };
}

function normalizeSourceRefs(refs) {
  if (!Array.isArray(refs)) return [];
  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    const normalized = normalizeSourceRef(ref);
    if (!normalized) continue;
    const key = `${normalized.layer}:${normalized.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function formatPinnedMarkdown(items) {
  if (!items.length) return "";
  return items.map((item) => `- ${item.text}`).join("\n") + "\n";
}

function playbookToCompatibilityText(playbook) {
  return [
    `Trigger: ${playbook.trigger}`,
    `Wrong path: ${playbook.wrongPath}`,
    `Root cause: ${playbook.rootCause}`,
    `Fix steps: ${playbook.fixSteps}`,
    `Validation: ${playbook.validation}`,
  ].join("\n");
}

function formatCompatibilityExperienceFiles(playbooks) {
  const byCategory = new Map();
  for (const playbook of playbooks) {
    const category = playbook.category || "General";
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(playbook);
  }

  const files = [];
  for (const [category, rows] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const filename = `${category}.md`;
    const body = rows.map((row, index) => {
      return `${index + 1}. ${row.trigger}\n   ${row.wrongPath}\n   ${row.rootCause}\n   ${row.fixSteps}\n   ${row.validation}`;
    }).join("\n");
    files.push({ category, filename, body: body ? `${body}\n` : "" });
  }
  return files;
}

function formatCompatibilityExperienceIndex(playbooks) {
  const files = formatCompatibilityExperienceFiles(playbooks);
  if (!files.length) return "";
  return files.map(({ category, filename, body }) => {
    const entries = body
      .split("\n")
      .filter((line) => /^\d+\.\s/.test(line.trim()))
      .map((line) => line.replace(/^\d+\.\s*/, "").trim());
    const snippets = entries.map((entry) => previewText(entry, 20));
    let description = snippets.join("; ");
    if (description.length > 120) description = `${description.slice(0, 117)}...`;
    return `# ${category} (${entries.length})\n${description}\n-> experience/${filename}`;
  }).join("\n\n") + "\n";
}

function parseLegacyExperienceMarkdown(content) {
  const categories = [];
  let current = null;
  for (const rawLine of safeText(content).split("\n")) {
    const heading = rawLine.match(/^#\s+(.+)/);
    if (heading) {
      current = { name: heading[1].trim(), entries: [] };
      categories.push(current);
      continue;
    }
    if (!current) continue;
    const entry = rawLine.replace(/^\d+\.\s*/, "").trim();
    if (entry) current.entries.push(entry);
  }
  return categories;
}

function legacyEntryToPlaybook(category, entry) {
  const text = trimText(entry);
  if (!text) return null;
  return {
    category,
    trigger: text,
    wrongPath: "(legacy compatibility entry)",
    rootCause: "(legacy compatibility entry)",
    fixSteps: text,
    validation: "(legacy compatibility entry)",
  };
}

function normalizePlaybookInput(input = {}) {
  return {
    category: trimText(input.category),
    trigger: trimText(input.trigger),
    wrongPath: trimText(input.wrongPath || input.wrong_path),
    rootCause: trimText(input.rootCause || input.root_cause),
    fixSteps: trimText(input.fixSteps || input.fix_steps),
    validation: trimText(input.validation),
  };
}

function assertPlaybookFields(playbook) {
  const missing = [];
  if (!playbook.trigger) missing.push("trigger");
  if (!playbook.wrongPath) missing.push("wrong_path");
  if (!playbook.rootCause) missing.push("root_cause");
  if (!playbook.fixSteps) missing.push("fix_steps");
  if (!playbook.validation) missing.push("validation");
  if (missing.length > 0) {
    throw new Error(`playbook missing required fields: ${missing.join(", ")}`);
  }
}

function computeEvidenceHash(payload) {
  return crypto.createHash("sha256").update(stringifyJson(payload, {})).digest("hex");
}

function normalizeFactEntry(entry = {}) {
  return {
    fact: trimText(entry.fact),
    tags: Array.isArray(entry.tags) ? entry.tags.map((item) => trimText(item)).filter(Boolean) : [],
    time: trimText(entry.time) || null,
    timeliness: trimText(entry.timeliness) || "persistent",
    state_key: trimText(entry.state_key || entry.stateKey) || null,
    ttl_days: entry.ttl_days ?? entry.ttlDays ?? null,
    valid_from: trimText(entry.valid_from || entry.validFrom) || null,
    valid_to: trimText(entry.valid_to || entry.validTo) || null,
    session_id: trimText(entry.session_id || entry.sessionId) || null,
    scope: trimText(entry.scope) || "agent",
    origin: trimText(entry.origin) || "assistant",
    source_refs: normalizeSourceRefs(entry.source_refs || entry.sourceRefs),
    truth_time: trimText(entry.truth_time || entry.truthTime || entry.time) || null,
    confidence: entry.confidence ?? null,
    importance: entry.importance ?? null,
    subject_id: trimText(entry.subject_id || entry.subjectId) || null,
    hash: trimText(entry.hash) || "",
    invalidated_by: trimText(entry.invalidated_by || entry.invalidatedBy) || null,
  };
}

function normalizeImportedMarkRecord(item, fallbackTs = nowIso()) {
  const raw = (item && typeof item === "object") ? item : { text: item };
  const text = normalizeMarkText(raw.text);
  if (!text) return null;
  const active = raw.active === false ? 0 : 1;
  const createdAt = trimText(raw.createdAt || raw.created_at) || fallbackTs;
  const updatedAt = trimText(raw.updatedAt || raw.updated_at) || createdAt;
  return {
    id: trimText(raw.id) || createId("mark"),
    text,
    factId: Number.isInteger(raw.factId) ? raw.factId : (Number.isInteger(raw.fact_id) ? raw.fact_id : null),
    active,
    sourceRefs: normalizeSourceRefs(raw.sourceRefs || raw.source_refs || []),
    createdAt,
    updatedAt,
    archivedAt: active ? null : (trimText(raw.archivedAt || raw.archived_at) || updatedAt),
    invalidatedBy: trimText(raw.invalidatedBy || raw.invalidated_by) || (active ? null : "import"),
  };
}

function normalizeImportedPlaybookRecord(item = {}, fallbackTs = nowIso()) {
  const playbook = normalizePlaybookInput(item);
  assertPlaybookFields(playbook);
  const active = item.active === false ? 0 : 1;
  const createdAt = trimText(item.createdAt || item.created_at) || fallbackTs;
  const updatedAt = trimText(item.updatedAt || item.updated_at) || createdAt;
  return {
    id: trimText(item.id) || createId("playbook"),
    category: playbook.category,
    trigger: playbook.trigger,
    wrongPath: playbook.wrongPath,
    rootCause: playbook.rootCause,
    fixSteps: playbook.fixSteps,
    validation: playbook.validation,
    active,
    origin: trimText(item.origin) || "assistant",
    sourceRefs: normalizeSourceRefs(item.sourceRefs || item.source_refs || []),
    createdAt,
    updatedAt,
    archivedAt: active ? null : (trimText(item.archivedAt || item.archived_at) || updatedAt),
    invalidatedBy: trimText(item.invalidatedBy || item.invalidated_by) || (active ? null : "import"),
  };
}

export class MemoryService {
  constructor({
    agentId,
    agentDir,
    userDir,
    factStore = null,
    onChanged = null,
    autoRunJobs = true,
  }) {
    this.agentId = agentId;
    this.agentDir = agentDir;
    this.userDir = userDir;
    this.memoryDir = path.join(agentDir, "memory");
    ensureDir(this.memoryDir);
    this._factStore = factStore || new FactStore(path.join(this.memoryDir, "facts.db"));
    this._ownsFactStore = !factStore;
    this.localDb = this._factStore.db;
    this.globalDbPath = path.join(userDir, "user-memory.db");
    ensureDir(userDir);
    this.globalDb = new Database(this.globalDbPath);
    this.globalDb.pragma("journal_mode = WAL");
    this.globalDb.pragma("synchronous = NORMAL");
    this._onChanged = typeof onChanged === "function" ? onChanged : null;
    this._autoRunJobs = autoRunJobs !== false;
    this._initGlobalSchema();
    this._repairLegacyMarkTexts();
  }

  static fromEngine(engine, agentId = null) {
    const targetAgentId = trimText(agentId) || engine.currentAgentId;
    const agent = targetAgentId ? engine.getAgent?.(targetAgentId) : null;
    if (agent?.memoryService) return agent.memoryService;

    const baseDir = targetAgentId ? path.join(engine.agentsDir, targetAgentId) : engine.agentDir;
    const isCurrent = !targetAgentId || targetAgentId === engine.currentAgentId;
    const factStore = isCurrent ? engine.factStore : null;
    const service = new MemoryService({
      agentId: targetAgentId || engine.currentAgentId,
      agentDir: baseDir,
      userDir: engine.userDir,
      factStore,
      onChanged: isCurrent ? () => engine.agent?.refreshSystemPrompt?.() : null,
      autoRunJobs: isCurrent,
    });
    service._isDetached = true;
    return service;
  }

  close() {
    if (this._ownsFactStore) this._factStore.close();
    if (this.globalDb?.open) this.globalDb.close();
  }

  get factStore() {
    return this._factStore;
  }

  _initGlobalSchema() {
    this.globalDb.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        profile_key TEXT PRIMARY KEY,
        content     TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        version     INTEGER NOT NULL DEFAULT 1
      );
    `);
  }

  _notifyChanged() {
    try {
      this._onChanged?.();
    } catch {}
  }

  _requireOrigin(origin, label = "origin") {
    const nextOrigin = trimText(origin);
    if (!nextOrigin) throw new Error(`${label} is required`);
    if (!MEMORY_ORIGIN_SET.has(nextOrigin)) {
      throw new Error(`${label} must be one of: ${[...MEMORY_ORIGIN_SET].join(", ")}`);
    }
    return nextOrigin;
  }

  _writeSummaryProjectionRecord(content, { sourceScope = "agent", generatedAt = null, updatedAt = null } = {}) {
    const nextContent = safeText(content);
    const generated = trimText(generatedAt) || nowIso();
    const updated = trimText(updatedAt) || generated;
    this.localDb.prepare(`
      INSERT INTO memory_projections (
        key, kind, content, source_scope, generated_at, updated_at
      ) VALUES (?, 'projection', ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        kind = excluded.kind,
        content = excluded.content,
        source_scope = excluded.source_scope,
        generated_at = excluded.generated_at,
        updated_at = excluded.updated_at
    `).run(SUMMARY_PROJECTION_KEY, nextContent, sourceScope, generated, updated);
    return {
      content: nextContent,
      generatedAt: generated,
      updatedAt: updated,
      sourceScope,
    };
  }

  _upsertImportedMark(item) {
    const row = normalizeImportedMarkRecord(item);
    if (!row) return null;
    this.localDb.prepare(`
      INSERT INTO memory_marks (
        id, kind, text, fact_id, active, source_refs, created_at, updated_at, archived_at, invalidated_by
      ) VALUES (?, 'pinned', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        text = excluded.text,
        fact_id = excluded.fact_id,
        active = excluded.active,
        source_refs = excluded.source_refs,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        archived_at = excluded.archived_at,
        invalidated_by = excluded.invalidated_by
    `).run(
      row.id,
      row.text,
      row.factId,
      row.active,
      stringifyJson(row.sourceRefs, []),
      row.createdAt,
      row.updatedAt,
      row.archivedAt,
      row.invalidatedBy,
    );
    return row.id;
  }

  _upsertImportedPlaybook(item) {
    const row = normalizeImportedPlaybookRecord(item);
    const sourceRefs = this._ensurePlaybookSourceRefs(row, {
      sourceRefs: row.sourceRefs,
      origin: row.origin,
      scope: "agent",
      sourceType: "playbook_import",
      sourceId: row.id,
    });
    this.localDb.prepare(`
      INSERT INTO playbooks (
        id, category, trigger, wrong_path, root_cause, fix_steps, validation, active,
        origin, source_refs, created_at, updated_at, archived_at, invalidated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        category = excluded.category,
        trigger = excluded.trigger,
        wrong_path = excluded.wrong_path,
        root_cause = excluded.root_cause,
        fix_steps = excluded.fix_steps,
        validation = excluded.validation,
        active = excluded.active,
        origin = excluded.origin,
        source_refs = excluded.source_refs,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        archived_at = excluded.archived_at,
        invalidated_by = excluded.invalidated_by
    `).run(
      row.id,
      row.category,
      row.trigger,
      row.wrongPath,
      row.rootCause,
      row.fixSteps,
      row.validation,
      row.active,
      row.origin,
      stringifyJson(sourceRefs, []),
      row.createdAt,
      row.updatedAt,
      row.archivedAt,
      row.invalidatedBy,
    );
    return row.id;
  }

  _normalizeImportedFactEntry(entry = {}, index = 0) {
    const normalized = normalizeFactEntry({
      ...entry,
      origin: trimText(entry.origin) || "import",
      scope: trimText(entry.scope) || "agent",
    });
    if (!normalized.fact) throw new Error(`imported fact #${index + 1} is missing fact`);
    return normalized;
  }

  _ensureFactEvidenceRef(entry, { sourceType = "memory_import_fact", sourceId = "" } = {}) {
    const evidenceRefs = entry.source_refs.filter((ref) => ref.layer === "evidence");
    if (evidenceRefs.length > 0) {
      this._assertEvidenceRefs(entry.source_refs);
      return entry;
    }
    const evidence = this.recordEvidence({
      origin: entry.origin,
      scope: entry.scope,
      sourceType,
      sourceId: sourceId || `${entry.session_id || "import"}:${computeEvidenceHash({
        fact: entry.fact,
        tags: entry.tags,
        time: entry.time,
      }).slice(0, 16)}`,
      sessionId: entry.session_id,
      content: entry.fact,
    });
    return {
      ...entry,
      source_refs: [...entry.source_refs, { layer: "evidence", id: evidence.id }],
    };
  }

  _insertFactLinks(factId, sourceRefs = []) {
    for (const ref of sourceRefs) {
      const evidenceId = ref.layer === "evidence" ? ref.id : null;
      const episodeId = ref.layer === "episode" ? ref.id : null;
      this.localDb.prepare(`
        INSERT INTO fact_links (fact_id, evidence_id, episode_id, created_at)
        VALUES (?, ?, ?, ?)
      `).run(factId, evidenceId, episodeId, nowIso());
    }
  }

  _validateFactEntry(entry) {
    if (!entry.fact) throw new Error("fact is required");
    if (!trimText(entry.origin)) throw new Error("fact origin is required");
    if (entry.origin === "channel" && entry.scope === "profile") {
      this.logDiagnostic("reject_channel_profile_write", { fact: entry.fact });
      throw new Error("origin=channel cannot write scope=profile");
    }
    if (entry.timeliness === "stateful" && !entry.state_key) {
      throw new Error("stateful facts require state_key");
    }
    if (entry.timeliness === "ephemeral" && !entry.valid_to && entry.ttl_days === null) {
      throw new Error("ephemeral facts require ttl_days or valid_to");
    }
    if (!entry.source_refs.length) {
      throw new Error("fact source_refs are required");
    }
    this._assertEvidenceRefs(entry.source_refs);
  }

  _scheduleJobs() {
    if (!this._autoRunJobs) return;
    const timer = setTimeout(() => {
      this.runJobs().catch(() => {});
    }, 0);
    if (timer.unref) timer.unref();
  }

  logDiagnostic(eventType, payload = {}) {
    this.localDb.prepare(`
      INSERT INTO memory_diagnostics (event_type, payload, created_at)
      VALUES (?, ?, ?)
    `).run(eventType, stringifyJson(payload, {}), nowIso());
  }

  getStatus(opts = {}) {
    const enabled = opts.enabled !== false;
    const needsUtilityModel = opts.needsUtilityModel === true;
    const canManageMemory = true;
    const canAutoMaintainMemory = enabled && !needsUtilityModel;
    return {
      enabled,
      canManageMemory,
      canAutoMaintainMemory,
      needsUtilityModel,
      reason: !enabled
        ? "memory.disabled"
        : needsUtilityModel
          ? "memory.needs_utility_model"
          : undefined,
    };
  }

  getProfile() {
    const row = this.globalDb.prepare(`
      SELECT content, updated_at, version
      FROM profiles
      WHERE profile_key = ?
    `).get(PROFILE_KEY);
    return {
      content: row?.content || "",
      updatedAt: row?.updated_at || null,
      version: row?.version || 0,
    };
  }

  upsertProfile(content, opts = {}) {
    const nextContent = safeText(content);
    const expectedVersion = Number.isInteger(opts.expectedVersion) ? opts.expectedVersion : null;
    const targetVersion = Number.isInteger(opts.targetVersion) ? opts.targetVersion : null;
    const ts = nowIso();
    const result = this.globalDb.transaction(() => {
      const current = this.globalDb.prepare(`
        SELECT content, updated_at, version
        FROM profiles
        WHERE profile_key = ?
      `).get(PROFILE_KEY);
      const currentVersion = current?.version || 0;
      if (expectedVersion !== null && currentVersion !== expectedVersion) {
        return {
          applied: false,
          content: current?.content || "",
          updatedAt: current?.updated_at || null,
          version: currentVersion,
          skippedBecauseNewer: currentVersion > expectedVersion,
        };
      }
      const nextVersion = targetVersion !== null
        ? Math.max(targetVersion, currentVersion + 1)
        : (currentVersion + 1);
      this.globalDb.prepare(`
        INSERT INTO profiles (profile_key, content, updated_at, version)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(profile_key) DO UPDATE SET
          content = excluded.content,
          updated_at = excluded.updated_at,
          version = excluded.version
      `).run(PROFILE_KEY, nextContent, ts, nextVersion);
      return {
        applied: true,
        content: nextContent,
        updatedAt: ts,
        version: nextVersion,
      };
    })();

    if (result.applied) {
      this._projectUserProfileFile(nextContent);
      this._notifyChanged();
      return result;
    }

    if (result.skippedBecauseNewer) {
      this.logDiagnostic("profile_job_skipped_newer_version", {
        expectedVersion,
        actualVersion: result.version,
      });
    }
    return result;
  }

  renderProfilePrompt() {
    return trimText(this.getProfile().content);
  }

  listMarks({ activeOnly = true } = {}) {
    const rows = this.localDb.prepare(`
      SELECT id, text, fact_id, active, created_at, updated_at, archived_at
      FROM memory_marks
      WHERE kind = 'pinned'
        AND (? = 0 OR active = 1)
      ORDER BY active DESC, updated_at DESC, created_at DESC
    `).all(activeOnly ? 1 : 0);
    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      factId: row.fact_id || null,
      active: row.active === 1,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      archivedAt: row.archived_at || null,
    }));
  }

  _writeMarksProjection() {
    const content = formatPinnedMarkdown(this.listMarks({ activeOnly: true }));
    const pinnedPath = path.join(this.agentDir, "pinned.md");
    writeTextAtomic(pinnedPath, content);
  }

  _projectUserProfileFile(content) {
    writeTextAtomic(path.join(this.userDir, "user.md"), safeText(content));
  }

  renderPinnedPrompt() {
    return trimText(formatPinnedMarkdown(this.listMarks({ activeOnly: true })));
  }

  _repairLegacyMarkTexts() {
    const rows = this.localDb.prepare(`
      SELECT id, text
      FROM memory_marks
      WHERE kind = 'pinned'
    `).all();
    if (!rows.length) return;

    const updates = [];
    for (const row of rows) {
      const normalized = normalizeMarkText(row.text);
      if (normalized && normalized !== row.text) {
        updates.push({ id: row.id, text: normalized });
      }
    }
    if (updates.length === 0) return;

    const ts = nowIso();
    const tx = this.localDb.transaction(() => {
      const stmt = this.localDb.prepare(`
        UPDATE memory_marks
        SET text = ?, updated_at = ?
        WHERE id = ?
      `);
      for (const row of updates) {
        stmt.run(row.text, ts, row.id);
      }
    });
    tx();
    this._writeMarksProjection();
    this._notifyChanged();
  }

  addMark({ text, factId = null, sourceRefs = [] } = {}) {
    const cleanedText = normalizeMarkText(text);
    if (!cleanedText) throw new Error("mark text is required");
    const id = createId("mark");
    const ts = nowIso();
    this.localDb.prepare(`
      INSERT INTO memory_marks (
        id, kind, text, fact_id, active, source_refs, created_at, updated_at
      ) VALUES (?, 'pinned', ?, ?, 1, ?, ?, ?)
    `).run(id, cleanedText, factId || null, stringifyJson(normalizeSourceRefs(sourceRefs), []), ts, ts);
    this._writeMarksProjection();
    this._notifyChanged();
    return this.getMarkById(id);
  }

  getMarkById(id) {
    const row = this.localDb.prepare(`
      SELECT id, text, fact_id, active, created_at, updated_at, archived_at, source_refs
      FROM memory_marks
      WHERE id = ?
    `).get(id);
    if (!row) return null;
    return {
      id: row.id,
      text: row.text,
      factId: row.fact_id || null,
      active: row.active === 1,
      sourceRefs: parseJson(row.source_refs || "[]", []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at || null,
    };
  }

  updateMark(id, patch = {}) {
    const current = this.getMarkById(id);
    if (!current) throw new Error(`mark not found: ${id}`);
    const nextText = Object.prototype.hasOwnProperty.call(patch, "text")
      ? normalizeMarkText(patch.text)
      : current.text;
    if (!nextText) throw new Error("mark text is required");
    const nextFactId = Object.prototype.hasOwnProperty.call(patch, "factId")
      ? patch.factId || null
      : current.factId;
    const nextActive = Object.prototype.hasOwnProperty.call(patch, "active")
      ? (patch.active ? 1 : 0)
      : (current.active ? 1 : 0);
    const sourceRefs = Object.prototype.hasOwnProperty.call(patch, "sourceRefs")
      ? normalizeSourceRefs(patch.sourceRefs)
      : current.sourceRefs;
    const ts = nowIso();
    this.localDb.prepare(`
      UPDATE memory_marks
      SET text = ?,
          fact_id = ?,
          active = ?,
          source_refs = ?,
          updated_at = ?,
          archived_at = CASE WHEN ? = 1 THEN archived_at ELSE COALESCE(archived_at, ?) END
      WHERE id = ?
    `).run(nextText, nextFactId, nextActive, stringifyJson(sourceRefs, []), ts, nextActive, ts, id);
    this._writeMarksProjection();
    this._notifyChanged();
    return this.getMarkById(id);
  }

  replaceMarks(items = []) {
    const rows = items
      .map((item) => normalizeMarkText(item))
      .filter(Boolean);
    const ts = nowIso();
    const tx = this.localDb.transaction(() => {
      this.localDb.prepare(`
        UPDATE memory_marks
        SET active = 0,
            archived_at = COALESCE(archived_at, ?),
            updated_at = ?
        WHERE kind = 'pinned' AND active = 1
      `).run(ts, ts);
      const insert = this.localDb.prepare(`
        INSERT INTO memory_marks (
          id, kind, text, fact_id, active, source_refs, created_at, updated_at
        ) VALUES (?, 'pinned', ?, NULL, 1, '[]', ?, ?)
      `);
      for (const text of rows) {
        insert.run(createId("mark"), text, ts, ts);
      }
    });
    tx();
    this._writeMarksProjection();
    this._notifyChanged();
    return this.listMarks({ activeOnly: true });
  }

  getSummaryProjection() {
    const row = this.localDb.prepare(`
      SELECT content, kind, source_scope, generated_at, updated_at
      FROM memory_projections
      WHERE key = ?
    `).get(SUMMARY_PROJECTION_KEY);
    return {
      title: "Current Memory Summary",
      content: row?.content || "",
      kind: "projection",
      generatedAt: row?.generated_at || null,
      sourceScope: row?.source_scope || null,
      updatedAt: row?.updated_at || null,
    };
  }

  getCompatibilityFacts() {
    return this._factStore.exportAll();
  }

  listArchiveCandidateIds({ includeFacts = true, includeMarks = true, includePlaybooks = true } = {}) {
    const ids = [];
    if (includeFacts) {
      const factRows = this.localDb.prepare(`
        SELECT id
        FROM facts
        WHERE is_active = 1
      `).all();
      ids.push(...factRows.map((row) => encodeMemoryId("fact", row.id)));
    }
    if (includeMarks) {
      const markRows = this.localDb.prepare(`
        SELECT id
        FROM memory_marks
        WHERE kind = 'pinned' AND active = 1
      `).all();
      ids.push(...markRows.map((row) => encodeMemoryId("mark", row.id)));
    }
    if (includePlaybooks) {
      const playbookRows = this.localDb.prepare(`
        SELECT id
        FROM playbooks
        WHERE active = 1
      `).all();
      ids.push(...playbookRows.map((row) => encodeMemoryId("playbook", row.id)));
    }
    return ids;
  }

  setSummaryProjection(content, { sourceScope = "agent" } = {}) {
    const next = this._writeSummaryProjectionRecord(content, { sourceScope });
    writeTextAtomic(path.join(this.memoryDir, "memory.md"), next.content);
    this._notifyChanged();
    return this.getSummaryProjection();
  }

  renderMemoryPrompt() {
    return trimText(this.getSummaryProjection().content);
  }

  listPlaybooks({ activeOnly = true } = {}) {
    const rows = this.localDb.prepare(`
      SELECT id, category, trigger, wrong_path, root_cause, fix_steps, validation, active,
             origin, source_refs, created_at, updated_at, archived_at
      FROM playbooks
      WHERE (? = 0 OR active = 1)
      ORDER BY active DESC, updated_at DESC, created_at DESC
    `).all(activeOnly ? 1 : 0);
    return rows.map((row) => ({
      id: row.id,
      category: row.category || "",
      trigger: row.trigger,
      wrongPath: row.wrong_path,
      rootCause: row.root_cause,
      fixSteps: row.fix_steps,
      validation: row.validation,
      active: row.active === 1,
      origin: row.origin || "assistant",
      sourceRefs: parseJson(row.source_refs || "[]", []),
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      archivedAt: row.archived_at || null,
    }));
  }

  getPlaybookById(id) {
    return this.listPlaybooks({ activeOnly: false }).find((item) => item.id === id) || null;
  }

  _writePlaybookProjection() {
    const playbooks = this.listPlaybooks({ activeOnly: true });
    const expDir = path.join(this.agentDir, "experience");
    ensureDir(expDir);
    const files = formatCompatibilityExperienceFiles(playbooks);
    const keep = new Set(files.map((item) => item.filename));
    for (const item of files) {
      writeTextAtomic(path.join(expDir, item.filename), item.body);
    }
    for (const name of fs.readdirSync(expDir).filter((item) => item.endsWith(".md"))) {
      if (!keep.has(name)) {
        fs.rmSync(path.join(expDir, name), { force: true });
      }
    }
    writeTextAtomic(path.join(this.agentDir, "experience.md"), formatCompatibilityExperienceIndex(playbooks));
  }

  _buildPlaybookEvidenceText(playbook) {
    return [
      `trigger: ${playbook.trigger}`,
      `wrong_path: ${playbook.wrongPath}`,
      `root_cause: ${playbook.rootCause}`,
      `fix_steps: ${playbook.fixSteps}`,
      `validation: ${playbook.validation}`,
    ].join("\n");
  }

  _ensurePlaybookSourceRefs(playbook, {
    sourceRefs = [],
    origin = "assistant",
    scope = "agent",
    sourceType = "playbook_manual",
    sourceId = "",
    sessionId = null,
  } = {}) {
    const normalized = normalizeSourceRefs(sourceRefs);
    if (normalized.length > 0) {
      this._assertEvidenceRefs(normalized);
      return normalized;
    }
    const evidence = this.recordEvidence({
      origin,
      scope,
      sourceType,
      sourceId: trimText(sourceId) || `playbook:${computeEvidenceHash(playbook).slice(0, 16)}`,
      sessionId: trimText(sessionId) || null,
      content: this._buildPlaybookEvidenceText(playbook),
    });
    return [{ layer: "evidence", id: evidence.id }];
  }

  addPlaybook(input = {}) {
    const playbook = normalizePlaybookInput(input);
    assertPlaybookFields(playbook);
    const origin = this._requireOrigin(trimText(input.origin) || "assistant", "playbook origin");
    const scope = trimText(input.scope) || "agent";
    if (origin === "channel" && scope === "profile") {
      this.logDiagnostic("reject_channel_profile_write", { trigger: playbook.trigger });
      throw new Error("origin=channel cannot write scope=profile");
    }
    const sourceRefs = this._ensurePlaybookSourceRefs(playbook, {
      sourceRefs: input.sourceRefs || input.source_refs || [],
      origin,
      scope,
      sourceType: trimText(input.sourceType || input.source_type) || "playbook_manual",
      sourceId: trimText(input.sourceId || input.source_id) || "",
      sessionId: trimText(input.sessionId || input.session_id) || null,
    });
    const id = createId("playbook");
    const ts = nowIso();
    this.localDb.prepare(`
      INSERT INTO playbooks (
        id, category, trigger, wrong_path, root_cause, fix_steps, validation, active,
        origin, source_refs, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      id,
      playbook.category,
      playbook.trigger,
      playbook.wrongPath,
      playbook.rootCause,
      playbook.fixSteps,
      playbook.validation,
      origin,
      stringifyJson(sourceRefs, []),
      ts,
      ts,
    );
    this._writePlaybookProjection();
    this._notifyChanged();
    return this.getPlaybookById(id);
  }

  updatePlaybook(id, patch = {}) {
    const current = this.getPlaybookById(id);
    if (!current) throw new Error(`playbook not found: ${id}`);
    const next = normalizePlaybookInput({
      ...current,
      ...patch,
    });
    assertPlaybookFields(next);
    const nextOrigin = this._requireOrigin(trimText(patch.origin || current.origin) || "assistant", "playbook origin");
    const sourceRefs = Object.prototype.hasOwnProperty.call(patch, "sourceRefs")
      || Object.prototype.hasOwnProperty.call(patch, "source_refs")
      ? this._ensurePlaybookSourceRefs(next, {
        sourceRefs: patch.sourceRefs || patch.source_refs || [],
        origin: nextOrigin,
        scope: trimText(patch.scope) || "agent",
        sourceType: trimText(patch.sourceType || patch.source_type) || "playbook_manual",
        sourceId: trimText(patch.sourceId || patch.source_id) || "",
        sessionId: trimText(patch.sessionId || patch.session_id) || null,
      })
      : this._ensurePlaybookSourceRefs(next, {
        sourceRefs: current.sourceRefs,
        origin: nextOrigin,
        scope: trimText(patch.scope) || "agent",
      });
    const active = Object.prototype.hasOwnProperty.call(patch, "active")
      ? (patch.active ? 1 : 0)
      : (current.active ? 1 : 0);
    const ts = nowIso();
    this.localDb.prepare(`
      UPDATE playbooks
      SET category = ?,
          trigger = ?,
          wrong_path = ?,
          root_cause = ?,
          fix_steps = ?,
          validation = ?,
          active = ?,
          origin = ?,
          source_refs = ?,
          updated_at = ?,
          archived_at = CASE WHEN ? = 1 THEN archived_at ELSE COALESCE(archived_at, ?) END
      WHERE id = ?
    `).run(
      next.category,
      next.trigger,
      next.wrongPath,
      next.rootCause,
      next.fixSteps,
      next.validation,
      active,
      nextOrigin,
      stringifyJson(sourceRefs, []),
      ts,
      active,
      ts,
      id,
    );
    this._writePlaybookProjection();
    this._notifyChanged();
    return this.getPlaybookById(id);
  }

  replacePlaybooks(playbooks = []) {
    const rows = playbooks.map((item) => normalizePlaybookInput(item));
    for (const row of rows) assertPlaybookFields(row);
    const ts = nowIso();
    const tx = this.localDb.transaction(() => {
      this.localDb.prepare(`
        UPDATE playbooks
        SET active = 0,
            archived_at = COALESCE(archived_at, ?),
            updated_at = ?
        WHERE active = 1
      `).run(ts, ts);
      const insert = this.localDb.prepare(`
        INSERT INTO playbooks (
          id, category, trigger, wrong_path, root_cause, fix_steps, validation, active,
          origin, source_refs, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `);
      for (const [index, row] of rows.entries()) {
        const sourceRefs = this._ensurePlaybookSourceRefs(row, {
          sourceRefs: [],
          origin: "assistant",
          scope: "agent",
          sourceType: "playbook_replace",
          sourceId: `replace:${index + 1}`,
        });
        insert.run(
          createId("playbook"),
          row.category,
          row.trigger,
          row.wrongPath,
          row.rootCause,
          row.fixSteps,
          row.validation,
          "assistant",
          stringifyJson(sourceRefs, []),
          ts,
          ts,
        );
      }
    });
    tx();
    this._writePlaybookProjection();
    this._notifyChanged();
    return this.listPlaybooks({ activeOnly: true });
  }

  replacePlaybooksFromLegacyMarkdown(content) {
    const playbooks = [];
    for (const category of parseLegacyExperienceMarkdown(content)) {
      for (const entry of category.entries) {
        const playbook = legacyEntryToPlaybook(category.name, entry);
        if (playbook) playbooks.push(playbook);
      }
    }
    return this.replacePlaybooks(playbooks);
  }

  getCompatibilityExperienceContent() {
    const playbooks = this.listPlaybooks({ activeOnly: true });
    const files = formatCompatibilityExperienceFiles(playbooks);
    return files.map((item) => `# ${item.category}\n${item.body.trimEnd()}`).join("\n\n") + (files.length ? "\n" : "");
  }

  recordEvidence({
    origin,
    scope,
    sourceType,
    sourceId,
    sessionId = null,
    episodeId = null,
    content,
    sourceRefs = [],
  }) {
    const nextOrigin = this._requireOrigin(origin, "evidence origin");
    const nextScope = trimText(scope) || "agent";
    if (nextOrigin === "channel" && nextScope === "profile") {
      this.logDiagnostic("reject_channel_profile_write", { sourceType, sourceId, sessionId });
      throw new Error("origin=channel cannot write scope=profile");
    }
    const { cleaned, detected } = scrubPII(safeText(content));
    const ts = nowIso();
    const normalizedSourceRefs = normalizeSourceRefs(sourceRefs);
    const hash = computeEvidenceHash({
      origin: nextOrigin,
      scope: nextScope,
      sourceType,
      sourceId,
      sessionId,
      episodeId,
      content: cleaned,
      sourceRefs: normalizedSourceRefs,
    });
    const preview = previewText(cleaned, 220);
    const id = createId("evidence");
    this.localDb.prepare(`
      INSERT OR IGNORE INTO evidence (
        id, origin, scope, source_type, source_id, session_id, episode_id, content, preview,
        source_refs, redaction, hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      nextOrigin,
      nextScope,
      trimText(sourceType) || "text",
      trimText(sourceId) || null,
      trimText(sessionId) || null,
      trimText(episodeId) || null,
      cleaned,
      preview,
      stringifyJson(normalizedSourceRefs, []),
      stringifyJson({ detected }, {}),
      hash,
      ts,
      ts,
    );
    const row = this.localDb.prepare(`
      SELECT id, origin, scope, source_type, source_id, session_id, episode_id, content, preview,
             source_refs, redaction, hash, created_at, updated_at
      FROM evidence
      WHERE hash = ?
    `).get(hash);
    return {
      id: row.id,
      origin: row.origin,
      scope: row.scope,
      sourceType: row.source_type,
      sourceId: row.source_id,
      sessionId: row.session_id,
      episodeId: row.episode_id,
      content: row.content,
      preview: row.preview,
      sourceRefs: parseJson(row.source_refs || "[]", []),
      redaction: parseJson(row.redaction || "{}", {}),
      hash: row.hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  upsertEpisode({
    origin,
    scope,
    sessionId = null,
    channelName = null,
    anchorText,
    sourceRefs = [],
  }) {
    const nextOrigin = this._requireOrigin(origin, "episode origin");
    const nextScope = trimText(scope) || "agent";
    if (nextOrigin === "channel" && nextScope === "profile") {
      this.logDiagnostic("reject_channel_profile_write", { sessionId, channelName });
      throw new Error("origin=channel cannot write scope=profile");
    }
    const normalizedSourceRefs = normalizeSourceRefs(sourceRefs);
    const stableKey = computeEvidenceHash({
      origin: nextOrigin,
      scope: nextScope,
      sessionId: trimText(sessionId) || null,
      channelName: trimText(channelName) || null,
    }).slice(0, 32);
    const id = `episode_${stableKey}`;
    const ts = nowIso();
    this.localDb.prepare(`
      INSERT INTO episodes (
        id, origin, scope, session_id, channel_name, anchor_text, source_refs, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        origin = excluded.origin,
        scope = excluded.scope,
        session_id = excluded.session_id,
        channel_name = excluded.channel_name,
        anchor_text = excluded.anchor_text,
        source_refs = excluded.source_refs,
        updated_at = excluded.updated_at
    `).run(
      id,
      nextOrigin,
      nextScope,
      trimText(sessionId) || null,
      trimText(channelName) || null,
      safeText(anchorText),
      stringifyJson(normalizedSourceRefs, []),
      ts,
      ts,
    );
    return this.getEpisodeById(id);
  }

  getEpisodeById(id) {
    const row = this.localDb.prepare(`
      SELECT id, origin, scope, session_id, channel_name, anchor_text, source_refs, created_at, updated_at
      FROM episodes
      WHERE id = ?
    `).get(id);
    if (!row) return null;
    return {
      id: row.id,
      origin: row.origin,
      scope: row.scope,
      sessionId: row.session_id,
      channelName: row.channel_name,
      anchorText: row.anchor_text,
      sourceRefs: parseJson(row.source_refs || "[]", []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getEpisodeBySession(sessionId) {
    const row = this.localDb.prepare(`
      SELECT id
      FROM episodes
      WHERE session_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `).get(sessionId);
    return row ? this.getEpisodeById(row.id) : null;
  }

  listEvidenceBySession(sessionId) {
    const rows = this.localDb.prepare(`
      SELECT id, origin, scope, source_type, source_id, session_id, episode_id, content, preview,
             source_refs, redaction, hash, created_at, updated_at
      FROM evidence
      WHERE session_id = ?
      ORDER BY updated_at DESC, created_at DESC
    `).all(sessionId);
    return rows.map((row) => ({
      id: row.id,
      origin: row.origin,
      scope: row.scope,
      sourceType: row.source_type,
      sourceId: row.source_id,
      sessionId: row.session_id,
      episodeId: row.episode_id,
      content: row.content,
      preview: row.preview,
      sourceRefs: parseJson(row.source_refs || "[]", []),
      redaction: parseJson(row.redaction || "{}", {}),
      hash: row.hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  addFacts(entries = []) {
    const normalized = entries.map((entry) => normalizeFactEntry(entry));
    for (const entry of normalized) this._validateFactEntry(entry);

    const tx = this.localDb.transaction(() => {
      for (const entry of normalized) {
        const { id } = this._factStore.add(entry);
        this._insertFactLinks(id, entry.source_refs);
      }
    });
    tx();
    this._notifyChanged();
    return normalized.length;
  }

  _assertEvidenceRefs(sourceRefs) {
    const evidenceIds = sourceRefs
      .filter((ref) => ref.layer === "evidence")
      .map((ref) => ref.id);
    if (evidenceIds.length === 0) {
      throw new Error("source_refs must include evidence");
    }
    const stmt = this.localDb.prepare(`SELECT COUNT(*) AS cnt FROM evidence WHERE id = ?`);
    for (const id of evidenceIds) {
      if ((stmt.get(id)?.cnt || 0) === 0) {
        throw new Error(`missing evidence source ref: ${id}`);
      }
    }
  }

  recordRetrievalLog({ query, layer = "facts", configSnapshot = {}, resultIds = [] }) {
    if (Math.random() > RETRIEVAL_LOG_SAMPLE_RATE) return;
    const retentionCutoff = new Date(Date.now() - RETRIEVAL_LOG_RETENTION_DAYS * 86400000).toISOString();
    this.localDb.prepare(`
      DELETE FROM retrieval_logs
      WHERE created_at < ?
    `).run(retentionCutoff);
    const nextSnapshot = {
      ...configSnapshot,
      samplingRate: RETRIEVAL_LOG_SAMPLE_RATE,
      retentionDays: RETRIEVAL_LOG_RETENTION_DAYS,
    };
    this.localDb.prepare(`
      INSERT INTO retrieval_logs (query, layer, ranking_version, config_snapshot, result_ids, sampled, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(
      safeText(query),
      layer,
      MEMORY_RANKING_VERSION,
      stringifyJson(nextSnapshot, {}),
      stringifyJson(resultIds, []),
      nowIso(),
    );
  }

  searchIndex({ query = "", tags = [], dateFrom = null, dateTo = null, limit = 10 } = {}) {
    const nextLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
    const dateRange = {};
    if (trimText(dateFrom)) dateRange.from = trimText(dateFrom);
    if (trimText(dateTo)) dateRange.to = trimText(dateTo);
    const candidateLimit = Math.max(nextLimit, Math.min(200, nextLimit * 6));
    const rows = [];
    const seen = new Set();
    if (Array.isArray(tags) && tags.length > 0) {
      for (const row of this._factStore.searchByTags(tags, Object.keys(dateRange).length > 0 ? dateRange : undefined, candidateLimit)) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push({ ...row, _source: "tag" });
      }
    }
    if (trimText(query)) {
      for (const row of this._factStore.searchFullText(query, candidateLimit)) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push({ ...row, _source: "fts" });
      }
    }
    const queryTokens = tokenizeText(query);
    const requestedTags = Array.isArray(tags)
      ? tags.map((item) => trimText(item).toLowerCase()).filter(Boolean)
      : [];
    const now = Date.now();
    const scoredRows = rows.map((row) => {
      const matchCount = Number(row.matchCount) || 0;
      const tagDenominator = requestedTags.length || (Array.isArray(row.tags) ? row.tags.length : 0) || 1;
      const tagScore = clamp01(matchCount / tagDenominator);

      const rowTextTokens = new Set([
        ...tokenizeText(row.fact),
        ...(Array.isArray(row.tags) ? row.tags.map((tag) => String(tag || "").toLowerCase()) : []),
      ]);
      const entityHits = queryTokens.filter((token) => rowTextTokens.has(token)).length;
      const entityScore = queryTokens.length > 0 ? clamp01(entityHits / queryTokens.length) : 0;

      const bm25Score = normalizeBm25Score(row.rank);
      const truthMs = toEpochMs(row.truth_time || row.time || row.updated_at || row.created_at);
      const ageDays = truthMs > 0 ? Math.max(0, (now - truthMs) / 86400000) : 9999;
      const recencyScore = truthMs > 0 ? clamp01(Math.exp(-ageDays / 30)) : 0;
      const confidenceScore = row.confidence == null ? 0.5 : clamp01(row.confidence);
      const importanceScore = row.importance == null ? 0.5 : clamp01(row.importance);

      const components = {
        bm25: bm25Score,
        tag: tagScore,
        entity: entityScore,
        recency: recencyScore,
        confidence: confidenceScore,
        importance: importanceScore,
      };
      const weightedScore = Object.entries(MEMORY_RANKING_WEIGHTS).reduce((acc, [key, weight]) => {
        return acc + (components[key] || 0) * weight;
      }, 0);
      return {
        ...row,
        _score: weightedScore,
        _components: components,
      };
    });
    scoredRows.sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      const bt = toEpochMs(b.truth_time || b.time || b.updated_at || b.created_at);
      const at = toEpochMs(a.truth_time || a.time || a.updated_at || a.created_at);
      if (bt !== at) return bt - at;
      return Number(b.id) - Number(a.id);
    });
    const finalRows = scoredRows.slice(0, nextLimit);
    this.recordRetrievalLog({
      query: trimText(query),
      layer: "facts",
      configSnapshot: {
        strategy: "ranked_blend",
        weights: MEMORY_RANKING_WEIGHTS,
        components: ["bm25", "tag", "entity", "recency", "confidence", "importance"],
        dateFrom: trimText(dateFrom) || null,
        dateTo: trimText(dateTo) || null,
        tags: requestedTags,
        queryTokens,
        limit: nextLimit,
        finalOrder: finalRows.map((row) => ({
          id: encodeMemoryId("fact", row.id),
          source: row._source || "unknown",
          truthTime: row.truth_time || row.time || row.updated_at || row.created_at || null,
          weightedScore: Number(row._score?.toFixed(6) || 0),
          componentScores: row._components || {},
        })),
      },
      resultIds: finalRows.map((row) => encodeMemoryId("fact", row.id)),
    });
    return finalRows;
  }

  searchCompatibilityText(params = {}) {
    const rows = this.searchIndex(params);
    return rows.map((row, index) => {
      const tags = Array.isArray(row.tags) && row.tags.length > 0 ? ` (${row.tags.join(", ")})` : "";
      const time = row.time ? ` - recorded: ${row.time}` : "";
      const validTo = row.valid_to ? ` - valid_to: ${row.valid_to}` : "";
      return `${index + 1}. ${row.fact} [${row.timeliness}]${tags}${time}${validTo}`;
    });
  }

  _listFactsPage({ includeInactive = false, offset = 0, limit = DEFAULT_PAGE_SIZE } = {}) {
    const rows = this.localDb.prepare(`
      SELECT id, fact, tags, time, truth_time, timeliness, scope, origin, is_active, created_at, updated_at
      FROM facts
      WHERE (? = 1 OR is_active = 1)
      ORDER BY COALESCE(truth_time, time, updated_at, created_at) DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(includeInactive ? 1 : 0, limit + 1, offset);
    const items = rows.slice(0, limit).map((row) => ({
      id: includeInactive
        ? encodeMemoryId("inactive", `fact:${row.id}`)
        : encodeMemoryId("fact", row.id),
      layer: includeInactive ? "inactive" : "facts",
      itemType: "fact",
      preview: row.fact,
      truthTime: row.truth_time || row.time || row.updated_at || row.created_at,
      timeliness: row.timeliness,
      origin: row.origin,
      scope: row.scope,
      active: row.is_active === 1,
      tags: parseJson(row.tags || "[]", []),
    }));
    return {
      items,
      nextCursor: rows.length > limit ? String(offset + limit) : null,
    };
  }

  _listEvidencePage({ offset = 0, limit = DEFAULT_PAGE_SIZE } = {}) {
    const rows = this.localDb.prepare(`
      SELECT id, preview, origin, scope, source_type, source_id, session_id, episode_id, updated_at, created_at
      FROM evidence
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit + 1, offset);
    const items = rows.slice(0, limit).map((row) => ({
      id: encodeMemoryId("evidence", row.id),
      layer: "evidence",
      itemType: "evidence",
      preview: row.preview,
      truthTime: row.updated_at || row.created_at,
      origin: row.origin,
      scope: row.scope,
      sourceType: row.source_type,
      sourceId: row.source_id,
      sessionId: row.session_id,
      episodeId: row.episode_id,
    }));
    return {
      items,
      nextCursor: rows.length > limit ? String(offset + limit) : null,
    };
  }

  _listEpisodesPage({ offset = 0, limit = DEFAULT_PAGE_SIZE } = {}) {
    const rows = this.localDb.prepare(`
      SELECT id, anchor_text, origin, scope, session_id, channel_name, updated_at, created_at
      FROM episodes
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit + 1, offset);
    const items = rows.slice(0, limit).map((row) => ({
      id: encodeMemoryId("episode", row.id),
      layer: "episodes",
      itemType: "episode",
      preview: previewText(row.anchor_text),
      truthTime: row.updated_at || row.created_at,
      origin: row.origin,
      scope: row.scope,
      sessionId: row.session_id,
      channelName: row.channel_name,
    }));
    return {
      items,
      nextCursor: rows.length > limit ? String(offset + limit) : null,
    };
  }

  _listPlaybooksPage({ includeInactive = false, offset = 0, limit = DEFAULT_PAGE_SIZE } = {}) {
    const rows = this.localDb.prepare(`
      SELECT id, category, trigger, validation, active, updated_at, created_at
      FROM playbooks
      WHERE (? = 1 OR active = 1)
      ORDER BY active DESC, updated_at DESC, created_at DESC
      LIMIT ? OFFSET ?
    `).all(includeInactive ? 1 : 0, limit + 1, offset);
    const items = rows.slice(0, limit).map((row) => ({
      id: includeInactive
        ? encodeMemoryId("inactive", `playbook:${row.id}`)
        : encodeMemoryId("playbook", row.id),
      layer: includeInactive ? "inactive" : "playbooks",
      itemType: "playbook",
      preview: `${row.category ? `[${row.category}] ` : ""}${row.trigger}`,
      truthTime: row.updated_at || row.created_at,
      category: row.category || "",
      active: row.active === 1,
      validation: row.validation,
    }));
    return {
      items,
      nextCursor: rows.length > limit ? String(offset + limit) : null,
    };
  }

  _listInactivePage({ offset = 0, limit = DEFAULT_PAGE_SIZE } = {}) {
    const rows = this.localDb.prepare(`
      SELECT *
      FROM (
        SELECT
          'fact' AS item_type,
          CAST(id AS TEXT) AS raw_id,
          fact AS preview,
          COALESCE(truth_time, time, updated_at, created_at) AS truth_time,
          timeliness,
          origin,
          scope,
          NULL AS category,
          NULL AS validation,
          NULL AS fact_id,
          updated_at,
          created_at
        FROM facts
        WHERE is_active = 0

        UNION ALL

        SELECT
          'playbook' AS item_type,
          id AS raw_id,
          CASE
            WHEN category IS NOT NULL AND category <> '' THEN '[' || category || '] ' || trigger
            ELSE trigger
          END AS preview,
          COALESCE(updated_at, created_at) AS truth_time,
          NULL AS timeliness,
          origin,
          NULL AS scope,
          category,
          validation,
          NULL AS fact_id,
          updated_at,
          created_at
        FROM playbooks
        WHERE active = 0

        UNION ALL

        SELECT
          'mark' AS item_type,
          id AS raw_id,
          text AS preview,
          COALESCE(updated_at, created_at) AS truth_time,
          NULL AS timeliness,
          'assistant' AS origin,
          NULL AS scope,
          NULL AS category,
          NULL AS validation,
          fact_id,
          updated_at,
          created_at
        FROM memory_marks
        WHERE kind = 'pinned' AND active = 0
      )
      ORDER BY truth_time DESC, updated_at DESC, created_at DESC, raw_id DESC
      LIMIT ? OFFSET ?
    `).all(limit + 1, offset);
    const items = rows.slice(0, limit).map((row) => ({
      id: encodeMemoryId("inactive", `${row.item_type}:${row.raw_id}`),
      layer: "inactive",
      itemType: row.item_type,
      preview: row.preview,
      truthTime: row.truth_time || row.updated_at || row.created_at,
      timeliness: row.timeliness || undefined,
      origin: row.origin || undefined,
      scope: row.scope || undefined,
      category: row.category || undefined,
      validation: row.validation || undefined,
      factId: row.fact_id ?? null,
      active: false,
    }));
    return {
      items,
      nextCursor: rows.length > limit ? String(offset + limit) : null,
    };
  }

  _getSummaryProjectionSourceScope() {
    const row = this.localDb.prepare(`
      SELECT source_scope
      FROM memory_projections
      WHERE key = ?
    `).get(SUMMARY_PROJECTION_KEY);
    return trimText(row?.source_scope) || "agent";
  }

  rebuildSummaryProjection({ sourceScope = null } = {}) {
    const factsPath = path.join(this.memoryDir, "facts.md");
    const todayPath = path.join(this.memoryDir, "today.md");
    const weekPath = path.join(this.memoryDir, "week.md");
    const longtermPath = path.join(this.memoryDir, "longterm.md");
    const memoryPath = path.join(this.memoryDir, "memory.md");
    writeTextAtomic(factsPath, buildFactsProjection(this._factStore.getAll()));
    const content = assemble(factsPath, todayPath, weekPath, longtermPath, memoryPath);
    return this._writeSummaryProjectionRecord(content, {
      sourceScope: trimText(sourceScope) || this._getSummaryProjectionSourceScope(),
    });
  }

  getLibraryPage({ layer = "facts", cursor = null, limit = DEFAULT_PAGE_SIZE } = {}) {
    const nextLayer = MEMORY_LAYERS.includes(layer) ? layer : "facts";
    const nextOffset = decodeCursor(cursor);
    const nextLimit = normalizePageSize(limit);
    let result;
    if (nextLayer === "facts") result = this._listFactsPage({ offset: nextOffset, limit: nextLimit });
    else if (nextLayer === "episodes") result = this._listEpisodesPage({ offset: nextOffset, limit: nextLimit });
    else if (nextLayer === "evidence") result = this._listEvidencePage({ offset: nextOffset, limit: nextLimit });
    else if (nextLayer === "playbooks") result = this._listPlaybooksPage({ offset: nextOffset, limit: nextLimit });
    else result = this._listInactivePage({ offset: nextOffset, limit: nextLimit });
    return {
      layer: nextLayer,
      items: result.items,
      nextCursor: result.nextCursor,
    };
  }

  getDetails(id, fallbackLayer = "") {
    const { layer, rawId } = decodeMemoryId(id, fallbackLayer);
    if (!rawId) throw new Error("memory id is required");

    if (layer === "inactive") {
      const nested = decodeMemoryId(rawId, "fact");
      const nestedLayer = nested.layer || "fact";
      if (!nested.rawId) throw new Error(`inactive memory id is invalid: ${rawId}`);
      return this.getDetails(encodeMemoryId(nestedLayer, nested.rawId), nestedLayer);
    }

    if (layer === "fact" || layer === "facts") {
      const row = this._factStore.getById(Number(rawId));
      if (!row) throw new Error(`fact not found: ${rawId}`);
      return {
        id: encodeMemoryId("fact", row.id),
        layer: row.is_active ? "facts" : "inactive",
        content: row.fact,
        preview: previewText(row.fact),
        sourceRefs: row.source_refs || [],
        truthTime: row.truth_time || row.time || row.updated_at || row.created_at,
        auditTrail: {
          origin: row.origin,
          scope: row.scope,
          timeliness: row.timeliness,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          invalidatedBy: row.invalidated_by || null,
          stateKey: row.state_key || null,
          validFrom: row.valid_from || null,
          validTo: row.valid_to || null,
          active: row.is_active,
        },
      };
    }

    if (layer === "evidence") {
      const row = this.localDb.prepare(`
        SELECT id, content, preview, source_refs, created_at, updated_at, redaction, origin, scope, source_type, source_id, session_id, episode_id
        FROM evidence
        WHERE id = ?
      `).get(rawId);
      if (!row) throw new Error(`evidence not found: ${rawId}`);
      return {
        id: encodeMemoryId("evidence", row.id),
        layer: "evidence",
        content: row.content,
        preview: row.preview,
        sourceRefs: parseJson(row.source_refs || "[]", []),
        truthTime: row.updated_at || row.created_at,
        auditTrail: {
          origin: row.origin,
          scope: row.scope,
          sourceType: row.source_type,
          sourceId: row.source_id,
          sessionId: row.session_id,
          episodeId: row.episode_id,
          redaction: parseJson(row.redaction || "{}", {}),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
      };
    }

    if (layer === "episode" || layer === "episodes") {
      const row = this.getEpisodeById(rawId);
      if (!row) throw new Error(`episode not found: ${rawId}`);
      return {
        id: encodeMemoryId("episode", row.id),
        layer: "episodes",
        content: row.anchorText,
        preview: previewText(row.anchorText),
        sourceRefs: row.sourceRefs,
        truthTime: row.updatedAt || row.createdAt,
        auditTrail: {
          origin: row.origin,
          scope: row.scope,
          sessionId: row.sessionId,
          channelName: row.channelName,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
      };
    }

    if (layer === "playbook" || layer === "playbooks") {
      const row = this.getPlaybookById(rawId);
      if (!row) throw new Error(`playbook not found: ${rawId}`);
      return {
        id: encodeMemoryId("playbook", row.id),
        layer: row.active ? "playbooks" : "inactive",
        content: playbookToCompatibilityText(row),
        preview: previewText(row.trigger),
        sourceRefs: row.sourceRefs,
        truthTime: row.updatedAt || row.createdAt,
        auditTrail: {
          category: row.category,
          active: row.active,
          origin: row.origin,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          archivedAt: row.archivedAt || null,
        },
      };
    }

    if (layer === "mark" || layer === "marks") {
      const row = this.getMarkById(rawId);
      if (!row) throw new Error(`mark not found: ${rawId}`);
      return {
        id: encodeMemoryId("mark", row.id),
        layer: row.active ? "facts" : "inactive",
        content: row.text,
        preview: previewText(row.text),
        sourceRefs: row.sourceRefs,
        truthTime: row.updatedAt || row.createdAt,
        auditTrail: {
          active: row.active,
          factId: row.factId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          archivedAt: row.archivedAt || null,
        },
      };
    }

    throw new Error(`unsupported memory layer: ${layer}`);
  }

  getAuditTrace(id) {
    return this.getDetails(id).auditTrail;
  }

  archive(ids = []) {
    const normalized = Array.isArray(ids) ? ids.map((item) => trimText(item)).filter(Boolean) : [];
    const affectedIds = [];
    const ts = nowIso();
    let factsChanged = false;
    const tx = this.localDb.transaction(() => {
      for (const item of normalized) {
        let { layer, rawId } = decodeMemoryId(item);
        if (!rawId) continue;
        if (layer === "inactive") {
          const nested = decodeMemoryId(rawId, "fact");
          layer = nested.layer || "fact";
          rawId = nested.rawId;
          if (!rawId) continue;
        }
        if (layer === "fact" || layer === "facts") {
          const changes = this.localDb.prepare(`
            UPDATE facts
            SET is_active = 0,
                valid_to = COALESCE(valid_to, ?),
                updated_at = ?,
                invalidated_by = COALESCE(invalidated_by, 'archive')
            WHERE id = ? AND is_active = 1
          `).run(ts, ts, Number(rawId)).changes;
          if (changes > 0) {
            factsChanged = true;
            affectedIds.push(encodeMemoryId("fact", rawId));
          }
          continue;
        }
        if (layer === "mark" || layer === "marks") {
          const changes = this.localDb.prepare(`
            UPDATE memory_marks
            SET active = 0,
                archived_at = COALESCE(archived_at, ?),
                updated_at = ?,
                invalidated_by = COALESCE(invalidated_by, 'archive')
            WHERE id = ? AND active = 1
          `).run(ts, ts, rawId).changes;
          if (changes > 0) affectedIds.push(encodeMemoryId("mark", rawId));
          continue;
        }
        if (layer === "playbook" || layer === "playbooks") {
          const changes = this.localDb.prepare(`
            UPDATE playbooks
            SET active = 0,
                archived_at = COALESCE(archived_at, ?),
                updated_at = ?,
                invalidated_by = COALESCE(invalidated_by, 'archive')
            WHERE id = ? AND active = 1
          `).run(ts, ts, rawId).changes;
          if (changes > 0) affectedIds.push(encodeMemoryId("playbook", rawId));
        }
      }
    });
    tx();
    this._writeMarksProjection();
    this._writePlaybookProjection();
    if (factsChanged) {
      this.rebuildSummaryProjection();
    }
    this._notifyChanged();
    return {
      affectedIds,
      hiddenFromDefaultView: true,
    };
  }

  restore(ids = []) {
    const normalized = Array.isArray(ids) ? ids.map((item) => trimText(item)).filter(Boolean) : [];
    const affectedIds = [];
    const ts = nowIso();
    let factsChanged = false;
    const tx = this.localDb.transaction(() => {
      for (const item of normalized) {
        let { layer, rawId } = decodeMemoryId(item);
        if (!rawId) continue;
        if (layer === "inactive") {
          const nested = decodeMemoryId(rawId, "fact");
          layer = nested.layer || "fact";
          rawId = nested.rawId;
          if (!rawId) continue;
        }
        if (layer === "fact" || layer === "facts") {
          const changes = this.localDb.prepare(`
            UPDATE facts
            SET is_active = 1,
                valid_to = NULL,
                updated_at = ?,
                invalidated_by = NULL
            WHERE id = ? AND is_active = 0
          `).run(ts, Number(rawId)).changes;
          if (changes > 0) {
            factsChanged = true;
            affectedIds.push(encodeMemoryId("fact", rawId));
          }
          continue;
        }
        if (layer === "mark" || layer === "marks") {
          const changes = this.localDb.prepare(`
            UPDATE memory_marks
            SET active = 1,
                archived_at = NULL,
                updated_at = ?,
                invalidated_by = NULL
            WHERE id = ? AND active = 0
          `).run(ts, rawId).changes;
          if (changes > 0) affectedIds.push(encodeMemoryId("mark", rawId));
          continue;
        }
        if (layer === "playbook" || layer === "playbooks") {
          const changes = this.localDb.prepare(`
            UPDATE playbooks
            SET active = 1,
                archived_at = NULL,
                updated_at = ?,
                invalidated_by = NULL
            WHERE id = ? AND active = 0
          `).run(ts, rawId).changes;
          if (changes > 0) affectedIds.push(encodeMemoryId("playbook", rawId));
        }
      }
    });
    tx();
    this._writeMarksProjection();
    this._writePlaybookProjection();
    if (factsChanged) {
      this.rebuildSummaryProjection();
    }
    this._notifyChanged();
    return {
      affectedIds,
      restoredToDefaultView: true,
    };
  }

  enqueueJob(jobType, payload, { jobKey = "" } = {}) {
    const now = nowIso();
    const key = jobKey || `${jobType}:${computeEvidenceHash(payload).slice(0, 24)}`;
    const id = createId("job");
    this.localDb.prepare(`
      INSERT INTO memory_jobs (
        id, job_key, job_type, payload, status, lease_until, attempts, max_attempts, last_error,
        available_at, created_at, updated_at, dead_letter_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 0, 5, NULL, ?, ?, ?, NULL)
      ON CONFLICT(job_key) DO UPDATE SET
        payload = excluded.payload,
        status = CASE
          WHEN memory_jobs.status = '${JOB_STATUS_DONE}' THEN memory_jobs.status
          ELSE '${JOB_STATUS_PENDING}'
        END,
        available_at = excluded.available_at,
        updated_at = excluded.updated_at,
        last_error = NULL,
        dead_letter_at = NULL
    `).run(id, key, jobType, stringifyJson(payload, {}), JOB_STATUS_PENDING, now, now, now);
    this._scheduleJobs();
    return { jobKey: key };
  }

  async runJobs(limit = 10) {
    const nextLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
    const now = nowIso();
    const rows = this.localDb.prepare(`
      SELECT id, job_key, job_type, payload, status, attempts, max_attempts
      FROM memory_jobs
      WHERE status IN ('${JOB_STATUS_PENDING}', '${JOB_STATUS_RETRY}')
        AND available_at <= ?
        AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY available_at ASC, created_at ASC
      LIMIT ?
    `).all(now, now, nextLimit);
    for (const row of rows) {
      const leaseUntil = new Date(Date.now() + 60_000).toISOString();
      const claimed = this.localDb.prepare(`
        UPDATE memory_jobs
        SET status = '${JOB_STATUS_RUNNING}',
            lease_until = ?,
            updated_at = ?
        WHERE id = ?
          AND status IN ('${JOB_STATUS_PENDING}', '${JOB_STATUS_RETRY}')
          AND (lease_until IS NULL OR lease_until <= ?)
      `).run(leaseUntil, nowIso(), row.id, nowIso()).changes;
      if (claimed === 0) continue;

      try {
        await this._processJob(row.job_type, parseJson(row.payload, {}));
        this.localDb.prepare(`
          UPDATE memory_jobs
          SET status = '${JOB_STATUS_DONE}',
              lease_until = NULL,
              updated_at = ?,
              last_error = NULL
          WHERE id = ?
        `).run(nowIso(), row.id);
      } catch (error) {
        const nextAttempts = (row.attempts || 0) + 1;
        const maxAttempts = row.max_attempts || 5;
        const retryDelayMs = Math.min(3_600_000, 60_000 * (2 ** Math.max(0, nextAttempts - 1)));
        const availableAt = new Date(Date.now() + retryDelayMs).toISOString();
        const failedStatus = nextAttempts >= maxAttempts ? JOB_STATUS_DEAD : JOB_STATUS_RETRY;
        this.localDb.prepare(`
          UPDATE memory_jobs
          SET status = ?,
              attempts = ?,
              last_error = ?,
              lease_until = NULL,
              available_at = ?,
              updated_at = ?,
              dead_letter_at = CASE WHEN ? = '${JOB_STATUS_DEAD}' THEN ? ELSE dead_letter_at END
          WHERE id = ?
        `).run(
          failedStatus,
          nextAttempts,
          String(error?.message || error || "job failed"),
          availableAt,
          nowIso(),
          failedStatus,
          nowIso(),
          row.id,
        );
      }
    }
  }

  async _processJob(jobType, payload) {
    if (jobType === "import_profile") {
      const content = safeText(payload.content);
      this.upsertProfile(content, {
        expectedVersion: Number.isInteger(payload.expectedVersion) ? payload.expectedVersion : null,
        targetVersion: Number.isInteger(payload.targetVersion) ? payload.targetVersion : null,
      });
      return;
    }
    throw new Error(`unsupported job type: ${jobType}`);
  }

  exportBundle() {
    return {
      version: 4,
      exportedAt: nowIso(),
      agentId: this.agentId,
      profile: this.getProfile(),
      marks: this.listMarks({ activeOnly: false }),
      summary: this.getSummaryProjection(),
      facts: this._factStore.exportAll(),
      evidence: this.localDb.prepare(`
        SELECT id, origin, scope, source_type, source_id, session_id, episode_id, content, preview,
               source_refs, redaction, hash, created_at, updated_at
        FROM evidence
        ORDER BY created_at ASC
      `).all().map((row) => ({
        id: row.id,
        origin: row.origin,
        scope: row.scope,
        sourceType: row.source_type,
        sourceId: row.source_id,
        sessionId: row.session_id,
        episodeId: row.episode_id,
        content: row.content,
        preview: row.preview,
        sourceRefs: parseJson(row.source_refs || "[]", []),
        redaction: parseJson(row.redaction || "{}", {}),
        hash: row.hash,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      episodes: this.localDb.prepare(`
        SELECT id, origin, scope, session_id, channel_name, anchor_text, source_refs, created_at, updated_at
        FROM episodes
        ORDER BY created_at ASC
      `).all().map((row) => ({
        id: row.id,
        origin: row.origin,
        scope: row.scope,
        sessionId: row.session_id,
        channelName: row.channel_name,
        anchorText: row.anchor_text,
        sourceRefs: parseJson(row.source_refs || "[]", []),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      playbooks: this.listPlaybooks({ activeOnly: false }),
    };
  }

  importBundle(bundle = {}) {
    const facts = Array.isArray(bundle.facts) ? bundle.facts : [];
    const evidence = Array.isArray(bundle.evidence) ? bundle.evidence : [];
    const episodes = Array.isArray(bundle.episodes) ? bundle.episodes : [];
    const playbooks = Array.isArray(bundle.playbooks) ? bundle.playbooks : [];
    const marks = Array.isArray(bundle.marks) ? bundle.marks : [];
    const summary = bundle.summary?.content;
    const profileContent = bundle.profile?.content;

    const tx = this.localDb.transaction(() => {
      for (const item of evidence) {
        this.recordEvidence({
          origin: item.origin,
          scope: item.scope,
          sourceType: item.sourceType || item.source_type,
          sourceId: item.sourceId || item.source_id,
          sessionId: item.sessionId || item.session_id,
          episodeId: item.episodeId || item.episode_id,
          content: item.content,
          sourceRefs: item.sourceRefs || item.source_refs || [],
        });
      }
      for (const item of episodes) {
        this.upsertEpisode({
          origin: item.origin,
          scope: item.scope,
          sessionId: item.sessionId || item.session_id,
          channelName: item.channelName || item.channel_name,
          anchorText: item.anchorText || item.anchor_text,
          sourceRefs: item.sourceRefs || item.source_refs || [],
        });
      }
      for (let index = 0; index < facts.length; index += 1) {
        const normalized = this._normalizeImportedFactEntry(facts[index], index);
        const withEvidence = this._ensureFactEvidenceRef(normalized, {
          sourceType: "memory_import_fact",
          sourceId: `memory-import:${index + 1}`,
        });
        this._validateFactEntry(withEvidence);
        const { id } = this._factStore.add(withEvidence);
        this._insertFactLinks(id, withEvidence.source_refs);
      }
      for (const item of marks) {
        this._upsertImportedMark(item);
      }
      for (const item of playbooks) {
        this._upsertImportedPlaybook(item);
      }
      if (typeof summary === "string") {
        this._writeSummaryProjectionRecord(summary, {
          sourceScope: bundle.summary?.sourceScope || bundle.summary?.source_scope || "agent",
          generatedAt: bundle.summary?.generatedAt || bundle.summary?.generated_at || null,
          updatedAt: bundle.summary?.updatedAt || bundle.summary?.updated_at || null,
        });
      }
    });
    tx();

    let queuedProfileImport = false;
    if (typeof profileContent === "string") {
      const currentProfile = this.getProfile();
      const expectedVersion = currentProfile.version || 0;
      const targetVersion = expectedVersion + 1;
      this.enqueueJob("import_profile", {
        content: profileContent,
        expectedVersion,
        targetVersion,
        sourceVersion: bundle.profile?.version ?? null,
      }, { jobKey: `import_profile:${PROFILE_KEY}:${targetVersion}` });
      queuedProfileImport = true;
    }

    if (typeof summary !== "string" && facts.length > 0) {
      this.rebuildSummaryProjection();
      this._projectUserProfileFile(this.getProfile().content);
      this._writeMarksProjection();
      this._writePlaybookProjection();
    } else {
      this.projectAllCompatibilityFiles();
    }
    this._notifyChanged();
    return {
      importedFacts: facts.length,
      importedEvidence: evidence.length,
      importedEpisodes: episodes.length,
      importedPlaybooks: playbooks.length,
      importedMarks: marks.length,
      queuedProfileImport,
    };
  }

  projectAllCompatibilityFiles() {
    this._projectUserProfileFile(this.getProfile().content);
    this._writeMarksProjection();
    this._writePlaybookProjection();
    writeTextAtomic(path.join(this.memoryDir, "memory.md"), safeText(this.getSummaryProjection().content));
  }
}
