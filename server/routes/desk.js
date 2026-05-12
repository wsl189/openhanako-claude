/**
 * desk.js — Desk 系统 REST API
 *
 * 提供 cron 任务、工作空间文件的 HTTP 接口。
 * 前端通过这些接口直接操作（不经过 agent/LLM），
 * agent 通过 tool 操作（走 WebSocket 推送更新）。
 */

import fs from "fs";
import path from "path";
import os from "os";
import { t } from "../i18n.js";
import { normalizeEverySchedule } from "../../lib/desk/cron-schedule.js";
import { readSessionMetadata } from "../../core/claude-session-store.js";

/** 解析真实路径（跟踪 symlink），失败返回 null */
function realPath(p) {
  try { return fs.realpathSync(path.resolve(p)); }
  catch { return null; }
}

/**
 * 解析用于安全比较的路径：
 * - 优先 realpath（跟踪 symlink）
 * - 若目标不存在，则回退到“最近存在父目录的 realpath + 剩余子路径”
 */
function resolvePathForCheck(p) {
  const abs = path.resolve(String(p || ""));
  try {
    return fs.realpathSync(abs);
  } catch (err) {
    if (err?.code !== "ENOENT") return null;
    const missingParts = [];
    let cursor = abs;
    while (true) {
      const parent = path.dirname(cursor);
      if (parent === cursor) return abs;
      missingParts.unshift(path.basename(cursor));
      try {
        const realParent = fs.realpathSync(parent);
        return path.join(realParent, ...missingParts);
      } catch (parentErr) {
        if (parentErr?.code !== "ENOENT") return null;
        cursor = parent;
      }
    }
  }
}

/** 判断 target 是否位于 base 内（含相等）；Windows 下做大小写不敏感比较 */
function isPathInside(target, base) {
  const normalize = (v) => {
    const resolved = path.resolve(String(v || ""));
    if (process.platform === "win32") {
      return resolved.replace(/\//g, "\\").toLowerCase();
    }
    return resolved;
  };
  const t = normalize(target);
  const b = normalize(base);
  const baseWithSep = b.endsWith(path.sep) ? b : b + path.sep;
  return t === b || t.startsWith(baseWithSep);
}

/** 安全路径校验：target 必须在 baseDir 内部（解析 symlink 后比较） */
function isInsidePath(target, baseDir) {
  const base = resolvePathForCheck(baseDir);
  if (!base) return false;
  const resolved = resolvePathForCheck(target);
  if (resolved) return isPathInside(resolved, base);
  // 路径不存在（mkdir / rename 目标）：解析父目录 + 保留 basename
  const parentResolved = realPath(path.dirname(target));
  if (!parentResolved) return false;
  const full = path.join(parentResolved, path.basename(target));
  return isPathInside(full, base);
}

/** 校验 dir 覆盖：仅允许 engine 已知的根目录（解析 symlink 后比较） */
function isApprovedDir(dir, engine) {
  const approved = [
    engine.deskCwd,
    engine.homeCwd,
    os.homedir(),
  ].filter(Boolean);
  const resolved = resolvePathForCheck(dir);
  if (!resolved) return false;
  const inApprovedRoots = approved.some(root => {
    const r = resolvePathForCheck(root);
    if (!r) return false;
    return isPathInside(resolved, r);
  });
  if (inApprovedRoots) return true;

  // 兼容欢迎页“打开文件夹”：允许用户显式选择的本地目录，
  // 但仍屏蔽敏感目录（.ssh/.gnupg/.aws/.kube 以及 hanakoHome）。
  // 目录存在：正常放行；
  // 目录不存在：允许“可创建目录”（父目录存在）以兼容首次切换/迁移后的工作区。
  const existing = realPath(dir);
  if (existing) {
    try {
      const stat = fs.statSync(existing);
      if (!stat.isDirectory()) return false;
    } catch {
      return false;
    }
    return !isSensitivePath(existing, engine.hanakoHome);
  }

  const parentResolved = realPath(path.dirname(dir));
  if (!parentResolved) return false;
  return !isSensitivePath(parentResolved, engine.hanakoHome);
}

/** 敏感 dot 目录（不允许 upload 从这些目录复制文件） */
const SENSITIVE_DIRS = [".ssh", ".gnupg", ".aws", ".config/gcloud", ".kube"];

function isSensitivePath(srcPath, hanakoHome) {
  const resolved = realPath(srcPath);
  if (!resolved) return true; // fail-closed
  const home = os.homedir();
  for (const d of SENSITIVE_DIRS) {
    const sensitive = path.join(home, d);
    if (resolved === sensitive || resolved.startsWith(sensitive + path.sep)) return true;
  }
  if (hanakoHome) {
    const realHome = realPath(hanakoHome);
    if (realHome && (resolved === realHome || resolved.startsWith(realHome + path.sep))) return true;
  }
  return false;
}

/** 列出工作空间目录下的文件 */
function listWorkspaceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const fullPath = path.join(dir, e.name);
    try {
      // 使用 stat 跟随符号链接；若是悬空链接/权限错误则跳过该条目，避免整页 500。
      const stat = fs.statSync(fullPath);
      files.push({
        name: e.name,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        isDir: stat.isDirectory(),
      });
    } catch {
      // skip invalid/unreadable entry
    }
  }

  return files.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
}

function isPptFileByPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return ext === ".ppt" || ext === ".pptx";
}

function getPptPreviewSidecarPath(filePath) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return path.join(dir, `.${base}.preview.pdf`);
}

function removeLinkedPptPreviewSidecar(pptPath, dirRoot) {
  try {
    if (!isPptFileByPath(pptPath)) return;
    const sidecar = getPptPreviewSidecarPath(pptPath);
    if (!isInsidePath(sidecar, dirRoot)) return;
    if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true });
  } catch {
    // ignore cleanup failures
  }
}

function moveLinkedPptPreviewSidecar(oldPptPath, newPptPath, dirRoot) {
  try {
    if (!isPptFileByPath(oldPptPath) || !isPptFileByPath(newPptPath)) return;
    const oldSidecar = getPptPreviewSidecarPath(oldPptPath);
    const newSidecar = getPptPreviewSidecarPath(newPptPath);
    if (!isInsidePath(oldSidecar, dirRoot) || !isInsidePath(newSidecar, dirRoot)) return;
    if (!fs.existsSync(oldSidecar)) return;
    if (fs.existsSync(newSidecar)) return;
    fs.renameSync(oldSidecar, newSidecar);
  } catch {
    // ignore cleanup failures
  }
}

function isSessionPathAllowed(sessionPath, engine) {
  const rawInput = String(sessionPath || "").trim();
  if (!rawInput) return false;
  let raw = rawInput;
  try {
    raw = decodeURIComponent(rawInput);
  } catch {
    raw = rawInput;
  }
  if (!raw) return false;
  const resolved = path.resolve(raw);
  const base = path.resolve(engine.agentsDir);
  return isPathInside(resolved, base);
}

