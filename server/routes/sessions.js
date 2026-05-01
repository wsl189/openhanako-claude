/**
 * Session 管理 REST 路由
 */
import fs from "fs/promises";
import path from "path";
import { t } from "../i18n.js";
import { BrowserManager } from "../../lib/browser/browser-manager.js";
import { isToolCallBlock, getToolArgs } from "../../core/llm-utils.js";
import { sanitizeAssistantVisibleText } from "../../lib/text/assistant-visible-text.js";
import {
  SESSION_FILE_EXT,
  listSessionMetadata,
  patchSessionMetadata,
  readSessionMetadata,
} from "../../core/claude-session-store.js";
import { buildSessionMessagesFromSession } from "../../core/claude-transcript.js";
import {
  hasSessionMessageLog,
  messageLogPathForSession,
  readSessionMessagesFromLog,
} from "../../core/session-message-log.js";

/**
 * 从内容块数组中提取纯文本 + thinking + tool_use 调用
 * content 可能是 string 或 [{type: "text", text: "..."}, {type: "thinking", thinking: "..."}, ...]
 * 返回 { text, thinking, toolUses }
 */
const TOOL_ARG_SUMMARY_KEYS = [
  "file_path", "path", "command", "cmd", "pattern", "url", "query", "q",
  "key", "value", "action", "type", "schedule", "prompt", "label", "cwd",
  "location", "ticker", "team", "opponent", "target", "ref_id", "id", "session_id",
  "task", "model", "max_turns", "permission_mode", "thinking", "timeout_sec", "continue", "dangerously_skip_permissions",
  "search_query", "weather", "finance", "sports", "open", "click", "find", "image_query",
  "tool_uses",
  // skill 工具关键字段
  "skill", "skill_name", "skillName", "skill_path", "skillPath", "github_url", "githubUrl",
  // 编辑/写入工具关键信息：让前端展开时能展示“实际写入/替换内容”
  "content", "old_string", "new_string", "old_text", "new_text", "replace_all", "offset", "limit", "lineno",
];
const TOOL_ARG_DEFAULT_TEXT_MAX_LEN = 1_600;
const TOOL_ARG_LONG_TEXT_MAX_LEN = 12_000;
const TOOL_ARG_ARRAY_MAX_ITEMS = 12;
const TOOL_ARG_OBJECT_MAX_KEYS = 40;
const TOOL_ARG_LONG_TEXT_KEYS = new Set(["content", "old_string", "new_string", "old_text", "new_text"]);
const TOOL_RESULT_DETAIL_SUMMARY_KEYS = [
  "error", "summary", "message", "action", "status",
  "url", "count", "filePath", "label", "ext",
  "artifactId", "type", "title", "language", "running", "todos",
];
const TOOL_RESULT_TEXT_MAX_LEN = 12_000;
const SESSION_TITLES_FILE = "session-titles.json";
const AUTO_WORKSPACE_TRACK_FILE = "auto-workspace-whitelist.json";
const TRACK_STATE_ACTIVE = "active";
const TRACK_STATE_ARCHIVED = "archived";
const BASELINE_NONE = "none";
const BASELINE_READ_ONLY = "read_only";

function isTodoToolName(name) {
  const normalized = String(name || "").trim().toLowerCase();
  return normalized === "todo" || normalized === "todowrite";
}

function toModelRef(model) {
  if (!model || typeof model !== "object") return "";
  const id = String(model.id || "").trim();
  if (!id) return "";
  const provider = String(model.provider || "").trim();
  return provider ? `${provider}/${id}` : id;
}

/** 从文本中提取并剥离 <think>...</think> 标签 */
function stripThinkTags(raw) {
  const thinkParts = [];
  const text = raw.replace(/<think>([\s\S]*?)<\/think>\n*/g, (_, inner) => {
    thinkParts.push(inner.trim());
    return "";
  });
  return { text, thinkContent: thinkParts.join("\n") };
}

function extractTextContent(content, { stripThink = false } = {}) {
  if (typeof content === "string") {
    if (stripThink) {
      const { text, thinkContent } = stripThinkTags(content);
      return { text, thinking: thinkContent, toolUses: [] };
    }
    return { text: content, thinking: "", toolUses: [] };
  }
  if (!Array.isArray(content)) return { text: "", thinking: "", toolUses: [] };
  const rawText = content
    .filter(block => block.type === "text" && block.text)
    .map(block => block.text)
    .join("");
  const { text, thinkContent } = stripThink ? stripThinkTags(rawText) : { text: rawText, thinkContent: "" };
  const thinking = [
    thinkContent,
    ...content
      .filter(block => block.type === "thinking" && block.thinking)
      .map(block => block.thinking),
  ].filter(Boolean).join("\n");
  const toolUses = content
    .filter(isToolCallBlock)
    .map(block => {
      const args = {};
      const params = getToolArgs(block);
      if (params && typeof params === "object") {
        for (const k of TOOL_ARG_SUMMARY_KEYS) {
          if (params[k] !== undefined) args[k] = compactToolArgValue(params[k], k, 0);
        }
      }
      return {
        name: block.name,
        toolUseId: block.id || undefined,
        args: Object.keys(args).length ? args : undefined,
      };
    });
  return { text, thinking, toolUses };
}

function compactToolArgsForHistory(rawArgs) {
  if (!rawArgs || typeof rawArgs !== "object") return undefined;
  const args = {};
  for (const k of TOOL_ARG_SUMMARY_KEYS) {
    if (rawArgs[k] !== undefined) args[k] = compactToolArgValue(rawArgs[k], k, 0);
  }
  return Object.keys(args).length ? args : undefined;
}

