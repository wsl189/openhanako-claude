/**
 * AgentExecutor — Agent 会话执行器
 *
 * 基于 Claude Agent SDK 长驻流式 session 执行多轮 prompt，
 * 捕获标记了 capture: true 的轮次输出。
 *
 * ChannelRouter 和 AgentMessenger 共用这个执行器。
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { debugLog } from "../lib/debug-log.js";
import { sanitizeAssistantVisibleText } from "../lib/text/assistant-visible-text.js";
import { t } from "../server/i18n.js";
import { applyRuntimeModelOverrides } from "../core/model-runtime-overrides.js";
import { createSessionMetadata } from "../core/claude-session-store.js";
import { ClaudeSessionRuntime } from "../core/claude-session-runtime.js";
import { buildClaudeRuntimeConfig } from "../core/claude-runtime-config.js";
import { normalizeWorkspacePath } from "../core/path-utils.js";

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

function buildRealtimeDateTimeContext(isZh = false) {
  const now = new Date();
  const dateTime = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
  return isZh
    ? `Current date and time: ${dateTime}\n你的一天从凌晨 4:00 开始。4:00 之前的对话属于前一天。`
    : `Current date and time: ${dateTime}\nYour day starts at 4:00 AM. Conversations before 4:00 AM belong to the previous day.`;
}

function normalizeAnthropicBaseUrlForSdk(url = "") {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(v1\/)?messages$/i, "")
    .replace(/\/v1$/i, "");
}

function isReasoningLikeType(type) {
  const normalized = String(type || "").toLowerCase();
  if (!normalized || normalized === "text") return false;
  return /(reason|think|analysis|commentary|summary)/.test(normalized);
}

function pickBlockText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (typeof block.reasoning === "string") return block.reasoning;
  if (typeof block.thinking === "string") return block.thinking;
  if (typeof block.output_text === "string") return block.output_text;
  return "";
}

function extractVisibleText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let text = "";
    for (const block of content) {
      const part = pickBlockText(block);
      if (!part) continue;
      if (isReasoningLikeType(block?.type)) continue;
      text += part;
    }
    return text;
  }
  if (!content || typeof content !== "object") return "";
  if (typeof content.output_text === "string") return content.output_text;
  const part = pickBlockText(content);
  if (!part) return "";
  if (isReasoningLikeType(content.type)) return "";
  return part;
}

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

    const tagged = line.match(/(?:^|\s)\[(?:附件|attachment)\]\s+(.+)$/i);
    if (tagged?.[1]) {
      const p = tagged[1]
        .trim()
        .replace(/^["'<]|[>"']$/g, "")
        .replace(/[),.;:!?]+$/g, "");
      if (p) candidates.push(p);
      continue;
    }

    const unixHits = line.match(/(\/[^\n]*?\.(?:png|jpe?g|gif|webp|bmp|svg|ico))/ig);
    if (unixHits?.length) {
      for (const hit of unixHits) {
        const p = hit.trim().replace(/^["'<]|[>"']$/g, "").replace(/[),.;:!?]+$/g, "");
        if (p) candidates.push(p);
      }
    }

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

export async function runAgentSession(agentId, rounds, {
  engine,
  signal,
  sessionSuffix = "temp",
  systemAppend,
  keepSession = false,
  noMemory = false,
  noTools = false,
  extractInlineImages = false,
} = {}) {
  const agent = engine.getAgent(agentId);
  if (!agent) {
    throw new Error(t("error.agentExecNotInit", { id: agentId }));
  }
  const agentDir = agent.agentDir;
  const isZh = String(agent?.config?.locale || "").startsWith("zh");

  if (!noMemory) {
    try { agent.refreshSystemPrompt?.(); } catch {}
  }

  const realtimeTimeAppend = noMemory ? buildRealtimeDateTimeContext(isZh) : "";
  const mergedSystemAppend = [systemAppend, realtimeTimeAppend].filter(Boolean).join("\n\n");
  const cwd = normalizeWorkspacePath(
    agent?.config?.desk?.home_folder || engine.getHomeFolder(agentId) || process.cwd(),
    process.cwd(),
  );
  const sessionDir = path.join(agentDir, "sessions", sessionSuffix);
  fs.mkdirSync(sessionDir, { recursive: true });

  const sessionId = randomUUID();
  const { sessionPath } = createSessionMetadata(sessionDir, {
    sessionId,
    cwd,
    agentId,
  });

  const modelRef = agent?.config?.models?.chat || engine.currentModel?.id || engine.currentModel?.name || null;
  let resolvedModelWithCreds = null;
  try {
    if (modelRef && typeof engine.resolveModelWithCredentials === "function") {
      resolvedModelWithCreds = engine.resolveModelWithCredentials(modelRef, agent.config) || null;
    }
  } catch {}

  const runtimeEnv = {
    ...process.env,
  };
  if (resolvedModelWithCreds) {
    runtimeEnv.ANTHROPIC_BASE_URL = resolvedModelWithCreds.api === "anthropic-messages"
      ? (normalizeAnthropicBaseUrlForSdk(resolvedModelWithCreds.base_url) || undefined)
      : (resolvedModelWithCreds.base_url || undefined);
    runtimeEnv.ANTHROPIC_API_KEY = resolvedModelWithCreds.api_key || undefined;
  }

  const model = applyRuntimeModelOverrides(
    resolvedModelWithCreds?.model || engine.createSessionContext().resolveModel(agent.config),
    agent?.config?.models?.overrides,
  );

  let runtime = null;
  const runtimeConfig = buildClaudeRuntimeConfig({
    agent,
    cwd,
    workspace: normalizeWorkspacePath(
      agent?.config?.desk?.home_folder || engine.getHomeFolder(agentId) || cwd,
      cwd,
    ),
    toolProfile: engine.getAgentPermissionConfig?.(agentId) || null,
    customTools: agent.tools,
    noTools,
    noMemory,
    systemAppend: mergedSystemAppend,
    model: model?.id || model?.name,
    env: runtimeEnv,
    createToolContext: () => ({
      sessionManager: runtime?.sessionManager,
    }),
    emitToolEvent: (event) => {
      runtime?._recordToolEvent?.(event);
      runtime?._emit?.(event);
    },
  });

  runtime = new ClaudeSessionRuntime({
    sessionId,
    cwd,
    sessionPath,
    options: runtimeConfig.options,
  });
  await runtime.start();

  let onAbort;
  if (signal) {
    onAbort = () => { runtime.abort().catch(() => {}); };
    signal.addEventListener("abort", onAbort, { once: true });
  }

  let capturedText = "";
  let capturedSnapshotText = "";
  let isCapturing = false;
  const unsub = runtime.subscribe((event) => {
    if (!isCapturing) return;
    if (event?.type === "stream_event") {
      const raw = event.event;
      if (raw?.type === "content_block_delta" && raw?.delta?.type === "text_delta") {
        capturedText += raw.delta.text || "";
      }
      return;
    }
    if (event?.type === "assistant") {
      const snapshot = extractVisibleText(event.message?.content);
      if (snapshot) capturedSnapshotText = snapshot;
      return;
    }
    if (event?.type === "result" && typeof event.result === "string" && event.result.trim()) {
      capturedSnapshotText = event.result.trim();
    }
  });

  debugLog()?.log("agent-executor", `${agentId} Claude session started (${rounds.length} rounds)`);
  const pendingImageKey = sessionPath || `temp-inline-images:${agentId}:${Date.now()}`;
  const throwIfAborted = () => {
    if (!signal?.aborted) return;
    const reason = signal.reason;
    if (reason?.name === "AbortError") throw reason;
    throw new DOMException("Aborted", "AbortError");
  };

  try {
    for (const round of rounds) {
      throwIfAborted();
      isCapturing = !!round.capture;
      if (round.capture) {
        capturedText = "";
        capturedSnapshotText = "";
      }
      const inlineImages = extractInlineImages ? readImagesFromText(round.text, 10) : [];
      const explicitImages = Array.isArray(round.images) ? round.images : [];
      const roundImages = [...explicitImages, ...inlineImages];

      if (roundImages.length) {
        engine.setSessionPendingImages?.(pendingImageKey, roundImages);
      } else {
        engine.clearSessionPendingImages?.(pendingImageKey);
      }

      await runtime.prompt(round.text, roundImages.length ? { images: roundImages } : undefined);
      if (round.capture && capturedSnapshotText) {
        capturedText = capturedSnapshotText;
      }
      throwIfAborted();
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    unsub?.();
    await runtime.close().catch(() => {});
    engine.clearSessionPendingImages?.(pendingImageKey);
  }

  throwIfAborted();

  if (!keepSession) {
    try { fs.unlinkSync(sessionPath); } catch {}
  }

  const text = sanitizeAssistantVisibleText(capturedText);
  debugLog()?.log("agent-executor", `${agentId} done, ${text.length} chars captured`);
  return text;
}
