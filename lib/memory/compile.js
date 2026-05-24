/**
 * compile.js — 记忆编译器（v3 四块独立编译 + assemble）
 *
 * 四个独立函数各自有指纹缓存，互不依赖：
 *   compileToday()    → today.md（当天 sessions）
 *   compileWeek()     → week.md（过去7天滑动窗口）
 *   compileLongterm() → longterm.md（fold 周报到长期）
 *   compileFacts()    → facts.md（重要事实，优先由 facts.db 生成）
 *
 * assemble() 同步读取四个文件，拼成 memory.md（≤2000 token）。
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getLogicalDay } from "../time-utils.js";
import { callProviderText } from "../llm/provider-client.js";
import { getLocale } from "../../server/i18n.js";

function _isZh() { return getLocale().startsWith("zh"); }

const EMPTY_MEMORY_ZH = "（暂无记忆）\n";
const EMPTY_MEMORY_EN = "(No memory yet)\n";
export function getEmptyMemory() { return _isZh() ? EMPTY_MEMORY_ZH : EMPTY_MEMORY_EN; }

// ════════════════════════════
//  v3 四块独立编译 + assemble
// ════════════════════════════

/**
 * 编译今天的 session 摘要 → today.md
 * @param {import('./session-summary.js').SessionSummaryManager} summaryManager
 * @param {string} outputPath
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @returns {Promise<"compiled"|"skipped">}
 */
export async function compileToday(summaryManager, outputPath, resolvedModel) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const { rangeStart } = getLogicalDay();
  const sessions = summaryManager.getSummariesInRange(rangeStart, new Date());

  const fpKeys = sessions.length === 0 ? ["empty"] : sessions.map((s) => `${s.session_id}:${s.updated_at}`);
  const fp = computeFingerprint(fpKeys);
  const fpPath = outputPath + ".fingerprint";
  try {
    if (fs.readFileSync(fpPath, "utf-8").trim() === fp && fs.existsSync(outputPath)) return "skipped";
  } catch {}

  if (sessions.length === 0) {
    atomicWrite(outputPath, "");
    fs.writeFileSync(fpPath, fp);
    return "compiled";
  }

  const input = sessions.map((s) => s.summary).join("\n\n---\n\n");
  const isZh = _isZh();
  const result = await _compactLLM(
    input,
    isZh
      ? "将以下今天的对话摘要整合成一段概要（500字以内）。重点突出，抓关键事件和决策，保留时间标注（HH:MM）。直接输出概要文本。"
      : "Consolidate the following conversation summaries from today into a single overview (under 300 words). Highlight key events and decisions, preserve time stamps (HH:MM). Output the overview text directly.",
    resolvedModel,
    750,
  );

  atomicWrite(outputPath, result);
  fs.writeFileSync(fpPath, fp);
  return "compiled";
}

/**
 * 编译过去 7 天滑动窗口的摘要 → week.md
 * @param {object} resolvedModel
 */
export async function compileWeek(summaryManager, outputPath, resolvedModel) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);

  const sessions = summaryManager.getSummariesInRange(sevenDaysAgo, now);

  const fpKeys = sessions.length === 0 ? ["empty"] : sessions.map((s) => `${s.session_id}:${s.updated_at}`);
  const fp = computeFingerprint(fpKeys);
  const fpPath = outputPath + ".fingerprint";
  try {
    if (fs.readFileSync(fpPath, "utf-8").trim() === fp && fs.existsSync(outputPath)) return "skipped";
  } catch {}

  if (sessions.length === 0) {
    atomicWrite(outputPath, "");
    fs.writeFileSync(fpPath, fp);
    return "compiled";
  }

  const input = sessions.map((s) => s.summary).join("\n\n---\n\n");
  const isZh = _isZh();
  const result = await _compactLLM(
    input,
    isZh
      ? "将以下过去7天的对话摘要整合成一段概要（500字以内）。提炼主要主题和重要事件，保留时间标注。对“当前状态/进行中/临时安排”这类时效信息执行通用规则：同主题冲突只保留最新状态；已结束、已取消、已被更新的信息剔除。直接输出概要文本。"
      : "Consolidate the following conversation summaries from the past 7 days into a single overview (under 300 words). Extract major themes and key events with timestamps. Apply a generic timeliness rule to stateful facts: keep only the latest state for the same topic, and drop ended/cancelled/superseded states. Output the overview text directly.",
    resolvedModel,
    750,
  );

  atomicWrite(outputPath, result);
  fs.writeFileSync(fpPath, fp);
  return "compiled";
}

/**
 * 将 week.md fold 进 longterm.md（每日一次）
 * @param {object} resolvedModel
 */
