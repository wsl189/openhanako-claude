/**
 * AgentExecutor — Agent 会话执行器
 *
 * 使用 Engine 中的长驻 Agent 实例（不再创建临时 Agent），
 * 创建临时 session 执行多轮 prompt，捕获标记了 capture: true 的轮次输出。
 *
 * ChannelRouter 和 AgentMessenger 共用这个执行器。
 */

import fs from "fs";
import path from "path";
import { createAgentSession, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { debugLog } from "../lib/debug-log.js";
import { sanitizeAssistantVisibleText } from "../lib/text/assistant-visible-text.js";
import { t } from "../server/i18n.js";

const IMAGE_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function isImagePath(filePath = "") {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return !!IMAGE_MIME_BY_EXT[ext];
}

function extractImagePathsFromText(text = "") {
  const content = String(text || "");
  if (!content) return [];
  const candidates = [];
  const lines = content.split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = String(lineRaw || "").trim();
    if (!line) continue;

    // 匹配频道输入附件标记: [附件] /abs/path/image.png 或 [attachment] ...
    const tagged = line.match(/(?:^|\s)\[(?:附件|attachment)\]\s+(.+)$/i);
    if (tagged?.[1]) {
      const p = tagged[1]
        .trim()
        .replace(/^["'<]|[>"']$/g, "")
        .replace(/[),.;:!?]+$/g, "");
      if (p) candidates.push(p);
      continue;
    }

    // Unix 绝对路径（兼容路径中空格）
    const unixHits = line.match(/(\/[^\n]*?\.(?:png|jpe?g|gif|webp|bmp|svg|ico))/ig);
    if (unixHits?.length) {
      for (const hit of unixHits) {
        const p = hit.trim().replace(/^["'<]|[>"']$/g, "").replace(/[),.;:!?]+$/g, "");
        if (p) candidates.push(p);
      }
    }

    // Windows 绝对路径（例如 C:\Users\...\a.png）
    const winHits = line.match(/([a-z]:\\[^\n]*?\.(?:png|jpe?g|gif|webp|bmp|svg|ico))/ig);
    if (winHits?.length) {
      for (const hit of winHits) {
        const p = hit.trim().replace(/^["'<]|[>"']$/g, "").replace(/[),.;:!?]+$/g, "");
        if (p) candidates.push(p);
      }
    }
  }

  const out = [];
  const seen = new Set();
  for (const p of candidates) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function readImagesFromText(text = "", maxCount = 10) {
  const paths = extractImagePathsFromText(text);
  const images = [];
  for (const p of paths) {
    if (images.length >= maxCount) break;
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) continue;
      if (!isImagePath(p)) continue;
      const ext = path.extname(p).toLowerCase();
      const mimeType = IMAGE_MIME_BY_EXT[ext] || "image/png";
      const data = fs.readFileSync(p).toString("base64");
      if (!data) continue;
      images.push({ type: "image", data, mimeType });
    } catch {
      // ignore unreadable file/path
    }
  }
  return images;
}

/**
 * 以指定 agentId 的身份跑一次临时会话。
 *
 * @param {string} agentId
 * @param {Array<{text: string, capture?: boolean, images?: Array}>} rounds  按序执行的 prompts
 * @param {object} opts
 * @param {import('../core/engine.js').HanaEngine} opts.engine
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.sessionSuffix="temp"]
 * @param {string} [opts.systemAppend] - 追加到 system prompt 末尾
 * @param {boolean} [opts.keepSession=false] - 是否保留 session 文件
 * @param {boolean} [opts.noMemory=false] - 不注入记忆，只用 personality
 * @param {boolean} [opts.noTools=false] - 不注入工具
 * @param {boolean} [opts.readOnly=false] - 只读模式（只保留读取类工具，排除写/编辑/ask_agent/dm 等）
 * @param {boolean} [opts.extractInlineImages=false] - 是否从 round 文本中的附件路径自动读取图片
 * @returns {Promise<string>}  capture 轮的输出（已去掉 MOOD 块）
 */
export async function runAgentSession(agentId, rounds, { engine, signal, sessionSuffix = "temp", systemAppend, keepSession = false, noMemory = false, noTools = false, readOnly = false, extractInlineImages = false } = {}) {
  // 1. 从长驻 Map 获取 Agent 实例
  const agent = engine.getAgent(agentId);
  if (!agent) {
    throw new Error(t("error.agentExecNotInit", { id: agentId }));
  }
  const agentDir = agent.agentDir;

  // 2. 临时 ResourceLoader
  const ctx = engine.createSessionContext();
  const tempResourceLoader = Object.create(ctx.resourceLoader);

  // noMemory 模式：只用 personality（identity + yuan + ishiki），不注入记忆/用户档案等
  const basePrompt = noMemory ? agent.personality : agent.systemPrompt;
  tempResourceLoader.getSystemPrompt = () =>
    systemAppend ? `${basePrompt}\n\n${systemAppend}` : basePrompt;
  tempResourceLoader.getSkills = () => ctx.getSkillsForAgent(agent);

  // 3. 临时 session
  const cwd = agent?.config?.desk?.home_folder || engine.getHomeFolder(agentId) || process.cwd();
  const sessionDir = path.join(agentDir, "sessions", sessionSuffix);
  fs.mkdirSync(sessionDir, { recursive: true });
  const tempSessionMgr = SessionManager.create(cwd, sessionDir);

  // 工具模式：noTools = 无工具，readOnly = 只读工具，默认 = 全部
  let tools, customTools;
  if (noTools) {
    tools = [];
    customTools = [];
  } else {
    const built = ctx.buildTools(cwd, agent.tools, { agentDir, workspace: cwd });
    if (readOnly) {
      // 频道群聊：放开工具白名单，允许使用完整工具集（含 describe_images 等）。
      tools = built.tools;
      customTools = built.customTools;
    } else {
      tools = built.tools;
      customTools = built.customTools;
    }
  }
  const model = ctx.resolveModel(agent.config);
  const contextWindow = model?.contextWindow || 200_000;
  const { session } = await createAgentSession({
    cwd,
    sessionManager: tempSessionMgr,
    settingsManager: SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: Math.max(contextWindow - 100_000, 16384),
        keepRecentTokens: 20_000,
      },
    }),
    authStorage: ctx.authStorage,
    modelRegistry: ctx.modelRegistry,
    model,
    thinkingLevel: "medium",
    resourceLoader: tempResourceLoader,
    tools,
    customTools,
  });

  // 4. AbortSignal 连接
  let onAbort;
  if (signal) {
    onAbort = () => { try { session.abort(); } catch {} };
    signal.addEventListener("abort", onAbort, { once: true });
  }

  // 5. 文本捕获
  let capturedText = "";
  let isCapturing = false;
  const unsub = session.subscribe((event) => {
    if (!isCapturing) return;
    if (event.type === "message_update") {
      const sub = event.assistantMessageEvent;
      if (sub?.type === "text_delta") capturedText += sub.delta || "";
    }
  });

  debugLog()?.log("agent-executor", `${agentId} session started (${rounds.length} rounds)`);
  const tempSessionPath = session.sessionManager?.getSessionFile?.() || null;
  const pendingImageKey = tempSessionPath || `temp-inline-images:${agentId}:${Date.now()}`;

  try {
    for (const round of rounds) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      isCapturing = !!round.capture;
      if (round.capture) capturedText = "";
      const inlineImages = extractInlineImages ? readImagesFromText(round.text, 10) : [];
      const explicitImages = Array.isArray(round.images) ? round.images : [];
      const roundImages = [...explicitImages, ...inlineImages];

      if (roundImages.length) {
        engine.setSessionPendingImages?.(pendingImageKey, roundImages);
      } else {
        engine.clearSessionPendingImages?.(pendingImageKey);
      }

      const promptOpts = roundImages.length ? { images: roundImages } : undefined;
      await session.prompt(round.text, promptOpts);
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    unsub?.();
    engine.clearSessionPendingImages?.(pendingImageKey);
  }

  // 6. 清理临时 session 文件（keepSession=true 时保留，供 DM 等场景存档）
  if (!keepSession) {
    const sessionPath = session.sessionManager?.getSessionFile?.();
    if (sessionPath) {
      try { fs.unlinkSync(sessionPath); } catch {}
    }
  }

  // 7. 清理内省/包裹标签，保证返回可见正文
  const text = sanitizeAssistantVisibleText(capturedText);

  debugLog()?.log("agent-executor", `${agentId} done, ${text.length} chars captured`);
  return text;
}
