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
const MEMORY_KIND_SET = new Set([
  "profile_identity",
  "profile_preference",
  "profile_constraint",
  "state",
  "decision",
  "background",
  "working_note",
]);
const FACT_EXTRACTION_MISSION_ID = "agent_fact_bank_v1";

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

  const memoryKind = MEMORY_KIND_SET.has(String(raw.memory_kind || raw.memoryKind || "").trim())
    ? String(raw.memory_kind || raw.memoryKind || "").trim()
    : "background";
  let timeliness = TIMELINESS_SET.has(raw.timeliness) ? raw.timeliness : (memoryKind === "state" ? "stateful" : "persistent");
  let stateKey = timeliness === "stateful" && typeof raw.state_key === "string"
    ? raw.state_key.trim().replace(/\s+/g, " ").slice(0, 120) || null
    : null;
  let decisionKey = typeof raw.decision_key === "string"
    ? raw.decision_key.trim().replace(/\s+/g, " ").slice(0, 120) || null
    : null;

  if (timeliness === "stateful" && !stateKey) {
    stateKey = normalizeStateKeyFromTags(tags);
    if (!stateKey) timeliness = "ephemeral";
  }
  if (memoryKind === "decision" && !decisionKey && tags.length >= 2) {
    decisionKey = tags.slice(0, 3).join("/").slice(0, 120);
  }

  const ttlDaysRaw = Number.parseInt(raw.ttl_days, 10);
  const ttlDays = Number.isFinite(ttlDaysRaw)
    ? Math.max(1, Math.min(180, ttlDaysRaw))
    : null;

  return {
    fact,
    tags,
    memory_kind: memoryKind,
    time: normalizeFactTime(raw.time, opts.referenceTime),
    timeliness,
    state_key: timeliness === "stateful" ? stateKey : null,
    decision_key: memoryKind === "decision" ? decisionKey : null,
    ttl_days: timeliness === "ephemeral" ? ttlDays : null,
    confidence: Number.isFinite(raw.confidence) ? Number(raw.confidence) : null,
    importance: Number.isFinite(raw.importance) ? Number(raw.importance) : null,
    subject_id: typeof raw.subject_id === "string" ? raw.subject_id.trim() || null : null,
    staleness_hint: typeof raw.staleness_hint === "string" ? raw.staleness_hint.trim() || null : null,
  };
}

function normalizePlaybook(raw) {
  if (!raw || typeof raw !== "object") return null;
  const trigger = String(raw.trigger || "").trim();
  const wrongPath = String(raw.wrong_path || raw.wrongPath || "").trim();
  const rootCause = String(raw.root_cause || raw.rootCause || "").trim();
  const fixSteps = String(raw.fix_steps || raw.fixSteps || "").trim();
  const validation = String(raw.validation || "").trim();
  if (!trigger || !wrongPath || !rootCause || !fixSteps || !validation) return null;
  return {
    category: String(raw.category || "").trim(),
    trigger,
    wrong_path: wrongPath,
    root_cause: rootCause,
    fix_steps: fixSteps,
    validation,
  };
}

function normalizeEpisodePatch(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      episode_kind: "conversation",
      tags: [],
      anchor_text: "",
    };
  }
  return {
    episode_kind: String(raw.episode_kind || raw.episodeKind || "conversation").trim() || "conversation",
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 10)
      : [],
    anchor_text: typeof raw.anchor_text === "string"
      ? raw.anchor_text.trim()
      : (typeof raw.anchorText === "string" ? raw.anchorText.trim() : ""),
  };
}