export async function compileLongterm(weekMdPath, longtermPath, resolvedModel) {
  fs.mkdirSync(path.dirname(longtermPath), { recursive: true });

  let weekContent = "";
  try { weekContent = fs.readFileSync(weekMdPath, "utf-8").trim(); } catch {}

  if (!weekContent) return "skipped";

  // fingerprint：week.md 内容没变就跳过，避免每天把同一批内容反复折叠
  const fp = computeFingerprint([weekContent]);
  const fpPath = longtermPath + ".fingerprint";
  try {
    if (fs.readFileSync(fpPath, "utf-8").trim() === fp && fs.existsSync(longtermPath)) return "skipped";
  } catch {}

  let prevLongterm = "";
  try { prevLongterm = fs.readFileSync(longtermPath, "utf-8").trim(); } catch {}

  const isZh = _isZh();
  const input = prevLongterm
    ? (isZh
        ? `## 上一份长期情况\n\n${prevLongterm}\n\n## 本周新增\n\n${weekContent}`
        : `## Previous long-term context\n\n${prevLongterm}\n\n## This week's additions\n\n${weekContent}`)
    : weekContent;

  const result = await _compactLLM(
    input,
    isZh
      ? "将以下内容整合成长期背景记录（300字以内）。只保留持续性的、跨时间有意义的背景信息。通用时效规则：剔除“当前状态/近期安排/阶段性进展”等易过期信息；若同主题有冲突，仅保留最新且仍有效的结论。直接输出记录文本。"
      : "Consolidate the following into a long-term background record (under 200 words). Keep only persistent cross-temporal context. Generic timeliness rule: remove temporary/current-state details, and when conflicts exist keep only the latest still-valid conclusion. Output the record text directly.",
    resolvedModel,
    450,
  );

  atomicWrite(longtermPath, result);
  fs.writeFileSync(fpPath, fp);
  return "compiled";
}

/**
 * 编译 facts.md（DB single source of truth）：
 * - 仅从 facts.db（FactStore）读取“当前有效事实”
 * - 禁止从 summary 或旧 facts.md 回退抽取，避免双真相源
 * @param {object} resolvedModel
 */
export async function compileFacts(summaryManager, outputPath, resolvedModel, opts = {}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const factStore = opts?.factStore || null;

  // 唯一路径：结构化事实库（带 is_active/valid_to 过滤）
  if (factStore && typeof factStore.getAll === "function") {
    atomicWrite(outputPath, buildFactsProjection(factStore.getAll()));
    return "compiled";
  }

  atomicWrite(outputPath, "");
  return "compiled";
}

export function buildFactsProjection(rows = [], opts = {}) {
  const nowIso = new Date().toISOString();
  const isZh = opts.isZh ?? _isZh();
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 60;
  const activeRows = rows
    .filter((row) => {
      if (!row?.is_active) return false;
      if (row.valid_from && row.valid_from > nowIso) return false;
      if (row.valid_to && row.valid_to < nowIso) return false;
      return true;
    })
    .sort((a, b) => {
      const ta = (a.truth_time || a.time || a.valid_from || a.updated_at || a.created_at || "");
      const tb = (b.truth_time || b.time || b.valid_from || b.updated_at || b.created_at || "");
      return tb.localeCompare(ta);
    });

  if (activeRows.length === 0) return "";

  const seen = new Set();
  const lines = [];
  for (const row of activeRows) {
    const key = `${row.fact}@@${row.timeliness || "persistent"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const timeLabel = _formatFactTime(
      row.truth_time || row.time || row.valid_from || row.updated_at || row.created_at,
      isZh,
    );
    const typeLabel = row.timeliness || "persistent";
    lines.push(`- [${timeLabel}] (${typeLabel}) ${row.fact}`);
    if (lines.length >= limit) break;
  }

  return lines.join("\n");
}

/**
 * 将四个中间文件组装成 memory.md（同步，不调 LLM）
 * @param {string} factsPath
 * @param {string} todayPath
 * @param {string} weekPath
 * @param {string} longtermPath
 * @param {string} memoryMdPath
 */
export function assemble(factsPath, todayPath, weekPath, longtermPath, memoryMdPath) {
  const read = (p) => { try { return fs.readFileSync(p, "utf-8").trim(); } catch { return ""; } };

  const facts    = read(factsPath);
  const today    = read(todayPath);
  const week     = read(weekPath);
  const longterm = read(longtermPath);

  // 四个标题始终保留，空栏写占位符，避免格式漂移
  const isZh = _isZh();
  const empty = isZh ? "（暂无）" : "(none)";
  const section = (title, content) =>
    `## ${title}\n\n${content || empty}`;

  const md = [
    section(isZh ? "重要事实" : "Key facts", facts),
    section(isZh ? "今天" : "Today", today),
    section(isZh ? "最近一周" : "Past week", week),
    section(isZh ? "长期情况" : "Long-term context", longterm),
  ].join("\n\n") + "\n";

  atomicWrite(memoryMdPath, md);
  return md;
}

/**
 * 通用 LLM 压缩调用（内部）
 * @param {string} input
 * @param {string} systemPrompt
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @param {number} maxTokens
 */
async function _compactLLM(input, systemPrompt, resolvedModel, maxTokens) {
  const { model, api, api_key, base_url } = resolvedModel;
  return callProviderText({
    api,
    model,
    api_key,
    base_url,
    messages: [{ role: "user", content: input }],
    systemPrompt,
    temperature: 0.3,
    max_tokens: maxTokens,
    timeoutMs: 60_000,
  });
}

// ════════════════════════════
//  辅助
// ════════════════════════════

function computeFingerprint(keys) {
  return crypto.createHash("md5").update(keys.join("\n")).digest("hex");
}

function atomicWrite(filePath, content) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function _formatFactTime(raw, isZh = true) {
  const unknown = isZh ? "时间未知" : "time-unknown";
  if (!raw || typeof raw !== "string") return unknown;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return unknown;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}
