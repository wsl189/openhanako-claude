/**
 * deep-memory.js — 深度记忆处理器
 *
 * 每日执行一次。遍历所有"脏" session（summary !== snapshot），
 * 仅根据 evidence + episode anchor 提取结构化事实，
 * 再通过 MemoryService 写入 facts。
 */

import { callProviderText } from "../llm/provider-client.js";
import { getLocale } from "../../server/i18n.js";

const MAX_RETRIES = 3;
const MAX_CONCURRENT = 3;
const _failCounts = new Map();
const TIMELINESS_SET = new Set(["persistent", "stateful", "ephemeral"]);

function normalizeStateKeyFromTags(tags) {
  if (!Array.isArray(tags) || tags.length < 2) return null;
  const key = tags
    .slice(0, 3)
    .map((x) => String(x || "").trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("/");
  return key ? `${key}/状态` : null;
}

function normalizeFactTime(value, referenceTime) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;

  const ref = referenceTime ? new Date(referenceTime) : new Date();
  if (Number.isNaN(ref.getTime())) return raw;
  if (parsed.getTime() > ref.getTime() + 86400000) return null;
  return raw;
}

export function normalizeFact(raw, opts = {}) {
  if (!raw || typeof raw.fact !== "string") return null;
  const fact = raw.fact.trim();
  if (!fact) return null;

  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 8)
    : [];

  let timeliness = TIMELINESS_SET.has(raw.timeliness) ? raw.timeliness : "persistent";
  let stateKey = timeliness === "stateful" && typeof raw.state_key === "string"
    ? raw.state_key.trim().replace(/\s+/g, " ").slice(0, 120) || null
    : null;

  if (timeliness === "stateful" && !stateKey) {
    stateKey = normalizeStateKeyFromTags(tags);
    if (!stateKey) timeliness = "ephemeral";
  }

  const ttlDaysRaw = Number.parseInt(raw.ttl_days, 10);
  const ttlDays = Number.isFinite(ttlDaysRaw)
    ? Math.max(1, Math.min(180, ttlDaysRaw))
    : null;

  return {
    fact,
    tags,
    time: normalizeFactTime(raw.time, opts.referenceTime),
    timeliness,
    state_key: timeliness === "stateful" ? stateKey : null,
    ttl_days: timeliness === "ephemeral" ? ttlDays : null,
  };
}

/**
 * 处理所有脏 session，提取新增元事实写入 memory service
 *
 * @param {import('./session-summary.js').SessionSummaryManager} summaryManager
 * @param {import('./memory-service.js').MemoryService} memoryService
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @returns {Promise<{ processed: number, factsAdded: number }>}
 */
export async function processDirtySessions(summaryManager, memoryService, resolvedModel) {
  if (!memoryService || typeof memoryService.listEvidenceBySession !== "function") {
    throw new Error("MemoryService is required for evidence-first extraction");
  }

  const dirty = summaryManager.getDirtySessions();
  if (dirty.length === 0) {
    return { processed: 0, factsAdded: 0 };
  }

  console.log(`\x1b[90m[deep-memory] ${dirty.length} 个脏 session 待处理\x1b[0m`);

  let totalFacts = 0;

  const processOne = async (session) => {
    try {
      const origin = String(session.session_id || "").startsWith("channel-") ? "channel" : "session";
      const scope = origin === "channel" ? "channel" : "agent";
      const evidenceRows = memoryService.listEvidenceBySession(session.session_id);
      if (evidenceRows.length === 0) {
        memoryService.logDiagnostic("missing_evidence_for_dirty_session", {
          sessionId: session.session_id,
          origin,
        });
        // Keep dirty for retry: evidence may arrive later via async/session recovery paths.
        return;
      }

      const episode = memoryService.upsertEpisode({
        origin,
        scope,
        sessionId: session.session_id,
        anchorText: session.summary || "",
        sourceRefs: evidenceRows.slice(0, 5).map((row) => ({ layer: "evidence", id: row.id })),
      });

      const facts = await extractFactsFromEvidence(
        episode.anchorText,
        evidenceRows.slice(0, 3),
        resolvedModel,
        { referenceTime: session.updated_at || session.created_at || session.snapshot_at },
      );

      if (facts.length > 0) {
        memoryService.addFacts(
          facts.map((f) => ({
            fact: f.fact,
            tags: f.tags || [],
            time: f.time || null,
            timeliness: f.timeliness || "persistent",
            state_key: f.state_key || null,
            ttl_days: f.ttl_days ?? null,
            session_id: session.session_id,
            origin,
            scope,
            source_refs: [
              ...evidenceRows.slice(0, 3).map((row) => ({ layer: "evidence", id: row.id })),
              { layer: "episode", id: episode.id },
            ],
          })),
        );
        totalFacts += facts.length;
        console.log(
          `\x1b[90m[deep-memory] ${session.session_id.slice(0, 8)}...: ${facts.length} 条元事实\x1b[0m`,
        );
      }

      summaryManager.markProcessed(session.session_id);
      _failCounts.delete(session.session_id);
    } catch (err) {
      const count = (_failCounts.get(session.session_id) || 0) + 1;
      _failCounts.set(session.session_id, count);

      if (count >= MAX_RETRIES) {
        console.error(
          `\x1b[90m[deep-memory] ${session.session_id.slice(0, 8)}... 连续失败 ${count} 次，标记跳过: ${err.message}\x1b[0m`,
        );
        summaryManager.markProcessed(session.session_id);
        _failCounts.delete(session.session_id);
      } else {
        console.error(
          `\x1b[90m[deep-memory] 处理失败 (${session.session_id.slice(0, 8)}... ${count}/${MAX_RETRIES}): ${err.message}\x1b[0m`,
        );
      }
    }
  };

  for (let i = 0; i < dirty.length; i += MAX_CONCURRENT) {
    const batch = dirty.slice(i, i + MAX_CONCURRENT);
    await Promise.allSettled(batch.map(processOne));
  }

  console.log(
    `\x1b[90m[deep-memory] 完成：${dirty.length} 个 session，${totalFacts} 条新元事实\x1b[0m`,
  );
  return { processed: dirty.length, factsAdded: totalFacts };
}