function resolveSessionDeskDir(sessionPath, engine) {
  if (!isSessionPathAllowed(sessionPath, engine)) return null;
  const rawInput = String(sessionPath || "").trim();
  let raw = rawInput;
  try {
    raw = decodeURIComponent(rawInput);
  } catch {
    raw = rawInput;
  }
  const resolvedSessionPath = path.resolve(raw);
  const agentId = engine.agentIdFromSessionPath(resolvedSessionPath);
  if (!agentId) return null;
  const sessionDir = path.join(engine.agentsDir, agentId, "sessions");
  if (!isInsidePath(resolvedSessionPath, sessionDir)) return null;
  try {
    const cwd = readSessionMetadata(resolvedSessionPath)?.cwd;
    if (typeof cwd !== "string") return null;
    const trimmed = cwd.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

export default async function deskRoute(app, { engine, hub }) {
  const ACTIVITY_LIST_LIMIT = 50;

  function normalizeNotifyTarget(value, fallback = "local") {
    const v = String(value ?? fallback).toLowerCase();
    return (v === "local" || v === "platform" || v === "auto") ? v : fallback;
  }

  function normalizeNotifyPlatform(value) {
    const v = String(value || "").trim().toLowerCase();
    return (v === "wechat" || v === "telegram" || v === "feishu" || v === "qq") ? v : "";
  }

  function resolveCronTarget(input = {}) {
    const explicitAgentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
    if (explicitAgentId) {
      const agent = engine.getAgent(explicitAgentId);
      if (agent?.cronStore) {
        return { store: agent.cronStore, agentId: explicitAgentId, agentName: agent.agentName || explicitAgentId };
      }
    }

    const sessionPath = typeof input.sessionPath === "string" ? input.sessionPath : "";
    if (sessionPath) {
      const sid = engine.agentIdFromSessionPath(sessionPath);
      if (sid) {
        const agent = engine.getAgent(sid);
        if (agent?.cronStore) {
          return { store: agent.cronStore, agentId: sid, agentName: agent.agentName || sid };
        }
      }
    }

    const fallbackId = engine.currentAgentId;
    const fallbackAgent = engine.getAgent(fallbackId) || engine.agent;
    return {
      store: fallbackAgent?.cronStore || null,
      agentId: fallbackId,
      agentName: fallbackAgent?.agentName || fallbackId,
    };
  }

  function withCronOwner(jobs, agentId, agentName) {
    return (jobs || []).map(job => ({ ...job, agentId, agentName }));
  }

  /** 聚合所有 agent 的 cron 任务（用于前端全量任务计划视图） */
  function listAllCronJobs() {
    const all = [];
    for (const ag of engine.listAgents()) {
      const store = engine.getAgent(ag.id)?.cronStore;
      if (!store) continue;
      const jobs = store.listJobs() || [];
      for (const job of jobs) {
        all.push({
          ...job,
          agentId: ag.id,
          agentName: ag.name || ag.id,
        });
      }
    }
    return all;
  }

  /** 从所有 agent 的 activityStore 中按 ID 查找 entry */
  function findActivityEntry(activityId) {
    for (const ag of engine.listAgents()) {
      const store = engine.getActivityStore(ag.id);
      const entry = store?.get(activityId);
      if (entry) return { entry, agentId: ag.id };
    }
    return { entry: null, agentId: null };
  }

  // ════════════════════════════
  //  助手活动
  // ════════════════════════════

  /** 活动列表（合并所有 agent） */
  app.get("/api/desk/activities", async () => {
    const allActivities = [];
    for (const ag of engine.listAgents()) {
      const store = engine.getActivityStore(ag.id);
      const items = store?.list() || [];
      for (const a of items) {
        allActivities.push({
          ...a,
          agentId: a.agentId || ag.id,
          agentName: a.agentName || ag.name,
        });
      }
    }
    // 按 startedAt 倒序
    allActivities.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return { activities: allActivities.slice(0, ACTIVITY_LIST_LIMIT) };
  });

  /** 读取指定活动的 session 对话消息（只读查看用） */
  app.get("/api/desk/activities/:id/session", async (req) => {
    const { id } = req.params;
    // 从所有 agent 的 activityStore 中查找
    const { entry, agentId: foundAgentId } = findActivityEntry(id);
    if (!entry) return { error: "activity not found" };
    if (!entry.sessionFile) return { error: "no session file" };

    const activityDir = path.join(engine.agentsDir, foundAgentId, "activity");
    const sessionPath = path.join(activityDir, entry.sessionFile);
    if (!fs.existsSync(sessionPath)) return { error: "session file missing" };

    try {
      const raw = fs.readFileSync(sessionPath, "utf-8");
      const lines = raw.trim().split("\n").map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      const messages = [];
      for (const line of lines) {
        if (line.type !== "message") continue;
        const msg = line.message;
        if (!msg) continue;
        if (msg.role !== "user" && msg.role !== "assistant") continue;

        const content = Array.isArray(msg.content)
          ? msg.content.filter(b => b.type === "text" && b.text).map(b => b.text).join("")
          : (typeof msg.content === "string" ? msg.content : "");

        if (!content) continue;
        messages.push({ role: msg.role, content });
      }

      return {
        activity: {
          id: entry.id,
          type: entry.type,
          label: entry.label || null,
          agentId: entry.agentId || foundAgentId,
          agentName: entry.agentName || engine.getAgent(foundAgentId)?.agentName || foundAgentId,
          summary: entry.summary,
          startedAt: entry.startedAt,
          finishedAt: entry.finishedAt,
        },
        messages,
      };
    } catch (err) {
      return { error: err.message };
    }
  });

  /** 将活动 session 提升为正常 session（从 activity/ 移到 sessions/） */
  app.post("/api/desk/activities/:id/promote", async (req) => {
    const { id } = req.params;
    const { entry, agentId: foundAgentId } = findActivityEntry(id);
    if (!entry) return { error: "activity not found" };
    if (!entry.sessionFile) return { error: "no session file" };

    // promote 需要先切到对应 agent（promoteActivitySession 操作当前焦点 agent 的目录）
    if (foundAgentId !== engine.currentAgentId) {
      return { error: t("error.activeSessionOnly") };
    }

    const newPath = engine.promoteActivitySession(entry.sessionFile);
    if (!newPath) return { error: "promote failed" };

    return { ok: true, sessionPath: newPath };
  });

  /** 用小工具模型快速摘要（DevTools 调试用） */
  app.post("/api/desk/activities/summarize", async (req) => {
    const { id } = req.body || {};
    if (!id) return { error: "id required" };
    try {
      const summary = await engine.summarizeActivityQuick(id);
      return { summary: summary || null };
    } catch (err) {
      return { error: err.message };
    }
  });

  /** DevTools 日志（历史） */
  app.get("/api/desk/logs", async () => {
    return { logs: engine.getDevLogs() };
  });

  /** 手动触发心跳巡检（调试用） */
  app.post("/api/desk/heartbeat", async () => {
    const hb = hub?.scheduler?.heartbeat;
    if (!hb) return { error: "Heartbeat not initialized" };
    hb.triggerNow();
    return { ok: true, message: t("error.heartbeatTriggered") };
  });

  // ════════════════════════════
  //  Cron 任务
  // ════════════════════════════

  /** 列出 cron 任务 */
  app.get("/api/desk/cron", async (req) => {
    const allFlagRaw = req.query?.all;
    const all = allFlagRaw === "1" || allFlagRaw === "true" || allFlagRaw === 1 || allFlagRaw === true;
    if (all) {
      return { jobs: listAllCronJobs(), agentId: null, agentName: null };
    }

    const { store, agentId, agentName } = resolveCronTarget(req.query || {});
    if (!store) return { jobs: [], agentId, agentName };
    return {
      jobs: withCronOwner(store.listJobs(), agentId, agentName),
      agentId,
      agentName,
    };
  });

  /** 操作 cron 任务 */
  app.post("/api/desk/cron", async (req) => {
    const { action, ...params } = req.body || {};
    const { store, agentId, agentName } = resolveCronTarget(params || {});
    if (!store) return { error: "Desk not initialized" };

    switch (action) {
      case "add": {
        if (!params.type || !params.schedule || !params.prompt) {
          return { error: "type, schedule, prompt required" };
        }
        const normalizedSchedule = params.type === "every"
          ? normalizeEverySchedule(params.schedule)
          : params.schedule;
        if (params.type === "every" && !normalizedSchedule) {
          return { error: t("error.cronEveryMustBeNumber") };
        }
        const job = store.addJob({
          type: params.type,
          schedule: normalizedSchedule,
          prompt: params.prompt,
          label: params.label,
          model: params.model,
          notifyTarget: normalizeNotifyTarget(params.notifyTarget, "local"),
          notifyPlatform: normalizeNotifyPlatform(params.notifyPlatform),
        });
        return {
          ok: true,
          job: { ...job, agentId, agentName },
          jobs: withCronOwner(store.listJobs(), agentId, agentName),
          agentId,
          agentName,
        };
      }

      case "remove": {
        if (!params.id) return { error: "id required" };
        const ok = store.removeJob(params.id);
        if (!ok) return { error: "not found" };
        return { ok: true, jobs: withCronOwner(store.listJobs(), agentId, agentName), agentId, agentName };
      }

      case "toggle": {
        if (!params.id) return { error: "id required" };
        const job = store.toggleJob(params.id);
        if (!job) return { error: "not found" };
        return {
          ok: true,
          job: { ...job, agentId, agentName },
          jobs: withCronOwner(store.listJobs(), agentId, agentName),
          agentId,
          agentName,
        };
      }

      case "update": {
        if (!params.id) return { error: "id required" };
        const { id, ...fields } = params;
        const current = store.getJob(id);
        if (!current) return { error: "not found" };

        const partial = { ...fields };
        delete partial.agentId;
        delete partial.sessionPath;

        if (partial.type === "every" || (current.type === "every" && partial.schedule !== undefined)) {
          const normalizedSchedule = normalizeEverySchedule(
            partial.schedule !== undefined ? partial.schedule : current.schedule,
          );
          if (!normalizedSchedule) return { error: t("error.cronEveryMustBeNumber") };
          partial.schedule = normalizedSchedule;
        }

        if (partial.notifyTarget !== undefined) {
          partial.notifyTarget = normalizeNotifyTarget(partial.notifyTarget, current.notifyTarget || "local");
        }
        if (partial.notifyPlatform !== undefined) {
          partial.notifyPlatform = normalizeNotifyPlatform(partial.notifyPlatform);
        }

        const job = store.updateJob(id, partial);
        if (!job) return { error: "not found" };
        return {
          ok: true,
          job: { ...job, agentId, agentName },
          jobs: withCronOwner(store.listJobs(), agentId, agentName),
          agentId,
          agentName,
        };
      }

      default:
        return { error: `unknown action: ${action}` };
    }
  });

  // ════════════════════════════
  //  工作空间文件（直接使用 cwd）
  // ════════════════════════════

  /** 工作空间路径 */
  app.get("/api/desk/path", async (req) => {
    const sessionDir = resolveSessionDeskDir(req.query?.sessionPath, engine);
    const dir = req.query.dir ? decodeURIComponent(req.query.dir) : (sessionDir || engine.deskCwd);
    if (!dir) return { path: null };
    if (req.query.dir && !isApprovedDir(dir, engine)) return { error: t("error.dirNotAllowed") };
    fs.mkdirSync(dir, { recursive: true });
    return { path: dir };
  });

  /** 列出工作空间文件（支持 ?subdir=xxx 浏览子目录, ?dir=xxx 覆盖基目录） */
  app.get("/api/desk/files", async (req) => {
    const sessionDir = resolveSessionDeskDir(req.query?.sessionPath, engine);
    const dir = req.query.dir ? decodeURIComponent(req.query.dir) : (sessionDir || engine.deskCwd);
    if (!dir) return { files: [], subdir: "", basePath: null };
    if (req.query.dir && !isApprovedDir(dir, engine)) return { error: t("error.dirNotAllowed") };
    const subdir = req.query.subdir || "";
    // 安全：禁止路径穿越
    if (subdir && (subdir.includes("\\") || subdir.includes("..") || subdir.startsWith("."))) {
      return { error: "invalid subdir" };
    }
    const target = subdir ? path.join(dir, subdir) : dir;
    if (!isInsidePath(target, dir)) return { error: "invalid path" };
    return { files: listWorkspaceFiles(target), subdir: subdir || "", basePath: dir };
  });

  /** 读取指定目录的 jian.md */
  app.get("/api/desk/jian", async (req) => {
    const sessionDir = resolveSessionDeskDir(req.query?.sessionPath, engine);
    const dir = req.query.dir ? decodeURIComponent(req.query.dir) : (sessionDir || engine.deskCwd);
    if (!dir) return { content: null };
    if (req.query.dir && !isApprovedDir(dir, engine)) return { error: t("error.dirNotAllowed") };
    const subdir = req.query.subdir || "";
    if (subdir && (subdir.includes("\\") || subdir.includes("..") || subdir.startsWith("."))) {
      return { error: "invalid subdir" };
    }
    const target = subdir ? path.join(dir, subdir) : dir;
    if (!isInsidePath(target, dir)) return { error: "invalid path" };
    const jianPath = path.join(target, "jian.md");
    if (!fs.existsSync(jianPath)) return { content: null };
    try {
      return { content: fs.readFileSync(jianPath, "utf-8") };
    } catch {
      return { content: null };
    }
  });

  /** 保存指定目录的 jian.md（自动创建 / 内容为空时删除） */
  app.post("/api/desk/jian", async (req) => {
    const sessionDir = resolveSessionDeskDir(req.body?.sessionPath, engine);
    const dir = req.body?.dir ? req.body.dir : (sessionDir || engine.deskCwd);
    if (!dir) return { error: t("error.noWorkspace") };
    if (req.body?.dir && !isApprovedDir(dir, engine)) return { error: t("error.dirNotAllowed") };
    const { subdir, content } = req.body || {};
    const sub = subdir || "";
    if (sub && (sub.includes("\\") || sub.includes("..") || sub.startsWith("."))) {
      return { error: "invalid subdir" };
    }
    const target = sub ? path.join(dir, sub) : dir;
    if (!isInsidePath(target, dir)) return { error: "invalid path" };
    const jianPath = path.join(target, "jian.md");

    try {
      if (content === null || content === undefined || content.trim() === "") {
        // 内容为空 → 删除 jian.md
        if (fs.existsSync(jianPath)) fs.unlinkSync(jianPath);
        return { ok: true, content: null };
      }
      // 确保目录存在
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(jianPath, content, "utf-8");
      return { ok: true, content };
    } catch (err) {
      return { error: err.message };
    }
  });

  /** 工作空间文件操作（支持 subdir + dir override） */
  app.post("/api/desk/files", async (req) => {
    const sessionDir = resolveSessionDeskDir(req.body?.sessionPath, engine);
    const baseDir = req.body?.dir || sessionDir || engine.deskCwd;
    if (!baseDir) return { error: t("error.noWorkspace") };
    if (req.body?.dir && !isApprovedDir(baseDir, engine)) return { error: t("error.dirNotAllowed") };
    fs.mkdirSync(baseDir, { recursive: true });

    const { action, subdir: sub, paths, name, content, oldName, newName } = req.body || {};

    // 解析子目录
    const subdirStr = sub || "";
    if (subdirStr && (subdirStr.includes("\\") || subdirStr.includes("..") || subdirStr.startsWith("."))) {
      return { error: "invalid subdir" };
    }
    const dir = subdirStr ? path.join(baseDir, subdirStr) : baseDir;
    if (!isInsidePath(dir, baseDir)) return { error: "invalid path" };

    switch (action) {
      case "upload": {
        if (!Array.isArray(paths) || paths.length === 0) {
          return { error: "paths required" };
        }
        const results = [];
        for (const srcPath of paths) {
          try {
            if (!path.isAbsolute(srcPath) || !fs.existsSync(srcPath)) {
              results.push({ src: srcPath, error: "invalid path" });
              continue;
            }
            if (isSensitivePath(srcPath, engine.hanakoHome)) {
              results.push({ src: srcPath, error: "sensitive path blocked" });
              continue;
            }
            const fname = path.basename(srcPath);
            const dest = path.join(dir, fname);
            const stat = fs.statSync(srcPath);
            if (stat.isDirectory()) {
              fs.cpSync(srcPath, dest, { recursive: true });
            } else {
              fs.copyFileSync(srcPath, dest);
            }
            results.push({ src: srcPath, name: fname });
          } catch (err) {
            results.push({ src: srcPath, error: err.message });
          }
        }
        return { ok: true, results, files: listWorkspaceFiles(dir) };
      }

      case "create": {
        if (!name || content === undefined) {
          return { error: "name and content required" };
        }
        const createTarget = path.join(dir, path.basename(name));
        if (!isInsidePath(createTarget, dir)) return { error: "invalid name" };
        fs.writeFileSync(createTarget, content, "utf-8");
        return { ok: true, files: listWorkspaceFiles(dir) };
      }

      case "mkdir": {
        if (!name) return { error: "name required" };
        const mkTarget = path.join(dir, path.basename(name));
        if (!isInsidePath(mkTarget, dir)) return { error: "invalid name" };
        if (fs.existsSync(mkTarget)) return { error: "already exists" };
        fs.mkdirSync(mkTarget, { recursive: true });
        return { ok: true, files: listWorkspaceFiles(dir) };
      }

      case "rename": {
        if (!oldName || !newName) return { error: "oldName and newName required" };
        const src = path.join(dir, path.basename(oldName));
        const dest = path.join(dir, path.basename(newName));
        if (!isInsidePath(src, dir) || !isInsidePath(dest, dir)) return { error: "invalid name" };
        if (!fs.existsSync(src)) return { error: "not found" };
        if (fs.existsSync(dest)) return { error: "target already exists" };
        fs.renameSync(src, dest);
        moveLinkedPptPreviewSidecar(src, dest, dir);
        return { ok: true, files: listWorkspaceFiles(dir) };
      }

      case "move": {
        const names = req.body?.names;
        const destFolder = req.body?.destFolder;
        if (!Array.isArray(names) || names.length === 0 || !destFolder) {
          return { error: "names[] and destFolder required" };
        }
        if (names.includes(destFolder)) {
          return { error: "cannot move folder into itself" };
        }
        const destDir = path.join(dir, path.basename(destFolder));
        if (!isInsidePath(destDir, dir)) return { error: "invalid destFolder" };
        if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
          return { error: "destFolder is not a directory" };
        }
        const results = [];
        for (const n of names) {
          const src = path.join(dir, path.basename(n));
          const dest = path.join(destDir, path.basename(n));
          if (!isInsidePath(src, dir)) { results.push({ name: n, error: "invalid name" }); continue; }
          if (!fs.existsSync(src)) { results.push({ name: n, error: "not found" }); continue; }
          if (fs.existsSync(dest)) { results.push({ name: n, error: "target already exists" }); continue; }
          try {
            fs.renameSync(src, dest);
            moveLinkedPptPreviewSidecar(src, dest, dir);
            results.push({ name: n, ok: true });
          } catch (err) {
            results.push({ name: n, error: err.message });
          }
        }
        return { ok: true, results, files: listWorkspaceFiles(dir) };
      }

      case "remove": {
        if (!name) return { error: "name required" };
        const rmTarget = path.join(dir, path.basename(name));
        if (!isInsidePath(rmTarget, dir)) return { error: "invalid name" };
        if (!fs.existsSync(rmTarget)) return { error: "not found" };
        const stat = fs.statSync(rmTarget);
        fs.rmSync(rmTarget, { recursive: true, force: true });
        if (stat.isFile()) {
          removeLinkedPptPreviewSidecar(rmTarget, dir);
        }
        return { ok: true, files: listWorkspaceFiles(dir) };
      }

      default:
        return { error: `unknown action: ${action}` };
    }
  });
}
