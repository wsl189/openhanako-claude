/**
 * deep-memory.js — 深度记忆处理器
 *
 * 每日执行一次。遍历所有"脏" session（summary !== snapshot），
 * 通过 snapshot diff 发现新增内容，调 LLM 拆成元事实 + 打标签，
 * 写入 FactStore。
 *
 * 这条链路替代 v1 的 extractMemoryEvents → findNewEvents → 三区间 → score/decay。
 */

import { callProviderText } from "../llm/provider-client.js";
import { getLocale } from "../../server/i18n.js";

const MAX_RETRIES = 3;
const MAX_CONCURRENT = 3;
const _failCounts = new Map();
const TIMELINESS_SET = new Set(["persistent", "stateful", "ephemeral"]);

function normalizeFact(raw) {
  if (!raw || typeof raw.fact !== "string") return null;
  const fact = raw.fact.trim();
  if (!fact) return null;

  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 8)
    : [];

  const timeliness = TIMELINESS_SET.has(raw.timeliness) ? raw.timeliness : "persistent";
  const stateKey = timeliness === "stateful" && typeof raw.state_key === "string"
    ? raw.state_key.trim().replace(/\s+/g, " ").slice(0, 120) || null
    : null;

  const ttlDaysRaw = Number.parseInt(raw.ttl_days, 10);
  const ttlDays = Number.isFinite(ttlDaysRaw)
    ? Math.max(1, Math.min(180, ttlDaysRaw))
    : null;

  return {
    fact,
    tags,
    time: typeof raw.time === "string" && raw.time.trim() ? raw.time.trim() : null,
    timeliness,
    state_key: stateKey,
    ttl_days: timeliness === "ephemeral" ? ttlDays : null,
  };
}

/**
 * 处理所有脏 session，提取新增元事实写入 fact-store
 *
 * @param {import('./session-summary.js').SessionSummaryManager} summaryManager
 * @param {import('./fact-store.js').FactStore} factStore
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @returns {Promise<{ processed: number, factsAdded: number }>}
 */
