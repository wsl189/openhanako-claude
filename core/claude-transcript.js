import fs from "fs";
import os from "os";
import path from "path";

const DEFAULT_CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

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

const INTERNAL_USER_TEXT_PATTERNS = [
  /^Base directory for this skill:/i,
  /^This session is being continued from a previous conversation that ran out of context\./i,
  /^<local-command-caveat>/i,
  /^<command-name>\/compact<\/command-name>/i,
  /^<local-command-stdout>Compacted\b/i,
  /^\[Request interrupted by user(?: for tool use)?\]$/i,
];
const INTERRUPTED_USER_TEXT_PATTERN = /^\[Request interrupted by user(?: for tool use)?\]$/i;

function extractPlainTextFromBlocks(blocks = []) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function isInternalUserTranscriptEntry(entry, blocks = []) {
  if (!entry || typeof entry !== "object") return false;
  if (entry?.message?.role !== "user") return false;
  if (entry?.isMeta) return true;
  if (entry?.sourceToolUseID) return true;
  const text = extractPlainTextFromBlocks(blocks).trim();
  if (!text) return false;
  return INTERNAL_USER_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

function isInterruptedUserTranscriptEntry(entry, blocks = []) {
  if (!entry || typeof entry !== "object") return false;
  if (entry?.message?.role !== "user") return false;
  const text = extractPlainTextFromBlocks(blocks).trim();
  return INTERRUPTED_USER_TEXT_PATTERN.test(text);
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

function normalizeHomePath(rawPath = "") {
  const input = String(rawPath || "").trim();
  if (!input) return "";
  const expanded = input.replace(/^~(?=$|[\\/])/, os.homedir());
  return path.resolve(expanded);
}

function collectHanakoAgentProjectDirs() {
  const hanakoHome = normalizeHomePath(process.env.HANA_HOME || "")
    || path.join(os.homedir(), ".hanako");
  const agentsDir = path.join(hanakoHome, "agents");
  if (!fs.existsSync(agentsDir)) return [];

  const out = [];
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectsDir = path.join(agentsDir, entry.name, "projects");
      if (fs.existsSync(projectsDir)) out.push(projectsDir);
    }
  } catch {
    return [];
  }
  return out;
}

function collectClaudeProjectRoots() {
  const roots = [];
  const seen = new Set();
  const pushIfExists = (dir) => {
    const normalized = normalizeHomePath(dir);
    if (!normalized || seen.has(normalized)) return;
    if (!fs.existsSync(normalized)) return;
    seen.add(normalized);
    roots.push(normalized);
  };

  pushIfExists(DEFAULT_CLAUDE_PROJECTS_DIR);
  const claudeConfigDir = normalizeHomePath(process.env.CLAUDE_CONFIG_DIR || "");
  if (claudeConfigDir) {
    pushIfExists(path.join(claudeConfigDir, "projects"));
  }
  for (const projectsDir of collectHanakoAgentProjectDirs()) {
    pushIfExists(projectsDir);
  }
  return roots;
}

export function resolveClaudeTranscriptPath(sessionId, cwd = "") {
  const sid = String(sessionId || "").trim();
  if (!sid) return null;
  const projectRoots = collectClaudeProjectRoots();
  if (projectRoots.length === 0) return null;

  const candidates = [];
  if (cwd) {
    const encoded = encodeClaudeProjectDir(cwd);
    for (const projectsDir of projectRoots) {
      candidates.push(path.join(projectsDir, encoded, `${sid}.jsonl`));
    }
  }
  for (const projectsDir of projectRoots) {
    candidates.push(path.join(projectsDir, `${sid}.jsonl`));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  for (const projectsDir of projectRoots) {
    let projectDirs = [];
    try {
      projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      projectDirs = [];
    }
    for (const projectDir of projectDirs) {
      const candidate = path.join(projectsDir, projectDir, `${sid}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
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
  let skipInterruptedTail = false;

  for (const entry of entries) {
    const role = entry?.message?.role;
    if (entry?.type === "assistant" && role === "assistant") {
      if (skipInterruptedTail) continue;
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
      if (isInternalUserTranscriptEntry(entry, blocks)) {
        if (isInterruptedUserTranscriptEntry(entry, blocks)) {
          skipInterruptedTail = true;
          toolUses.clear();
        }
        continue;
      }
      const toolResultBlocks = blocks.filter((block) => block?.type === "tool_result");
      if (toolResultBlocks.length && toolResultBlocks.length === blocks.length) {
        if (skipInterruptedTail) continue;
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
        skipInterruptedTail = false;
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
