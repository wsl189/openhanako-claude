import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { validateSummary } from "./session-summary.js";
import { MEMORY_RANKING_VERSION } from "./memory-service.js";

const NOISE_FACT_RE = /(No response requested|打招呼|发送['"]?你好|打开网易云|播放每日推荐|QQ.*发送消息|查看桌面文件|搜索过程|调用.*搜索|工具.*错误|API.*限流)/i;
const SUMMARY_PROJECTION_KEY = "current_summary";
const PROFILE_KEY = "default";

function defaultHanakoHome() {
  return process.env.HANAKO_HOME || path.join(os.homedir(), ".hanako");
}

function listAgentDirs(hanakoHome) {
  const agentsDir = path.join(hanakoHome, "agents");
  try {
    return fs.readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        agentId: entry.name,
        agentDir: path.join(agentsDir, entry.name),
      }))
      .filter(({ agentDir }) => fs.existsSync(path.join(agentDir, "config.yaml")));
  } catch {
    return [];
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, filePath);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value || "").replace(/\r/g, "").trimEnd();
}

function formatPinnedMarkdown(items) {
  if (!items.length) return "";
  return items.map((item) => `- ${item.text}`).join("\n") + "\n";
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
    const body = rows.map((row, index) => (
      `${index + 1}. ${row.trigger}\n   ${row.wrongPath}\n   ${row.rootCause}\n   ${row.fixSteps}\n   ${row.validation}`
    )).join("\n");
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
    const snippets = entries.map((entry) => {
      const text = entry.replace(/\s+/g, " ").trim();
      return text.length > 20 ? `${text.slice(0, 19)}...` : text;
    });
    let description = snippets.join("; ");
    if (description.length > 120) description = `${description.slice(0, 117)}...`;
    return `# ${category} (${entries.length})\n${description}\n-> experience/${filename}`;
  }).join("\n\n") + "\n";
}

function scanSummaries(agentDir, opts = {}) {
  const issues = [];
  let total = 0;
  let dirty = 0;

  let db = null;
  try {
    db = openFactsDb(agentDir);
    if (db) {
      const rows = db.prepare(`
        SELECT session_id, summary, snapshot, invalid, invalid_at, invalid_reasons, created_at, updated_at
        FROM memory_summaries
        ORDER BY updated_at DESC, created_at DESC
      `).all();

      for (const row of rows) {
        if (!row.summary || row.invalid === 1) continue;
        total++;
        if (row.summary !== (row.snapshot || "")) dirty++;
        const validation = validateSummary(row.summary);
        if (!validation.ok) {
          issues.push({
            type: "malformed_summary",
            filePath: `db:memory_summaries:${row.session_id}`,
            reasons: validation.reasons,
            action: "mark_invalid",
          });
          if (opts.fix && !opts.dryRun) {
            db.prepare(`
              UPDATE memory_summaries
              SET invalid = 1,
                  invalid_at = ?,
                  invalid_reasons = ?
              WHERE session_id = ?
            `).run(new Date().toISOString(), JSON.stringify(validation.reasons), row.session_id);
          }
        }
      }
    }

    const summariesDir = path.join(agentDir, "memory", "summaries");
    let files = [];
    try {
      files = fs.readdirSync(summariesDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(summariesDir, name));
    } catch {}
    for (const filePath of files) {
      issues.push({
        type: "legacy_summary_artifact",
        filePath,
        action: "cleanup_legacy_file",
      });
      if (opts.fix && !opts.dryRun) {
        try { fs.rmSync(filePath, { force: true }); } catch {}
      }
    }
  } finally {
    if (db?.open) db.close();
  }

  return { total, dirty, issues };
}

function openFactsDb(agentDir) {
  const dbPath = path.join(agentDir, "memory", "facts.db");
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath);
}

