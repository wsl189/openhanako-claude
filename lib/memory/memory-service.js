import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { FactStore } from "./fact-store.js";
import { assemble, assembleSections, buildFactsProjection, parseAssembledSections } from "./compile.js";
import { scrubPII } from "../pii-guard.js";

export const MEMORY_LAYERS = ["facts", "episodes", "evidence", "playbooks", "inactive"];
export const MEMORY_RANKING_VERSION = "rank_v3";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const SUMMARY_PROJECTION_KEY = "current_summary";
const CHANNEL_SUMMARY_PROJECTION_KEY = "current_summary_channel";
const PROFILE_PROJECTION_KEY = "current_profile";
const REFLECTION_PROJECTION_KEY = "current_reflection";
const PROFILE_KEY = "default";
const JOB_STATUS_PENDING = "pending";
const JOB_STATUS_RUNNING = "running";
const JOB_STATUS_DONE = "done";
const JOB_STATUS_RETRY = "retry";
const JOB_STATUS_DEAD = "dead";
const RETRIEVAL_LOG_SAMPLE_RATE = 1;
const RETRIEVAL_LOG_RETENTION_DAYS = 30;
const EVIDENCE_RETENTION_POLICY = {
  core: { archiveDays: null, purgeDays: null },
  session: { archiveDays: 45, purgeDays: 135 },
  tool_noise: { archiveDays: 1, purgeDays: 7 },
  tool_debug: { archiveDays: 14, purgeDays: 45 },
};
const MEMORY_ORIGIN_SET = new Set(["assistant", "session", "channel", "import", "system", "tool"]);
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
const SEARCH_INTENT_SET = new Set(["auto", "profile", "state", "decision", "episode", "playbook"]);
const SEARCH_SCOPE_SET = new Set(["auto", "agent", "profile", "channel"]);
const SEARCH_LAYER_SET = new Set(["auto", "facts", "episodes", "playbooks"]);
const MEMORY_RANKING_WEIGHTS = {
  bm25: 0.32,
  tag: 0.18,
  entity: 0.1,
  structured_entity: 0.15,
  recency: 0.14,
  confidence: 0.055,
  importance: 0.055,
};
const INTENT_PRIOR_WEIGHT = 0.2;
const SCOPE_PRIOR_WEIGHT = 0.12;
const FRESHNESS_GUARD_WEIGHT = 0.18;

function nowIso() {
  return new Date().toISOString();
}