export async function processDirtySessions(summaryManager, factStore, resolvedModel) {
  const dirty = summaryManager.getDirtySessions();
  if (dirty.length === 0) {
    return { processed: 0, factsAdded: 0 };
  }

  console.log(`\x1b[90m[deep-memory] ${dirty.length} 个脏 session 待处理\x1b[0m`);

  let totalFacts = 0;

  const processOne = async (session) => {
    try {
      const facts = await extractFactsFromDiff(
        session.summary,
        session.snapshot || "",
        resolvedModel,
      );

      if (facts.length > 0) {
        factStore.addBatch(
          facts.map((f) => ({
            fact: f.fact,
            tags: f.tags || [],
            time: f.time || null,
            timeliness: f.timeliness || "persistent",
            state_key: f.state_key || null,
            ttl_days: f.ttl_days ?? null,
            session_id: session.session_id,
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

  // 分批并行处理，每批最多 MAX_CONCURRENT 个 LLM 调用
  for (let i = 0; i < dirty.length; i += MAX_CONCURRENT) {
    const batch = dirty.slice(i, i + MAX_CONCURRENT);
    await Promise.allSettled(batch.map(processOne));
  }

  console.log(
    `\x1b[90m[deep-memory] 完成：${dirty.length} 个 session，${totalFacts} 条新元事实\x1b[0m`,
  );
  return { processed: dirty.length, factsAdded: totalFacts };
}

/**
 * 从摘要 diff 中提取元事实
 *
 * @param {string} currentSummary - 当前摘要全文
 * @param {string} previousSnapshot - 上次处理时的摘要快照
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @returns {Promise<Array<{ fact: string, tags: string[], time: string|null, timeliness: string, state_key: string|null, ttl_days: number|null }>>}
 */
async function extractFactsFromDiff(currentSummary, previousSnapshot, resolvedModel) {
  const { model: utilityModel, api, api_key, base_url } = resolvedModel;

  const hasPrevious = !!previousSnapshot;

  const isZh = getLocale().startsWith("zh");

  let userContent;
  if (hasPrevious) {
    const prevLabel = isZh ? "## 上次快照" : "## Previous Snapshot";
    const currLabel = isZh ? "## 当前摘要" : "## Current Summary";
    userContent = `${prevLabel}\n\n${previousSnapshot}\n\n${currLabel}\n\n${currentSummary}`;
  } else {
    const label = isZh ? "## 摘要内容" : "## Summary Content";
    userContent = `${label}\n\n${currentSummary}`;
  }

  const raw = await callProviderText({
    api,
    model: utilityModel,
    api_key,
    base_url,
    systemPrompt: buildFactExtractionPrompt(hasPrevious),
    messages: [{ role: "user", content: userContent }],
    temperature: 0.3,
    max_tokens: 4096,
    timeoutMs: 60_000,
  });

  // 兼容 markdown 代码块包裹（提取最外层 fence 之间的内容）
  const fenceMatch = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  const jsonStr = (fenceMatch ? fenceMatch[1] : raw).trim();

  try {
    const facts = JSON.parse(jsonStr);
    if (!Array.isArray(facts)) return [];
    return facts
      .map((f) => normalizeFact(f))
      .filter(Boolean);
  } catch {
    console.error(`[deep-memory] JSON 解析失败: ${jsonStr.slice(0, 200)}`);
    return [];
  }
}

/**
 * 构建元事实提取 prompt
 */
function buildFactExtractionPrompt(hasPrevious) {
  const isZh = getLocale().startsWith("zh");

  if (isZh) {
    const diffInstruction = hasPrevious
      ? `你会收到两部分输入：
1. **上次快照**：上次已处理的摘要内容
2. **当前摘要**：最新的完整摘要

请找出"当前摘要"相对于"上次快照"新增或变化的内容，将其拆分成独立的元事实。
已经在上次快照中存在的内容不要重复提取。`
      : `将以下摘要内容拆分成独立的元事实。`;

    return `你是一个记忆拆分器。${diffInstruction}

## 规则

1. 每条事实必须是原子的（一条只记一件事）。
2. 标签用于后续检索，选择有辨识度的关键词，2~5 个。
3. time 字段从摘要中的时间标注提取，格式 YYYY-MM-DDTHH:MM；无法确定填 null。
4. 不要提取助手的内心活动，只提取客观事实和事件。
5. 如果没有新增内容值得提取，返回空数组 []。
6. 严禁提取身份等价事实：不要把“用户”和任何 agent/助手成员写成同一身份。
7. 必须判断事实时效性，使用 timeliness 字段：
   - "persistent"：长期稳定（偏好、身份、长期约束）
   - "stateful"：当前状态类事实，未来可能被更新（例如当前计划、当前持有/不持有、当前在做什么）
   - "ephemeral"：短期临时事实（临时安排、一次性状态）
8. 当 timeliness="stateful" 时，必须提供 state_key（同主题稳定键，格式建议“实体/主题/属性”）。
   例：同一股票“持有/不持有”必须用同一个 state_key，这样后续可自动让旧状态失效。
9. 当 timeliness="ephemeral" 时可提供 ttl_days（1-180）；不确定可填 null。

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

  // English prompt
  const diffInstruction = hasPrevious
    ? `You will receive two inputs:
1. **Previous Snapshot**: the summary content from last processing
2. **Current Summary**: the latest full summary

Find content that is new or changed in "Current Summary" compared to "Previous Snapshot", and split it into independent atomic facts.
Do not re-extract content that already exists in the previous snapshot.`
    : `Split the following summary content into independent atomic facts.`;

  return `You are a memory splitter. ${diffInstruction}

## Rules

1. Each fact must be atomic (one fact per entry).
2. Tags are for retrieval; choose distinctive keywords, 2-5 per fact.
3. Extract time from summary annotations in YYYY-MM-DDTHH:MM; use null if unknown.
4. Do not extract assistant inner thoughts; only objective facts/events.
5. If no meaningful new content exists, return [].
6. Never extract identity-equivalence claims that rewrite the human user as an agent/member.
7. You must classify timeliness:
   - "persistent": long-term stable facts
   - "stateful": current-state facts that can be superseded later
   - "ephemeral": short-lived temporary facts
8. If timeliness="stateful", state_key is required (stable key like "entity/topic/attribute").
   Opposite updates of the same topic must reuse the same state_key.
9. If timeliness="ephemeral", ttl_days may be provided (1-180), otherwise null.

## Output Format

Strict JSON array, no markdown code blocks:
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