function clipToolArgText(raw, maxLen) {
  const text = String(raw ?? "").replace(/\r/g, "");
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function compactToolArgValue(value, keyHint = "", depth = 0) {
  if (typeof value === "string") {
    const maxLen = TOOL_ARG_LONG_TEXT_KEYS.has(keyHint)
      ? TOOL_ARG_LONG_TEXT_MAX_LEN
      : TOOL_ARG_DEFAULT_TEXT_MAX_LEN;
    return clipToolArgText(value, maxLen);
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, TOOL_ARG_ARRAY_MAX_ITEMS).map((item) => compactToolArgValue(item, keyHint, depth + 1));
    if (value.length > TOOL_ARG_ARRAY_MAX_ITEMS) {
      items.push(`…(${value.length - TOOL_ARG_ARRAY_MAX_ITEMS} more items)`);
    }
    return items;
  }
  if (typeof value === "object") {
    if (depth >= 2) return "[omitted nested object]";
    const out = {};
    const keys = Object.keys(value).slice(0, TOOL_ARG_OBJECT_MAX_KEYS);
    for (const key of keys) {
      out[key] = compactToolArgValue(value[key], key, depth + 1);
    }
    const omitted = Object.keys(value).length - keys.length;
    if (omitted > 0) out.__omittedKeys = omitted;
    return out;
  }
  return String(value);
}

function clipToolResultText(raw) {
  const text = String(raw || "")
    .replace(/\r/g, "")
    .trim();
  if (!text) return "";
  if (text.length <= TOOL_RESULT_TEXT_MAX_LEN) return text;
  return `${text.slice(0, TOOL_RESULT_TEXT_MAX_LEN - 1)}…`;
}

function pickToolResultPart(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (typeof block.output_text === "string") return block.output_text;
  if (typeof block.result === "string") return block.result;
  return "";
}

function extractToolResultTextForHistory(content) {
  if (typeof content === "string") return clipToolResultText(content);
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    const part = pickToolResultPart(block);
    if (part) text += part;
  }
  return clipToolResultText(text);
}

function compactToolDetailsForHistory(details) {
  if (!details || typeof details !== "object") return undefined;
  const out = {};
  for (const key of TOOL_RESULT_DETAIL_SUMMARY_KEYS) {
    if (details[key] !== undefined) out[key] = details[key];
  }
  if (Array.isArray(details.files) && details.files.length > 0) {
    out.files = details.files
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        filePath: item.filePath,
        label: item.label,
        ext: item.ext,
      }))
      .filter((item) => typeof item.filePath === "string" && item.filePath.trim());
    if (!out.files.length) delete out.files;
  }
  return Object.keys(out).length ? out : undefined;
}

function compactAssistantHistoryBlocks(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      const text = sanitizeAssistantVisibleText(block.text);
      if (text) out.push({ type: "text", text });
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      if (block.thinking.trim()) out.push({ type: "thinking", thinking: block.thinking });
      continue;
    }
    if (block.type === "tool_use" && block.id) {
      out.push({
        type: "tool_use",
        id: block.id,
        name: block.name || "",
        input: compactToolArgsForHistory(getToolArgs(block) || block.input || {}),
      });
      continue;
    }
    if (
      typeof block.type === "string"
      && /(reason|analysis|commentary|summary)/i.test(block.type)
    ) {
      const text = typeof block.text === "string"
        ? block.text
        : (typeof block.reasoning === "string" ? block.reasoning : "");
      if (text.trim()) out.push({ type: "thinking", thinking: text });
    }
  }
  return out;
}

function isToolMessageSuccess(message) {
  if (!message || typeof message !== "object") return true;
  if (typeof message.success === "boolean") return message.success;
  const error = message.details?.error;
  return !(typeof error === "string" && error.trim());
}

function toAssistantHistoryToolResult(message) {
  if (!message || typeof message !== "object") return null;
  const name = String(message.toolName || "").trim();
  if (!name) return null;
  const details = compactToolDetailsForHistory(message.details);
  const resultText = extractToolResultTextForHistory(message.content)
    || (typeof details?.error === "string" ? clipToolResultText(details.error) : "");
  return {
    name,
    toolUseId: message.toolUseId ? String(message.toolUseId) : undefined,
    args: compactToolArgsForHistory(message.args),
    details,
    resultText: resultText || undefined,
    success: isToolMessageSuccess(message),
  };
}

function appendAssistantToolResult(targetMessage, result) {
  if (!targetMessage || !result) return;
  const list = Array.isArray(targetMessage.toolResults) ? [...targetMessage.toolResults] : [];
  let hit = -1;
  if (result.toolUseId) {
    hit = list.findIndex((item) => item?.toolUseId === result.toolUseId);
  }
  if (hit < 0) {
    hit = list.findIndex((item) => !item?.toolUseId && item?.name === result.name);
  }
  if (hit >= 0) {
    const prev = list[hit] || {};
    list[hit] = {
      ...prev,
      ...result,
      args: result.args || prev.args,
      details: result.details || prev.details,
      resultText: result.resultText || prev.resultText,
    };
  } else {
    list.push(result);
  }
  targetMessage.toolResults = list;
}

/**
 * 优先从 session JSONL 读取完整历史。
 * engine.messages 可能只是当前上下文窗口，切回页面时会导致旧消息缺失。
 * 读文件失败时再退回内存态，避免历史接口直接空白。
 */