function addDaysIso(baseIso, days) {
  const base = trimText(baseIso) || nowIso();
  const dt = new Date(base);
  if (!Number.isFinite(dt.getTime())) return null;
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toISOString();
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

function isMalformedSqliteError(err) {
  return /database disk image is malformed|malformed/i.test(String(err?.message || err || ""));
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

function parseToolEvidenceSummary(content) {
  const text = safeText(content);
  if (!text) return { isToolEvidence: false, success: null, body: "" };
  const match = text.match(/^tool:\s*(.+?)\nsuccess:\s*(true|false)\s*([\s\S]*)$/i);
  if (!match) return { isToolEvidence: false, success: null, body: "" };
  return {
    isToolEvidence: true,
    success: match[2].toLowerCase() === "true",
    body: trimText(match[3] || ""),
  };
}

function classifyEvidenceRetention({
  sourceType = "",
  content = "",
  retentionClass = "",
} = {}) {
  const explicit = trimText(retentionClass);
  if (explicit && Object.prototype.hasOwnProperty.call(EVIDENCE_RETENTION_POLICY, explicit)) {
    return explicit;
  }
  const type = trimText(sourceType);
  if (type === "memory_import_fact" || type === "playbook_manual" || type === "playbook_replace"
      || type === "playbook_extraction" || type === "playbook_promotion") {
    return "core";
  }
  if (type === "tool_result") {
    const toolSummary = parseToolEvidenceSummary(content);
    if (toolSummary.isToolEvidence) {
      return toolSummary.success ? "tool_noise" : "tool_debug";
    }
    return "tool_noise";
  }
  return "session";
}

function resolveEvidenceLifecycle(retentionClass, createdAt = nowIso()) {
  const policy = EVIDENCE_RETENTION_POLICY[retentionClass] || EVIDENCE_RETENTION_POLICY.session;
  return {
    archiveAfter: policy.archiveDays == null ? null : addDaysIso(createdAt, policy.archiveDays),
    purgeAfter: policy.purgeDays == null ? null : addDaysIso(createdAt, policy.purgeDays),
  };
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

function buildStructuredEntityLinks({ subjectId = null, stateKey = null, decisionKey = null } = {}) {
  const links = [];
  const seen = new Set();
  const push = (kind, value) => {
    const normalized = trimText(value);
    if (!normalized) return;
    const key = `${kind}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({
      key,
      kind,
      value: normalized,
      tokens: tokenizeText(normalized.replace(/[:/_-]+/g, " ")),
    });
  };
  push("subject", subjectId);
  push("state", stateKey);
  push("decision", decisionKey);
  return links;
}

function findMatchingStructuredEntityLinks(links = [], query = "", queryTokens = []) {
  const normalizedQuery = trimText(query).toLowerCase();
  const tokens = new Set(Array.isArray(queryTokens) ? queryTokens : []);
  return (Array.isArray(links) ? links : []).filter((link) => {
    const value = trimText(link?.value).toLowerCase();
    if (!value) return false;
    if (normalizedQuery && (normalizedQuery.includes(value) || value.includes(normalizedQuery))) {
      return true;
    }
    return (Array.isArray(link?.tokens) ? link.tokens : []).some((token) => tokens.has(token));
  }).map((link) => ({
    key: link.key,
    kind: link.kind,
    value: link.value,
  }));
}

function scoreStructuredEntityLinks(links = [], query = "", queryTokens = []) {
  const matches = findMatchingStructuredEntityLinks(links, query, queryTokens);
  if (matches.length === 0) return { score: 0, matches: [] };
  const denominator = Math.max(1, Math.min(queryTokens.length || 1, links.length));
  return {
    score: clamp01(matches.length / denominator),
    matches,
  };
}

function formatBlockMarkdown(blocks = []) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((block) => {
      const title = trimText(block?.title);
      const content = trimText(block?.content);
      if (!title || !content) return "";
      return `## ${title}\n\n${content}`;
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function normalizeMemoryKind(value) {
  const next = trimText(value).toLowerCase();
  return MEMORY_KIND_SET.has(next) ? next : "semantic";
}

function normalizeEpisodeKind(value) {
  const next = trimText(value).toLowerCase();
  return EPISODE_KIND_SET.has(next) ? next : "conversation";
}

function normalizeSearchIntent(value) {
  const next = trimText(value).toLowerCase();
  return SEARCH_INTENT_SET.has(next) ? next : "auto";
}

function normalizeSearchScope(value) {
  const next = trimText(value).toLowerCase();
  return SEARCH_SCOPE_SET.has(next) ? next : "auto";
}

function normalizeSearchLayer(value) {
  const next = trimText(value).toLowerCase();
  return SEARCH_LAYER_SET.has(next) ? next : "auto";
}

function normalizeProjectionScope(value) {
  return trimText(value) === "channel" ? "channel" : "agent";
}

function projectionScopeForMemoryScope(scope) {
  return trimText(scope) === "channel" ? "channel" : "agent";
}

function getSummaryProjectionKey(sourceScope = "agent") {
  return normalizeProjectionScope(sourceScope) === "channel"
    ? CHANNEL_SUMMARY_PROJECTION_KEY
    : SUMMARY_PROJECTION_KEY;
}

function resolveSearchIntent({
  query = "",
  tags = [],
  requestedIntent = "auto",
  requestedLayer = "auto",
} = {}) {
  if (requestedIntent !== "auto") return requestedIntent;
  if (requestedLayer === "playbooks") return "playbook";
  if (requestedLayer === "episodes") return "episode";
  if (requestedLayer === "facts") return "auto";

  const text = `${trimText(query)} ${(Array.isArray(tags) ? tags.join(" ") : "")}`.toLowerCase();
  if (!text) return "auto";

  const matches = (patterns) => patterns.some((pattern) => pattern.test(text));

  if (matches([
    /怎么修/,
    /怎么处理/,
    /如何修/,
    /如何处理/,
    /通常怎么/,
    /经验/,
    /排障/,
    /修复/,
    /根因/,
    /playbook/i,
    /runbook/i,
    /troubleshoot/i,
    /\bfix\b/i,
  ])) return "playbook";

  if (matches([
    /了解我/,
    /我是什么风格/,
    /我的偏好/,
    /我偏好/,
    /喜欢/,
    /偏好/,
    /习惯/,
    /约束/,
    /禁忌/,
    /注意事项/,
    /about me/i,
    /know me/i,
    /preference/i,
    /\bprefer\b/i,
  ])) return "profile";

  if (matches([
    /现在/,
    /目前/,
    /当前/,
    /还在/,
    /仍在/,
    /仍然/,
    /是否还/,
    /还.*吗/,
    /还持有/,
    /持有/,
    /进行中/,
    /最新状态/,
    /current status/i,
    /\bcurrently\b/i,
    /\bstill\b/i,
    /\bholding\b/i,
    /\bongoing\b/i,
  ])) return "state";

  if (matches([
    /为什么/,
    /为何/,
    /怎么定/,
    /如何定/,
    /决定/,
    /决策/,
    /结论/,
    /采纳/,
    /拒绝/,
    /路线/,
    /方案/,
    /原因/,
    /\bwhy\b/i,
    /decision/i,
    /\bdecide\b/i,
    /\bchosen\b/i,
    /conclusion/i,
  ])) return "decision";

  if (matches([
    /经过/,
    /过程/,
    /发生了什么/,
    /聊了什么/,
    /时间线/,
    /timeline/i,
    /history/i,
    /what happened/i,
  ])) return "episode";

  return "auto";
}

function isProfileMemoryKind(kind) {
  return kind === "profile_identity" || kind === "profile_preference" || kind === "profile_constraint";
}

function resolveFactScopeForKind(origin, fallbackScope, memoryKind) {
  if (origin === "channel") return "channel";
  if (isProfileMemoryKind(memoryKind)) return "profile";
  return trimText(fallbackScope) || "agent";
}

function shouldIncludeFactForProjection(row, sourceScope = "agent") {
  const scope = trimText(row?.scope) || "agent";
  if (sourceScope === "channel") return scope === "channel";
  return scope === "agent" || scope === "profile";
}

function memoryKindMatchesIntent(kind, intent) {
  if (intent === "auto") return 1;
  if (intent === "profile") return isProfileMemoryKind(kind) ? 1 : 0;
  if (intent === "state") return kind === "state" ? 1 : 0;
  if (intent === "decision") return kind === "decision" ? 1 : 0;
  return 0;
}

function scopeMatchesIntent(scope, requestedScope, memoryKind, intent) {
  const nextScope = trimText(scope) || "agent";
  if (requestedScope !== "auto") return nextScope === requestedScope ? 1 : 0;
  if (intent === "profile") return nextScope === "profile" ? 1 : 0.25;
  if (intent === "state" || intent === "decision") return nextScope === "agent" || nextScope === "channel" ? 1 : 0.2;
  return 0.5;
}

function freshnessGuardScore(row, intent) {
  if (intent !== "state") return 1;
  const truthMs = toEpochMs(row.truth_time || row.time || row.updated_at || row.created_at);
  if (!truthMs) return 0.2;
  const ageDays = Math.max(0, (Date.now() - truthMs) / 86400000);
  if (ageDays <= 3) return 1;
  if (ageDays <= 14) return 0.8;
  if (ageDays <= 30) return 0.45;
  return 0.15;
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

function collectEvidenceIds(rows = []) {
  const ids = new Set();
  for (const row of rows) {
    const refs = Array.isArray(row?.source_refs) ? row.source_refs : [];
    for (const ref of refs) {
      if (trimText(ref?.layer) !== "evidence") continue;
      const id = trimText(ref?.id);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function collectProjectionScopesFromFacts(rows = []) {
  const scopes = new Set();
  for (const row of rows) {
    scopes.add(projectionScopeForMemoryScope(row?.scope));
  }
  return scopes;
}

function collectProjectionScopesFromPlaybooks(rows = []) {
  const scopes = new Set();
  for (const row of rows) {
    scopes.add(projectionScopeForMemoryScope(row?.scope));
  }
  return scopes;
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
    memory_kind: normalizeMemoryKind(entry.memory_kind || entry.memoryKind),
    state_key: trimText(entry.state_key || entry.stateKey) || null,
    decision_key: trimText(entry.decision_key || entry.decisionKey) || null,
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
    staleness_hint: trimText(entry.staleness_hint || entry.stalenessHint) || null,
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
    scope: trimText(item.scope) || "agent",
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
    this.rebuildProfileProjection();
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

  _runWithMalformedFtsRepair(operation) {
    try {
      return operation();
    } catch (err) {
      if (!isMalformedSqliteError(err)) throw err;
      console.warn("[MemoryService] detected malformed facts FTS artifacts during write, rebuilding facts_fts and retrying");
      this._factStore.repairMalformedFtsArtifacts();
      return operation();
    }
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

  _writeProjectionRecord(key, kind, content, { sourceScope = "agent", generatedAt = null, updatedAt = null } = {}) {
    const nextContent = safeText(content);
    const generated = trimText(generatedAt) || nowIso();
    const updated = trimText(updatedAt) || generated;
    this.localDb.prepare(`
      INSERT INTO memory_projections (
        key, kind, content, source_scope, generated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        kind = excluded.kind,
        content = excluded.content,
        source_scope = excluded.source_scope,
        generated_at = excluded.generated_at,
        updated_at = excluded.updated_at
    `).run(key, kind, nextContent, sourceScope, generated, updated);
    return {
      content: nextContent,
      kind,
      generatedAt: generated,
      updatedAt: updated,
      sourceScope,
    };
  }

  _writeSummaryProjectionRecord(content, { sourceScope = "agent", generatedAt = null, updatedAt = null } = {}) {
    const nextSourceScope = normalizeProjectionScope(sourceScope);
    return this._writeProjectionRecord(getSummaryProjectionKey(nextSourceScope), "projection", content, {
      sourceScope: nextSourceScope,
      generatedAt,
      updatedAt,
    });
  }

  _writeProfileProjectionRecord(content, { sourceScope = "profile", generatedAt = null, updatedAt = null } = {}) {
    return this._writeProjectionRecord(PROFILE_PROJECTION_KEY, "profile_projection", content, {
      sourceScope,
      generatedAt,
      updatedAt,
    });
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
      scope: row.scope,
      sourceType: "playbook_import",
      sourceId: row.id,
    });
    this.localDb.prepare(`
      INSERT INTO playbooks (
        id, category, trigger, wrong_path, root_cause, fix_steps, validation, active,
        origin, scope, source_refs, created_at, updated_at, archived_at, invalidated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        category = excluded.category,
        trigger = excluded.trigger,
        wrong_path = excluded.wrong_path,
        root_cause = excluded.root_cause,
        fix_steps = excluded.fix_steps,
        validation = excluded.validation,
        active = excluded.active,
        origin = excluded.origin,
        scope = excluded.scope,
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
      row.scope,
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
      evidenceCleanup: this.getEvidenceCleanupStatus(),
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

  getProfileProjection() {
    const row = this.localDb.prepare(`
      SELECT content, kind, source_scope, generated_at, updated_at
      FROM memory_projections
      WHERE key = ?
    `).get(PROFILE_PROJECTION_KEY);
    return {
      title: "Current Profile Summary",
      content: row?.content || "",
      kind: row?.kind || "profile_projection",
      generatedAt: row?.generated_at || null,
      sourceScope: row?.source_scope || "profile",
      updatedAt: row?.updated_at || null,
    };
  }

  getProfileBlocks({ includePinned = true, includeManualSupplement = false } = {}) {
    const manualProfile = trimText(this.getProfile().content);
    const profileFacts = this._factStore.getAll()
      .filter((row) => row.is_active && row.scope === "profile")
      .sort((a, b) => {
        const bt = toEpochMs(b.truth_time || b.time || b.updated_at || b.created_at);
        const at = toEpochMs(a.truth_time || a.time || a.updated_at || a.created_at);
        return bt - at;
      });
    const pinned = includePinned
      ? this.listMarks({ activeOnly: true }).map((item) => trimText(item.text)).filter(Boolean)
      : [];
    const seenFacts = new Set();
    const identity = [];
    const preferences = [];
    const constraints = [];
    for (const row of profileFacts) {
      const text = trimText(row.fact);
      if (!text || seenFacts.has(text)) continue;
      seenFacts.add(text);
      const kind = normalizeMemoryKind(row.memory_kind);
      if (kind === "profile_identity") identity.push(text);
      else if (kind === "profile_constraint") constraints.push(text);
      else preferences.push(text);
    }
    const blocks = [];
    if (identity.length > 0) {
      blocks.push({
        id: "profile_identity",
        kind: "identity",
        title: "长期身份",
        itemCount: identity.length,
        items: identity,
        content: identity.map((item) => `- ${item}`).join("\n"),
      });
    }
    if (preferences.length > 0) {
      blocks.push({
        id: "profile_preferences",
        kind: "preferences",
        title: "长期偏好",
        itemCount: preferences.length,
        items: preferences,
        content: preferences.map((item) => `- ${item}`).join("\n"),
      });
    }
    if (constraints.length > 0) {
      blocks.push({
        id: "profile_constraints",
        kind: "constraints",
        title: "长期约束",
        itemCount: constraints.length,
        items: constraints,
        content: constraints.map((item) => `- ${item}`).join("\n"),
      });
    }
    if (pinned.length > 0) {
      blocks.push({
        id: "profile_pinned",
        kind: "pinned",
        title: "置顶记忆",
        itemCount: pinned.length,
        items: pinned,
        content: pinned.map((item) => `- ${item}`).join("\n"),
      });
    }
    if (manualProfile && (blocks.length === 0 || includeManualSupplement)) {
      blocks.push({
        id: "profile_manual",
        kind: "manual_profile",
        title: "手动档案",
        itemCount: 1,
        items: [manualProfile],
        content: manualProfile,
      });
    }
    return blocks;
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
      this.rebuildProfileProjection();
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

  renderProfilePrompt({ includePinned = true } = {}) {
    const content = formatBlockMarkdown(this.getProfileBlocks({
      includePinned,
      includeManualSupplement: false,
    }));
    if (content) return content;
    return trimText(this.getProfile().content);
  }

  rebuildProfileProjection() {
    const content = formatBlockMarkdown(this.getProfileBlocks({
      includePinned: true,
      includeManualSupplement: false,
    }));
    this._writeProfileProjectionRecord(content, { sourceScope: "profile" });
    this._projectUserProfileFile(content);
    return this.getProfileProjection();
  }

  getReflectionBlocks({ sourceScope = "agent" } = {}) {
    const nextScope = normalizeProjectionScope(sourceScope);
    const activeFacts = this._factStore.getAll()
      .filter((row) => row.is_active && shouldIncludeFactForProjection(row, nextScope))
      .sort((a, b) => {
        const bt = toEpochMs(b.truth_time || b.time || b.updated_at || b.created_at);
        const at = toEpochMs(a.truth_time || a.time || a.updated_at || a.created_at);
        return bt - at;
      });
    const stateItems = activeFacts
      .filter((row) => row.timeliness === "stateful" || row.timeliness === "ephemeral" || normalizeMemoryKind(row.memory_kind) === "state")
      .slice(0, 5)
      .map((row) => `- [${(row.truth_time || row.time || row.updated_at || row.created_at || "").slice(0, 16).replace("T", " ")}] ${trimText(row.fact)}`);
    const decisionItems = activeFacts
      .filter((row) => normalizeMemoryKind(row.memory_kind) === "decision")
      .slice(0, 5)
      .map((row) => `- [${(row.truth_time || row.time || row.updated_at || row.created_at || "").slice(0, 16).replace("T", " ")}] ${trimText(row.fact)}`);
    const playbookItems = this.listPlaybooks({
      activeOnly: true,
      scope: nextScope === "channel" ? "channel" : "agent",
    }).slice(0, 5).map((row) => {
      const summary = previewText(row.rootCause || row.validation || row.trigger, 90);
      return `- ${trimText(row.trigger)}${summary ? `：${summary}` : ""}`;
    });
    const blocks = [];
    if (stateItems.length > 0) {
      blocks.push({
        id: "reflection_state_watch",
        kind: "state_watch",
        title: "近期状态关注点",
        itemCount: stateItems.length,
        items: stateItems,
        content: stateItems.join("\n"),
      });
    }
    if (decisionItems.length > 0) {
      blocks.push({
        id: "reflection_decision_watch",
        kind: "decision_watch",
        title: "近期决策脉络",
        itemCount: decisionItems.length,
        items: decisionItems,
        content: decisionItems.join("\n"),
      });
    }
    if (playbookItems.length > 0) {
      blocks.push({
        id: "reflection_verified_experience",
        kind: "verified_experience",
        title: "已验证经验",
        itemCount: playbookItems.length,
        items: playbookItems,
        content: playbookItems.join("\n"),
      });
    }
    return blocks;
  }

  getReflectionProjection({ sourceScope = "agent" } = {}) {
    const nextScope = normalizeProjectionScope(sourceScope);
    const blocks = this.getReflectionBlocks({ sourceScope: nextScope });
    return {
      title: "Current Reflections",
      kind: "reflection_projection",
      sourceScope: nextScope,
      generatedAt: nowIso(),
      updatedAt: nowIso(),
      blocks,
      content: formatBlockMarkdown(blocks),
    };
  }

  renderReflectionPrompt({ sourceScope = "agent" } = {}) {
    return trimText(this.getReflectionProjection({ sourceScope }).content);
  }

  listMarks({ activeOnly = true } = {}) {
    const rows = this.localDb.prepare(`
      SELECT id, text, fact_id, active, source_refs, created_at, updated_at, archived_at
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
      sourceRefs: parseJson(row.source_refs || "[]", []),
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
    this.rebuildProfileProjection();
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
    this.rebuildProfileProjection();
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
    this.rebuildProfileProjection();
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
    this.rebuildProfileProjection();
    this._notifyChanged();
    return this.listMarks({ activeOnly: true });
  }

  getSummaryProjection({ sourceScope = "agent" } = {}) {
    const nextSourceScope = normalizeProjectionScope(sourceScope);
    const row = this.localDb.prepare(`
      SELECT content, kind, source_scope, generated_at, updated_at
      FROM memory_projections
      WHERE key = ?
    `).get(getSummaryProjectionKey(nextSourceScope));
    return {
      title: "Current Memory Summary",
      content: row?.content || "",
      kind: "projection",
      generatedAt: row?.generated_at || null,
      sourceScope: row?.source_scope || nextSourceScope,
      updatedAt: row?.updated_at || null,
    };
  }

  getCompatibilityFacts() {
    return this._factStore.exportAll();
  }

  listArchiveCandidateIds({
    includeFacts = true,
    includeEpisodes = true,
    includeEvidence = true,
    includeMarks = true,
    includePlaybooks = true,
  } = {}) {
    const ids = [];
    if (includeFacts) {
      const factRows = this.localDb.prepare(`
        SELECT id
        FROM facts
        WHERE is_active = 1
      `).all();
      ids.push(...factRows.map((row) => encodeMemoryId("fact", row.id)));
    }
    if (includeEpisodes) {
      const episodeRows = this.localDb.prepare(`
        SELECT id
        FROM episodes
        WHERE NOT EXISTS (
          SELECT 1
          FROM memory_archives ma
          WHERE ma.layer = 'episode' AND ma.item_id = episodes.id
        )
      `).all();
      ids.push(...episodeRows.map((row) => encodeMemoryId("episode", row.id)));
    }
    if (includeEvidence) {
      const evidenceRows = this.localDb.prepare(`
        SELECT id
        FROM evidence
        WHERE NOT EXISTS (
          SELECT 1
          FROM memory_archives ma
          WHERE ma.layer = 'evidence' AND ma.item_id = evidence.id
        )
      `).all();
      ids.push(...evidenceRows.map((row) => encodeMemoryId("evidence", row.id)));
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
    const nextSourceScope = normalizeProjectionScope(sourceScope);
    const next = this._writeSummaryProjectionRecord(content, { sourceScope: nextSourceScope });
    if (nextSourceScope === "agent") {
      writeTextAtomic(path.join(this.memoryDir, "memory.md"), next.content);
    }
    this._notifyChanged();
    return this.getSummaryProjection({ sourceScope: nextSourceScope });
  }

  renderMemoryPrompt({ sourceScope = "agent" } = {}) {
    return trimText(this.getSummaryProjection({ sourceScope }).content);
  }

  listPlaybooks({ activeOnly = true, scope = "auto" } = {}) {
    const nextScope = normalizeSearchScope(scope);
    const rows = this.localDb.prepare(`
      SELECT id, category, trigger, wrong_path, root_cause, fix_steps, validation, active,
             scope,
             origin, source_refs, created_at, updated_at, archived_at
      FROM playbooks
      WHERE (? = 0 OR active = 1)
        AND (? = 'auto' OR scope = ?)
      ORDER BY active DESC, updated_at DESC, created_at DESC
    `).all(activeOnly ? 1 : 0, nextScope, nextScope);
    return rows.map((row) => ({
      id: row.id,
      category: row.category || "",
      trigger: row.trigger,
      wrongPath: row.wrong_path,
      rootCause: row.root_cause,
      fixSteps: row.fix_steps,
      validation: row.validation,
      active: row.active === 1,
      scope: row.scope || "agent",
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
    const playbooks = this.listPlaybooks({ activeOnly: true, scope: "agent" });
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
        origin, scope, source_refs, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      id,
      playbook.category,
      playbook.trigger,
      playbook.wrongPath,
      playbook.rootCause,
      playbook.fixSteps,
      playbook.validation,
      origin,
      scope,
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
          scope = ?,
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
      trimText(patch.scope || current.scope) || "agent",
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
    retentionClass = "",
    archiveAfter = null,
    purgeAfter = null,
  }) {
    const nextOrigin = this._requireOrigin(origin, "evidence origin");
    const nextScope = trimText(scope) || "agent";
    if (nextOrigin === "channel" && nextScope === "profile") {
      this.logDiagnostic("reject_channel_profile_write", { sourceType, sourceId, sessionId });
      throw new Error("origin=channel cannot write scope=profile");
    }
    const { cleaned, detected } = scrubPII(safeText(content));
    const toolSummary = trimText(sourceType) === "tool_result" ? parseToolEvidenceSummary(cleaned) : null;
    if (toolSummary?.isToolEvidence && toolSummary.success === true && !toolSummary.body) {
      this.logDiagnostic("tool_evidence_skipped_empty_success", {
        sourceType: trimText(sourceType) || "text",
        sourceId: trimText(sourceId) || null,
        sessionId: trimText(sessionId) || null,
      });
      return null;
    }
    const ts = nowIso();
    const normalizedSourceRefs = normalizeSourceRefs(sourceRefs);
    const nextRetentionClass = classifyEvidenceRetention({
      sourceType,
      content: cleaned,
      retentionClass,
    });
    const lifecycle = resolveEvidenceLifecycle(nextRetentionClass, ts);
    const nextArchiveAfter = trimText(archiveAfter) || lifecycle.archiveAfter;
    const nextPurgeAfter = trimText(purgeAfter) || lifecycle.purgeAfter;
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
        source_refs, redaction, retention_class, archive_after, purge_after, hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      nextRetentionClass,
      nextArchiveAfter,
      nextPurgeAfter,
      hash,
      ts,
      ts,
    );
    const row = this.localDb.prepare(`
      SELECT id, origin, scope, source_type, source_id, session_id, episode_id, content, preview,
             source_refs, redaction, retention_class, archive_after, purge_after, hash, created_at, updated_at
      FROM evidence
      WHERE hash = ?
    `).get(hash);
    this.enqueueJob("cleanup_evidence", {
      scheduledForDay: ts.slice(0, 10),
    }, { jobKey: `cleanup_evidence:${ts.slice(0, 10)}` });
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
      retentionClass: row.retention_class || "session",
      archiveAfter: row.archive_after || null,
      purgeAfter: row.purge_after || null,
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
    episodeKind = "conversation",
    tags = [],
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
        id, origin, scope, session_id, channel_name, anchor_text, episode_kind, tags, source_refs, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        origin = excluded.origin,
        scope = excluded.scope,
        session_id = excluded.session_id,
        channel_name = excluded.channel_name,
        anchor_text = excluded.anchor_text,
        episode_kind = excluded.episode_kind,
        tags = excluded.tags,
        source_refs = excluded.source_refs,
        updated_at = excluded.updated_at
    `).run(
      id,
      nextOrigin,
      nextScope,
      trimText(sessionId) || null,
      trimText(channelName) || null,
      safeText(anchorText),
      normalizeEpisodeKind(episodeKind),
      stringifyJson(Array.isArray(tags) ? tags.map((item) => trimText(item)).filter(Boolean) : [], []),
      stringifyJson(normalizedSourceRefs, []),
      ts,
      ts,
    );
    return this.getEpisodeById(id);
  }

  getEpisodeById(id) {
    const row = this.localDb.prepare(`
      SELECT id, origin, scope, session_id, channel_name, anchor_text, episode_kind, tags, source_refs, created_at, updated_at
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
      episodeKind: normalizeEpisodeKind(row.episode_kind),
      tags: parseJson(row.tags || "[]", []),
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

  listEvidenceBySession(sessionId, { includeArchived = false } = {}) {
    const rows = this.localDb.prepare(`
      SELECT id, origin, scope, source_type, source_id, session_id, episode_id, content, preview,
             source_refs, redaction, retention_class, archive_after, purge_after, hash, created_at, updated_at
      FROM evidence
      WHERE session_id = ?
        AND (? = 1 OR NOT EXISTS (
          SELECT 1
          FROM memory_archives ma
          WHERE ma.layer = 'evidence' AND ma.item_id = evidence.id
        ))
      ORDER BY updated_at DESC, created_at DESC
    `).all(sessionId, includeArchived ? 1 : 0);
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
      retentionClass: row.retention_class || "session",
      archiveAfter: row.archive_after || null,
      purgeAfter: row.purge_after || null,
      hash: row.hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getEvidenceCleanupPolicy() {
    return {
      core: { archiveDays: null, purgeDays: null },
      session: { archiveDays: 45, purgeDays: 135 },
      toolNoise: { archiveDays: 1, purgeDays: 7 },
      toolDebug: { archiveDays: 14, purgeDays: 45 },
    };
  }

  _collectProtectedEvidenceIds() {
    const protectedIds = new Set();
    const addRefIds = (refs = []) => {
      for (const ref of normalizeSourceRefs(refs)) {
        if (ref.layer === "evidence" && trimText(ref.id)) {
          protectedIds.add(trimText(ref.id));
        }
      }
    };

    const factRows = this.localDb.prepare(`
      SELECT DISTINCT fl.evidence_id
      FROM fact_links fl
      JOIN facts f ON f.id = fl.fact_id
      WHERE f.is_active = 1
        AND fl.evidence_id IS NOT NULL
        AND fl.evidence_id <> ''
    `).all();
    for (const row of factRows) {
      if (trimText(row.evidence_id)) protectedIds.add(trimText(row.evidence_id));
    }

    for (const playbook of this.listPlaybooks({ activeOnly: true })) addRefIds(playbook.sourceRefs);
    for (const mark of this.listMarks({ activeOnly: true })) addRefIds(mark.sourceRefs);

    const episodeRows = this.localDb.prepare(`
      SELECT source_refs
      FROM episodes
      WHERE NOT EXISTS (
        SELECT 1
        FROM memory_archives ma
        WHERE ma.layer = 'episode' AND ma.item_id = episodes.id
      )
    `).all();
    for (const row of episodeRows) addRefIds(parseJson(row.source_refs || "[]", []));

    const evidenceRows = this.localDb.prepare(`
      SELECT source_refs
      FROM evidence
      WHERE NOT EXISTS (
        SELECT 1
        FROM memory_archives ma
        WHERE ma.layer = 'evidence' AND ma.item_id = evidence.id
      )
    `).all();
    for (const row of evidenceRows) addRefIds(parseJson(row.source_refs || "[]", []));

    return protectedIds;
  }

  _listEvidenceRowsDueForArchive(now, limit = 200) {
    return this.localDb.prepare(`
      SELECT id, preview, origin, scope, source_type, source_id, session_id, episode_id,
             retention_class, archive_after, purge_after, created_at, updated_at
      FROM evidence
      WHERE archive_after IS NOT NULL
        AND archive_after <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM memory_archives ma
          WHERE ma.layer = 'evidence' AND ma.item_id = evidence.id
        )
      ORDER BY archive_after ASC, created_at ASC
      LIMIT ?
    `).all(now, limit);
  }

  _listEvidenceRowsDueForPurge(now, limit = 200) {
    return this.localDb.prepare(`
      SELECT e.id, e.preview, e.origin, e.scope, e.source_type, e.source_id, e.session_id, e.episode_id,
             e.retention_class, e.archive_after, e.purge_after, e.created_at, e.updated_at,
             ma.archived_at
      FROM evidence e
      JOIN memory_archives ma
        ON ma.layer = 'evidence' AND ma.item_id = e.id
      WHERE e.purge_after IS NOT NULL
        AND e.purge_after <= ?
      ORDER BY e.purge_after ASC, ma.archived_at ASC
      LIMIT ?
    `).all(now, limit);
  }

  _archiveEvidenceRows(rows, { archivedAt = nowIso(), reason = "auto_cleanup", autoCleanup = false } = {}) {
    for (const row of rows) {
      this.localDb.prepare(`
        INSERT INTO memory_archives (
          layer, item_id, preview, truth_time, origin, scope, payload, archived_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(layer, item_id) DO UPDATE SET
          preview = excluded.preview,
          truth_time = excluded.truth_time,
          origin = excluded.origin,
          scope = excluded.scope,
          payload = excluded.payload,
          archived_at = excluded.archived_at,
          updated_at = excluded.updated_at
      `).run(
        "evidence",
        row.id,
        row.preview || "",
        row.updated_at || row.created_at || archivedAt,
        row.origin || null,
        row.scope || null,
        stringifyJson({
          sourceType: row.source_type || null,
          sourceId: row.source_id || null,
          sessionId: row.session_id || null,
          episodeId: row.episode_id || null,
          retentionClass: row.retention_class || "session",
          archiveAfter: row.archive_after || null,
          purgeAfter: row.purge_after || null,
          autoCleanup,
          cleanupReason: reason,
        }, {}),
        archivedAt,
        archivedAt,
      );
    }
  }

  _planEvidenceCleanup({ now = nowIso(), archiveLimit = 200, purgeLimit = 200 } = {}) {
    const protectedIds = this._collectProtectedEvidenceIds();
    const archiveDue = this._listEvidenceRowsDueForArchive(now, archiveLimit);
    const purgeDue = this._listEvidenceRowsDueForPurge(now, purgeLimit);
    const archivableRows = archiveDue.filter((row) => !protectedIds.has(trimText(row.id)));
    const purgeableRows = purgeDue.filter((row) => !protectedIds.has(trimText(row.id)));
    return {
      now,
      protectedIds,
      archiveDueCount: archiveDue.length,
      purgeDueCount: purgeDue.length,
      skippedProtectedCount: (archiveDue.length - archivableRows.length) + (purgeDue.length - purgeableRows.length),
      archivableRows,
      purgeableRows,
    };
  }

  getEvidenceCleanupStatus() {
    const plan = this._planEvidenceCleanup();
    return {
      enabled: true,
      policy: this.getEvidenceCleanupPolicy(),
      dueArchiveCount: plan.archivableRows.length,
      duePurgeCount: plan.purgeableRows.length,
      skippedProtectedCount: plan.skippedProtectedCount,
      evaluatedAt: plan.now,
    };
  }

  runEvidenceCleanup({ now = nowIso(), archiveLimit = 200, purgeLimit = 200, dryRun = false, trigger = "manual" } = {}) {
    const plan = this._planEvidenceCleanup({ now, archiveLimit, purgeLimit });
    if (dryRun) {
      return {
        dryRun: true,
        trigger,
        archivedEvidence: 0,
        purgedEvidence: 0,
        dueArchiveCount: plan.archivableRows.length,
        duePurgeCount: plan.purgeableRows.length,
        skippedProtectedCount: plan.skippedProtectedCount,
      };
    }

    const archivedAt = nowIso();
    this.localDb.transaction(() => {
      this._archiveEvidenceRows(plan.archivableRows, {
        archivedAt,
        reason: "auto_cleanup_archive",
        autoCleanup: true,
      });
      for (const row of plan.purgeableRows) {
        this.localDb.prepare(`
          DELETE FROM fact_links
          WHERE evidence_id = ?
        `).run(row.id);
        this.localDb.prepare(`
          DELETE FROM memory_archives
          WHERE layer = 'evidence' AND item_id = ?
        `).run(row.id);
        this.localDb.prepare(`
          DELETE FROM evidence
          WHERE id = ?
        `).run(row.id);
      }
    })();
    if (plan.archivableRows.length > 0 || plan.purgeableRows.length > 0) {
      this._notifyChanged();
    }
    this.logDiagnostic("evidence_cleanup_run", {
      trigger,
      archivedEvidence: plan.archivableRows.length,
      purgedEvidence: plan.purgeableRows.length,
      skippedProtectedCount: plan.skippedProtectedCount,
    });
    return {
      dryRun: false,
      trigger,
      archivedEvidence: plan.archivableRows.length,
      purgedEvidence: plan.purgeableRows.length,
      dueArchiveCount: plan.archivableRows.length,
      duePurgeCount: plan.purgeableRows.length,
      skippedProtectedCount: plan.skippedProtectedCount,
    };
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
    if (normalized.some((entry) => entry.scope === "profile")) {
      this.rebuildProfileProjection();
    }
    this._notifyChanged();
    return normalized.length;
  }

  applyExtractionBundle(bundle = {}, context = {}) {
    const origin = this._requireOrigin(trimText(context.origin) || "session", "bundle origin");
    const fallbackScope = trimText(context.scope) || (origin === "channel" ? "channel" : "agent");
    const sessionId = trimText(context.sessionId || context.session_id) || null;
    const channelName = trimText(context.channelName || context.channel_name) || null;
    const sourceRefs = normalizeSourceRefs(context.sourceRefs || context.source_refs || []);
    const facts = Array.isArray(bundle.facts) ? bundle.facts : [];
    const playbooks = Array.isArray(bundle.playbooks) ? bundle.playbooks : [];
    const episodePatch = (bundle.episode_patch && typeof bundle.episode_patch === "object")
      ? bundle.episode_patch
      : ((bundle.episodePatch && typeof bundle.episodePatch === "object") ? bundle.episodePatch : {});
    const ignored = [];

    const episode = this.upsertEpisode({
      origin,
      scope: fallbackScope,
      sessionId,
      channelName,
      anchorText: trimText(episodePatch.anchor_text || episodePatch.anchorText || context.anchorText) || "",
      episodeKind: episodePatch.episode_kind || episodePatch.episodeKind || context.episodeKind || "conversation",
      tags: Array.isArray(episodePatch.tags) ? episodePatch.tags : [],
      sourceRefs,
    });

    const factEntries = facts.map((item) => {
      const memoryKind = normalizeMemoryKind(item.memory_kind || item.memoryKind);
      const resolvedScope = resolveFactScopeForKind(origin, fallbackScope, memoryKind);
      if (origin === "channel" && resolvedScope === "profile") {
        ignored.push(trimText(item.fact));
        return null;
      }
      const nextTimeliness = memoryKind === "state"
        ? "stateful"
        : (trimText(item.timeliness) || "persistent");
      return normalizeFactEntry({
        ...item,
        timeliness: nextTimeliness,
        memory_kind: memoryKind,
        scope: resolvedScope,
        origin,
        session_id: sessionId,
        source_refs: item.source_refs || item.sourceRefs || sourceRefs,
      });
    }).filter(Boolean);

    if (factEntries.length > 0) {
      this.addFacts(factEntries);
    }

    const addedPlaybookIds = [];
    for (const item of playbooks) {
      const sourceRefsForPlaybook = item.sourceRefs || item.source_refs || sourceRefs;
      const created = this.addPlaybook({
        ...item,
        origin,
        scope: origin === "channel" ? "channel" : "agent",
        sessionId,
        sourceRefs: sourceRefsForPlaybook,
        sourceType: trimText(item.sourceType || item.source_type) || "playbook_extraction",
      });
      if (created?.id) addedPlaybookIds.push(created.id);
    }

    this.enqueueJob("consolidate_facts", {
      origin,
      scope: fallbackScope,
      sessionId,
      sourceRefs,
    }, { jobKey: `consolidate_facts:${sessionId || origin}:${episode.id}` });
    this.enqueueJob("promote_patterns", {
      origin,
      scope: fallbackScope,
      sessionId,
    }, { jobKey: `promote_patterns:${sessionId || origin}:${episode.id}` });
    const consolidation = this.runConsolidation();
    const promotion = this.promotePatterns();
    const hasProfileFacts = factEntries.some((item) => item.scope === "profile") || promotion.promotedProfileFacts > 0;
    if (hasProfileFacts || this.listMarks({ activeOnly: true }).length > 0 || trimText(this.getProfile().content)) {
      this.enqueueJob("rebuild_profile", {
        origin,
        sessionId,
      }, { jobKey: `rebuild_profile:${sessionId || origin}` });
      this.rebuildProfileProjection();
    }
    if (ignored.length > 0) {
      this.logDiagnostic("channel_profile_fact_ignored", {
        missionId: trimText(context.missionId) || null,
        origin,
        ignored,
      });
    }
    return {
      episodeId: episode.id,
      factsAdded: factEntries.length,
      playbooksAdded: addedPlaybookIds.length,
      ignoredFacts: ignored,
      consolidation,
      promotion,
    };
  }

  runConsolidation() {
    const activeFacts = this._factStore.getAll().filter((row) => row.is_active);
    let deactivatedStates = 0;
    let deactivatedDecisions = 0;
    const tx = this.localDb.transaction(() => {
      const deactivate = this.localDb.prepare(`
        UPDATE facts
        SET is_active = 0,
            valid_to = COALESCE(valid_to, ?),
            updated_at = ?,
            invalidated_by = COALESCE(invalidated_by, ?)
        WHERE id = ? AND is_active = 1
      `);
      const processGroup = (rows, reason) => {
        const ordered = rows.slice().sort((a, b) => {
          const bt = toEpochMs(b.truth_time || b.time || b.updated_at || b.created_at);
          const at = toEpochMs(a.truth_time || a.time || a.updated_at || a.created_at);
          if (bt !== at) return bt - at;
          return Number(b.id) - Number(a.id);
        });
        const winner = ordered[0];
        const winnerTs = winner.truth_time || winner.time || winner.updated_at || winner.created_at || nowIso();
        for (const row of ordered.slice(1)) {
          const changes = deactivate.run(winnerTs, nowIso(), reason, row.id).changes;
          if (changes > 0 && reason === "state_replaced") deactivatedStates += 1;
          if (changes > 0 && reason === "decision_replaced") deactivatedDecisions += 1;
        }
      };

      const stateGroups = new Map();
      const decisionGroups = new Map();
      for (const row of activeFacts) {
        if (normalizeMemoryKind(row.memory_kind) === "state" && trimText(row.state_key)) {
          const key = `${trimText(row.scope) || "agent"}::${trimText(row.state_key)}`;
          if (!stateGroups.has(key)) stateGroups.set(key, []);
          stateGroups.get(key).push(row);
        }
        if (normalizeMemoryKind(row.memory_kind) === "decision" && trimText(row.decision_key)) {
          const key = `${trimText(row.scope) || "agent"}::${trimText(row.decision_key)}`;
          if (!decisionGroups.has(key)) decisionGroups.set(key, []);
          decisionGroups.get(key).push(row);
        }
      }
      for (const rows of stateGroups.values()) {
        if (rows.length > 1) processGroup(rows, "state_replaced");
      }
      for (const rows of decisionGroups.values()) {
        if (rows.length > 1) processGroup(rows, "decision_replaced");
      }
    });
    tx();
    return { deactivatedStates, deactivatedDecisions };
  }

  promotePatterns() {
    const activeFacts = this._factStore.getAll().filter((row) => row.is_active);
    const promotedProfileFacts = [];
    const promotedPlaybooks = [];
    const grouped = new Map();

    for (const row of activeFacts) {
      if (row.scope === "profile") continue;
      const factText = trimText(row.fact);
      if (!factText) continue;
      const scopeKey = trimText(row.scope) || "agent";
      const key = `${scopeKey}::${factText}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }

    for (const [groupKey, rows] of grouped.entries()) {
      if (rows.length < 2) continue;
      const [scopeKey, ...factTextParts] = groupKey.split("::");
      const factText = factTextParts.join("::");
      const evidenceIds = collectEvidenceIds(rows);
      if (evidenceIds.size < 2) continue;
      const first = rows[0];
      const tags = Array.isArray(first.tags) ? first.tags : [];
      const refs = normalizeSourceRefs(rows.flatMap((row) => row.source_refs || [])).slice(0, 6);
      const sessionId = trimText(first.session_id) || null;
      const time = first.truth_time || first.time || null;
      if (scopeKey === "agent" && (/喜欢|偏好|习惯|总是|倾向/.test(factText) || tags.some((tag) => /偏好|习惯/.test(tag)))) {
        const exists = activeFacts.some((row) => row.scope === "profile" && row.fact === factText);
        if (!exists) {
          this.addFacts([{
            fact: factText,
            tags,
            time,
            timeliness: "persistent",
            memory_kind: "profile_preference",
            origin: "assistant",
            scope: "profile",
            session_id: sessionId,
            source_refs: refs,
            confidence: 0.85,
            importance: 0.75,
          }]);
          promotedProfileFacts.push(factText);
          this.logDiagnostic("fact_promoted_to_profile", { fact: factText, kind: "profile_preference" });
        }
        continue;
      }
      if (scopeKey === "agent" && (/必须|不要|禁止|约束|要求|只能|不可/.test(factText) || tags.some((tag) => /约束|规则|限制/.test(tag)))) {
        const exists = activeFacts.some((row) => row.scope === "profile" && row.fact === factText);
        if (!exists) {
          this.addFacts([{
            fact: factText,
            tags,
            time,
            timeliness: "persistent",
            memory_kind: "profile_constraint",
            origin: "assistant",
            scope: "profile",
            session_id: sessionId,
            source_refs: refs,
            confidence: 0.9,
            importance: 0.85,
          }]);
          promotedProfileFacts.push(factText);
          this.logDiagnostic("fact_promoted_to_profile", { fact: factText, kind: "profile_constraint" });
        }
        continue;
      }
      const playbookScope = scopeKey === "channel" ? "channel" : "agent";
      if ((/错误|报错|修复|根因|排障/.test(factText) || tags.some((tag) => /错误|修复|排障|根因/.test(tag)))
          && !this.listPlaybooks({ activeOnly: true, scope: playbookScope }).some((item) => item.trigger === factText)) {
        const playbook = this.addPlaybook({
          category: "Promoted",
          trigger: factText,
          wrong_path: "重复出现同类问题但没有沉淀经验",
          root_cause: factText,
          fix_steps: "参考关联 evidence 与历史处理记录进行复现和修复",
          validation: "同类问题可被快速定位并处理",
          origin: "assistant",
          scope: playbookScope,
          sessionId,
          sourceRefs: refs,
          sourceType: "playbook_promotion",
        });
        promotedPlaybooks.push(playbook.id);
        this.logDiagnostic("fact_promoted_to_playbook", { fact: factText, playbookId: playbook.id });
      }
    }

    return {
      promotedProfileFacts: promotedProfileFacts.length,
      promotedPlaybooks: promotedPlaybooks.length,
    };
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

  searchIndex({ query = "", tags = [], dateFrom = null, dateTo = null, limit = 10, intent = "auto", scope = "auto", route = null } = {}) {
    const nextLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
    const nextIntent = normalizeSearchIntent(intent);
    const nextScope = normalizeSearchScope(scope);
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
    const filteredRows = rows.filter((row) => {
      if (nextScope !== "auto" && trimText(row.scope) !== nextScope) return false;
      if (nextIntent === "profile" && normalizeMemoryKind(row.memory_kind) === "working_note") return false;
      return true;
    });
    const queryTokens = tokenizeText(query);
    const requestedTags = Array.isArray(tags)
      ? tags.map((item) => trimText(item).toLowerCase()).filter(Boolean)
      : [];
    const now = Date.now();
    const scoredRows = filteredRows.map((row) => {
      const matchCount = Number(row.matchCount) || 0;
      const tagDenominator = requestedTags.length || (Array.isArray(row.tags) ? row.tags.length : 0) || 1;
      const tagScore = clamp01(matchCount / tagDenominator);

      const rowTextTokens = new Set([
        ...tokenizeText(row.fact),
        ...(Array.isArray(row.tags) ? row.tags.map((tag) => String(tag || "").toLowerCase()) : []),
      ]);
      const entityHits = queryTokens.filter((token) => rowTextTokens.has(token)).length;
      const entityScore = queryTokens.length > 0 ? clamp01(entityHits / queryTokens.length) : 0;
      const structuredLinks = buildStructuredEntityLinks({
        subjectId: row.subject_id || null,
        stateKey: row.state_key || null,
        decisionKey: row.decision_key || null,
      });
      const structuredEntity = scoreStructuredEntityLinks(structuredLinks, query, queryTokens);

      const bm25Score = normalizeBm25Score(row.rank);
      const truthMs = toEpochMs(row.truth_time || row.time || row.updated_at || row.created_at);
      const ageDays = truthMs > 0 ? Math.max(0, (now - truthMs) / 86400000) : 9999;
      const recencyScore = truthMs > 0 ? clamp01(Math.exp(-ageDays / 30)) : 0;
      const confidenceScore = row.confidence == null ? 0.5 : clamp01(row.confidence);
      const importanceScore = row.importance == null ? 0.5 : clamp01(row.importance);
      const intentMatchScore = memoryKindMatchesIntent(normalizeMemoryKind(row.memory_kind), nextIntent);
      const scopeMatchScore = scopeMatchesIntent(row.scope, nextScope, normalizeMemoryKind(row.memory_kind), nextIntent);
      const freshnessGuard = freshnessGuardScore(row, nextIntent);

      const components = {
        bm25: bm25Score,
        tag: tagScore,
        entity: entityScore,
        structured_entity: structuredEntity.score,
        recency: recencyScore,
        confidence: confidenceScore,
        importance: importanceScore,
        intent_match: intentMatchScore,
        scope_match: scopeMatchScore,
        freshness_guard: freshnessGuard,
      };
      const weightedScore = Object.entries(MEMORY_RANKING_WEIGHTS).reduce((acc, [key, weight]) => {
        return acc + (components[key] || 0) * weight;
      }, 0)
        + (intentMatchScore * INTENT_PRIOR_WEIGHT)
        + (scopeMatchScore * SCOPE_PRIOR_WEIGHT)
        + (freshnessGuard * FRESHNESS_GUARD_WEIGHT);
      return {
        ...row,
        _score: weightedScore,
        _components: components,
        _entityLinks: structuredLinks.map(({ tokens, ...rest }) => rest),
        _entityMatches: structuredEntity.matches,
      };
    });
    if (nextIntent === "state" && scoredRows.some((row) => (row._components?.freshness_guard || 0) < 0.5)) {
      this.logDiagnostic("stale_state_suppressed", {
        query: trimText(query),
        scope: nextScope,
        staleCandidates: scoredRows
          .filter((row) => (row._components?.freshness_guard || 0) < 0.5)
          .map((row) => ({
            id: row.id,
            fact: row.fact,
            freshness: row._components?.freshness_guard || 0,
          }))
          .slice(0, 5),
      });
    }
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
        components: ["bm25", "tag", "entity", "structured_entity", "recency", "confidence", "importance", "intent_match", "scope_match", "freshness_guard"],
        requestedIntent: route?.requestedIntent || nextIntent,
        resolvedIntent: nextIntent,
        requestedScope: route?.requestedScope || nextScope,
        resolvedScope: nextScope,
        requestedLayer: route?.requestedLayer || "facts",
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
          entityLinks: row._entityLinks || [],
          entityMatches: row._entityMatches || [],
        })),
      },
      resultIds: finalRows.map((row) => encodeMemoryId("fact", row.id)),
    });
    return finalRows;
  }

  _searchEpisodes({ query = "", limit = 10, scope = "auto" } = {}) {
    const nextLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
    const nextScope = normalizeSearchScope(scope);
    const text = trimText(query);
    if (!text) return [];
    const rows = this.localDb.prepare(`
      SELECT id, anchor_text, origin, scope, session_id, channel_name, episode_kind, tags, updated_at, created_at
      FROM episodes
      WHERE anchor_text LIKE '%' || ? || '%'
        AND (? = 'auto' OR scope = ?)
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(text, nextScope, nextScope, nextLimit);
    return rows.map((row) => ({
      id: encodeMemoryId("episode", row.id),
      layer: "episodes",
      itemType: "episode",
      preview: previewText(row.anchor_text, 220),
      content: row.anchor_text,
      truthTime: row.updated_at || row.created_at,
      origin: row.origin,
      scope: row.scope,
      episodeKind: normalizeEpisodeKind(row.episode_kind),
      tags: parseJson(row.tags || "[]", []),
      sessionId: row.session_id || null,
      channelName: row.channel_name || null,
    }));
  }

  _searchPlaybooks({ query = "", limit = 10, scope = "auto" } = {}) {
    const nextLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
    const nextScope = normalizeSearchScope(scope);
    const text = trimText(query);
    if (!text) return [];
    const rows = this.localDb.prepare(`
      SELECT id, category, trigger, wrong_path, root_cause, fix_steps, validation, origin, scope, updated_at, created_at
      FROM playbooks
      WHERE active = 1
        AND (? = 'auto' OR scope = ?)
        AND (
          trigger LIKE '%' || ? || '%'
          OR wrong_path LIKE '%' || ? || '%'
          OR root_cause LIKE '%' || ? || '%'
          OR fix_steps LIKE '%' || ? || '%'
          OR validation LIKE '%' || ? || '%'
        )
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(nextScope, nextScope, text, text, text, text, text, nextLimit);
    return rows.map((row) => ({
      id: encodeMemoryId("playbook", row.id),
      layer: "playbooks",
      itemType: "playbook",
      preview: `${row.category ? `[${row.category}] ` : ""}${row.trigger}`,
      content: playbookToCompatibilityText({
        trigger: row.trigger,
        wrongPath: row.wrong_path,
        rootCause: row.root_cause,
        fixSteps: row.fix_steps,
        validation: row.validation,
      }),
      truthTime: row.updated_at || row.created_at,
      origin: row.origin || "assistant",
      scope: row.scope || "agent",
      category: row.category || "",
    }));
  }

  searchMemories({ query = "", tags = [], dateFrom = null, dateTo = null, limit = 10, intent = "auto", layers = "auto", scope = "auto" } = {}) {
    const nextLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
    const requestedIntent = normalizeSearchIntent(intent);
    const requestedLayer = normalizeSearchLayer(layers);
    const requestedScope = normalizeSearchScope(scope);
    const nextIntent = resolveSearchIntent({
      query,
      tags,
      requestedIntent,
      requestedLayer,
    });
    const nextLayer = requestedLayer;
    const nextScope = requestedScope === "auto" && nextIntent === "profile"
      ? "profile"
      : requestedScope;
    const route = {
      requestedIntent,
      requestedLayer,
      requestedScope,
    };
    const includeFacts = nextLayer === "facts"
      || (nextLayer === "auto" && nextIntent !== "playbook");
    const includeEpisodes = nextLayer === "episodes"
      || (nextLayer === "auto" && (nextIntent === "episode" || nextIntent === "decision"));
    const includePlaybooks = nextLayer === "playbooks"
      || (nextLayer === "auto" && nextIntent === "playbook");

    const results = [];
    if (includeFacts) {
      results.push(...this.searchIndex({
        query,
        tags,
        dateFrom,
        dateTo,
        limit: nextLimit,
        intent: nextIntent,
        scope: nextScope,
        route,
      }).map((row) => ({
        ...row,
        id: encodeMemoryId("fact", row.id),
        layer: "facts",
        itemType: "fact",
        preview: row.fact,
        truthTime: row.truth_time || row.time || row.updated_at || row.created_at,
      })));
    }
    if (includeEpisodes) {
      results.push(...this._searchEpisodes({ query, limit: nextLimit, scope: nextScope }));
    }
    if (includePlaybooks) {
      results.push(...this._searchPlaybooks({ query, limit: nextLimit, scope: nextScope }));
    }
    const finalResults = results
      .sort((a, b) => {
        const aScore = Number(a._score) || 0;
        const bScore = Number(b._score) || 0;
        if (bScore !== aScore) return bScore - aScore;
        return toEpochMs(b.truthTime || b.updated_at || b.created_at) - toEpochMs(a.truthTime || a.updated_at || a.created_at);
      })
      .slice(0, nextLimit);

    if (!includeFacts || includeEpisodes || includePlaybooks) {
      const loggedLayer = nextLayer === "auto"
        ? (includeEpisodes && includePlaybooks ? "mixed" : includeEpisodes ? "episodes" : includePlaybooks ? "playbooks" : "facts")
        : nextLayer;
      this.recordRetrievalLog({
        query: trimText(query),
        layer: loggedLayer,
        configSnapshot: {
          strategy: "routed_layers",
          requestedIntent,
          resolvedIntent: nextIntent,
          requestedScope,
          resolvedScope: nextScope,
          requestedLayer,
          includedLayers: [
            includeFacts ? "facts" : null,
            includeEpisodes ? "episodes" : null,
            includePlaybooks ? "playbooks" : null,
          ].filter(Boolean),
          limit: nextLimit,
          finalOrder: finalResults.map((row) => ({
            id: row.id,
            itemType: row.itemType,
            scope: row.scope || null,
            truthTime: row.truthTime || row.updated_at || row.created_at || null,
            weightedScore: row._score == null ? null : Number(row._score?.toFixed(6) || 0),
            componentScores: row._components || null,
            entityLinks: row._entityLinks || [],
            entityMatches: row._entityMatches || [],
          })),
        },
        resultIds: finalResults.map((row) => row.id),
      });
    }
    return finalResults;
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
      SELECT id, fact, tags, time, truth_time, timeliness, scope, origin, memory_kind, is_active, created_at, updated_at
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
      memoryKind: normalizeMemoryKind(row.memory_kind),
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
      WHERE NOT EXISTS (
        SELECT 1
        FROM memory_archives ma
        WHERE ma.layer = 'evidence' AND ma.item_id = evidence.id
      )
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
      SELECT id, anchor_text, origin, scope, session_id, channel_name, episode_kind, tags, updated_at, created_at
      FROM episodes
      WHERE NOT EXISTS (
        SELECT 1
        FROM memory_archives ma
        WHERE ma.layer = 'episode' AND ma.item_id = episodes.id
      )
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
      episodeKind: normalizeEpisodeKind(row.episode_kind),
      tags: parseJson(row.tags || "[]", []),
    }));
    return {
      items,
      nextCursor: rows.length > limit ? String(offset + limit) : null,
    };
  }

  _listPlaybooksPage({ includeInactive = false, offset = 0, limit = DEFAULT_PAGE_SIZE } = {}) {
    const rows = this.localDb.prepare(`
      SELECT id, category, trigger, validation, scope, active, updated_at, created_at
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
      scope: row.scope || "agent",
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
          scope,
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

        UNION ALL

        SELECT
          layer AS item_type,
          item_id AS raw_id,
          preview AS preview,
          truth_time AS truth_time,
          NULL AS timeliness,
          origin,
          scope,
          NULL AS category,
          NULL AS validation,
          NULL AS fact_id,
          updated_at,
          archived_at AS created_at
        FROM memory_archives
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

  _resolveCompactMemoryItem(id, fallbackLayer = "") {
    const { layer, rawId } = decodeMemoryId(id, fallbackLayer);
    if (!rawId) return null;

    if (layer === "inactive") {
      const nested = decodeMemoryId(rawId, "fact");
      return this._resolveCompactMemoryItem(encodeMemoryId(nested.layer || "fact", nested.rawId), nested.layer || "fact");
    }

    if (layer === "fact" || layer === "facts") {
      const row = this._factStore.getById(Number(rawId));
      if (!row) return null;
      return {
        id: encodeMemoryId("fact", row.id),
        layer: row.is_active ? "facts" : "inactive",
        itemType: "fact",
        preview: previewText(row.fact),
        truthTime: row.truth_time || row.time || row.updated_at || row.created_at,
      };
    }

    if (layer === "evidence") {
      const row = this.localDb.prepare(`
        SELECT id, preview, updated_at, created_at
        FROM evidence
        WHERE id = ?
      `).get(rawId);
      if (!row) return null;
      return {
        id: encodeMemoryId("evidence", row.id),
        layer: "evidence",
        itemType: "evidence",
        preview: previewText(row.preview),
        truthTime: row.updated_at || row.created_at,
      };
    }

    if (layer === "episode" || layer === "episodes") {
      const row = this.localDb.prepare(`
        SELECT id, anchor_text, updated_at, created_at
        FROM episodes
        WHERE id = ?
      `).get(rawId);
      if (!row) return null;
      const archived = this.localDb.prepare(`
        SELECT 1
        FROM memory_archives
        WHERE layer = 'episode' AND item_id = ?
      `).get(rawId);
      return {
        id: encodeMemoryId("episode", row.id),
        layer: archived ? "inactive" : "episodes",
        itemType: "episode",
        preview: previewText(row.anchor_text),
        truthTime: row.updated_at || row.created_at,
      };
    }

    if (layer === "playbook" || layer === "playbooks") {
      const row = this.getPlaybookById(rawId);
      if (!row) return null;
      return {
        id: encodeMemoryId("playbook", row.id),
        layer: row.active ? "playbooks" : "inactive",
        itemType: "playbook",
        preview: previewText(`${row.category ? `[${row.category}] ` : ""}${row.trigger}`),
        truthTime: row.updatedAt || row.createdAt,
      };
    }

    if (layer === "mark" || layer === "marks") {
      const row = this.getMarkById(rawId);
      if (!row) return null;
      return {
        id: encodeMemoryId("mark", row.id),
        layer: row.active ? "facts" : "inactive",
        itemType: "mark",
        preview: previewText(row.text),
        truthTime: row.updatedAt || row.createdAt,
      };
    }

    return null;
  }

  _relatedItemFromMemoryId(id, reason, fallbackLayer = "") {
    const resolved = this._resolveCompactMemoryItem(id, fallbackLayer);
    if (!resolved) return null;
    return {
      ...resolved,
      reason,
    };
  }

  _loadFactRowsForEntityLinks(sourceRefs = []) {
    const factIds = new Set();
    for (const ref of normalizeSourceRefs(sourceRefs)) {
      if (ref.layer === "fact" || ref.layer === "facts") {
        const parsed = Number.parseInt(ref.id, 10);
        if (Number.isFinite(parsed)) factIds.add(parsed);
        continue;
      }
      if (ref.layer === "evidence" && trimText(ref.id)) {
        const rows = this.localDb.prepare(`
          SELECT DISTINCT fact_id
          FROM fact_links
          WHERE evidence_id = ?
        `).all(trimText(ref.id));
        for (const row of rows) {
          if (Number.isFinite(Number(row.fact_id))) factIds.add(Number(row.fact_id));
        }
      }
      if ((ref.layer === "episode" || ref.layer === "episodes") && trimText(ref.id)) {
        const rows = this.localDb.prepare(`
          SELECT DISTINCT fact_id
          FROM fact_links
          WHERE episode_id = ?
        `).all(trimText(ref.id));
        for (const row of rows) {
          if (Number.isFinite(Number(row.fact_id))) factIds.add(Number(row.fact_id));
        }
      }
    }
    return [...factIds]
      .map((factId) => this._factStore.getById(factId))
      .filter(Boolean);
  }

  _deriveEntityLinks({ sourceRefs = [], stateKey = null, decisionKey = null, subjectId = null } = {}) {
    const links = buildStructuredEntityLinks({ stateKey, decisionKey, subjectId });
    const seen = new Set(links.map((item) => item.key));
    for (const row of this._loadFactRowsForEntityLinks(sourceRefs)) {
      for (const link of buildStructuredEntityLinks({
        stateKey: row.state_key || null,
        decisionKey: row.decision_key || null,
        subjectId: row.subject_id || null,
      })) {
        if (seen.has(link.key)) continue;
        seen.add(link.key);
        links.push({
          ...link,
          source: "linked_fact",
          sourceFactId: row.id,
        });
      }
    }
    return links.map(({ tokens, ...rest }) => rest);
  }

  _collectRelatedItems({ currentId, sourceRefs = [], stateKey = null, decisionKey = null, subjectId = null } = {}) {
    const related = [];
    const seen = new Set([trimText(currentId)]);
    const evidenceIds = new Set();
    const episodeIds = new Set();
    const entityLinks = this._deriveEntityLinks({ sourceRefs, stateKey, decisionKey, subjectId });

    for (const ref of normalizeSourceRefs(sourceRefs)) {
      if (ref.layer === "evidence" && trimText(ref.id)) evidenceIds.add(trimText(ref.id));
      if (ref.layer === "episode" && trimText(ref.id)) episodeIds.add(trimText(ref.id));
    }

    const push = (id, reason, fallbackLayer = "") => {
      const normalizedId = trimText(id);
      if (!normalizedId || seen.has(normalizedId)) return;
      const item = this._relatedItemFromMemoryId(normalizedId, reason, fallbackLayer);
      if (!item || seen.has(item.id)) return;
      seen.add(normalizedId);
      seen.add(item.id);
      related.push(item);
    };

    for (const evidenceId of evidenceIds) {
      push(encodeMemoryId("evidence", evidenceId), "source_evidence", "evidence");
    }
    for (const episodeId of episodeIds) {
      push(encodeMemoryId("episode", episodeId), "source_episode", "episode");
    }

    const derivedStateKeys = [...new Set(entityLinks
      .filter((item) => item.kind === "state")
      .map((item) => trimText(item.value))
      .filter(Boolean))];
    for (const nextStateKey of derivedStateKeys) {
      const rows = this.localDb.prepare(`
        SELECT id
        FROM facts
        WHERE state_key = ?
        ORDER BY is_active DESC, updated_at DESC, created_at DESC
        LIMIT 6
      `).all(nextStateKey);
      for (const row of rows) {
        push(encodeMemoryId("fact", row.id), "same_state_key", "fact");
      }
    }

    const derivedDecisionKeys = [...new Set(entityLinks
      .filter((item) => item.kind === "decision")
      .map((item) => trimText(item.value))
      .filter(Boolean))];
    for (const nextDecisionKey of derivedDecisionKeys) {
      const rows = this.localDb.prepare(`
        SELECT id
        FROM facts
        WHERE decision_key = ?
        ORDER BY is_active DESC, updated_at DESC, created_at DESC
        LIMIT 6
      `).all(nextDecisionKey);
      for (const row of rows) {
        push(encodeMemoryId("fact", row.id), "same_decision_key", "fact");
      }
    }

    const derivedSubjectIds = [...new Set(entityLinks
      .filter((item) => item.kind === "subject")
      .map((item) => trimText(item.value))
      .filter(Boolean))];
    for (const nextSubjectId of derivedSubjectIds) {
      const rows = this.localDb.prepare(`
        SELECT id
        FROM facts
        WHERE subject_id = ?
        ORDER BY is_active DESC, updated_at DESC, created_at DESC
        LIMIT 6
      `).all(nextSubjectId);
      for (const row of rows) {
        push(encodeMemoryId("fact", row.id), "same_subject", "fact");
      }
    }

    for (const evidenceId of evidenceIds) {
      const factRows = this.localDb.prepare(`
        SELECT DISTINCT fact_id
        FROM fact_links
        WHERE evidence_id = ?
      `).all(evidenceId);
      for (const row of factRows) {
        push(encodeMemoryId("fact", row.fact_id), "shared_evidence", "fact");
      }
    }

    for (const episodeId of episodeIds) {
      const factRows = this.localDb.prepare(`
        SELECT DISTINCT fact_id
        FROM fact_links
        WHERE episode_id = ?
      `).all(episodeId);
      for (const row of factRows) {
        push(encodeMemoryId("fact", row.fact_id), "shared_episode", "fact");
      }
    }

    const hasSharedRef = (refs = []) => {
      const normalized = normalizeSourceRefs(refs);
      return normalized.some((ref) => (
        (ref.layer === "evidence" && evidenceIds.has(trimText(ref.id)))
        || (ref.layer === "episode" && episodeIds.has(trimText(ref.id)))
      ));
    };

    for (const playbook of this.listPlaybooks({ activeOnly: false })) {
      if (hasSharedRef(playbook.sourceRefs)) {
        push(encodeMemoryId("playbook", playbook.id), "shared_source_refs", "playbook");
      }
    }

    for (const mark of this.listMarks({ activeOnly: false })) {
      if (hasSharedRef(mark.sourceRefs)) {
        push(encodeMemoryId("mark", mark.id), "shared_source_refs", "mark");
      }
    }

    return related.slice(0, 8);
  }

  listRetrievalLogs({ limit = DEFAULT_PAGE_SIZE, layer = "auto", query = "" } = {}) {
    const nextLimit = normalizePageSize(limit);
    const nextLayer = trimText(layer) || "auto";
    const nextQuery = trimText(query);
    const rows = this.localDb.prepare(`
      SELECT id, query, layer, ranking_version, config_snapshot, result_ids, sampled, created_at
      FROM retrieval_logs
      WHERE (? = '' OR query LIKE '%' || ? || '%')
        AND (? = 'auto' OR layer = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(nextQuery, nextQuery, nextLayer, nextLayer, nextLimit);

    return rows.map((row) => {
      const snapshot = parseJson(row.config_snapshot || "{}", {});
      const resultIds = parseJson(row.result_ids || "[]", []);
      const finalOrder = Array.isArray(snapshot.finalOrder) ? snapshot.finalOrder : [];
      const results = resultIds.map((memoryId) => {
        const resolved = this._resolveCompactMemoryItem(memoryId);
        const orderEntry = finalOrder.find((item) => trimText(item?.id) === trimText(memoryId)) || null;
        return {
          id: trimText(memoryId),
          layer: resolved?.layer || decodeMemoryId(memoryId).layer || "facts",
          itemType: resolved?.itemType || decodeMemoryId(memoryId).layer || "fact",
          preview: resolved?.preview || "",
          truthTime: resolved?.truthTime || orderEntry?.truthTime || null,
          weightedScore: orderEntry?.weightedScore ?? null,
          componentScores: orderEntry?.componentScores || null,
          entityLinks: orderEntry?.entityLinks || [],
          entityMatches: orderEntry?.entityMatches || [],
        };
      });

      return {
        id: `retrieval:${row.id}`,
        query: row.query,
        layer: row.layer,
        rankingVersion: row.ranking_version,
        sampled: row.sampled === 1,
        createdAt: row.created_at,
        configSnapshot: snapshot,
        resultIds,
        results,
      };
    });
  }

  _getSummaryProjectionSourceScope() {
    const row = this.localDb.prepare(`
      SELECT source_scope
      FROM memory_projections
      WHERE key = ?
    `).get(SUMMARY_PROJECTION_KEY);
    return trimText(row?.source_scope) || "agent";
  }

  _rebuildSummaryProjections(scopes = []) {
    const orderedScopes = [...new Set((Array.isArray(scopes) ? scopes : [])
      .map((scope) => normalizeProjectionScope(scope))
      .filter(Boolean))];
    for (const scope of orderedScopes) {
      this.rebuildSummaryProjection({ sourceScope: scope });
    }
  }

  rebuildSummaryProjection({ sourceScope = null } = {}) {
    const nextSourceScope = trimText(sourceScope) || this._getSummaryProjectionSourceScope();
    const activeFacts = this._factStore.getAll().filter((row) => row.is_active);
    const scopeFilteredCount = activeFacts.filter((row) => !shouldIncludeFactForProjection(row, nextSourceScope)).length;
    if (scopeFilteredCount > 0) {
      this.logDiagnostic("scope_filtered_from_projection", {
        sourceScope: nextSourceScope,
        filteredCount: scopeFilteredCount,
      });
    }
    const factsPath = path.join(this.memoryDir, "facts.md");
    const todayPath = path.join(this.memoryDir, "today.md");
    const weekPath = path.join(this.memoryDir, "week.md");
    const longtermPath = path.join(this.memoryDir, "longterm.md");
    const memoryPath = path.join(this.memoryDir, "memory.md");
    const factsContent = buildFactsProjection(this._factStore.getAll(), {
      sourceScope: nextSourceScope,
      playbooks: this.listPlaybooks({ activeOnly: true, scope: nextSourceScope === "channel" ? "channel" : "agent" }),
    });
    if (nextSourceScope === "agent") {
      writeTextAtomic(factsPath, factsContent);
    }
    let content;
    if (nextSourceScope === "channel") {
      const currentProjection = this.getSummaryProjection({ sourceScope: "channel" });
      const currentSections = currentProjection.sourceScope === "channel"
        ? parseAssembledSections(currentProjection.content)
        : {};
      content = assembleSections({
        facts: factsContent,
        today: currentSections["今天"] || currentSections.Today || "",
        week: currentSections["最近一周"] || currentSections["Past week"] || "",
        longterm: currentSections["长期情况"] || currentSections["Long-term context"] || "",
      });
    } else {
      content = assemble(factsPath, todayPath, weekPath, longtermPath, memoryPath);
    }
    return this._writeSummaryProjectionRecord(content, {
      sourceScope: nextSourceScope,
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
      const detailId = encodeMemoryId("fact", row.id);
      const entityLinks = this._deriveEntityLinks({
        sourceRefs: row.source_refs || [],
        stateKey: row.state_key || null,
        decisionKey: row.decision_key || null,
        subjectId: row.subject_id || null,
      });
      return {
        id: detailId,
        layer: row.is_active ? "facts" : "inactive",
        content: row.fact,
        preview: previewText(row.fact),
        sourceRefs: row.source_refs || [],
        truthTime: row.truth_time || row.time || row.updated_at || row.created_at,
        entityLinks,
        auditTrail: {
          origin: row.origin,
          scope: row.scope,
          timeliness: row.timeliness,
          memoryKind: normalizeMemoryKind(row.memory_kind),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          invalidatedBy: row.invalidated_by || null,
          stateKey: row.state_key || null,
          decisionKey: row.decision_key || null,
          stalenessHint: row.staleness_hint || null,
          validFrom: row.valid_from || null,
          validTo: row.valid_to || null,
          active: row.is_active,
        },
        relatedItems: this._collectRelatedItems({
          currentId: detailId,
          sourceRefs: row.source_refs || [],
          stateKey: row.state_key || null,
          decisionKey: row.decision_key || null,
          subjectId: row.subject_id || null,
        }),
      };
    }

    if (layer === "evidence") {
      const row = this.localDb.prepare(`
        SELECT id, content, preview, source_refs, created_at, updated_at, redaction, origin, scope,
               source_type, source_id, session_id, episode_id, retention_class, archive_after, purge_after
        FROM evidence
        WHERE id = ?
      `).get(rawId);
      if (!row) throw new Error(`evidence not found: ${rawId}`);
      const detailId = encodeMemoryId("evidence", row.id);
      const sourceRefs = parseJson(row.source_refs || "[]", []);
      const entityLinks = this._deriveEntityLinks({
        sourceRefs: [
          ...sourceRefs,
          ...(row.episode_id ? [{ layer: "episode", id: row.episode_id }] : []),
          { layer: "evidence", id: row.id },
        ],
      });
      return {
        id: detailId,
        layer: "evidence",
        content: row.content,
        preview: row.preview,
        sourceRefs,
        truthTime: row.updated_at || row.created_at,
        entityLinks,
        auditTrail: {
          origin: row.origin,
          scope: row.scope,
          sourceType: row.source_type,
          sourceId: row.source_id,
          sessionId: row.session_id,
          episodeId: row.episode_id,
          retentionClass: row.retention_class || "session",
          archiveAfter: row.archive_after || null,
          purgeAfter: row.purge_after || null,
          redaction: parseJson(row.redaction || "{}", {}),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
        relatedItems: this._collectRelatedItems({
          currentId: detailId,
          sourceRefs: [
            ...sourceRefs,
            ...(row.episode_id ? [{ layer: "episode", id: row.episode_id }] : []),
            { layer: "evidence", id: row.id },
          ],
        }),
      };
    }

    if (layer === "episode" || layer === "episodes") {
      const row = this.getEpisodeById(rawId);
      if (!row) throw new Error(`episode not found: ${rawId}`);
      const detailId = encodeMemoryId("episode", row.id);
      const entityLinks = this._deriveEntityLinks({
        sourceRefs: row.sourceRefs,
      });
      return {
        id: detailId,
        layer: "episodes",
        content: row.anchorText,
        preview: previewText(row.anchorText),
        sourceRefs: row.sourceRefs,
        truthTime: row.updatedAt || row.createdAt,
        entityLinks,
        auditTrail: {
          origin: row.origin,
          scope: row.scope,
          episodeKind: row.episodeKind,
          tags: row.tags,
          sessionId: row.sessionId,
          channelName: row.channelName,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
        relatedItems: this._collectRelatedItems({
          currentId: detailId,
          sourceRefs: row.sourceRefs,
        }),
      };
    }

    if (layer === "playbook" || layer === "playbooks") {
      const row = this.getPlaybookById(rawId);
      if (!row) throw new Error(`playbook not found: ${rawId}`);
      const detailId = encodeMemoryId("playbook", row.id);
      const entityLinks = this._deriveEntityLinks({
        sourceRefs: row.sourceRefs,
      });
      return {
        id: detailId,
        layer: row.active ? "playbooks" : "inactive",
        content: playbookToCompatibilityText(row),
        preview: previewText(row.trigger),
        sourceRefs: row.sourceRefs,
        truthTime: row.updatedAt || row.createdAt,
        entityLinks,
        auditTrail: {
          category: row.category,
          active: row.active,
          origin: row.origin,
          scope: row.scope,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          archivedAt: row.archivedAt || null,
        },
        relatedItems: this._collectRelatedItems({
          currentId: detailId,
          sourceRefs: row.sourceRefs,
        }),
      };
    }

    if (layer === "mark" || layer === "marks") {
      const row = this.getMarkById(rawId);
      if (!row) throw new Error(`mark not found: ${rawId}`);
      const detailId = encodeMemoryId("mark", row.id);
      const entityLinks = this._deriveEntityLinks({
        sourceRefs: row.sourceRefs,
      });
      return {
        id: detailId,
        layer: row.active ? "facts" : "inactive",
        content: row.text,
        preview: previewText(row.text),
        sourceRefs: row.sourceRefs,
        truthTime: row.updatedAt || row.createdAt,
        entityLinks,
        auditTrail: {
          active: row.active,
          factId: row.factId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          archivedAt: row.archivedAt || null,
        },
        relatedItems: this._collectRelatedItems({
          currentId: detailId,
          sourceRefs: row.sourceRefs,
        }),
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
    const summaryScopes = new Set();
    let profileFactsChanged = false;
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
          const row = this.localDb.prepare(`
            SELECT scope
            FROM facts
            WHERE id = ?
          `).get(Number(rawId));
          const changes = this.localDb.prepare(`
            UPDATE facts
            SET is_active = 0,
                valid_to = COALESCE(valid_to, ?),
                updated_at = ?,
                invalidated_by = COALESCE(invalidated_by, 'archive')
            WHERE id = ? AND is_active = 1
          `).run(ts, ts, Number(rawId)).changes;
          if (changes > 0) {
            summaryScopes.add(projectionScopeForMemoryScope(row?.scope));
            if (trimText(row?.scope) === "profile") profileFactsChanged = true;
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
        if (layer === "evidence") {
          const row = this.localDb.prepare(`
            SELECT id, preview, origin, scope, source_type, source_id, session_id, episode_id, created_at, updated_at
            FROM evidence
            WHERE id = ?
          `).get(rawId);
          if (!row) continue;
          this.localDb.prepare(`
            INSERT INTO memory_archives (
              layer, item_id, preview, truth_time, origin, scope, payload, archived_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(layer, item_id) DO UPDATE SET
              preview = excluded.preview,
              truth_time = excluded.truth_time,
              origin = excluded.origin,
              scope = excluded.scope,
              payload = excluded.payload,
              archived_at = excluded.archived_at,
              updated_at = excluded.updated_at
          `).run(
            "evidence",
            row.id,
            row.preview || "",
            row.updated_at || row.created_at || ts,
            row.origin || null,
            row.scope || null,
            stringifyJson({
              sourceType: row.source_type || null,
              sourceId: row.source_id || null,
              sessionId: row.session_id || null,
              episodeId: row.episode_id || null,
            }, {}),
            ts,
            ts,
          );
          affectedIds.push(encodeMemoryId("evidence", rawId));
          continue;
        }
        if (layer === "episode" || layer === "episodes") {
          const row = this.localDb.prepare(`
            SELECT id, anchor_text, origin, scope, session_id, channel_name, created_at, updated_at
            FROM episodes
            WHERE id = ?
          `).get(rawId);
          if (!row) continue;
          this.localDb.prepare(`
            INSERT INTO memory_archives (
              layer, item_id, preview, truth_time, origin, scope, payload, archived_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(layer, item_id) DO UPDATE SET
              preview = excluded.preview,
              truth_time = excluded.truth_time,
              origin = excluded.origin,
              scope = excluded.scope,
              payload = excluded.payload,
              archived_at = excluded.archived_at,
              updated_at = excluded.updated_at
          `).run(
            "episode",
            row.id,
            previewText(row.anchor_text || "", 220),
            row.updated_at || row.created_at || ts,
            row.origin || null,
            row.scope || null,
            stringifyJson({
              sessionId: row.session_id || null,
              channelName: row.channel_name || null,
            }, {}),
            ts,
            ts,
          );
          affectedIds.push(encodeMemoryId("episode", rawId));
          continue;
        }
        if (layer === "playbook" || layer === "playbooks") {
          const row = this.localDb.prepare(`
            SELECT scope
            FROM playbooks
            WHERE id = ?
          `).get(rawId);
          const changes = this.localDb.prepare(`
            UPDATE playbooks
            SET active = 0,
                archived_at = COALESCE(archived_at, ?),
                updated_at = ?,
                invalidated_by = COALESCE(invalidated_by, 'archive')
            WHERE id = ? AND active = 1
          `).run(ts, ts, rawId).changes;
          if (changes > 0) {
            summaryScopes.add(projectionScopeForMemoryScope(row?.scope));
            affectedIds.push(encodeMemoryId("playbook", rawId));
          }
        }
      }
    });
    this._runWithMalformedFtsRepair(tx);
    this._writeMarksProjection();
    this._writePlaybookProjection();
    if (summaryScopes.size > 0) {
      this._rebuildSummaryProjections([...summaryScopes]);
    }
    if (profileFactsChanged || affectedIds.some((id) => id.startsWith("mark:"))) {
      this.rebuildProfileProjection();
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
    const summaryScopes = new Set();
    let profileFactsChanged = false;
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
          const row = this.localDb.prepare(`
            SELECT scope
            FROM facts
            WHERE id = ?
          `).get(Number(rawId));
          const changes = this.localDb.prepare(`
            UPDATE facts
            SET is_active = 1,
                valid_to = NULL,
                updated_at = ?,
                invalidated_by = NULL
            WHERE id = ? AND is_active = 0
          `).run(ts, Number(rawId)).changes;
          if (changes > 0) {
            summaryScopes.add(projectionScopeForMemoryScope(row?.scope));
            if (trimText(row?.scope) === "profile") profileFactsChanged = true;
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
        if (layer === "evidence") {
          const changes = this.localDb.prepare(`
            DELETE FROM memory_archives
            WHERE layer = 'evidence' AND item_id = ?
          `).run(rawId).changes;
          if (changes > 0) affectedIds.push(encodeMemoryId("evidence", rawId));
          continue;
        }
        if (layer === "episode" || layer === "episodes") {
          const changes = this.localDb.prepare(`
            DELETE FROM memory_archives
            WHERE layer = 'episode' AND item_id = ?
          `).run(rawId).changes;
          if (changes > 0) affectedIds.push(encodeMemoryId("episode", rawId));
          continue;
        }
        if (layer === "playbook" || layer === "playbooks") {
          const row = this.localDb.prepare(`
            SELECT scope
            FROM playbooks
            WHERE id = ?
          `).get(rawId);
          const changes = this.localDb.prepare(`
            UPDATE playbooks
            SET active = 1,
                archived_at = NULL,
                updated_at = ?,
                invalidated_by = NULL
            WHERE id = ? AND active = 0
          `).run(ts, rawId).changes;
          if (changes > 0) {
            summaryScopes.add(projectionScopeForMemoryScope(row?.scope));
            affectedIds.push(encodeMemoryId("playbook", rawId));
          }
        }
      }
    });
    this._runWithMalformedFtsRepair(tx);
    this._writeMarksProjection();
    this._writePlaybookProjection();
    if (summaryScopes.size > 0) {
      this._rebuildSummaryProjections([...summaryScopes]);
    }
    if (profileFactsChanged || affectedIds.some((id) => id.startsWith("mark:"))) {
      this.rebuildProfileProjection();
    }
    this._notifyChanged();
    return {
      affectedIds,
      restoredToDefaultView: true,
    };
  }

  remove(ids = []) {
    const normalized = Array.isArray(ids) ? ids.map((item) => trimText(item)).filter(Boolean) : [];
    const affectedIds = [];
    const summaryScopes = new Set();
    let profileFactsChanged = false;
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
          const factId = Number(rawId);
          if (!Number.isFinite(factId)) continue;
          const row = this.localDb.prepare(`
            SELECT scope
            FROM facts
            WHERE id = ?
          `).get(factId);
          const deleted = this.localDb.prepare(`
            DELETE FROM facts
            WHERE id = ? AND is_active = 0
          `).run(factId).changes;
          if (deleted > 0) {
            this.localDb.prepare(`
              DELETE FROM fact_links
              WHERE fact_id = ?
            `).run(factId);
            summaryScopes.add(projectionScopeForMemoryScope(row?.scope));
            if (trimText(row?.scope) === "profile") profileFactsChanged = true;
            affectedIds.push(encodeMemoryId("inactive", `fact:${rawId}`));
          }
          continue;
        }

        if (layer === "mark" || layer === "marks") {
          const deleted = this.localDb.prepare(`
            DELETE FROM memory_marks
            WHERE id = ? AND active = 0
          `).run(rawId).changes;
          if (deleted > 0) affectedIds.push(encodeMemoryId("inactive", `mark:${rawId}`));
          continue;
        }
        if (layer === "evidence") {
          const archived = this.localDb.prepare(`
            DELETE FROM memory_archives
            WHERE layer = 'evidence' AND item_id = ?
          `).run(rawId).changes;
          if (archived > 0) {
            this.localDb.prepare(`DELETE FROM evidence WHERE id = ?`).run(rawId);
            affectedIds.push(encodeMemoryId("inactive", `evidence:${rawId}`));
          }
          continue;
        }
        if (layer === "episode" || layer === "episodes") {
          const archived = this.localDb.prepare(`
            DELETE FROM memory_archives
            WHERE layer = 'episode' AND item_id = ?
          `).run(rawId).changes;
          if (archived > 0) {
            this.localDb.prepare(`DELETE FROM episodes WHERE id = ?`).run(rawId);
            affectedIds.push(encodeMemoryId("inactive", `episode:${rawId}`));
          }
          continue;
        }

        if (layer === "playbook" || layer === "playbooks") {
          const row = this.localDb.prepare(`
            SELECT scope
            FROM playbooks
            WHERE id = ?
          `).get(rawId);
          const deleted = this.localDb.prepare(`
            DELETE FROM playbooks
            WHERE id = ? AND active = 0
          `).run(rawId).changes;
          if (deleted > 0) {
            summaryScopes.add(projectionScopeForMemoryScope(row?.scope));
            affectedIds.push(encodeMemoryId("inactive", `playbook:${rawId}`));
          }
        }
      }
    });
    this._runWithMalformedFtsRepair(tx);
    this._writeMarksProjection();
    this._writePlaybookProjection();
    if (summaryScopes.size > 0) this._rebuildSummaryProjections([...summaryScopes]);
    if (profileFactsChanged || affectedIds.some((id) => id.startsWith("inactive:mark:"))) {
      this.rebuildProfileProjection();
    }
    this._notifyChanged();
    return {
      affectedIds,
      removedFromArchive: true,
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
    if (jobType === "consolidate_facts") {
      this.runConsolidation();
      return;
    }
    if (jobType === "rebuild_profile") {
      this.rebuildProfileProjection();
      return;
    }
    if (jobType === "promote_patterns") {
      this.promotePatterns();
      return;
    }
    if (jobType === "cleanup_evidence") {
      this.runEvidenceCleanup({ trigger: "job" });
      return;
    }
    throw new Error(`unsupported job type: ${jobType}`);
  }

  exportBundle() {
    return {
      version: 5,
      exportedAt: nowIso(),
      agentId: this.agentId,
      profile: this.getProfile(),
      marks: this.listMarks({ activeOnly: false }),
      summary: this.getSummaryProjection({ sourceScope: "agent" }),
      channelSummary: this.getSummaryProjection({ sourceScope: "channel" }),
      facts: this._factStore.exportAll(),
      evidence: this.localDb.prepare(`
        SELECT id, origin, scope, source_type, source_id, session_id, episode_id, content, preview,
               source_refs, redaction, retention_class, archive_after, purge_after, hash, created_at, updated_at
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
        retentionClass: row.retention_class || "session",
        archiveAfter: row.archive_after || null,
        purgeAfter: row.purge_after || null,
        hash: row.hash,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      episodes: this.localDb.prepare(`
        SELECT id, origin, scope, session_id, channel_name, anchor_text, episode_kind, tags, source_refs, created_at, updated_at
        FROM episodes
        ORDER BY created_at ASC
      `).all().map((row) => ({
        id: row.id,
        origin: row.origin,
        scope: row.scope,
        sessionId: row.session_id,
        channelName: row.channel_name,
        anchorText: row.anchor_text,
        episodeKind: normalizeEpisodeKind(row.episode_kind),
        tags: parseJson(row.tags || "[]", []),
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
    const channelSummary = bundle.channelSummary?.content;
    const profileContent = bundle.profile?.content;
    const importedProjectionScopes = new Set([
      ...collectProjectionScopesFromFacts(facts),
      ...collectProjectionScopesFromPlaybooks(playbooks),
    ]);

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
          retentionClass: item.retentionClass || item.retention_class || "",
          archiveAfter: item.archiveAfter || item.archive_after || null,
          purgeAfter: item.purgeAfter || item.purge_after || null,
        });
      }
      for (const item of episodes) {
        this.upsertEpisode({
          origin: item.origin,
          scope: item.scope,
          sessionId: item.sessionId || item.session_id,
          channelName: item.channelName || item.channel_name,
          anchorText: item.anchorText || item.anchor_text,
          episodeKind: item.episodeKind || item.episode_kind,
          tags: item.tags || [],
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
      if (typeof channelSummary === "string") {
        this._writeSummaryProjectionRecord(channelSummary, {
          sourceScope: bundle.channelSummary?.sourceScope || bundle.channelSummary?.source_scope || "channel",
          generatedAt: bundle.channelSummary?.generatedAt || bundle.channelSummary?.generated_at || null,
          updatedAt: bundle.channelSummary?.updatedAt || bundle.channelSummary?.updated_at || null,
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

    const scopesToRebuild = [];
    if (typeof summary !== "string" && importedProjectionScopes.has("agent")) {
      scopesToRebuild.push("agent");
    }
    if (typeof channelSummary !== "string" && importedProjectionScopes.has("channel")) {
      scopesToRebuild.push("channel");
    }

    if (scopesToRebuild.length > 0) {
      this._rebuildSummaryProjections(scopesToRebuild);
      this.rebuildProfileProjection();
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
    this.rebuildProfileProjection();
    this._writeMarksProjection();
    this._writePlaybookProjection();
    writeTextAtomic(path.join(this.memoryDir, "memory.md"), safeText(this.getSummaryProjection().content));
  }
}
