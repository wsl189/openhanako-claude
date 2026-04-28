/**
 * assistant-visible-text.js
 *
 * 将 assistant 原始输出清理为“可直接展示给用户”的文本：
 * - 兼容 final/replying/reply 包裹标签
 */

const WRAPPER_TAGS = ["final", "replying", "reply"];
const NAMED_TOOL_TAGS = [
  "glob",
  "read",
  "read_file",
  "write",
  "write_file",
  "edit",
  "edit_file",
  "bash",
  "grep",
  "find",
  "find_files",
  "list_files",
  "ls",
  "exec",
  "exec_command",
  "command",
];

export function stripSdkDiagnosticLines(rawText) {
  const diagnosticPatterns = [
    /\[ede_diagnostic\]/i,
    /Native CLI binary for\s+[A-Za-z0-9._-]+-[A-Za-z0-9._-]+\s+not found\./i,
    /Reinstall @anthropic-ai\/claude-agent-sdk/i,
  ];
  return String(rawText || "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => !diagnosticPatterns.some((re) => re.test(String(line || ""))))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/g, "\n\n");
}

export function stripRawToolCallMarkup(rawText) {
  return String(rawText || "")
    .replace(/```[\s\S]*?(?:<assistant\b[^>]*\bto=|<tool_use\b|<minimax:tool_call\b|<function_call\b|<function_calls\b)[\s\S]*?```/gi, " ")
    .replace(/```[\s\S]*?\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\][\s\S]*?```/gi, " ")
    .replace(/<assistant\b[^>]*\bto\s*=\s*(?:"[^"]+"|'[^']+'|“[^”]+”|‘[^’]+’|[^\s>]+)[^>]*>[\s\S]*?<\/assistant>\s*/gi, " ")
    .replace(/<tool_use\b[^>]*\bname\s*=\s*(?:"[^"]+"|'[^']+'|“[^”]+”|‘[^’]+’|[^\s>]+)[^>]*>[\s\S]*?<\/tool_use>\s*/gi, " ")
    .replace(/<minimax:tool_call\b[^>]*>[\s\S]*?<\/minimax:tool_call>\s*/gi, " ")
    .replace(/<\/?minimax:tool_call\b[^>]*>\s*/gi, " ")
    .replace(/<function_call\b[^>]*>[\s\S]*?<\/function_call>\s*/gi, " ")
    .replace(/<function_calls\b[^>]*>[\s\S]*?<\/function_calls>\s*/gi, " ")
    .replace(/(?:^|\n)\s*function_call\s*\n[\s\S]*?<\/function_call>\s*/gi, "\n")
    .replace(new RegExp(
      `<(?:${NAMED_TOOL_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?<\\/(?:${NAMED_TOOL_TAGS.join("|")})>\\s*`,
      "gi",
    ), " ")
    .replace(new RegExp(`</(?:${NAMED_TOOL_TAGS.join("|")})\\s*>`, "gi"), " ")
    .replace(new RegExp(`<(?:${NAMED_TOOL_TAGS.join("|")})\\b[^>]*>`, "gi"), " ")
    .replace(/<\/?function_call\b[^>]*>\s*/gi, " ")
    .replace(/<\/?function_calls\b[^>]*>\s*/gi, " ")
    .replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter>\s*/gi, " ")
    .replace(/<\/?parameter\b[^>]*>\s*/gi, " ")
    .replace(/<\/?invoke\b[^>]*>\s*/gi, " ")
    .replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]\s*/gi, " ")
    .replace(/(?:^|\n)\s*tool_call\s*:?[^\n]*(?:\n(?!\s*tool_call_end\b)[^\n]*)*\n\s*tool_call_end\s*:?[^\n]*(?=\n|$)/gi, "\n")
    .replace(/^\s*tool_call(?:_start|_end)?\s*:?[^\n]*$/gim, "")
    .replace(/\bto\s*=\s*[A-Za-z_][\w-]*\b/gi, " ")
    .replace(/\bcode omitted\b/gi, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

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

  cleaned = stripSdkDiagnosticLines(cleaned);
  cleaned = stripRawToolCallMarkup(cleaned);

  return cleaned
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
