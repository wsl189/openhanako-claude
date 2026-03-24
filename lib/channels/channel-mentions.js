/**
 * channel-mentions.js — 频道 @ 提及解析
 *
 * 支持：
 * - 以 agent.name / agent.id 提及
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

const PREFIX = "(^|[\\s\\(\\[\\{<\"'“‘，。！？、,:;；])";
const SUFFIX = "(?=$|[\\s\\)\\]\\}>\"'”’，。！？、,:;；.!?])";

/**
 * @param {string} text
 * @param {string} token
 * @returns {boolean}
 */
function hasMention(text, token) {
  const t = String(token || "").trim();
  if (!t) return false;
  const re = new RegExp(`${PREFIX}@${escapeRegExp(t)}${SUFFIX}`, "u");
  return re.test(String(text || ""));
}

/**
 * @param {string} text
 * @param {Array<{id: string, name?: string}>} agents
 * @param {string[]} [allowedIds]
 * @returns {string[]}
 */
export function collectMentionedAgentIds(text, agents, allowedIds) {
  const allowed = Array.isArray(allowedIds) && allowedIds.length > 0
    ? new Set(allowedIds)
    : null;
  const out = [];
  const seen = new Set();

  for (const a of agents || []) {
    const id = String(a?.id || "").trim();
    if (!id) continue;
    if (allowed && !allowed.has(id)) continue;

    const tokens = [a?.name, id]
      .map(v => String(v || "").trim())
      .filter(Boolean);
    if (!tokens.some(t => hasMention(text, t))) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