function openGlobalDb(hanakoHome) {
  const dbPath = path.join(hanakoHome, "user", "user-memory.db");
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

function scanFacts(agentDir, opts = {}) {
  const issues = [];
  const stats = {
    total: 0,
    active: 0,
    inactive: 0,
    byType: {},
    fts: 0,
    rankingVersions: {},
    channelProfileRejects: 0,
  };

  let db = null;
  try {
    db = openFactsDb(agentDir);
    if (!db) return { stats, issues };

    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS inactive
      FROM facts
    `).get();
    stats.total = counts.total || 0;
    stats.active = counts.active || 0;
    stats.inactive = counts.inactive || 0;
    try {
      stats.fts = db.prepare(`SELECT COUNT(*) AS c FROM facts_fts`).get().c || 0;
    } catch {}
    for (const row of db.prepare(`
      SELECT COALESCE(timeliness, 'persistent') AS type, COUNT(*) AS c
      FROM facts
      GROUP BY 1
    `).all()) {
      stats.byType[row.type] = row.c;
    }

    const candidates = [
      ...db.prepare(`
        SELECT id, fact, timeliness, time, created_at, valid_to, state_key, 'stateful_missing_key' AS type
        FROM facts
        WHERE is_active = 1 AND timeliness = 'stateful' AND (state_key IS NULL OR state_key = '')
      `).all(),
      ...db.prepare(`
        SELECT id, fact, timeliness, time, created_at, valid_to, state_key, 'future_time' AS type
        FROM facts
        WHERE is_active = 1
          AND time IS NOT NULL
          AND created_at IS NOT NULL
          AND julianday(time) > julianday(created_at) + 1
      `).all(),
      ...db.prepare(`
        SELECT id, fact, timeliness, time, created_at, valid_to, state_key, 'expired_ephemeral' AS type
        FROM facts
        WHERE is_active = 1
          AND timeliness = 'ephemeral'
          AND valid_to IS NOT NULL
          AND julianday(valid_to) < julianday('now')
      `).all(),
      ...db.prepare(`
        SELECT id, fact, timeliness, time, created_at, valid_to, state_key, 'noise_fact' AS type
        FROM facts
        WHERE is_active = 1
      `).all().filter((row) => NOISE_FACT_RE.test(row.fact || "")),
    ];

    const seen = new Set();
    for (const row of candidates) {
      const key = `${row.type}:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        type: row.type,
        factId: row.id,
        fact: row.fact,
        action: row.type === "noise_fact" ? "review_or_deactivate" : "deactivate",
      });
    }

    const osFacts = db.prepare(`
      SELECT id, fact
      FROM facts
      WHERE is_active = 1
        AND (fact LIKE '%macOS%' OR fact LIKE '%WSL%' OR fact LIKE '%Windows Subsystem for Linux%')
    `).all();
    const hasMac = osFacts.some((row) => /macOS/i.test(row.fact || ""));
    const hasWsl = osFacts.some((row) => /WSL|Windows Subsystem for Linux/i.test(row.fact || ""));
    if (hasMac && hasWsl) {
      for (const row of osFacts) {
        issues.push({
          type: "possible_conflict",
          factId: row.id,
          fact: row.fact,
          action: "review",
        });
      }
    }

    for (const row of db.prepare(`
      SELECT id, fact, origin, scope, source_refs
      FROM facts
      ORDER BY id ASC
    `).all()) {
      if (row.origin === "channel" && row.scope === "profile") {
        issues.push({
          type: "channel_profile_fact_write",
          factId: row.id,
          fact: row.fact,
          action: "fix_writer",
        });
      }
      const refs = parseJson(row.source_refs || "[]", []);
      if (!Array.isArray(refs) || refs.length === 0) {
        issues.push({
          type: "missing_source_refs",
          factId: row.id,
          fact: row.fact,
          action: "rebuild_from_evidence",
        });
        continue;
      }
      const evidenceRefs = refs
        .filter((ref) => ref && typeof ref === "object" && ref.layer === "evidence" && ref.id)
        .map((ref) => String(ref.id));
      if (evidenceRefs.length === 0) {
        issues.push({
          type: "missing_evidence_ref",
          factId: row.id,
          fact: row.fact,
          action: "rebuild_from_evidence",
        });
        continue;
      }
      for (const evidenceId of evidenceRefs) {
        const evidenceRow = db.prepare(`
          SELECT source_type
          FROM evidence
          WHERE id = ?
        `).get(evidenceId);
        if (!evidenceRow) {
          issues.push({
            type: "dangling_evidence_ref",
            factId: row.id,
            fact: row.fact,
            action: "rebuild_from_evidence",
          });
          continue;
        }
        if (evidenceRow.source_type === "session_transcript") {
          issues.push({
            type: "transcript_tail_fact_source",
            factId: row.id,
            fact: row.fact,
            action: "rebuild_from_evidence",
          });
        }
      }
    }

    for (const row of db.prepare(`
      SELECT id, source_type, source_id
      FROM evidence
      WHERE origin = 'channel' AND scope = 'profile'
    `).all()) {
      issues.push({
        type: "channel_profile_evidence_write",
        fact: `${row.source_type}:${row.source_id || row.id}`,
        action: "fix_writer",
      });
    }

    for (const row of db.prepare(`
      SELECT id, session_id, channel_name
      FROM episodes
      WHERE origin = 'channel' AND scope = 'profile'
    `).all()) {
      issues.push({
        type: "channel_profile_episode_write",
        fact: `${row.channel_name || row.session_id || row.id}`,
        action: "fix_writer",
      });
    }

    stats.channelProfileRejects = db.prepare(`
      SELECT COUNT(*) AS c
      FROM memory_diagnostics
      WHERE event_type = 'reject_channel_profile_write'
    `).get().c || 0;

    for (const row of db.prepare(`
      SELECT ranking_version, COUNT(*) AS c
      FROM retrieval_logs
      GROUP BY ranking_version
    `).all()) {
      stats.rankingVersions[row.ranking_version || "(empty)"] = row.c;
      if (row.ranking_version !== MEMORY_RANKING_VERSION) {
        issues.push({
          type: "ranking_version_drift",
          fact: `ranking_version=${row.ranking_version}`,
          action: "review_ranking_config",
        });
      }
    }

    const invalidSnapshots = db.prepare(`
      SELECT COUNT(*) AS c
      FROM retrieval_logs
      WHERE json_valid(config_snapshot) = 0
    `).get().c || 0;
    if (invalidSnapshots > 0) {
      issues.push({
        type: "invalid_ranking_snapshot",
        fact: `${invalidSnapshots} retrieval_logs rows`,
        action: "fix_logging",
      });
    }

    if (opts.fix && !opts.dryRun) {
      const now = new Date().toISOString();
      const deactivate = db.prepare(`
        UPDATE facts
        SET is_active = 0,
            valid_to = COALESCE(valid_to, @now)
        WHERE id = @id AND is_active = 1
      `);
      const tx = db.transaction((rows) => {
        for (const issue of rows) {
          if (issue.action !== "deactivate" && issue.action !== "review_or_deactivate") continue;
          if (!issue.factId) continue;
          deactivate.run({ id: issue.factId, now });
        }
      });
      tx(issues);
    }
  } finally {
    if (db?.open) db.close();
  }

  return { stats, issues };
}