function normalizeExtractionBundle(parsed, opts = {}) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      facts: [],
      playbooks: [],
      episode_patch: normalizeEpisodePatch(null),
      ignored: [],
    };
  }
  return {
    facts: Array.isArray(parsed.facts)
      ? parsed.facts.map((item) => normalizeFact(item, opts)).filter(Boolean)
      : [],
    playbooks: Array.isArray(parsed.playbooks)
      ? parsed.playbooks.map((item) => normalizePlaybook(item)).filter(Boolean)
      : [],
    episode_patch: normalizeEpisodePatch(parsed.episode_patch || parsed.episodePatch || null),
    ignored: Array.isArray(parsed.ignored)
      ? parsed.ignored.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean)
      : [],
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
          missionId: FACT_EXTRACTION_MISSION_ID,
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

      const bundle = await extractMemoryBundleFromEvidence(
        episode.anchorText,
        evidenceRows.slice(0, 3),
        resolvedModel,
        { referenceTime: session.updated_at || session.created_at || session.snapshot_at },
      );

      if ((bundle.facts.length + bundle.playbooks.length) > 0) {
        const result = memoryService.applyExtractionBundle(bundle, {
          origin,
          scope,
          sessionId: session.session_id,
          channelName: origin === "channel" ? session.session_id.replace(/^channel-/, "") : null,
          anchorText: episode.anchorText,
          sourceRefs: [
            ...evidenceRows.slice(0, 3).map((row) => ({ layer: "evidence", id: row.id })),
            { layer: "episode", id: episode.id },
          ],
          missionId: FACT_EXTRACTION_MISSION_ID,
        });
        totalFacts += result.factsAdded || 0;
        console.log(
          `\x1b[90m[deep-memory] ${session.session_id.slice(0, 8)}...: ${result.factsAdded || 0} 条事实, ${result.playbooksAdded || 0} 条经验\x1b[0m`,
        );
      } else {
        memoryService.logDiagnostic("extraction_empty_due_to_uncertainty", {
          missionId: FACT_EXTRACTION_MISSION_ID,
          sessionId: session.session_id,
          origin,
          ignored: bundle.ignored,
        });
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

async function extractMemoryBundleFromEvidence(episodeAnchor, evidenceRows, resolvedModel, opts = {}) {
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
    const parsed = JSON.parse(jsonStr);
    return normalizeExtractionBundle(parsed, { referenceTime: opts.referenceTime });
  } catch {
    console.error(`[deep-memory] JSON 解析失败: ${jsonStr.slice(0, 200)}`);
    return {
      facts: [],
      playbooks: [],
      episode_patch: normalizeEpisodePatch(null),
      ignored: [],
    };
  }
}