async function loadSessionHistoryMessages(engine, explicitPath) {
  const sessionPath = explicitPath || engine.currentSessionPath;
  if (!sessionPath) return Array.isArray(engine.messages) ? engine.messages : [];

  const activeSession = engine.getSessionByPath(sessionPath);
  if (Array.isArray(activeSession?.messages) && activeSession.messages.length > 0) {
    return activeSession.messages;
  }

  try {
    if (hasSessionMessageLog(sessionPath)) {
      const messages = readSessionMessagesFromLog(sessionPath);
      if (messages.length > 0) return messages;
    }
  } catch {
    // 回退到 transcript / 内存态
  }

  try {
    const metadata = readSessionMetadata(sessionPath);
    const messages = buildSessionMessagesFromSession({
      sessionId: metadata.sessionId,
      cwd: metadata.cwd,
    });
    if (messages.length > 0) return messages;
  } catch {
    // 回退到内存态
  }

  return Array.isArray(engine.messages) ? engine.messages : [];
}

async function moveSessionMessageLog(fromSessionPath, toSessionPath) {
  const fromLogPath = messageLogPathForSession(fromSessionPath);
  const toLogPath = messageLogPathForSession(toSessionPath);
  if (!fromLogPath || !toLogPath || fromLogPath === toLogPath) return;
  try {
    await fs.access(fromLogPath);
  } catch {
    return;
  }
  await fs.mkdir(path.dirname(toLogPath), { recursive: true });
  await fs.rename(fromLogPath, toLogPath);
}

async function removeSessionMessageLog(sessionPath) {
  const logPath = messageLogPathForSession(sessionPath);
  if (!logPath) return;
  try {
    await fs.unlink(logPath);
  } catch {
    // ignore missing sidecar
  }
}

/**
 * 校验 sessionPath 是否在合法范围内，防止路径穿越
 * baseDir 可以是 sessionDir（单 agent）或 agentsDir（跨 agent）
 */
function isValidSessionPath(sessionPath, baseDir) {
  const resolved = path.resolve(sessionPath);
  const base = path.resolve(baseDir);
  return resolved.startsWith(base + path.sep) || resolved === base;
}

function isArchivedSessionPath(sessionPath, agentsDir) {
  if (!isValidSessionPath(sessionPath, agentsDir)) return false;
  const rel = path.relative(path.resolve(agentsDir), path.resolve(sessionPath));
  if (!rel || rel.startsWith("..")) return false;
  const parts = rel.split(path.sep);
  return parts.length >= 4 && parts[1] === "sessions" && parts[2] === "archived";
}