function scanCompatibilityProjection(agentDir, hanakoHome) {
  const issues = [];
  let localDb = null;
  let globalDb = null;
  try {
    localDb = openFactsDb(agentDir);
    globalDb = openGlobalDb(hanakoHome);

    if (globalDb) {
      const profile = globalDb.prepare(`
        SELECT content
        FROM profiles
        WHERE profile_key = ?
      `).get(PROFILE_KEY)?.content || "";
      const fileContent = readText(path.join(hanakoHome, "user", "user.md"));
      if (normalizeText(profile) !== normalizeText(fileContent)) {
        issues.push({
          type: "profile_projection_drift",
          fact: path.join(hanakoHome, "user", "user.md"),
          action: "reproject",
        });
      }
    }

    if (!localDb) return { issues };

    const pinnedRows = localDb.prepare(`
      SELECT text
      FROM memory_marks
      WHERE kind = 'pinned' AND active = 1
      ORDER BY active DESC, updated_at DESC, created_at DESC
    `).all();
    const pinnedDb = formatPinnedMarkdown(pinnedRows);
    const pinnedFile = readText(path.join(agentDir, "pinned.md"));
    if (normalizeText(pinnedDb) !== normalizeText(pinnedFile)) {
      issues.push({
        type: "pinned_projection_drift",
        fact: path.join(agentDir, "pinned.md"),
        action: "reproject",
      });
    }

    const summaryDb = localDb.prepare(`
      SELECT content
      FROM memory_projections
      WHERE key = ?
    `).get(SUMMARY_PROJECTION_KEY)?.content || "";
    const summaryFile = readText(path.join(agentDir, "memory", "memory.md"));
    if (normalizeText(summaryDb) !== normalizeText(summaryFile)) {
      issues.push({
        type: "summary_projection_drift",
        fact: path.join(agentDir, "memory", "memory.md"),
        action: "reproject",
      });
    }

    const playbooks = localDb.prepare(`
      SELECT category, trigger, wrong_path, root_cause, fix_steps, validation
      FROM playbooks
      WHERE active = 1
      ORDER BY updated_at DESC, created_at DESC
    `).all().map((row) => ({
      category: row.category || "",
      trigger: row.trigger,
      wrongPath: row.wrong_path,
      rootCause: row.root_cause,
      fixSteps: row.fix_steps,
      validation: row.validation,
    }));
    const experienceIndexDb = formatCompatibilityExperienceIndex(playbooks);
    const experienceIndexFile = readText(path.join(agentDir, "experience.md"));
    if (normalizeText(experienceIndexDb) !== normalizeText(experienceIndexFile)) {
      issues.push({
        type: "experience_index_projection_drift",
        fact: path.join(agentDir, "experience.md"),
        action: "reproject",
      });
    }

    const expectedFiles = formatCompatibilityExperienceFiles(playbooks);
    const expectedByName = new Map(expectedFiles.map((item) => [item.filename, normalizeText(item.body)]));
    const experienceDir = path.join(agentDir, "experience");
    const actualNames = fs.existsSync(experienceDir)
      ? fs.readdirSync(experienceDir).filter((name) => name.endsWith(".md"))
      : [];
    for (const [filename, body] of expectedByName.entries()) {
      const actual = normalizeText(readText(path.join(experienceDir, filename)));
      if (body !== actual) {
        issues.push({
          type: "experience_projection_drift",
          fact: path.join(experienceDir, filename),
          action: "reproject",
        });
      }
    }
    for (const filename of actualNames) {
      if (!expectedByName.has(filename)) {
        issues.push({
          type: "stale_experience_projection",
          fact: path.join(experienceDir, filename),
          action: "reproject",
        });
      }
    }
  } finally {
    if (localDb?.open) localDb.close();
    if (globalDb?.open) globalDb.close();
  }
  return { issues };
}

