/**
 * assistant-visible-text.js
 *
 * 将 assistant 原始输出清理为“可直接展示给用户”的文本：
 * - 剥离 mood/pulse/reflect 内省块（含非标准标签写法的兜底）
 * - 兼容 final/replying/reply 包裹标签
 */

const INNER_STATE_TAGS = ["mood", "pulse", "reflect"];
const WRAPPER_TAGS = ["final", "replying", "reply"];

function pickLastWrappedContent(text, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>\\s*([\\s\\S]*?)\\s*<\\/${tag}\\s*>`, "gi");
  let match = null;
  let last = null;
  while ((match = re.exec(text)) !== null) {
    last = match[1];
  }
  return last;
}

function pickMalformedReplyContent(text) {
  const open = /<reply\b[^>]*>/i.exec(text);
  if (!open) return null;
  const start = open.index + open[0].length;
  const after = text.slice(start);
  const closeIdx = after.search(/<\/(?:reply|mood|pulse|reflect|final|replying)\s*>/i);
  return closeIdx === -1 ? after : after.slice(0, closeIdx);
}

function stripPairedTagBlocks(text, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>\\s*`, "gi");
  let prev = null;
  let next = text;
  // 反复剥离，覆盖重复或嵌套片段
  while (next !== prev) {
    prev = next;
    next = next.replace(re, "");
  }
  return next;
}

export function sanitizeAssistantVisibleText(rawText) {
  let cleaned = String(rawText || "");

  // 若显式给出 final/replying，优先取最后一个包裹块内容。
  const finalContent = pickLastWrappedContent(cleaned, "final");
  if (finalContent !== null) {
    cleaned = finalContent;
  } else {
    const replyingContent = pickLastWrappedContent(cleaned, "replying");
    if (replyingContent !== null) {
      cleaned = replyingContent;
    } else {
      const replyContent = pickLastWrappedContent(cleaned, "reply");
      if (replyContent !== null) {
        cleaned = replyContent;
      } else {
        const malformedReply = pickMalformedReplyContent(cleaned);
        if (malformedReply !== null) cleaned = malformedReply;
      }
    }
  }

  // 去掉 mood/pulse/reflect 代码块（含未闭合 fence 的兜底）
  cleaned = cleaned
    .replace(/```(?:\s*)(?:mood|pulse|reflect)\b[\s\S]*?```\s*/gi, "")
    .replace(/```(?:\s*)(?:mood|pulse|reflect)\b[\s\S]*$/gi, "");

  for (const tag of INNER_STATE_TAGS) {
    cleaned = stripPairedTagBlocks(cleaned, tag);
  }

  // 未闭合开标签兜底：从开标签到末尾全部丢弃
  for (const tag of INNER_STATE_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "gi"), "");
  }

  // 剥离残留标签（保留 reply 包裹内的正文）
  cleaned = cleaned.replace(
    new RegExp(`</?\\s*(?:${[...INNER_STATE_TAGS, ...WRAPPER_TAGS].join("|")})\\b[^>]*>`, "gi"),
    "",
  );

  // 兼容偶发“缺左尖括号”残片（如 mood> / @mood>）
  cleaned = cleaned.replace(/^[ \t]*@?(?:mood|pulse|reflect)\s*>\s*$/gim, "");

  return cleaned
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
