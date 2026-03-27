/**
 * Session 管理 REST 路由
 */
import fs from "fs/promises";
import path from "path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { t } from "../i18n.js";
import { BrowserManager } from "../../lib/browser/browser-manager.js";
import { isToolCallBlock, getToolArgs } from "../../core/llm-utils.js";

/**
 * 从 Pi SDK 的 content 块数组中提取纯文本 + thinking + tool_use 调用
 * content 可能是 string 或 [{type: "text", text: "..."}, {type: "thinking", thinking: "..."}, ...]
 * 返回 { text, thinking, toolUses }
 */
const TOOL_ARG_SUMMARY_KEYS = ["file_path", "path", "command", "pattern", "url", "query", "key", "value", "action", "type", "schedule", "prompt", "label"];
const SESSION_TITLES_FILE = "session-titles.json";

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
          if (params[k] !== undefined) args[k] = params[k];
        }
      }
      return { name: block.name, args: Object.keys(args).length ? args : undefined };
    });
  return { text, thinking, toolUses };
}

/**
 * 优先从 session JSONL 读取完整历史。
 * engine.messages 可能只是当前上下文窗口，切回页面时会导致旧消息缺失。
 * 读文件失败时再退回内存态，避免历史接口直接空白。
 */
async function loadSessionHistoryMessages(engine, explicitPath) {
  const sessionPath = explicitPath || engine.currentSessionPath;
  if (sessionPath) {
    try {
      const raw = await fs.readFile(sessionPath, "utf-8");
      const messages = [];

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "message" && entry.message) {
            messages.push(entry.message);
          }
        } catch {
          // 跳过损坏行
        }
      }

      if (messages.length > 0) return messages;
    } catch {
      // 回退到内存态
    }
  }

  return Array.isArray(engine.messages) ? engine.messages : [];
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

  const ext = path.extname(preferredPath);
  const base = preferredPath.slice(0, preferredPath.length - ext.length);
  for (let i = 1; i <= 999; i++) {
    const candidate = `${base}_restored-${i}${ext}`;
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }

  return `${base}_restored-${Date.now()}${ext}`;
}

export default async function sessionsRoute(app, { engine }) {

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
      let sessions = [];
      try {
        sessions = await SessionManager.list(process.cwd(), archiveDir);
      } catch {
        sessions = [];
      }

      const titles = await readSessionTitles(sessionDir);
      const mapped = sessions.map((s) => ({
        path: s.path,
        title: resolveSessionTitle(titles, s.path, s.firstMessage || ""),
        firstMessage: (s.firstMessage || "").slice(0, 120),
        modified: s.modified?.toISOString?.() || s.modified || null,
        messageCount: s.messageCount || 0,
        cwd: s.cwd || null,
        agentId,
      }));

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
      let globalIdx = 0;

      for (const m of sourceMessages) {
        if (m.role === "user") {
          const { text } = extractTextContent(m.content);
          if (text) allMessages.push({ id: String(globalIdx++), role: "user", content: text });
        } else if (m.role === "assistant") {
          const { text, thinking, toolUses } = extractTextContent(m.content, { stripThink: true });
          if (text || toolUses.length) {
            allMessages.push({
              id: String(globalIdx++),
              role: "assistant",
              content: text,
              thinking: thinking || undefined,
              toolCalls: toolUses.length ? toolUses : undefined,
            });
          }
        } else if (m.role === "toolResult") {
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
        if (m.role === "toolResult" && m.toolName === "todo" && m.details?.todos) {
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
      const { cwd, memoryEnabled, agentId } = req.body || {};
      const memFlag = memoryEnabled !== false; // 默认 true
      console.log("[sessions] 新建 session", {
        hasCwd: !!cwd,
        memoryEnabled: memFlag,
        customAgent: !!agentId,
      });

      // 新建前挂起浏览器（保存当前 session 的浏览器状态）
      const bm = BrowserManager.instance();
      if (bm.isRunning) await bm.suspendForSession(engine.currentSessionPath);

      if (agentId && agentId !== engine.currentAgentId) {
        await engine.createSessionForAgent(agentId, cwd || undefined, memFlag);
      } else {
        await engine.createSession(null, cwd || undefined, memFlag);
      }
      engine.persistMemoryEnabled();

      // 记住工作目录 + 更新历史
      if (cwd) {
        const history = Array.isArray(engine.config.cwd_history)
          ? engine.config.cwd_history.filter(p => p !== cwd)
          : [];
        history.unshift(cwd);
        if (history.length > 10) history.length = 10;  // 保留最近 10 条
        await engine.updateConfig({ last_cwd: cwd, cwd_history: history });
      }

      console.log("[sessions] session 创建完成");
      return {
        ok: true,
        path: engine.currentSessionPath,
        cwd: engine.cwd,
        agentId: engine.currentAgentId,
        agentName: engine.agentName,
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

      // 遍历所有 agent 的 sessions/archived/ 目录
      const agentsDir = engine.agentsDir;
      const agents = await fs.readdir(agentsDir).catch(() => []);
      for (const agentId of agents) {
        const archiveDir = path.join(agentsDir, agentId, "sessions", "archived");
        let files;
        try { files = await fs.readdir(archiveDir); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          const fp = path.join(archiveDir, f);
          try {
            const stat = await fs.stat(fp);
            if (stat.mtime.getTime() < cutoff) {
              await fs.unlink(fp);
              deleted++;
            }
          } catch {}
        }
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
      await remapSessionTitle(sessDir, sessionPath, destPath);

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

      await fs.rename(archivedPath, targetPath);
      await remapSessionTitle(sessionDir, archivedPath, targetPath);

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

      const archiveDir = path.dirname(archivedPath);
      const sessionDir = path.dirname(archiveDir);
      await removeSessionTitle(sessionDir, archivedPath);

      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });
}
