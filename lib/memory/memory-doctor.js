import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { validateSummary } from "./session-summary.js";

const NOISE_FACT_RE = /(No response requested|打招呼|发送['"]?你好|打开网易云|播放每日推荐|QQ.*发送消息|查看桌面文件|搜索过程|调用.*搜索|工具.*错误|API.*限流)/i;

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
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch { return null; }
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, filePath);
}

function scanSummaries(agentDir, opts = {}) {
  const summariesDir = path.join(agentDir, "memory", "summaries");
  const issues = [];
  let total = 0;
  let dirty = 0;

  let files = [];
  try {
    files = fs.readdirSync(summariesDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(summariesDir, name));
  } catch {
    return { total, dirty, issues };
  }

  for (const filePath of files) {
    const data = readJson(filePath);
    if (!data?.summary || data.invalid === true) continue;
    total++;
    if (data.summary !== (data.snapshot || "")) dirty++;
    const validation = validateSummary(data.summary);
    if (!validation.ok) {
      issues.push({
        type: "malformed_summary",
        filePath,
        reasons: validation.reasons,
        action: "mark_invalid",
      });
      if (opts.fix && !opts.dryRun) {
        writeJsonAtomic(filePath, {
          ...data,
          invalid: true,
          invalid_at: new Date().toISOString(),
          invalid_reasons: validation.reasons,
        });
      }
    }
  }

  return { total, dirty, issues };
}

function openFactsDb(agentDir) {
  const dbPath = path.join(agentDir, "memory", "facts.db");
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath);
}

function scanFacts(agentDir, opts = {}) {
  const issues = [];
  let stats = {
    total: 0,
    active: 0,
    inactive: 0,
    byType: {},
    fts: 0,
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
    try { stats.fts = db.prepare(`SELECT COUNT(*) AS c FROM facts_fts`).get().c || 0; } catch {}
    for (const row of db.prepare(`SELECT COALESCE(timeliness, 'persistent') AS type, COUNT(*) AS c FROM facts GROUP BY 1`).all()) {
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

    if (opts.fix && !opts.dryRun) {
      const now = new Date().toISOString();
      const deactivate = db.prepare(`UPDATE facts SET is_active = 0, valid_to = COALESCE(valid_to, @now) WHERE id = @id AND is_active = 1`);
      const tx = db.transaction((rows) => {
        for (const issue of rows) {
          if (issue.action !== "deactivate" && issue.action !== "review_or_deactivate") continue;
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

export function runMemoryDoctor(opts = {}) {
  const hanakoHome = opts.hanakoHome || defaultHanakoHome();
  const agents = listAgentDirs(hanakoHome);
  const results = [];

  for (const { agentId, agentDir } of agents) {
    const summaries = scanSummaries(agentDir, opts);
    const facts = scanFacts(agentDir, opts);
    results.push({
      agentId,
      agentDir,
      summaries,
      facts,
      issueCount: summaries.issues.length + facts.issues.length,
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
    lines.push(`Agent ${agent.agentId}:`);
    lines.push(`- facts: ${agent.facts.stats.total} total, ${agent.facts.stats.active} active, ${agent.facts.stats.inactive} inactive, fts ${agent.facts.stats.fts}, types ${byType}`);
    lines.push(`- summaries: ${agent.summaries.total} total, ${agent.summaries.dirty} dirty`);
    lines.push(`- issues: ${agent.issueCount}`);

    const sampleIssues = [...agent.summaries.issues, ...agent.facts.issues].slice(0, opts.limit || 10);
    for (const issue of sampleIssues) {
      const target = issue.factId ? `fact#${issue.factId}` : path.basename(issue.filePath || "");
      const reason = issue.reasons ? ` (${issue.reasons.join(", ")})` : "";
      const fact = issue.fact ? ` — ${String(issue.fact).slice(0, 120)}` : "";
      lines.push(`  - ${issue.type}: ${target}${reason} -> ${issue.action}${fact}`);
    }
    if (agent.issueCount > sampleIssues.length) {
      lines.push(`  - ... ${agent.issueCount - sampleIssues.length} more`);
    }
    lines.push("");
  }

  if (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
