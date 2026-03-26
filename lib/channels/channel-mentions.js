/**
 * channel-mentions.js — 频道 @ 提及解析
 *
 * 支持：
 * - 以 agent.name / agent.id 提及
 * - @全体成员 / @all / @everyone 触发全员提及
 * - 名称含空格
 * - 中英文标点边界
 */

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Markdown 包裹符（* _ ~ `）也作为合法边界，
// 兼容 **@name** / __@name__ / ~~@name~~ / `@name` 这类写法。
const PREFIX = "(^|[\\s\\(\\[\\{<\"'“‘，。！？、,:;；：*_~`])";
const SUFFIX = "(?=$|[\\s\\)\\]\\}>\"'”’，。！？、,:;；：.!?*_~`])";
const AT_SIGN = "[@＠]";
const ALL_MENTION_TOKENS = [
  "全体成员",
  "所有成员",
  "所有人",
  "all",
  "all members",
  "everyone",
];

/**
 * @param {string} text
 * @param {string} token
 * @returns {boolean}
 */
function hasMention(text, token) {
  const t = String(token || "").trim();
  if (!t) return false;
  const re = new RegExp(`${PREFIX}${AT_SIGN}${escapeRegExp(t)}${SUFFIX}`, "iu");
  return re.test(String(text || ""));
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function hasMentionAll(text) {
  return ALL_MENTION_TOKENS.some((token) => hasMention(text, token));
}

/**
 * @param {string} text
 * @param {Array<{id: string, name?: string}>} agents
 * @param {string[]} [allowedIds]
 * @returns {string[]}
 */
export function collectMentionedAgentIds(text, agents, allowedIds) {
  const allowedRaw = Array.isArray(allowedIds) && allowedIds.length > 0
    ? new Set(
      allowedIds
        .map((v) => String(v || "").trim())
        .filter(Boolean),
    )
    : null;
  const allowedNorm = allowedRaw
    ? new Set([...allowedRaw].map((v) => v.toLowerCase()))
    : null;
  const candidates = (agents || [])
    .map((a) => ({ id: String(a?.id || "").trim(), name: a?.name }))
    .filter((a) => !!a.id)
    .filter((a) => {
      if (!allowedRaw || !allowedNorm) return true;
      const id = String(a.id || "").trim();
      const name = String(a.name || "").trim();
      const idNorm = id.toLowerCase();
      const nameNorm = name.toLowerCase();
      return (
        allowedRaw.has(id)
        || allowedNorm.has(idNorm)
        || (name && (allowedRaw.has(name) || allowedNorm.has(nameNorm)))
      );
    });

  if (hasMentionAll(text)) {
    return candidates.map((a) => a.id);
  }

  const out = [];
  const seen = new Set();
  for (const a of candidates) {
    const id = a.id;

    const tokens = [a.name, id]
      .map(v => String(v || "").trim())
      .filter(Boolean);
    if (!tokens.some(t => hasMention(text, t))) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
