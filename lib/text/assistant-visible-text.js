/**
 * assistant-visible-text.js
 *
 * 将 assistant 原始输出清理为“可直接展示给用户”的文本：
 * - 兼容 final/replying/reply 包裹标签
 */

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
  const closeIdx = after.search(/<\/(?:reply|final|replying)\s*>/i);
  return closeIdx === -1 ? after : after.slice(0, closeIdx);
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

  // 剥离包裹标签本身（保留正文）
  cleaned = cleaned.replace(
    new RegExp(`</?\\s*(?:${WRAPPER_TAGS.join("|")})\\b[^>]*>`, "gi"),
    "",
  );

  return cleaned
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