function buildFactExtractionPrompt() {
  const isZh = getLocale().startsWith("zh");

  if (isZh) {
    return `你是 Hanako 的长期记忆路由器，当前 mission_id=${FACT_EXTRACTION_MISSION_ID}。
你只能根据 episode anchor 和 evidence 产出结构化记忆包，不能凭空补充。

## 1. 提取目标

- 识别哪些信息值得进入长期画像、当前状态、决策结论、长期背景、短期工作笔记或经验 playbook。
- 识别哪些信息只适合作为 episode 过程保留，不应进入长期事实。
- 不确定时宁可不提取，也不要猜。

## 2. 记忆类型定义

- facts[].memory_kind 只能是：
  - profile_identity：稳定身份或稳定角色信息
  - profile_preference：稳定偏好、习惯、沟通偏好
  - profile_constraint：长期约束、禁忌、必须遵守的规则
  - state：当前状态，未来可能变化
  - decision：明确结论、已做决定、已采纳方案
  - background：跨时间仍有价值的长期背景
  - working_note：短期工作笔记，只能短期使用
- playbooks[]：重复问题沉淀出的经验，必须包含 trigger / wrong_path / root_cause / fix_steps / validation
- episode_patch：描述这一轮 episode 的类型、标签和 anchor 文本

### bank missions

- profile bank：只保留能长期改善对用户理解的稳定身份、偏好、约束。
- agent fact bank：只保留当前状态、明确决策、长期背景与短期 working_note。
- playbook bank：只保留“重复问题 + 错误路径 + 根因 + 修复法 + 验证法”完整闭环经验。

## 3. 正向准入标准

- 只有同时满足“可追溯到 evidence”“未来可复用”“不是一次性过程痕迹”时，才进入长期 facts。
- 当前状态类信息要写成 state，且尽量提供 state_key。
- 明确结论、拒绝某方案、定下约束或路线，优先写成 decision。
- 用户长期稳定偏好、身份、长期约束，写成 profile_*。

## 4. 排除规则

- 新闻、行情、价格、网页瞬时状态、接口临时故障、搜索步骤、点击/播放/发消息过程、寒暄、工具清单、模型自述、长篇搜索结果全文，默认不要进长期 facts。
- 一次性动作本身不该进长期事实；若它体现了稳定习惯或长期偏好，才抽象后写入。
- summary 只是 episode anchor，不是独立事实来源；evidence 不支撑就不要写。
- 严禁提取身份等价事实：不要把“用户”和任何 agent/成员写成同一身份。

## 5. 路由与升级规则

- 单次行为 -> 仅保留在 episode_patch 或 ignored。
- 重复且稳定的偏好/约束 -> 升级为 profile_preference / profile_constraint。
- 当前持仓、项目状态、关系状态、进行中事项 -> state。
- 已确认的结论、采纳路线、拒绝原因 -> decision。
- 重复失败且 evidence 能说明错误路径、根因、修复法、验证法 -> playbooks。

## 6. 更新规则

- state 必须尽量复用 state_key；新状态如果覆盖旧状态，state_key 要一致。
- decision 若属于同一主题，尽量复用 decision_key。
- time 只能取 evidence 中可追溯时间，格式 YYYY-MM-DDTHH:MM；无法确定填 null。
- confidence / importance 用 0~1 的小数；不确定可填 null。

## 输出格式

严格输出 JSON 对象，不要 markdown：
{
  "facts": [
    {
      "fact": "当前不再持有中国核建",
      "tags": ["中国核建", "持仓", "状态变更"],
      "memory_kind": "state",
      "time": "2026-04-08T10:20",
      "timeliness": "stateful",
      "state_key": "投资组合/中国核建/持仓状态",
      "decision_key": null,
      "ttl_days": null,
      "confidence": 0.82,
      "importance": 0.74,
      "subject_id": null
    }
  ],
  "playbooks": [],
  "episode_patch": {
    "episode_kind": "decision_process",
    "tags": ["投资", "状态更新"],
    "anchor_text": "用户更新了中国核建持仓状态。"
  },
  "ignored": ["搜索过程本身不进入长期事实"]
}`;
  }

  return `You are Hanako's structured memory router, mission_id=${FACT_EXTRACTION_MISSION_ID}.
You may only use the episode anchor plus evidence, and you must output a structured memory bundle.

## 1. Extraction Goal

- Route reusable information into long-term profile facts, current state, decisions, background context, short-lived working notes, or playbooks.
- Keep one-off process traces inside episode metadata instead of long-term facts.
- If uncertain, abstain instead of guessing.

## 2. Memory Types

- facts[].memory_kind must be one of:
  - profile_identity
  - profile_preference
  - profile_constraint
  - state
  - decision
  - background
  - working_note
- playbooks[] require trigger, wrong_path, root_cause, fix_steps, validation.
- episode_patch captures episode_kind, tags, and anchor_text.

### bank missions

- profile bank: durable identity, preferences, and constraints that improve long-term user understanding.
- agent fact bank: current state, explicit decisions, durable background, and short-lived working notes.
- playbook bank: only repeated-problem knowledge with wrong path, root cause, fix, and validation.

## 3. Positive Admission Rules

- Only store long-term facts when they are evidence-backed, reusable, and not raw one-off process traces.
- Current mutable information should become state facts and should reuse state_key when possible.
- Confirmed conclusions, adopted plans, and stable constraints should become decision or profile facts.

## 4. Exclusions

- News, market quotes, prices, transient page state, temporary tool/API errors, search traces, click/play/send-message steps, greetings, tool inventories, model self-descriptions, and full search dumps should not become long-term facts.
- Single actions should not be stored directly unless they reveal a stable preference, constraint, or reusable pattern.
- The summary is only an anchor, not an authoritative fact source.
- Never rewrite the human user as an agent/member identity.

## 5. Routing and Promotion

- Single action -> episode_patch or ignored.
- Stable repeated preference/constraint -> profile_preference / profile_constraint.
- Mutable current status -> state.
- Confirmed conclusion or chosen path -> decision.
- Repeated failure with clear wrong path, root cause, fix, and validation -> playbook.

## 6. Update Rules

- Reuse state_key for the same evolving state.
- Reuse decision_key for the same evolving decision topic when possible.
- time must come from evidence in YYYY-MM-DDTHH:MM format or be null.
- confidence / importance should be 0-1 floats or null.

## Output

Return strict JSON object only:
{
  "facts": [],
  "playbooks": [],
  "episode_patch": {
    "episode_kind": "conversation",
    "tags": [],
    "anchor_text": ""
  },
  "ignored": []
}`;
}
