/**
 * BridgeSessionManager — Bridge（外部平台）session 管理
 *
 * 负责 bridge session 索引读写、外部消息执行、消息注入。
 * 使用 Claude Agent SDK runtime + Hanako session metadata。
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { debugLog } from "../lib/debug-log.js";
import { t, getLocale } from "../server/i18n.js";
import { applyRuntimeModelOverrides } from "./model-runtime-overrides.js";
import { buildClaudeRuntimeConfig } from "./claude-runtime-config.js";
import { ClaudeSessionRuntime } from "./claude-session-runtime.js";
import {
  createSessionMetadata,
  patchSessionMetadata,
  readSessionMetadata,
} from "./claude-session-store.js";
import { extractTextFromContent, resolveClaudeTranscriptPath } from "./claude-transcript.js";

function nowIso() {
  return new Date().toISOString();
}

function getSteerPrefix() {
  const isZh = getLocale().startsWith("zh");
  return isZh ? "（插话）\n" : "(Interjection)\n";
}

function normalizeAnthropicBaseUrlForSdk(url = "") {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(v1\/)?messages$/i, "")
    .replace(/\/v1$/i, "");
}

function extractAssistantTextFromSdkMessage(message) {
  return extractTextFromContent(message?.message?.content || []);
}

function buildBridgeAssistantTranscriptEntry({ metadata, text, parentUuid = null }) {
  return {
    parentUuid,
    isSidechain: false,
    userType: "external",
    cwd: metadata.cwd,
    sessionId: metadata.sessionId,
    version: "hanako-claude-sdk",
    gitBranch: metadata.gitBranch || "HEAD",
    type: "assistant",
    message: {
      id: `bridge_inject_${Date.now().toString(36)}`,
      type: "message",
      role: "assistant",
      model: "hanako-bridge",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    uuid: randomUUID(),
    timestamp: nowIso(),
  };
}

export class BridgeSessionManager {
  /**
   * @param {object} deps
   */
  constructor(deps) {
    this._deps = deps;
    this._activeSessions = new Map();
  }

  get activeSessions() { return this._activeSessions; }

  isSessionStreaming(sessionKey) {
    return this._activeSessions.get(sessionKey)?.isStreaming ?? false;
  }

  async abortSession(sessionKey) {
    const session = this._activeSessions.get(sessionKey);
    if (!session?.isStreaming) return false;
    await session.abort();
    return true;
  }

  async resetSession(sessionKey, opts = {}) {
    const agent = this._resolveAgent(opts.agentId);
    const active = this._activeSessions.get(sessionKey);
    if (active?.isStreaming) {
      try { await active.abort(); } catch {}
    }
    this._activeSessions.delete(sessionKey);

    const index = this.readIndex(agent);
    const raw = index[sessionKey];
    if (!raw) return false;

    const entry = typeof raw === "string" ? {} : { ...raw };
    const existingFile = typeof raw === "string" ? raw : raw?.file || null;
    if (existingFile) {
      const metaPath = path.join(agent.sessionDir, "bridge", existingFile);
      try { fs.unlinkSync(metaPath); } catch {}
    }
    delete entry.file;
    index[sessionKey] = entry;
    this.writeIndex(index, agent);
    return true;
  }

  _indexPath(agent) {
    const a = agent || this._deps.getAgent();
    return path.join(a.sessionDir, "bridge", "bridge-sessions.json");
  }

  reconcile() {
    const index = this.readIndex();
    const bridgeDir = path.join(this._deps.getAgent().sessionDir, "bridge");
    let cleaned = 0;

    for (const [sessionKey, raw] of Object.entries(index)) {
      const entry = typeof raw === "string" ? { file: raw } : raw;
      if (!entry.file) continue;
      const fp = path.join(bridgeDir, entry.file);
      if (!fs.existsSync(fp)) {
        delete entry.file;
        index[sessionKey] = entry;
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.writeIndex(index);
      debugLog()?.log("bridge", `reconcile: cleaned ${cleaned} orphan session refs`);
    }
  }

  readIndex(agent) {
    try {
      return JSON.parse(fs.readFileSync(this._indexPath(agent), "utf-8"));
    } catch {
      return {};
    }
  }

  writeIndex(index, agent) {
    const dir = path.dirname(this._indexPath(agent));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this._indexPath(agent), JSON.stringify(index, null, 2) + "\n", "utf-8");
  }

  _resolveAgent(agentId) {
    const fallback = this._deps.getAgent();
    if (!agentId || !this._deps.getAgentById) return fallback;
    try {
      return this._deps.getAgentById(agentId) || fallback;
    } catch (err) {
      debugLog()?.error("bridge-session", `getAgentById failed (${agentId}): ${err.message}`);
      return fallback;
    }
  }

  _resolveBridgeModel(mm, agent) {
    const preferredId = agent?.config?.models?.chat || "";
    if (!preferredId) {
      if (mm.defaultModel) return mm.defaultModel;
      throw new Error(t("error.bridgeAgentNoChatModel", { name: agent.agentName }));
    }
    const preferred = mm.availableModels.find((m) => m.id === preferredId);
    if (preferred) return preferred;
    if (mm.defaultModel) return mm.defaultModel;
    throw new Error(t("error.bridgeAgentModelNotAvailable", { name: agent.agentName, model: preferredId }));
  }

  _resolveBridgeMetadata({ agent, sessionKey, meta }) {
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const subDir = "owner";
    const sessionDir = path.join(bridgeDir, subDir);
    fs.mkdirSync(sessionDir, { recursive: true });

    const index = this.readIndex(agent);
    const raw = index[sessionKey];
    const existingFile = typeof raw === "string" ? raw : raw?.file || null;
    const existingPath = existingFile ? path.join(bridgeDir, existingFile) : null;

    if (existingPath && fs.existsSync(existingPath)) {
      const metadata = patchSessionMetadata(existingPath, {
        bridge: meta || raw?.bridge || null,
      });
      return { sessionPath: existingPath, metadata, index, existingFile, bridgeDir, subDir };
    }

    const homeCwd = agent?.config?.desk?.home_folder || this._deps.getHomeCwd() || process.cwd();
    const created = createSessionMetadata(sessionDir, {
      sessionId: randomUUID(),
      cwd: homeCwd,
      agentId: agent?.id || path.basename(agent?.agentDir || ""),
      memoryEnabled: true,
      bridge: meta || null,
    });
    return {
      sessionPath: created.sessionPath,
      metadata: created.metadata,
      index,
      existingFile: null,
      bridgeDir,
      subDir,
    };
  }

  _buildRuntimeEnv(mm, agent, modelRef) {
    const resolved = mm.resolveModelWithCredentials(modelRef, agent?.config);
    return {
      model: resolved.model,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: resolved.api === "anthropic-messages"
          ? (normalizeAnthropicBaseUrlForSdk(resolved.base_url) || undefined)
          : (resolved.base_url || undefined),
        ANTHROPIC_API_KEY: resolved.api_key || undefined,
        ANTHROPIC_AUTH_TOKEN: resolved.auth_token || undefined,
      },
    };
  }

  async executeExternalMessage(prompt, sessionKey, meta, opts = {}) {
    const agent = this._resolveAgent(opts.agentId);
    const mm = this._deps.getModelManager();
    const mediaInstruction = "你当前处于外部平台会话，支持发送媒体文件。不要声称“平台不支持发送图片/文件”。\n当用户请求查看/接收图片或文件，或你已经生成了可交付媒体（图片、视频、音频、文档）时，输出媒体指令。\n仅在用户明确说“不要发送/先别发”时，不要输出 MEDIA: 或 <media> 标签。\n如果用户只是询问文件信息、列举路径、确认存在性，也不要输出媒体指令。\n当你确实需要发送媒体文件时，在回复中单独一行写 MEDIA:<source>。\nsource 只能是 http(s) URL、file:// 绝对路径、或本地绝对路径。\n路径里如果有空格，请用 <...> 包裹。\n禁止使用 present_files / dm / message_agent 来给用户传图或传文件。";

    try {
      const { sessionPath, metadata, index, existingFile, bridgeDir, subDir } = this._resolveBridgeMetadata({
        agent,
        sessionKey,
        meta,
      });

      const homeCwd = agent?.config?.desk?.home_folder || this._deps.getHomeCwd() || process.cwd();
      const bridgeCwd = metadata.cwd || homeCwd;
      const model = applyRuntimeModelOverrides(
        this._resolveBridgeModel(mm, agent),
        agent?.config?.models?.overrides,
      );
      const runtimeEnv = this._buildRuntimeEnv(mm, agent, model);
      const toolProfile = this._deps.getAgentPermissionConfig?.(
        agent?.id || path.basename(agent?.agentDir || ""),
      ) || null;

      try {
        agent.refreshSystemPrompt?.();
      } catch (err) {
        debugLog()?.error("bridge-session", `refresh system prompt failed: ${err.message}`);
      }

      let runtime = null;
      const runtimeConfig = buildClaudeRuntimeConfig({
        agent,
        cwd: bridgeCwd,
        workspace: homeCwd,
        toolProfile,
        customTools: agent?.tools || [],
        model: runtimeEnv.model,
        env: runtimeEnv.env,
        systemAppend: mediaInstruction,
        createToolContext: () => ({
          sessionManager: runtime?.sessionManager,
        }),
        emitToolEvent: (event) => {
          runtime?._recordToolEvent?.(event);
          runtime?._emit?.(event);
        },
      });

      runtime = new ClaudeSessionRuntime({
        sessionId: metadata.sessionId,
        resumeSessionId: existingFile ? metadata.sessionId : null,
        cwd: bridgeCwd,
        sessionPath,
        options: runtimeConfig.options,
      });
      await runtime.start();
      this._activeSessions.set(sessionKey, runtime);

      if (opts.images?.length) {
        this._deps.setSessionPendingImages?.(sessionPath, opts.images);
      } else {
        this._deps.clearSessionPendingImages?.(sessionPath);
      }

      let capturedText = "";
      const unsub = runtime.subscribe((event) => {
        if (event?.type === "stream_event") {
          const raw = event.event;
          if (raw?.type === "content_block_delta" && raw?.delta?.type === "text_delta") {
            const delta = raw.delta.text || "";
            capturedText += delta;
            try { opts.onDelta?.(delta, capturedText); } catch {}
          }
        } else if (event?.type === "assistant") {
          const finalText = extractAssistantTextFromSdkMessage(event);
          if (finalText) capturedText = finalText;
        } else if (event?.type === "result" && typeof event.result === "string" && event.result.trim()) {
          capturedText = event.result.trim();
        }
      });

      try {
        const promptOpts = opts.images?.length ? { images: opts.images } : undefined;
        await runtime.prompt(prompt, promptOpts);
      } finally {
        unsub?.();
        this._activeSessions.delete(sessionKey);
        try { await runtime.close(); } catch {}
      }

      const fileName = `${subDir}/${path.basename(sessionPath)}`;
      const entry = typeof index[sessionKey] === "string"
        ? { file: index[sessionKey] }
        : { ...(index[sessionKey] || {}) };
      entry.file = fileName;
      if (meta && typeof meta === "object") Object.assign(entry, meta);
      index[sessionKey] = entry;
      this.writeIndex(index, agent);
      patchSessionMetadata(sessionPath, { bridge: meta || entry.bridge || null });

      return capturedText.trim() || null;
    } catch (err) {
      console.error(`[bridge-session] external message failed (${sessionKey}):`, err.message);
      return null;
    }
  }

  steerSession(sessionKey, text) {
    const session = this._activeSessions.get(sessionKey);
    if (!session?.isStreaming) return false;
    return session.steer(getSteerPrefix() + text);
  }

  injectMessage(sessionKey, text) {
    try {
      const index = this.readIndex();
      const raw = index[sessionKey];
      const existingFile = typeof raw === "string" ? raw : raw?.file || null;
      if (!existingFile) return false;

      const bridgeDir = path.join(this._deps.getAgent().sessionDir, "bridge");
      const sessionPath = path.join(bridgeDir, existingFile);
      if (!fs.existsSync(sessionPath)) return false;

      const metadata = readSessionMetadata(sessionPath);
      const transcriptPath = resolveClaudeTranscriptPath(metadata.sessionId, metadata.cwd);
      if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;

      const rawTranscript = fs.readFileSync(transcriptPath, "utf-8");
      const lines = rawTranscript.split(/\r?\n/).filter(Boolean);
      let parentUuid = null;
      if (lines.length > 0) {
        try {
          parentUuid = JSON.parse(lines.at(-1))?.uuid || null;
        } catch {
          parentUuid = null;
        }
      }

      const entry = buildBridgeAssistantTranscriptEntry({ metadata, text, parentUuid });
      fs.appendFileSync(transcriptPath, JSON.stringify(entry) + "\n", "utf-8");
      debugLog()?.log("bridge-session", `injected message to ${sessionKey} (${text.length} chars)`);
      return true;
    } catch (err) {
      console.error(`[bridge-session] injectMessage failed: ${err.message}`);
      return false;
    }
  }
}
