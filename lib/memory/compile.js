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
const FINAL_MEMORY_OPEN = "<hanako_memory>";
const FINAL_MEMORY_CLOSE = "</hanako_memory>";
const COMPACT_OUTPUT_MAX_ATTEMPTS = 2;
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
  const result = await compactFinalMemoryOutput(
    input,
    isZh
      ? "将以下今天的对话摘要整合成一段概要（500字以内）。重点写关键事件、明确决策、状态变化、阻塞与下一步，保留时间标注（HH:MM）。不要输出分析过程、计划或解释。"
      : "Consolidate the following conversation summaries from today into a single overview (under 300 words). Focus on key events, explicit decisions, state changes, blockers, and next steps, preserving HH:MM timestamps. Do not output analysis, plans, or explanations.",
    resolvedModel,
    750,
    { isZh, kind: "today" },
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
  const result = await compactFinalMemoryOutput(
    input,
    isZh
      ? "将以下过去7天的对话摘要整合成一段概要（500字以内）。提炼主要主题、重要事件、最近状态、关键决策和主题演进，保留时间标注。对“当前状态/进行中/临时安排”这类时效信息执行通用规则：同主题冲突只保留最新状态；已结束、已取消、已被更新的信息剔除。不要输出分析过程、计划或解释。"
      : "Consolidate the following conversation summaries from the past 7 days into a single overview (under 300 words). Extract major themes, important events, recent states, explicit decisions, and topic evolution with timestamps. Apply a timeliness rule to stateful facts: keep only the latest state for the same topic and drop ended/cancelled/superseded states. Do not output analysis, plans, or explanations.",
    resolvedModel,
    750,
    { isZh, kind: "week" },
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

  const result = await compactFinalMemoryOutput(
    input,
    isZh
      ? "将以下内容整合成长期背景记录（300字以内）。只保留长期画像、长期约束、稳定背景、长期仍有效的决策结论和可复用经验。剔除 working note、近期安排、阶段性进展、短期状态等易过期信息；若同主题有冲突，仅保留最新且仍有效的结论。不要输出分析过程、计划或解释。"
      : "Consolidate the following into a long-term background record (under 200 words). Keep only durable profile facts, durable constraints, stable background, still-valid long-term decisions, and reusable experience. Remove working notes, near-term plans, phase-specific progress, and temporary state. When conflicts exist, keep only the latest still-valid conclusion. Do not output analysis, plans, or explanations.",
    resolvedModel,
    450,
    { isZh, kind: "longterm" },
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
  const sourceScope = opts?.sourceScope || "agent";
  const playbooks = Array.isArray(opts?.playbooks) ? opts.playbooks : [];

  // 唯一路径：结构化事实库（带 is_active/valid_to 过滤）
  if (factStore && typeof factStore.getAll === "function") {
    atomicWrite(outputPath, buildFactsProjection(factStore.getAll(), { sourceScope, playbooks }));
    return "compiled";
  }

  atomicWrite(outputPath, "");
  return "compiled";
}

function shouldIncludeFactForScope(row, sourceScope = "agent") {
  if (!row) return false;
  const scope = String(row.scope || "agent").trim() || "agent";
  if (sourceScope === "channel") return scope === "channel";
  return scope === "agent" || scope === "profile";
}

function classifyFactGroup(row = {}) {
  const kind = String(row.memory_kind || "semantic").trim();
  const tags = Array.isArray(row.tags) ? row.tags.map((item) => String(item || "")) : [];
  if (kind === "profile_identity" || kind === "profile_preference") return "profile";
  if (kind === "state") return "state";
  if (kind === "profile_constraint" || kind === "decision") return "decision";
  if (kind === "background") {
    if (tags.some((tag) => /经验|流程|修复|排障|调试|playbook/i.test(tag))) return "experience";
    return "decision";
  }
  if (kind === "working_note") return "working";
  return "decision";
}

function shouldIncludePlaybookForScope(playbook = {}, sourceScope = "agent") {
  const scope = String(playbook.scope || "agent").trim() || "agent";
  if (sourceScope === "channel") return scope === "channel";
  return scope === "agent";
}

export function buildFactsProjection(rows = [], opts = {}) {
  const nowIso = new Date().toISOString();
  const isZh = opts.isZh ?? _isZh();
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 60;
  const sourceScope = typeof opts.sourceScope === "string" ? opts.sourceScope : "agent";
  const playbooks = Array.isArray(opts.playbooks) ? opts.playbooks : [];
  const activeRows = rows
    .filter((row) => {
      if (!row?.is_active) return false;
      if (!shouldIncludeFactForScope(row, sourceScope)) return false;
      if (row.valid_from && row.valid_from > nowIso) return false;
      if (row.valid_to && row.valid_to < nowIso) return false;
      if (String(row.memory_kind || "").trim() === "working_note") return false;
      return true;
    })
    .sort((a, b) => {
      const ta = (a.truth_time || a.time || a.valid_from || a.updated_at || a.created_at || "");
      const tb = (b.truth_time || b.time || b.valid_from || b.updated_at || b.created_at || "");
      return tb.localeCompare(ta);
    });

  const seen = new Set();
  const groups = {
    profile: [],
    state: [],
    decision: [],
    experience: [],
  };
  for (const row of activeRows) {
    const key = `${row.fact}@@${row.timeliness || "persistent"}@@${row.memory_kind || "semantic"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const timeLabel = _formatFactTime(
      row.truth_time || row.time || row.valid_from || row.updated_at || row.created_at,
      isZh,
    );
    const typeLabel = row.timeliness || "persistent";
    const nextGroup = classifyFactGroup(row);
    if (groups[nextGroup]) {
      groups[nextGroup].push(`- [${timeLabel}] (${typeLabel}) ${row.fact}`);
    }
    if (Object.values(groups).reduce((acc, items) => acc + items.length, 0) >= limit) break;
  }

  const labels = isZh
    ? {
      profile: "### 长期画像",
      state: "### 当前状态",
      decision: "### 决策与约束",
      experience: "### 已验证经验",
    }
    : {
      profile: "### Long-term Profile",
      state: "### Current State",
      decision: "### Decisions & Constraints",
      experience: "### Verified Experience",
    };
  const experienceLines = playbooks
    .filter((item) => item && item.active !== false && shouldIncludePlaybookForScope(item, sourceScope))
    .slice(0, Math.max(0, limit - Object.values(groups).reduce((acc, items) => acc + items.length, 0)))
    .map((item) => `- ${item.category ? `[${item.category}] ` : ""}${item.trigger}`);
  if (experienceLines.length > 0) {
    groups.experience.push(...experienceLines);
  }
  const totalLines = Object.values(groups).reduce((acc, items) => acc + items.length, 0);
  if (totalLines === 0) return "";
  return ["profile", "state", "decision", "experience"]
    .filter((name) => groups[name].length > 0)
    .map((name) => `${labels[name]}\n${groups[name].join("\n")}`)
    .join("\n\n");
}

export function assembleSections({ facts = "", today = "", week = "", longterm = "", memoryMdPath = null } = {}) {
  const isZh = _isZh();
  const empty = isZh ? "（暂无）" : "(none)";
  const section = (title, content) =>
    `## ${title}\n\n${String(content || "").trim() || empty}`;

  const md = [
    section(isZh ? "重要事实" : "Key facts", facts),
    section(isZh ? "今天" : "Today", today),
    section(isZh ? "最近一周" : "Past week", week),
    section(isZh ? "长期情况" : "Long-term context", longterm),
  ].join("\n\n") + "\n";

  if (memoryMdPath) atomicWrite(memoryMdPath, md);
  return md;
}

export function parseAssembledSections(content = "") {
  const text = String(content || "");
  const pattern = /^##\s+(.+?)\n\n([\s\S]*?)(?=^##\s+.+?$|\s*$)/gm;
  const sections = {};
  let match = pattern.exec(text);
  while (match) {
    sections[match[1].trim()] = String(match[2] || "").trim();
    match = pattern.exec(text);
  }
  return sections;
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
  return assembleSections({
    facts: read(factsPath),
    today: read(todayPath),
    week: read(weekPath),
    longterm: read(longtermPath),
    memoryMdPath,
  });
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

async function compactFinalMemoryOutput(input, basePrompt, resolvedModel, maxTokens, { isZh = true, kind = "summary" } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= COMPACT_OUTPUT_MAX_ATTEMPTS; attempt += 1) {
    const systemPrompt = withFinalMemoryWrapperInstruction(basePrompt, isZh, { retry: attempt > 1 });
    const rawResult = await _compactLLM(input, systemPrompt, resolvedModel, maxTokens);
    try {
      const result = extractFinalMemoryOutput(rawResult, { kind });
      assertCompactOutputQuality(result, { isZh, kind });
      return result;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function withFinalMemoryWrapperInstruction(prompt, isZh = true, { retry = false } = {}) {
  const wrapperInstruction = isZh
    ? `最终结果必须严格包裹在 ${FINAL_MEMORY_OPEN} 和 ${FINAL_MEMORY_CLOSE} 之间；标签外不能输出任何文字。`
    : `The final result must be strictly wrapped between ${FINAL_MEMORY_OPEN} and ${FINAL_MEMORY_CLOSE}; output nothing outside those tags.`;
  const retryInstruction = isZh
    ? "上一次输出没有通过记忆摘要格式或质量校验；这次只能输出最终摘要正文，不要解释失败原因。"
    : "The previous output failed the memory summary format or quality validation; this time output only the final summary body and do not explain the failure.";
  const parts = retry ? [prompt, retryInstruction, wrapperInstruction] : [prompt, wrapperInstruction];
  return parts.join(isZh ? "" : " ");
}

function extractFinalMemoryOutput(output, { kind = "summary" } = {}) {
  const text = String(output || "").trim();
  const pattern = new RegExp(
    `^${escapeRegExp(FINAL_MEMORY_OPEN)}\\s*([\\s\\S]*?)\\s*${escapeRegExp(FINAL_MEMORY_CLOSE)}$`,
    "i",
  );
  const match = text.match(pattern);
  if (!match) {
    throw new Error(`compiled ${kind} output failed validation: missing_final_wrapper`);
  }
  const inner = String(match[1] || "").trim();
  if (new RegExp(`${escapeRegExp(FINAL_MEMORY_OPEN)}|${escapeRegExp(FINAL_MEMORY_CLOSE)}`, "i").test(inner)) {
    throw new Error(`compiled ${kind} output failed validation: malformed_final_wrapper`);
  }
  return inner;
}

function assertCompactOutputQuality(output, { isZh = true, kind = "summary" } = {}) {
  const text = String(output || "").trim();
  const reasons = [];
  if (!text) reasons.push("empty");

  const leading = text.slice(0, 240).toLowerCase();
  const analysisPatterns = [
    /^\s*(?:okay[,]?\s*)?(?:let me|i need to|we need to|the user (?:is asking|wants)|analysis\b|reasoning\b)/i,
    /^\s*(?:(?:好的|嗯|明白)[，,。]?\s*)?(?:我来|让我|我需要|我们需要|下面我(?:来|将)|分析如下|思考)/,
    /^\s*(?:分析|解析|梳理)(?:用户|输入|资料|内容|任务)/,
    /the user is asking me to/i,
    /the user wants me to/i,
    /\bi need to (?:consolidate|summari[sz]e|extract|analy[sz]e)\b/i,
    /\bwe need to (?:consolidate|summari[sz]e|extract|analy[sz]e)\b/i,
    /now let me/i,
    /(?:首先|先)(?:分析|识别|提取|判断)/,
    /用户(?:要求|希望|想让我|让我)(?:我)?(?:整合|总结|提取|分析)/,
    /previous long-term context/i,
    /this week's additions/i,
    /consolidate the following/i,
    /上一份长期情况/,
    /本周新增/,
  ];
  if (analysisPatterns.some((pattern) => pattern.test(leading) || pattern.test(text))) {
    reasons.push("analysis_preamble");
  }

  if (/<think\b|<\/think>|<analysis\b|<\/analysis>/i.test(text)) {
    reasons.push("reasoning_tag");
  }

  const cjkCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latinWordCount = (text.match(/[A-Za-z]{3,}/g) || []).length;
  if (isZh && latinWordCount > 20 && latinWordCount * 2 > cjkCount) {
    reasons.push("wrong_language");
  }

  const maxChars = kind === "longterm" ? (isZh ? 900 : 1400) : (isZh ? 3000 : 4500);
  if (text.length > maxChars) {
    reasons.push("too_long");
  }

  if (reasons.length > 0) {
    throw new Error(`compiled ${kind} output failed validation: ${reasons.join(", ")}`);
  }
}

// ════════════════════════════
//  辅助
// ════════════════════════════

function computeFingerprint(keys) {
  return crypto.createHash("md5").update(keys.join("\n")).digest("hex");
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