async function extractFactsFromEvidence(episodeAnchor, evidenceRows, resolvedModel, opts = {}) {
  const { model: utilityModel, api, api_key, base_url } = resolvedModel;
  const isZh = getLocale().startsWith("zh");
  const evidenceText = evidenceRows.map((row, index) => {
    const title = isZh ? `### 证据 ${index + 1}` : `### Evidence ${index + 1}`;
    return `${title}\nID: ${row.id}\n${row.content || row.preview || ""}`;
  }).join("\n\n");
  const userContent = `${isZh ? "## Episode Anchor" : "## Episode Anchor"}\n\n${episodeAnchor || ""}\n\n${isZh ? "## Evidence" : "## Evidence"}\n\n${evidenceText}`;

  const raw = await callProviderText({
    api,
    model: utilityModel,
    api_key,
    base_url,
    systemPrompt: buildFactExtractionPrompt(),
    messages: [{ role: "user", content: userContent }],
    temperature: 0.3,
    max_tokens: 4096,
    timeoutMs: 60_000,
  });

  const fenceMatch = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  const jsonStr = (fenceMatch ? fenceMatch[1] : raw).trim();

  try {
    const facts = JSON.parse(jsonStr);
    if (!Array.isArray(facts)) return [];
    return facts
      .map((f) => normalizeFact(f, { referenceTime: opts.referenceTime }))
      .filter(Boolean);
  } catch {
    console.error(`[deep-memory] JSON 解析失败: ${jsonStr.slice(0, 200)}`);
    return [];
  }
}

function buildFactExtractionPrompt() {
  const isZh = getLocale().startsWith("zh");

  if (isZh) {
    return `你是一个记忆拆分器。你只允许根据 episode anchor 和 evidence 提取结构化事实。

## 规则

1. 每条事实必须是原子的（一条只记一件事）。
2. 标签用于后续检索，选择有辨识度的关键词，2~5 个。
3. time 字段只能从 evidence 中可追溯的时间标注提取，格式 YYYY-MM-DDTHH:MM；无法确定填 null。
4. 不要提取助手的内心活动，只提取客观事实和事件。
5. 如果没有新增内容值得提取，返回空数组 []。
6. 严禁提取身份等价事实：不要把“用户”和任何 agent/助手成员写成同一身份。
7. 必须判断事实时效性，使用 timeliness 字段：
   - "persistent"：长期稳定（偏好、身份、长期约束）
   - "stateful"：当前状态类事实，未来可能被更新
   - "ephemeral"：短期临时事实
8. 当 timeliness="stateful" 时，必须提供 state_key。
9. 当 timeliness="ephemeral" 时可提供 ttl_days（1-180）；不确定可填 null。
10. 新闻、行情、价格、网页状态、工具/API 错误、搜索过程、点击/播放/发消息等一次性操作通常是 "ephemeral" 或 "stateful"，不要标为 "persistent"。
11. 只有用户长期偏好、稳定身份信息、长期项目背景、明确长期约束才可标为 "persistent"。
12. 如果新事实否定或更新旧状态，必须复用同一个 state_key。
13. 不要提取工具/技能清单、助手自我介绍、模型名称自述、长篇搜索结果全文。
14. summary 只作为 episode anchor，不得把 anchor 自身当成独立事实来源；若 evidence 无法支撑，就不要提取。

## 输出格式

严格 JSON 数组，不要 markdown 代码块：
[
  {
    "fact": "当前不再持有中国核建",
    "tags": ["中国核建", "持仓", "状态变更"],
    "time": "2026-04-08T10:20",
    "timeliness": "stateful",
    "state_key": "投资组合/中国核建/持仓状态",
    "ttl_days": null
  }
]`;
  }

  return `You are a memory splitter. You may only extract structured facts from the episode anchor plus evidence.

## Rules

1. Each fact must be atomic.
2. Tags should be distinctive keywords (2-5 items).
3. Extract time only from explicit timestamps in evidence; otherwise null.
4. Do not extract assistant inner thoughts.
5. Return [] if there is nothing worth extracting.
6. Never extract identity-equivalence claims that rewrite the human user as an agent/member.
7. Classify timeliness as persistent, stateful, or ephemeral.
8. If timeliness="stateful", state_key is required.
9. If timeliness="ephemeral", ttl_days may be provided (1-180), otherwise null.
10. News, market quotes, prices, page state, tool/API errors, search process, and one-off actions are usually ephemeral or stateful, not persistent.
11. Only durable user preferences, stable identity facts, long-term project background, and explicit durable constraints should be persistent.
12. If a new fact negates or updates an old state, reuse the same state_key.
13. Do not extract tool inventories, self-introductions, model-name chatter, or full long search dumps.
14. The summary is only an episode anchor, not an authoritative fact source. If evidence does not support a fact, do not extract it.

## Output Format

Strict JSON array, no markdown:
[
  {
    "fact": "No longer holds China State Construction stock",
    "tags": ["portfolio", "holding", "status-change"],
    "time": "2026-04-08T10:20",
    "timeliness": "stateful",
    "state_key": "portfolio/china-state-construction/holding-status",
    "ttl_days": null
  }
]`;
}
