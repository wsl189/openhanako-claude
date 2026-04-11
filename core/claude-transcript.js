import fs from "fs";
import os from "os";
import path from "path";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

function toTextBlock(text = "") {
  return { type: "text", text: String(text || "") };
}

export function normalizeContentBlocks(content) {
  if (Array.isArray(content)) return content.filter(Boolean);
  if (typeof content === "string") return [toTextBlock(content)];
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return [toTextBlock(content.text)];
    if (typeof content.content === "string") return [toTextBlock(content.content)];
  }
  return [];
}

export function extractTextFromContent(content, { includeThinking = true } = {}) {
  const blocks = normalizeContentBlocks(content);
  let text = "";
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string" && (block.type === "text" || !block.type)) {
      text += block.text;
      continue;
    }
    if (includeThinking && typeof block.thinking === "string") {
      text += block.thinking;
      continue;
    }
    if (typeof block.content === "string" && !block.type) {
      text += block.content;
    }
  }
  return text;
}

function maybeParseJson(raw) {
  const text = String(raw || "").trim();
  if (!text || !/^[\[{]/.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractToolResultPayload(rawContent) {
  let content = normalizeContentBlocks(rawContent);
  let details;

  if (!content.length && typeof rawContent === "string") {
    const parsed = maybeParseJson(rawContent);
    if (parsed && typeof parsed === "object") {
      if (parsed.details && typeof parsed.details === "object") {
        details = parsed.details;
      } else if (parsed.structuredContent?.details && typeof parsed.structuredContent.details === "object") {
        details = parsed.structuredContent.details;
      }
      if (parsed.content !== undefined) {
        content = normalizeContentBlocks(parsed.content);
      }
      if (!content.length && Array.isArray(parsed.content)) {
        content = parsed.content.filter(Boolean);
      }
      if (!content.length && typeof rawContent === "string") {
        content = [toTextBlock(rawContent)];
      }
    }
  }

  if (!content.length && rawContent && typeof rawContent === "object") {
    if (rawContent.details && typeof rawContent.details === "object") {
      details = rawContent.details;
    } else if (rawContent.structuredContent?.details && typeof rawContent.structuredContent.details === "object") {
      details = rawContent.structuredContent.details;
    }
    if (rawContent.content !== undefined) {
      content = normalizeContentBlocks(rawContent.content);
    }
  }

  return {
    content: content.length ? content : [toTextBlock(String(rawContent || ""))],
    details,
  };
}

function mergeAssistantBlocks(target, sourceBlocks) {
  const next = Array.isArray(target?.content) ? [...target.content] : [];
  for (const block of sourceBlocks || []) {
    if (!block) continue;
    next.push(block);
  }
  target.content = next;
}

function buildAssistantEntry(entry) {
  return {
    role: "assistant",
    content: normalizeContentBlocks(entry?.message?.content),
    _mergeKey: entry?.message?.id || entry?.uuid,
  };
}

function buildUserEntry(entry) {
  return {
    role: "user",
    content: normalizeContentBlocks(entry?.message?.content),
  };
}

function buildToolEntry({ toolName = "", args, content, details, toolUseId = null } = {}) {
  return {
    role: "tool",
    toolName,
    args,
    toolUseId,
    content: normalizeContentBlocks(content),
    details,
  };
}

export function encodeClaudeProjectDir(cwd = "") {
  return String(cwd || "").replace(/[^a-zA-Z0-9]/g, "-");
}

export function resolveClaudeTranscriptPath(sessionId, cwd = "") {
  const sid = String(sessionId || "").trim();
  if (!sid || !fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;

  const candidates = [];
  if (cwd) {
    candidates.push(path.join(CLAUDE_PROJECTS_DIR, encodeClaudeProjectDir(cwd), `${sid}.jsonl`));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  for (const projectDir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
    const candidate = path.join(CLAUDE_PROJECTS_DIR, projectDir, `${sid}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function readClaudeTranscriptEntries({ sessionId, cwd, limit = null } = {}) {
  const transcriptPath = resolveClaudeTranscriptPath(sessionId, cwd);
  if (!transcriptPath) return [];
  try {
    const raw = fs.readFileSync(transcriptPath, "utf-8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const slice = limit && limit > 0 ? lines.slice(-limit) : lines;
    return slice.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function buildSessionMessagesFromTranscriptEntries(entries = []) {
  const out = [];
  const toolUses = new Map();

  for (const entry of entries) {
    const role = entry?.message?.role;
    if (entry?.type === "assistant" && role === "assistant") {
      const assistant = buildAssistantEntry(entry);
      const last = out[out.length - 1];
      if (last?.role === "assistant" && last._mergeKey === assistant._mergeKey) {
        mergeAssistantBlocks(last, assistant.content);
      } else {
        out.push(assistant);
      }
      for (const block of assistant.content) {
        if (block?.type === "tool_use" && block.id) {
          toolUses.set(block.id, { name: block.name || "", args: block.input });
        }
      }
      continue;
    }

    if (entry?.type === "user" && role === "user") {
      const blocks = normalizeContentBlocks(entry?.message?.content);
      const toolResultBlocks = blocks.filter((block) => block?.type === "tool_result");
      if (toolResultBlocks.length && toolResultBlocks.length === blocks.length) {
        for (const block of toolResultBlocks) {
          const toolMeta = toolUses.get(block.tool_use_id) || {};
          const payload = extractToolResultPayload(block.content);
          out.push(buildToolEntry({
            toolName: toolMeta.name || "",
            args: toolMeta.args,
            toolUseId: block.tool_use_id || null,
            content: payload.content,
            details: payload.details,
          }));
        }
      } else {
        out.push(buildUserEntry(entry));
      }
    }
  }

  return out.map((message) => {
    if (message && typeof message === "object" && "_mergeKey" in message) {
      const { _mergeKey, ...rest } = message;
      return rest;
    }
    return message;
  });
}

export function buildSessionMessagesFromSession({
  sessionId,
  cwd,
  limit = null,
} = {}) {
  return buildSessionMessagesFromTranscriptEntries(
    readClaudeTranscriptEntries({ sessionId, cwd, limit }),
  );
}