export function runMemoryDoctor(opts = {}) {
  const hanakoHome = opts.hanakoHome || defaultHanakoHome();
  const agents = listAgentDirs(hanakoHome);
  const results = [];

  for (const { agentId, agentDir } of agents) {
    const summaries = scanSummaries(agentDir, opts);
    const facts = scanFacts(agentDir, opts);
    const projections = scanCompatibilityProjection(agentDir, hanakoHome);
    results.push({
      agentId,
      agentDir,
      summaries,
      facts,
      projections,
      issueCount: summaries.issues.length + facts.issues.length + projections.issues.length,
    });
  }

  return {
    hanakoHome,
    dryRun: opts.dryRun !== false,
    fix: opts.fix === true,
    agents: results,
  };
}

export function formatMemoryDoctorReport(report, opts = {}) {
  const lines = [];
  lines.push(`Memory doctor: ${report.hanakoHome}`);
  lines.push(report.fix
    ? (report.dryRun ? "Mode: fix dry-run" : "Mode: fix applied")
    : "Mode: report only");
  lines.push("");

  for (const agent of report.agents) {
    if (!opts.all && agent.issueCount === 0) continue;
    const byType = Object.entries(agent.facts.stats.byType)
      .map(([type, count]) => `${type}:${count}`)
      .join(", ") || "none";
    const rankingVersions = Object.entries(agent.facts.stats.rankingVersions || {})
      .map(([version, count]) => `${version}:${count}`)
      .join(", ") || "none";
    lines.push(`Agent ${agent.agentId}:`);
    lines.push(`- facts: ${agent.facts.stats.total} total, ${agent.facts.stats.active} active, ${agent.facts.stats.inactive} inactive, fts ${agent.facts.stats.fts}, types ${byType}`);
    lines.push(`- summaries: ${agent.summaries.total} total, ${agent.summaries.dirty} dirty`);
    lines.push(`- diagnostics: reject_channel_profile_write=${agent.facts.stats.channelProfileRejects}, ranking_versions=${rankingVersions}`);
    lines.push(`- issues: ${agent.issueCount}`);

    const sampleIssues = [
      ...agent.summaries.issues,
      ...agent.facts.issues,
      ...agent.projections.issues,
    ].slice(0, opts.limit || 12);
    for (const issue of sampleIssues) {
      const target = issue.factId
        ? `fact#${issue.factId}`
        : (issue.filePath || issue.fact || "");
      const reason = issue.reasons ? ` (${issue.reasons.join(", ")})` : "";
      lines.push(`  - ${issue.type}: ${target}${reason} -> ${issue.action}`);
    }
    if (agent.issueCount > sampleIssues.length) {
      lines.push(`  - ... ${agent.issueCount - sampleIssues.length} more`);
    }
    lines.push("");
  }

  if (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