async function readSessionTitles(sessionDir) {
  try {
    const raw = await fs.readFile(path.join(sessionDir, SESSION_TITLES_FILE), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSessionTitles(sessionDir, titles) {
  await fs.writeFile(
    path.join(sessionDir, SESSION_TITLES_FILE),
    JSON.stringify(titles, null, 2),
    "utf-8",
  );
}

function findLegacyTitleEntry(titles, sessionPath) {
  const name = path.basename(sessionPath);
  for (const [key, value] of Object.entries(titles || {})) {
    if (path.basename(key) === name && typeof value === "string" && value.trim()) {
      return { key, title: value };
    }
  }
  return null;
}

function resolveSessionTitle(titles, sessionPath, fallback = "") {
  if (typeof titles?.[sessionPath] === "string" && titles[sessionPath].trim()) {
    return titles[sessionPath];
  }
  const legacy = findLegacyTitleEntry(titles, sessionPath);
  if (legacy?.title) return legacy.title;
  return fallback || null;
}

async function remapSessionTitle(sessionDir, fromPath, toPath) {
  const titles = await readSessionTitles(sessionDir);
  let changed = false;
  let title = null;

  if (typeof titles[fromPath] === "string" && titles[fromPath].trim()) {
    title = titles[fromPath];
    if (fromPath !== toPath) {
      delete titles[fromPath];
      changed = true;
    }
  } else {
    const legacy = findLegacyTitleEntry(titles, fromPath);
    if (legacy) {
      title = legacy.title;
      if (legacy.key !== toPath) {
        delete titles[legacy.key];
        changed = true;
      }
    }
  }

  if (title && titles[toPath] !== title) {
    titles[toPath] = title;
    changed = true;
  }

  if (changed) {
    await writeSessionTitles(sessionDir, titles);
  }
}

async function removeSessionTitle(sessionDir, sessionPath) {
  const titles = await readSessionTitles(sessionDir);
  const fileName = path.basename(sessionPath);
  let changed = false;

  for (const key of Object.keys(titles)) {
    if (key === sessionPath || path.basename(key) === fileName) {
      delete titles[key];
      changed = true;
    }
  }

  if (changed) {
    await writeSessionTitles(sessionDir, titles);
  }
}

async function resolveRestorePath(preferredPath) {
  try {
    await fs.access(preferredPath);
  } catch {
    return preferredPath;
  }

  const suffix = preferredPath.endsWith(SESSION_FILE_EXT)
    ? SESSION_FILE_EXT
    : path.extname(preferredPath);
  const base = preferredPath.slice(0, preferredPath.length - suffix.length);
  for (let i = 1; i <= 999; i++) {
    const candidate = `${base}_restored-${i}${suffix}`;
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }

  return `${base}_restored-${Date.now()}${suffix}`;
}

function normalizeAbsolutePath(rawPath) {
  const p = String(rawPath || "").trim();
  if (!p || !path.isAbsolute(p)) return "";
  return path.resolve(p);
}

function normalizePathRules(rawRules) {
  if (!Array.isArray(rawRules)) return [];
  const out = [];
  const seen = new Set();
  for (const rule of rawRules) {
    const rulePath = normalizeAbsolutePath(rule?.path);
    const access = String(rule?.access || "").trim();
    if (!rulePath) continue;
    if (access !== "read_only" && access !== "read_write") continue;
    if (seen.has(rulePath)) continue;
    seen.add(rulePath);
    out.push({ path: rulePath, access });
  }
  return out;
}

function findPathRuleIndex(pathRules, targetPath) {
  for (let i = 0; i < pathRules.length; i++) {
    if (normalizeAbsolutePath(pathRules[i]?.path) === targetPath) return i;
  }
  return -1;
}

function createEmptyWorkspaceTracker() {
  return {
    version: 1,
    sessions: {},
    managedRules: {},
  };
}

function normalizeWorkspaceTracker(raw) {
  const out = createEmptyWorkspaceTracker();
  if (!raw || typeof raw !== "object") return out;
  out.version = 1;

  if (raw.sessions && typeof raw.sessions === "object") {
    for (const [sessionPath, item] of Object.entries(raw.sessions)) {
      const normalizedSessionPath = normalizeAbsolutePath(sessionPath);
      const agentId = String(item?.agentId || "").trim();
      const cwd = normalizeAbsolutePath(item?.cwd);
      const state = item?.state === TRACK_STATE_ARCHIVED ? TRACK_STATE_ARCHIVED : TRACK_STATE_ACTIVE;
      if (!normalizedSessionPath || !agentId || !cwd) continue;
      out.sessions[normalizedSessionPath] = { agentId, cwd, state };
    }
  }

  if (raw.managedRules && typeof raw.managedRules === "object") {
    for (const [agentIdRaw, cwdMapRaw] of Object.entries(raw.managedRules)) {
      const agentId = String(agentIdRaw || "").trim();
      if (!agentId || !cwdMapRaw || typeof cwdMapRaw !== "object") continue;
      for (const [cwdRaw, rule] of Object.entries(cwdMapRaw)) {
        const cwd = normalizeAbsolutePath(cwdRaw);
        const baselineAccess = rule?.baselineAccess === BASELINE_READ_ONLY
          ? BASELINE_READ_ONLY
          : BASELINE_NONE;
        if (!cwd) continue;
        if (!out.managedRules[agentId]) out.managedRules[agentId] = {};
        out.managedRules[agentId][cwd] = { baselineAccess };
      }
    }
  }

  return out;
}

async function readWorkspaceTracker(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return normalizeWorkspaceTracker(JSON.parse(raw));
  } catch {
    return createEmptyWorkspaceTracker();
  }
}

async function writeWorkspaceTracker(filePath, tracker) {
  const normalized = normalizeWorkspaceTracker(tracker);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(normalized, null, 2), "utf-8");
}

function getManagedRule(tracker, agentId, cwd) {
  return tracker?.managedRules?.[agentId]?.[cwd] || null;
}

function setManagedRule(tracker, agentId, cwd, baselineAccess) {
  if (!tracker.managedRules[agentId]) tracker.managedRules[agentId] = {};
  tracker.managedRules[agentId][cwd] = {
    baselineAccess: baselineAccess === BASELINE_READ_ONLY ? BASELINE_READ_ONLY : BASELINE_NONE,
  };
}

function deleteManagedRule(tracker, agentId, cwd) {
  if (!tracker.managedRules?.[agentId]) return;
  delete tracker.managedRules[agentId][cwd];
  if (Object.keys(tracker.managedRules[agentId]).length === 0) {
    delete tracker.managedRules[agentId];
  }
}

function getTrackedSession(tracker, sessionPath) {
  const normalized = normalizeAbsolutePath(sessionPath);
  if (!normalized) return null;
  return tracker.sessions?.[normalized] || null;
}

function setTrackedSession(tracker, sessionPath, data) {
  const normalizedSessionPath = normalizeAbsolutePath(sessionPath);
  const agentId = String(data?.agentId || "").trim();
  const cwd = normalizeAbsolutePath(data?.cwd);
  const state = data?.state === TRACK_STATE_ARCHIVED ? TRACK_STATE_ARCHIVED : TRACK_STATE_ACTIVE;
  if (!normalizedSessionPath || !agentId || !cwd) return;
  tracker.sessions[normalizedSessionPath] = { agentId, cwd, state };
}

function moveTrackedSession(tracker, fromPath, toPath, { state } = {}) {
  const from = normalizeAbsolutePath(fromPath);
  const to = normalizeAbsolutePath(toPath);
  if (!from || !to) return null;
  const current = tracker.sessions?.[from];
  if (!current) return null;
  delete tracker.sessions[from];
  tracker.sessions[to] = {
    ...current,
    state: state === TRACK_STATE_ARCHIVED ? TRACK_STATE_ARCHIVED : (state === TRACK_STATE_ACTIVE ? TRACK_STATE_ACTIVE : current.state),
  };
  return tracker.sessions[to];
}

function deleteTrackedSession(tracker, sessionPath) {
  const normalized = normalizeAbsolutePath(sessionPath);
  if (!normalized) return;
  delete tracker.sessions[normalized];
}

function countTrackedSessions(tracker, { agentId, cwd, state } = {}) {
  let total = 0;
  for (const item of Object.values(tracker.sessions || {})) {
    if (agentId && item.agentId !== agentId) continue;
    if (cwd && item.cwd !== cwd) continue;
    if (state && item.state !== state) continue;
    total++;
  }
  return total;
}

async function updateAgentPathRules(engine, agentId, mutate) {
  const targetAgent = engine.getAgent(agentId);
  if (!targetAgent) throw new Error(`agent not found: ${agentId}`);
  const currentRules = normalizePathRules(engine.getAgentPermissionConfig(agentId)?.sandbox?.path_rules);
  const nextRulesRaw = mutate([...currentRules]);
  const nextRules = normalizePathRules(nextRulesRaw);
  const currentStr = JSON.stringify(currentRules);
  const nextStr = JSON.stringify(nextRules);
  if (currentStr === nextStr) return { changed: false, rules: currentRules };
  targetAgent.updateConfig({
    sandbox: {
      ...(targetAgent.config?.sandbox || {}),
      path_rules: nextRules,
    },
  });
  return { changed: true, rules: nextRules };
}

async function ensurePathRuleAccess(engine, agentId, cwd, access = "read_write") {
  const normalizedCwd = normalizeAbsolutePath(cwd);
  if (!normalizedCwd) return;
  await updateAgentPathRules(engine, agentId, (rules) => {
    const idx = findPathRuleIndex(rules, normalizedCwd);
    if (idx >= 0) {
      rules[idx] = { path: normalizedCwd, access };
      return rules;
    }
    return [...rules, { path: normalizedCwd, access }];
  });
}

async function removePathRule(engine, agentId, cwd) {
  const normalizedCwd = normalizeAbsolutePath(cwd);
  if (!normalizedCwd) return;
  await updateAgentPathRules(engine, agentId, (rules) =>
    rules.filter((rule) => normalizeAbsolutePath(rule.path) !== normalizedCwd),
  );
}

async function reconcileManagedWorkspaceRule(engine, tracker, agentId, cwd) {
  const managed = getManagedRule(tracker, agentId, cwd);
  if (!managed) return;
  const activeCount = countTrackedSessions(tracker, { agentId, cwd, state: TRACK_STATE_ACTIVE });
  if (activeCount > 0) {
    await ensurePathRuleAccess(engine, agentId, cwd, "read_write");
    return;
  }
  if (managed.baselineAccess === BASELINE_READ_ONLY) {
    await ensurePathRuleAccess(engine, agentId, cwd, "read_only");
    return;
  }
  await removePathRule(engine, agentId, cwd);
}

function pruneManagedRuleIfUnused(tracker, agentId, cwd) {
  const refs = countTrackedSessions(tracker, { agentId, cwd });
  if (refs === 0) deleteManagedRule(tracker, agentId, cwd);
}

export default async function sessionsRoute(app, { engine }) {
  const workspaceTrackerPath = path.join(engine.userDir, AUTO_WORKSPACE_TRACK_FILE);

  // 列出所有 agent 的历史 session
  app.get("/api/sessions", async (req, reply) => {
    try {
      const sessions = await engine.listSessions();
      return sessions.map(s => ({
        path: s.path,
        title: s.title || null,
        firstMessage: (s.firstMessage || "").slice(0, 100),
        modified: s.modified?.toISOString() || null,
        messageCount: s.messageCount || 0,
        cwd: s.cwd || null,
        agentId: s.agentId || null,
        agentName: s.agentName || null,
      }));
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 列出指定 agent 的归档 session
  app.get("/api/sessions/archived", async (req, reply) => {
    try {
      const agentId = String(req.query?.agentId || engine.currentAgentId || "").trim();
      if (!agentId) return { agentId: "", sessions: [] };

      const sessionDir = path.join(engine.agentsDir, agentId, "sessions");
      if (!isValidSessionPath(sessionDir, engine.agentsDir)) {
        reply.code(403);
        return { error: "Invalid session path", sessions: [] };
      }

      const archiveDir = path.join(sessionDir, "archived");
      const archived = listSessionMetadata(archiveDir, { includeArchived: true });
      const mapped = archived.map(({ sessionPath, metadata }) => {
        let messages = [];
        if (hasSessionMessageLog(sessionPath)) {
          messages = readSessionMessagesFromLog(sessionPath, { limit: 50 });
        } else {
          messages = buildSessionMessagesFromSession({
            sessionId: metadata.sessionId,
            cwd: metadata.cwd,
            limit: 50,
          });
        }
        const firstUser = messages.find((m) => m.role === "user");
        return {
          path: sessionPath,
          title: metadata.title || null,
          firstMessage: extractTextContent(firstUser?.content || "").text.slice(0, 120),
          modified: metadata.updatedAt || metadata.createdAt || null,
          messageCount: messages.filter((m) => m.role === "user" || m.role === "assistant").length,
          cwd: metadata.cwd || null,
          agentId,
        };
      });

      mapped.sort((a, b) => {
        const at = a.modified ? new Date(a.modified).getTime() : 0;
        const bt = b.modified ? new Date(b.modified).getTime() : 0;
        return bt - at;
      });

      return { agentId, sessions: mapped };
    } catch (err) {
      reply.code(500);
      return { error: err.message, sessions: [] };
    }
  });

  // 获取 session 的消息（支持 ?path= 指定 session，否则读焦点 session）
  app.get("/api/sessions/messages", async (req, reply) => {
    try {
      const queryPath = req.query?.path || null;
      if (queryPath && !isValidSessionPath(queryPath, engine.agentsDir)) {
        reply.code(403);
        return { error: "Invalid session path" };
      }
      const sourceMessages = await loadSessionHistoryMessages(engine, queryPath);

      // 分页参数
      const beforeId = req.query?.before != null ? Number(req.query.before) : null;
      const limit = Math.min(Number(req.query?.limit) || 50, 200);

      // 提取可显示的消息（user/assistant 文本 + 文件/artifact 工具结果）
      // 每条消息带稳定 id（原始 sourceMessages 索引）
      const allMessages = [];
      const fileOutputs = [];
      const artifacts = [];
      const toolUseToAssistantIndex = new Map();
      const pendingToolResults = [];
      let awaitingAssistantForTurn = false;
      let lastAssistantIndex = -1;
      let globalIdx = 0;

      for (const m of sourceMessages) {
        if (m.role === "user") {
          if (pendingToolResults.length && lastAssistantIndex >= 0) {
            const lastAssistant = allMessages[lastAssistantIndex];
            if (lastAssistant?.role === "assistant") {
              for (const result of pendingToolResults) {
                appendAssistantToolResult(lastAssistant, result);
              }
            }
            pendingToolResults.length = 0;
          }
          const { text } = extractTextContent(m.content);
          if (text) allMessages.push({ id: String(globalIdx++), role: "user", content: text });
          awaitingAssistantForTurn = true;
        } else if (m.role === "assistant") {
          const { text, thinking, toolUses } = extractTextContent(m.content, { stripThink: true });
          const visibleText = sanitizeAssistantVisibleText(text);
          const contentBlocks = compactAssistantHistoryBlocks(m.content);
          if (visibleText || toolUses.length) {
            const assistantMessage = {
              id: String(globalIdx++),
              role: "assistant",
              content: visibleText,
              thinking: thinking || undefined,
              toolCalls: toolUses.length ? toolUses : undefined,
              contentBlocks: contentBlocks.length ? contentBlocks : undefined,
            };
            allMessages.push(assistantMessage);
            const assistantIndex = allMessages.length - 1;
            lastAssistantIndex = assistantIndex;
            awaitingAssistantForTurn = false;
            for (const toolUse of toolUses) {
              if (toolUse?.toolUseId) {
                toolUseToAssistantIndex.set(toolUse.toolUseId, assistantIndex);
              }
            }
            if (pendingToolResults.length) {
              for (const result of pendingToolResults) {
                appendAssistantToolResult(assistantMessage, result);
              }
              pendingToolResults.length = 0;
            }
          }
        } else if (m.role === "tool" || m.role === "toolResult") {
          const toolResult = toAssistantHistoryToolResult(m);
          if (toolResult) {
            let targetIndex = -1;
            if (toolResult.toolUseId && toolUseToAssistantIndex.has(toolResult.toolUseId)) {
              targetIndex = toolUseToAssistantIndex.get(toolResult.toolUseId);
            } else if (!awaitingAssistantForTurn && lastAssistantIndex >= 0) {
              targetIndex = lastAssistantIndex;
            }
            if (targetIndex >= 0 && allMessages[targetIndex]?.role === "assistant") {
              appendAssistantToolResult(allMessages[targetIndex], toolResult);
            } else {
              pendingToolResults.push(toolResult);
            }
          }
          const d = m.details || {};
          if (m.toolName === "present_files" && d.files?.length) {
            fileOutputs.push({ afterIndex: allMessages.length - 1, files: d.files });
          } else if (m.toolName === "create_artifact" && d.content) {
            artifacts.push({
              afterIndex: allMessages.length - 1,
              artifactId: d.artifactId,
              artifactType: d.type,
              title: d.title,
              content: d.content,
              language: d.language,
            });
          }
        }
      }
      if (pendingToolResults.length && lastAssistantIndex >= 0) {
        const lastAssistant = allMessages[lastAssistantIndex];
        if (lastAssistant?.role === "assistant") {
          for (const result of pendingToolResults) {
            appendAssistantToolResult(lastAssistant, result);
          }
        }
      }

      // 分页：只在有 before 参数时切片，否则返回全量
      let messages;
      let hasMore = false;
      let slicedFileOutputs = fileOutputs;
      let slicedArtifacts = artifacts;

      if (beforeId != null && beforeId > 0) {
        const endIdx = Math.min(beforeId, allMessages.length);
        const startIdx = Math.max(0, endIdx - limit);
        messages = allMessages.slice(startIdx, endIdx);
        hasMore = startIdx > 0;
        // 重映射 afterIndex 到切片内偏移，过滤超出范围的
        slicedFileOutputs = fileOutputs
          .filter(fo => fo.afterIndex >= startIdx && fo.afterIndex < endIdx)
          .map(fo => ({ ...fo, afterIndex: fo.afterIndex - startIdx }));
        slicedArtifacts = artifacts
          .filter(a => a.afterIndex >= startIdx && a.afterIndex < endIdx)
          .map(a => ({ ...a, afterIndex: a.afterIndex - startIdx }));
      } else {
        // 默认返回全量，不截断
        messages = allMessages;
      }

      // 从历史中提取最新 todo 状态
      let todos = null;
      for (let i = sourceMessages.length - 1; i >= 0; i--) {
        const m = sourceMessages[i];
        if ((m.role === "tool" || m.role === "toolResult") && isTodoToolName(m.toolName) && m.details?.todos) {
          todos = m.details.todos;
          break;
        }
      }

      return { messages, todos, fileOutputs: slicedFileOutputs, artifacts: slicedArtifacts, hasMore };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 新建 session（可选指定工作目录和 agentId）
  app.post("/api/sessions/new", async (req, reply) => {
    try {
      const { cwd, memoryEnabled, agentId, modelId } = req.body || {};
      const memFlag = memoryEnabled !== false; // 默认 true
      const requestedCwd = normalizeAbsolutePath(cwd);
      const targetAgentId = String(agentId || engine.currentAgentId || "").trim();
      const desiredModelId = String(modelId || "").trim();
      const defaultWorkspace = normalizeAbsolutePath(engine.getHomeFolder(targetAgentId) || "");
      const shouldTrackWorkspace = !!requestedCwd && requestedCwd !== defaultWorkspace;
      let workspaceTracker = null;
      let pendingManagedBaseline = null;
      console.log("[sessions] 新建 session", {
        hasCwd: !!cwd,
        memoryEnabled: memFlag,
        customAgent: !!agentId,
      });

      if (shouldTrackWorkspace) {
        workspaceTracker = await readWorkspaceTracker(workspaceTrackerPath);
        const managed = getManagedRule(workspaceTracker, targetAgentId, requestedCwd);
        if (managed) {
          await ensurePathRuleAccess(engine, targetAgentId, requestedCwd, "read_write");
        } else {
          const currentRules = normalizePathRules(engine.getAgentPermissionConfig(targetAgentId)?.sandbox?.path_rules);
          const idx = findPathRuleIndex(currentRules, requestedCwd);
          if (idx < 0) {
            await ensurePathRuleAccess(engine, targetAgentId, requestedCwd, "read_write");
            pendingManagedBaseline = BASELINE_NONE;
          } else if (currentRules[idx].access === "read_only") {
            await ensurePathRuleAccess(engine, targetAgentId, requestedCwd, "read_write");
            pendingManagedBaseline = BASELINE_READ_ONLY;
          }
        }
      }

      // 新建前挂起浏览器（保存当前 session 的浏览器状态）
      const bm = BrowserManager.instance();
      if (bm.isRunning) await bm.suspendForSession(engine.currentSessionPath);

      if (agentId && agentId !== engine.currentAgentId) {
        await engine.createSessionForAgent(agentId, cwd || undefined, memFlag);
      } else {
        await engine.createSession(null, cwd || undefined, memFlag);
      }
      engine.persistMemoryEnabled();

      // 新建会话时允许直接指定模型，确保首轮消息就使用该 session 的目标模型。
      if (desiredModelId) {
        await engine.setModel(desiredModelId);
        if (engine.currentSessionPath) {
          try {
            const modelRef = toModelRef(engine.currentModel) || desiredModelId;
            patchSessionMetadata(engine.currentSessionPath, { model: modelRef });
          } catch {
            // ignore metadata patch failures
          }
        }
      }

      // 记住工作目录 + 更新历史
      if (cwd) {
        const history = Array.isArray(engine.config.cwd_history)
          ? engine.config.cwd_history.filter(p => p !== cwd)
          : [];
        history.unshift(cwd);
        if (history.length > 10) history.length = 10;  // 保留最近 10 条
        await engine.updateConfig({ last_cwd: cwd, cwd_history: history });
      }

      if (shouldTrackWorkspace && workspaceTracker && engine.currentSessionPath) {
        if (pendingManagedBaseline) {
          setManagedRule(workspaceTracker, engine.currentAgentId, requestedCwd, pendingManagedBaseline);
        }
        setTrackedSession(workspaceTracker, engine.currentSessionPath, {
          agentId: engine.currentAgentId || targetAgentId,
          cwd: requestedCwd,
          state: TRACK_STATE_ACTIVE,
        });
        await writeWorkspaceTracker(workspaceTrackerPath, workspaceTracker);
      }

      console.log("[sessions] session 创建完成");
      return {
        ok: true,
        path: engine.currentSessionPath,
        cwd: engine.cwd,
        agentId: engine.currentAgentId,
        agentName: engine.agentName,
        homeFolder: engine.getHomeFolder(engine.currentAgentId) || null,
      };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 切换 session（支持跨 agent）
  app.post("/api/sessions/switch", async (req, reply) => {
    try {
      const { path: sessionPath } = req.body || {};
      if (!sessionPath) {
        reply.code(400);
        return { error: t("error.missingParam", { param: "path" }) };
      }
      // 校验路径在 agentsDir 范围内（支持跨 agent session）
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        reply.code(403);
        return { error: "Invalid session path" };
      }
      // 切换前挂起浏览器（保存当前 session 的浏览器状态）
      const bm = BrowserManager.instance();
      const oldSessionPath = engine.currentSessionPath;
      if (bm.isRunning) await bm.suspendForSession(oldSessionPath);

      await engine.switchSession(sessionPath);

      // 恢复目标 session 的浏览器（若有）
      await bm.resumeForSession(sessionPath);

      return {
        ok: true,
        messageCount: engine.messages.length,
        memoryEnabled: engine.memoryEnabled,
        cwd: engine.cwd,
        agentId: engine.currentAgentId,
        agentName: engine.agentName,
        homeFolder: engine.getHomeFolder(engine.currentAgentId) || null,
        browserRunning: bm.isRunning,
        browserUrl: bm.currentUrl || null,
        isStreaming: engine.isStreaming,
      };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 获取所有有浏览器的 session
  app.get("/api/browser/sessions", async () => {
    const bm = BrowserManager.instance();
    return bm.getBrowserSessions();
  });

  // 关闭指定 session 的浏览器
  app.post("/api/browser/close-session", async (req) => {
    const { sessionPath } = req.body || {};
    if (!sessionPath) return { error: "missing sessionPath" };
    const bm = BrowserManager.instance();
    await bm.closeBrowserForSession(sessionPath);
    return { ok: true };
  });

  // 清理过期归档 session
  app.post("/api/sessions/cleanup", async (req, reply) => {
    try {
      const { maxAgeDays = 90 } = req.body || {};
      const cutoff = Date.now() - maxAgeDays * 86400000;
      let deleted = 0;
      let trackerDirty = false;
      const workspaceTracker = await readWorkspaceTracker(workspaceTrackerPath);

      // 遍历所有 agent 的 sessions/archived/ 目录
      const agentsDir = engine.agentsDir;
      const agents = await fs.readdir(agentsDir).catch(() => []);
      for (const agentId of agents) {
        const archiveDir = path.join(agentsDir, agentId, "sessions", "archived");
        let files;
        try { files = await fs.readdir(archiveDir); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith(SESSION_FILE_EXT)) continue;
          const fp = path.join(archiveDir, f);
          try {
            const stat = await fs.stat(fp);
            if (stat.mtime.getTime() < cutoff) {
              await fs.unlink(fp);
              await removeSessionMessageLog(fp);
              const tracked = getTrackedSession(workspaceTracker, fp);
              if (tracked) {
                deleteTrackedSession(workspaceTracker, fp);
                pruneManagedRuleIfUnused(workspaceTracker, tracked.agentId, tracked.cwd);
                trackerDirty = true;
              }
              deleted++;
            }
          } catch {}
        }
      }

      if (trackerDirty) {
        await writeWorkspaceTracker(workspaceTrackerPath, workspaceTracker);
      }

      return { ok: true, deleted, maxAgeDays };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 归档 session（支持跨 agent）
  app.post("/api/sessions/archive", async (req, reply) => {
    try {
      const { path: sessionPath } = req.body || {};
      if (!sessionPath) {
        reply.code(400);
        return { error: t("error.missingParam", { param: "path" }) };
      }
      // 校验路径在 agentsDir 范围内
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        reply.code(403);
        return { error: "Invalid session path" };
      }

      // 确认文件存在
      try {
        await fs.access(sessionPath);
      } catch {
        reply.code(404);
        return { error: t("error.sessionNotFound") };
      }

      // 先从 engine 的 session map 中移除（如果正在后台跑会被 abort）
      await engine.closeSession(sessionPath);

      // 从 session 路径推导归档目录（同 agent 的 sessions/archived/）
      const sessDir = path.dirname(sessionPath);
      const archiveDir = path.join(sessDir, "archived");
      await fs.mkdir(archiveDir, { recursive: true });

      const fileName = path.basename(sessionPath);
      const destPath = path.join(archiveDir, fileName);
      await fs.rename(sessionPath, destPath);
      await moveSessionMessageLog(sessionPath, destPath);
      await remapSessionTitle(sessDir, sessionPath, destPath);
      patchSessionMetadata(destPath, { archiveState: TRACK_STATE_ARCHIVED });

      try {
        const workspaceTracker = await readWorkspaceTracker(workspaceTrackerPath);
        const moved = moveTrackedSession(workspaceTracker, sessionPath, destPath, { state: TRACK_STATE_ARCHIVED });
        if (moved) {
          await reconcileManagedWorkspaceRule(engine, workspaceTracker, moved.agentId, moved.cwd);
          await writeWorkspaceTracker(workspaceTrackerPath, workspaceTracker);
        }
      } catch (trackerErr) {
        console.warn("[sessions] archive workspace tracker update failed:", trackerErr?.message || trackerErr);
      }

      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 恢复归档 session
  app.post("/api/sessions/restore", async (req, reply) => {
    try {
      const { path: archivedPath } = req.body || {};
      if (!archivedPath) {
        reply.code(400);
        return { error: t("error.missingParam", { param: "path" }) };
      }
      if (!isArchivedSessionPath(archivedPath, engine.agentsDir)) {
        reply.code(400);
        return { error: "Invalid archived session path" };
      }

      try {
        await fs.access(archivedPath);
      } catch {
        reply.code(404);
        return { error: t("error.sessionNotFound") };
      }

      const archiveDir = path.dirname(archivedPath);
      const sessionDir = path.dirname(archiveDir);
      const preferredTargetPath = path.join(sessionDir, path.basename(archivedPath));
      const targetPath = await resolveRestorePath(preferredTargetPath);
      const workspaceTracker = await readWorkspaceTracker(workspaceTrackerPath);
      const tracked = getTrackedSession(workspaceTracker, archivedPath);

      if (tracked && getManagedRule(workspaceTracker, tracked.agentId, tracked.cwd)) {
        await ensurePathRuleAccess(engine, tracked.agentId, tracked.cwd, "read_write");
      }

      await fs.rename(archivedPath, targetPath);
      await moveSessionMessageLog(archivedPath, targetPath);
      await remapSessionTitle(sessionDir, archivedPath, targetPath);
      patchSessionMetadata(targetPath, { archiveState: TRACK_STATE_ACTIVE });

      if (tracked) {
        moveTrackedSession(workspaceTracker, archivedPath, targetPath, { state: TRACK_STATE_ACTIVE });
        try {
          await writeWorkspaceTracker(workspaceTrackerPath, workspaceTracker);
        } catch (trackerErr) {
          console.warn("[sessions] restore workspace tracker update failed:", trackerErr?.message || trackerErr);
        }
      }

      return { ok: true, path: targetPath };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 彻底删除归档 session（删除 .hanako 对应文件）
  app.post("/api/sessions/delete-archived", async (req, reply) => {
    try {
      const { path: archivedPath } = req.body || {};
      if (!archivedPath) {
        reply.code(400);
        return { error: t("error.missingParam", { param: "path" }) };
      }
      if (!isArchivedSessionPath(archivedPath, engine.agentsDir)) {
        reply.code(400);
        return { error: "Invalid archived session path" };
      }

      try {
        await fs.access(archivedPath);
      } catch {
        reply.code(404);
        return { error: t("error.sessionNotFound") };
      }

      await fs.unlink(archivedPath);
      await removeSessionMessageLog(archivedPath);

      const archiveDir = path.dirname(archivedPath);
      const sessionDir = path.dirname(archiveDir);
      await removeSessionTitle(sessionDir, archivedPath);

      try {
        const workspaceTracker = await readWorkspaceTracker(workspaceTrackerPath);
        const tracked = getTrackedSession(workspaceTracker, archivedPath);
        if (tracked) {
          deleteTrackedSession(workspaceTracker, archivedPath);
          pruneManagedRuleIfUnused(workspaceTracker, tracked.agentId, tracked.cwd);
          await writeWorkspaceTracker(workspaceTrackerPath, workspaceTracker);
        }
      } catch (trackerErr) {
        console.warn("[sessions] delete archived workspace tracker update failed:", trackerErr?.message || trackerErr);
      }

      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });
}
