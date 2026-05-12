/**
 * bridge-manager.js — 外部平台接入管理器
 *
 * 统一管理 Telegram / 飞书等外部消息平台的生命周期。
 * 每个平台一个 adapter，共享 engine 的 _executeExternalMessage()。
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { createRequire } from "module";
import { decode as decodeSilk, isSilk as isSilkFile } from "silk-wasm";
import { debugLog } from "../debug-log.js";
import { normalizeModelRef } from "../../core/model-ref.js";
import { buildProviderAuthHeaders } from "../llm/provider-client.js";
import { createTelegramAdapter } from "./telegram-adapter.js";
import { createFeishuAdapter } from "./feishu-adapter.js";
import { createQQAdapter } from "./qq-adapter.js";
import { createWechatAdapter } from "./wechat-adapter.js";
import { downloadMedia, bufferToBase64, detectMime, splitMediaFromOutput, formatSize, setMediaLocalRoots } from "./media-utils.js";
import {
  parseSessionKey,
  parsePlatformKey,
  buildPlatformKey,
  buildSessionKey,
  normalizeBridgeBots,
} from "./session-key.js";

const require = createRequire(import.meta.url);
let _ffmpegInstallerPath = undefined;

// ── Adapter Registry ─────────────────────────────────────
// 每个平台注册：create 工厂、凭证提取。
// 新增平台只需在此注册 + 提供 adapter 文件。
const ADAPTER_REGISTRY = {
  telegram: {
    create: (creds, onMessage, hooks) => createTelegramAdapter({ token: creds.token, onMessage, onStatus: hooks?.onStatus }),
    getCredentials: (cfg) => cfg?.enabled && cfg?.token ? { token: cfg.token } : null,
  },
  feishu: {
    create: (creds, onMessage, hooks) => createFeishuAdapter({ appId: creds.appId, appSecret: creds.appSecret, onMessage, onStatus: hooks?.onStatus }),
    getCredentials: (cfg) => cfg?.enabled && cfg?.appId && cfg?.appSecret ? { appId: cfg.appId, appSecret: cfg.appSecret } : null,
  },
  qq: {
    create: (creds, onMessage, hooks) => createQQAdapter({
      appID: creds.appID, appSecret: creds.appSecret, onMessage,
      dmGuildMap: creds.dmGuildMap,
      onDmGuildDiscovered: hooks?.onQqDmGuild,
      onStatus: hooks?.onStatus,
    }),
    getCredentials: (cfg) => {
      const secret = cfg?.appSecret || cfg?.token; // 兼容旧版 token 字段
      return cfg?.enabled && cfg?.appID && secret
        ? { appID: cfg.appID, appSecret: secret, dmGuildMap: cfg.dmGuildMap }
        : null;
    },
  },
  wechat: {
    create: (creds, onMessage, hooks) => createWechatAdapter({
      botToken: creds.botToken,
      hanaHome: creds.hanaHome,
      onMessage,
      onStatus: hooks?.onStatus,
    }),
    getCredentials: (cfg) => cfg?.enabled && cfg?.botToken ? { botToken: cfg.botToken, hanaHome: cfg._hanaHome || "" } : null,
  },
};

/* ── StreamCleaner ─────────────────────────────────────────
 * 增量剥离桥接层控制标签（如 <tool_code>/<replying>）。
 * 两态状态机（NORMAL / IN_TAG），支持标签跨 delta。
 */
const STRIP_TAGS = ["tool_code", "replying"];
const MEDIA_CUT_RE = /^(.*?\.(?:png|jpe?g|gif|webp|bmp|svg|pdf|mp4|mov|mkv|avi|mp3|wav|ogg|m4a|opus|amr|silk|zip|rar|7z|docx?|xlsx?|pptx?|txt|md|json))(?=\s|$)/i;
const BRIDGE_TRANSCRIBE_MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const BRIDGE_TRANSCRIBE_TIMEOUT_MS = 45_000;
const AUDIO_FORMATS_SUPPORTED_BY_OPENAI_COMPAT = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp4",
  "audio/mpga",
  "audio/m4a",
  "audio/ogg",
  "audio/webm",
  "audio/opus",
  "audio/flac",
]);
const AUDIO_MIME_BY_EXT = {
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  opus: "audio/opus",
  amr: "audio/amr",
  silk: "audio/silk",
  aac: "audio/aac",
  flac: "audio/flac",
  webm: "audio/webm",
  weba: "audio/webm",
};
const AUDIO_EXT_BY_MIME = {
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/opus": "opus",
  "audio/amr": "amr",
  "audio/3gpp": "amr",
  "audio/silk": "silk",
  "audio/flac": "flac",
  "audio/webm": "webm",
};
const SILK_SAMPLE_RATE_CANDIDATES = [24000, 16000, 12000, 8000, 32000, 44100, 48000];

function extractMediaSourceFromLine(line) {
  const trimmed = String(line || "").trim();
  let source = null;

  // 协议 1：MEDIA:<source>
  const m = /^MEDIA:\s*(.+?)\s*$/.exec(trimmed);
  if (m) source = m[1].trim();

  // 协议 2：<media>source</media>（兼容历史输出格式）
  if (source === null) {
    const tag = /^<media>\s*([\s\S]*?)\s*<\/media>\s*$/i.exec(trimmed);
    if (tag) source = tag[1].trim();
  }

  if (source === null) return null;
  if (!source) return "";

  if (source.startsWith("<") && source.endsWith(">")) {
    source = source.slice(1, -1).trim();
  } else {
    const qm = /^(['"])([\s\S]*?)\1$/.exec(source);
    if (qm) source = qm[2].trim();
  }

  // 容错：同一行里混入描述文本时，尽量截到文件扩展名
  if ((source.startsWith("/") || source.startsWith("file://") || source.startsWith("http://") || source.startsWith("https://")) && !/\.(?:png|jpe?g|gif|webp|bmp|svg|pdf|mp4|mov|mkv|avi|mp3|wav|ogg|m4a|opus|amr|silk|zip|rar|7z|docx?|xlsx?|pptx?|txt|md|json)$/i.test(source)) {
    const cut = source.match(MEDIA_CUT_RE);
    if (cut?.[1]) source = cut[1].trim();
  }

  return source;
}

function extractMediaSourcesFromBlock(blockText) {
  const sources = [];
  const seen = new Set();
  const lines = String(blockText || "").split(/\r?\n/);

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;

    let source = null;
    const parsed = extractMediaSourceFromLine(line);
    if (parsed !== null) {
      source = parsed;
    } else {
      source = line;
      if (source.startsWith("<") && source.endsWith(">")) {
        source = source.slice(1, -1).trim();
      }
    }

    if (!source) continue;
    const isHttp = source.startsWith("http://") || source.startsWith("https://");
    const isFile = source.startsWith("file://") || source.startsWith("/");
    if (!isHttp && !isFile) continue;
    if (seen.has(source)) continue;
    seen.add(source);
    sources.push(source);
  }

  return sources;
}

class StreamCleaner {
  constructor() {
    this._buf = "";
    this._inTag = false;
    this._tagName = null;
    this.cleaned = "";
    /** 流式过程中提取到的媒体 URL */
    this.extractedMedia = [];
    this._inCodeFence = false;
    /** 媒体拦截的行缓冲（处理 delta 分片边界） */
    this._lineBuf = "";
    this._inMediaTag = false;
    this._mediaTagLines = [];
  }

  /** 喂入 delta，返回可发送的干净文本增量（可能为空） */
  feed(delta) {
    this._buf += delta;
    let out = "";

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this._inTag) {
        const close = `</${this._tagName}>`;
        const ci = this._buf.indexOf(close);
        if (ci === -1) break; // 等待更多数据
        this._buf = this._buf.slice(ci + close.length).replace(/^\s*/, "");
        this._inTag = false;
        this._tagName = null;
      } else {
        // 寻找最近的开标签
        let best = null;
        let bestIdx = Infinity;
        for (const tag of STRIP_TAGS) {
          const open = `<${tag}>`;
          const idx = this._buf.indexOf(open);
          if (idx !== -1 && idx < bestIdx) { bestIdx = idx; best = tag; }
        }

        if (best) {
          out += this._buf.slice(0, bestIdx);
          this._buf = this._buf.slice(bestIdx + `<${best}>`.length);
          this._inTag = true;
          this._tagName = best;
        } else {
          // 保留可能的不完整开标签（如 "<moo"）
          let hold = 0;
          for (const tag of STRIP_TAGS) {
            const open = `<${tag}>`;
            for (let len = 1; len < open.length; len++) {
              if (this._buf.endsWith(open.slice(0, len)) && len > hold) hold = len;
            }
          }
          out += this._buf.slice(0, this._buf.length - hold);
          this._buf = this._buf.slice(this._buf.length - hold);
          break;
        }
      }
    }

    // ── 媒体拦截：从 out 中剥离 MEDIA: 和 ![](url) ──
    out = this._interceptMedia(out);

    this.cleaned += out;
    return out;
  }

  /**
   * 从文本增量中拦截媒体标记，返回剥离后的干净文本。
   * 使用行缓冲处理 delta 分片边界（如 "MED" + "IA:https://..."）。
   * 只有遇到换行时才处理完整行，未完成的行 hold 在 _lineBuf 中。
   */
  _interceptMedia(text) {
    if (!text) return text;

    // 把新文本追加到行缓冲
    this._lineBuf += text;

    // 按换行拆分：最后一段如果没有换行，留在 _lineBuf 等下一个 delta
    const parts = this._lineBuf.split("\n");
    this._lineBuf = parts.pop(); // 最后一段（可能不完整）留着

    const cleaned = [];
    for (const line of parts) {
      const processed = this._processLine(line);
      if (processed !== null) cleaned.push(processed);
    }

    return cleaned.length ? cleaned.join("\n") + "\n" : "";
  }

  /** 处理一行完整文本，返回 null 表示该行被媒体拦截移除 */
  _processLine(line) {
    const trimmed = line.trim();
    // 追踪 code fence 状态
    if (trimmed.startsWith("```")) {
      this._inCodeFence = !this._inCodeFence;
      return line;
    }
    if (this._inCodeFence) return line;

    // 兼容多行 <media> ... </media> 标签块
    if (this._inMediaTag) {
      const closeIdx = trimmed.toLowerCase().indexOf("</media>");
      if (closeIdx !== -1) {
        this._mediaTagLines.push(trimmed.slice(0, closeIdx));
        const blockText = this._mediaTagLines.join("\n").trim();
        this._mediaTagLines = [];
        this._inMediaTag = false;
        const sources = extractMediaSourcesFromBlock(blockText);
        if (sources.length) {
          this.extractedMedia.push(...sources);
        }
      } else {
        this._mediaTagLines.push(trimmed);
      }
      return null;
    }

    if (/^<media>/i.test(trimmed)) {
      const afterOpen = trimmed.slice("<media>".length);
      const closeIdx = afterOpen.toLowerCase().indexOf("</media>");
      if (closeIdx !== -1) {
        const blockText = afterOpen.slice(0, closeIdx).trim();
        const sources = extractMediaSourcesFromBlock(blockText);
        if (sources.length) {
          this.extractedMedia.push(...sources);
        }
      } else {
        this._inMediaTag = true;
        this._mediaTagLines = [afterOpen];
      }
      return null;
    }

    // MEDIA:<source> 指令行（支持 URL 和本地路径）
    const source = extractMediaSourceFromLine(trimmed);
    if (source !== null) {
      // 接受 http(s) URL、file:// URI、绝对路径
      const isHttp = source.startsWith("http://") || source.startsWith("https://");
      const isFile = source.startsWith("file://") || source.startsWith("/");
      if (isHttp || isFile) {
        this.extractedMedia.push(source);
      }
      return null; // 无论是否有效都从输出中移除（不泄漏路径）
    }

    // ![alt](url) — 整行是图片标记时拦截
    const imgMatch = /^!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)\s*$/.exec(trimmed);
    if (imgMatch) {
      this.extractedMedia.push(imgMatch[1]);
      return null;
    }

    return line;
  }

  /** 流结束时 flush 行缓冲中剩余的不完整行 */
  flushLineBuf() {
    if (this._inMediaTag) {
      const recovered = [`<media>${this._mediaTagLines.join("\n")}`];
      if (this._lineBuf) recovered.push(this._lineBuf);
      this._inMediaTag = false;
      this._mediaTagLines = [];
      this._lineBuf = "";
      return recovered.join("\n").trim();
    }

    if (!this._lineBuf) return "";
    const line = this._lineBuf;
    this._lineBuf = "";
    const processed = this._processLine(line);
    return processed !== null ? processed : "";
  }
}

/* ── BlockChunker ─────────────────────────────────────────
 * 将流式文本按行拆成多条消息（block streaming）。
 *
 * 规则：换行即分块，但 markdown 结构内不拆。
 *   普通行 + \n → flush 为一条气泡
 *   列表 / 代码围栏 / 表格 / 引用 → 积累为一整块
 *   标题（# ）→ 开启「节模式」，节内所有内容攒成一个气泡，
 *              下一个标题触发 flush 并开启新节
 *   结构块结束后恢复逐行发送
 */
class BlockChunker {
  /**
   * @param {object} opts
   * @param {(text: string) => Promise<void>} opts.onFlush  发送一条消息
   * @param {number} [opts.maxChars=2000]  安全上限：无换行时强制 flush
   */
  constructor({ onFlush, maxChars = 2000 }) {
    this._onFlush = onFlush;
    this._maxChars = maxChars;
    this._buf = "";
    this._flushing = Promise.resolve();
    this._inCodeFence = false;
    this._structured = false;
    this._inSection = false;
    this._currentLine = "";
  }

  /** 喂入清理后的文本增量 */
  feed(text) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      this._buf += ch;
      this._currentLine += ch;
      if (ch === '\n') {
        this._onLineEnd(this._currentLine);
        this._currentLine = "";
      }
    }
    // 安全：无换行的超长文本强制 flush
    if (this._buf.length >= this._maxChars && !this._inCodeFence) {
      this._flushBuf();
    }
  }

  /** 流结束：flush 剩余 buffer */
  async finish() {
    await this._flushing;
    const rest = this._buf.trim();
    if (rest) {
      await this._onFlush(rest);
      this._buf = "";
    }
    this._currentLine = "";
  }

  _onLineEnd(line) {
    const stripped = line.replace(/\n$/, '');
    const trimmed = stripped.trim();
    const isEmpty = trimmed === '';

    // ── 代码围栏 ──
    if (trimmed.startsWith('```')) {
      if (this._inCodeFence) {
        // 关闭围栏：flush 整个代码块（含 ``` 行）
        this._inCodeFence = false;
        this._flushBuf();
      } else {
        // 打开围栏：先 flush 围栏前的内容
        this._inCodeFence = true;
        const cutAt = this._buf.length - line.length;
        if (cutAt > 0) this._flushAt(cutAt);
      }
      return;
    }
    if (this._inCodeFence) return;

    // ── 标题：开启/切换节 ──
    const isHeading = /^#{1,6} /.test(trimmed);
    if (isHeading) {
      // flush 标题前的内容（上一节 / 普通行 / 结构块）
      const cutAt = this._buf.length - line.length;
      if (cutAt > 0) this._flushAt(cutAt);
      this._inSection = true;
      this._sectionHasContent = false;
      this._structured = false;
      return;
    }

    // ── 节内：积累，有内容后遇段落空行才 flush ──
    if (this._inSection) {
      if (!isEmpty) this._sectionHasContent = true;
      if (isEmpty && this._sectionHasContent && this._buf.slice(0, -1).endsWith('\n')) {
        this._flushBuf();
        this._inSection = false;
      }
      return;
    }

    // ── 结构化内容（列表 / 表格 / 引用）──
    const isList = /^[ \t]*[-*+] /.test(stripped) || /^[ \t]*\d+[.)]\s/.test(stripped);
    const isTable = /^[ \t]*\|.*\|/.test(stripped);
    const isBlockquote = /^[ \t]*>/.test(stripped);
    const isStructured = isList || isTable || isBlockquote;

    if (isStructured) {
      this._structured = true;
      return;
    }
    if (this._structured && isEmpty) return; // 结构块内空行

    if (this._structured) {
      // 结构块结束：flush 结构内容，当前行留在 buf
      this._structured = false;
      const cutAt = this._buf.length - line.length;
      if (cutAt > 0) this._flushAt(cutAt);
      // fall through：当前行按普通行处理
    }

    // ── 普通行：非空则 flush ──
    if (!isEmpty && this._buf.trim()) {
      this._flushBuf();
    }
  }

  /** flush 整个 buf */
  _flushBuf() {
    const content = this._buf.trim();
    this._buf = "";
    if (content) {
      this._flushing = this._flushing.then(() => this._onFlush(content));
    }
  }

  /** flush buf 前 cutAt 个字符，保留剩余 */
  _flushAt(cutAt) {
    const content = this._buf.slice(0, cutAt).trim();
    this._buf = this._buf.slice(cutAt);
    if (content) {
      this._flushing = this._flushing.then(() => this._onFlush(content));
    }
  }
}

/** 生成紧凑时间标记：[MM-DD HH:mm] */
function timeTag(ts = Date.now()) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `[${mm}-${dd} ${hh}:${mi}]`;
}

function stripTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

function isLocalBaseUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(String(url || ""));
}

function isOpenAICompatibleApi(api) {
  return api === "openai-completions"
    || api === "openai-responses"
    || api === "openai-codex-responses";
}

function parseErrorMessage(data, fallback) {
  return String(
    data?.error?.message
      || data?.error
      || data?.message
      || fallback,
  ).trim();
}

function normalizeAudioExt(pathLike = "") {
  const raw = String(pathLike || "").trim();
  if (!raw) return "";
  const clean = raw.split(/[?#]/)[0];
  const name = clean.split("/").pop() || clean;
  const m = /\.([a-zA-Z0-9]{1,12})$/.exec(name);
  return m?.[1]?.toLowerCase() || "";
}

function inferAudioMimeFromPath(pathLike = "") {
  const ext = normalizeAudioExt(pathLike);
  return AUDIO_MIME_BY_EXT[ext] || "";
}

function inferAudioExtFromMime(mimeType = "") {
  const lower = String(mimeType || "").trim().toLowerCase().split(";")[0];
  return AUDIO_EXT_BY_MIME[lower] || "";
}

function withReplacedAudioExt(pathLike = "", ext = "wav") {
  const raw = String(pathLike || "").trim();
  if (!raw) return `bridge-voice-input.${ext}`;
  const clean = raw.split(/[?#]/)[0];
  const name = clean.split("/").pop() || clean;
  if (!name) return `bridge-voice-input.${ext}`;
  if (/\.[a-zA-Z0-9]{1,12}$/.test(name)) {
    return name.replace(/\.[a-zA-Z0-9]{1,12}$/, `.${ext}`);
  }
  return `${name}.${ext}`;
}

function normalizeAudioMime(mimeType = "", pathLike = "") {
  const raw = String(mimeType || "").trim().toLowerCase();
  if (!raw || raw === "voice" || raw === "audio" || raw === "application/octet-stream") {
    return inferAudioMimeFromPath(pathLike);
  }
  if (raw.startsWith("audio/")) {
    return raw.split(";")[0];
  }
  if (raw === "amr") return "audio/amr";
  if (raw === "silk") return "audio/silk";
  if (raw === "wav") return "audio/wav";
  if (raw === "mp3") return "audio/mpeg";
  if (raw === "ogg") return "audio/ogg";
  if (raw === "m4a") return "audio/mp4";
  if (raw === "weba" || raw === "webm") return "audio/webm";
  return inferAudioMimeFromPath(pathLike);
}

function findAsciiMagicOffset(buffer, ascii, maxOffset = 8) {
  if (!buffer?.length || !ascii) return -1;
  const sig = Buffer.from(ascii, "ascii");
  const limit = Math.min(Math.max(0, maxOffset), Math.max(0, buffer.length - sig.length));
  for (let i = 0; i <= limit; i += 1) {
    if (buffer.subarray(i, i + sig.length).equals(sig)) return i;
  }
  return -1;
}

function wrapPcm16leAsWav(pcmBuffer, sampleRate, channels = 1) {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBuffer.length;
  const totalSize = 44 + dataSize;
  const wav = Buffer.alloc(totalSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(wav, 44);
  return wav;
}

function normalizeIncomingVoicePayload({ audioBuffer, mimeType, fileName }) {
  let normalizedBuffer = audioBuffer;
  let normalizedMime = normalizeAudioMime(mimeType, fileName) || inferAudioMimeFromPath(fileName) || "";
  let normalizedFileName = String(fileName || "").trim();
  const silkOffset = findAsciiMagicOffset(normalizedBuffer, "#!SILK", 12);
  const amrOffset = silkOffset === -1 ? findAsciiMagicOffset(normalizedBuffer, "#!AMR", 12) : -1;

  if (silkOffset > 0) {
    normalizedBuffer = normalizedBuffer.subarray(silkOffset);
  } else if (amrOffset > 0) {
    normalizedBuffer = normalizedBuffer.subarray(amrOffset);
  }

  if (silkOffset >= 0) {
    normalizedMime = "audio/silk";
    normalizedFileName = withReplacedAudioExt(normalizedFileName, "silk");
  } else if (amrOffset >= 0) {
    normalizedMime = "audio/amr";
    normalizedFileName = withReplacedAudioExt(normalizedFileName, "amr");
  }

  return {
    audioBuffer: normalizedBuffer,
    mimeType: normalizedMime,
    fileName: normalizedFileName,
    silkOffset,
    amrOffset,
  };
}

function shouldTranscodeForOpenAICompat(mimeType = "", fileName = "") {
  const normalized = normalizeAudioMime(mimeType, fileName) || "";
  if (normalized && AUDIO_FORMATS_SUPPORTED_BY_OPENAI_COMPAT.has(normalized)) {
    return false;
  }
  const ext = normalizeAudioExt(fileName);
  return ext === "amr" || ext === "silk" || normalized === "audio/amr" || normalized === "audio/silk";
}

function runAudioCommand(bin, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${bin} timeout`));
    }, timeoutMs);
    child.stderr.on("data", (buf) => {
      stderr += String(buf || "");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${bin} exited ${code}: ${stderr.trim().slice(0, 240)}`));
    });
  });
}

function resolveBundledFfmpegPath() {
  if (_ffmpegInstallerPath !== undefined) return _ffmpegInstallerPath;
  try {
    const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
    const bundled = String(ffmpegInstaller?.path || "").trim();
    _ffmpegInstallerPath = bundled || "";
  } catch (err) {
    const message = String(err?.message || err || "");
    if (/unsupported platform\/architecture/i.test(message)) {
      console.warn(
        `[bridge] bundled ffmpeg unavailable on ${process.platform}-${process.arch}, `
        + "falling back to system ffmpeg if present",
      );
    } else {
      console.warn(`[bridge] failed to load bundled ffmpeg: ${message}`);
    }
    _ffmpegInstallerPath = "";
  }
  return _ffmpegInstallerPath;
}

async function transcodeAudioToWav({ audioBuffer, mimeType, fileName }) {
  const normalized = normalizeIncomingVoicePayload({ audioBuffer, mimeType, fileName });
  if (normalized.mimeType === "audio/silk" || isSilkFile(normalized.audioBuffer)) {
    const decodeErrors = [];
    for (const sampleRate of SILK_SAMPLE_RATE_CANDIDATES) {
      try {
        const decoded = await decodeSilk(normalized.audioBuffer, sampleRate);
        const pcm = Buffer.from(decoded?.data || []);
        if (!pcm.length) {
          decodeErrors.push(`silk-wasm@${sampleRate}: empty pcm`);
          continue;
        }
        const wav = wrapPcm16leAsWav(pcm, sampleRate, 1);
        return {
          audioBuffer: wav,
          mimeType: "audio/wav",
          fileName: withReplacedAudioExt(normalized.fileName || fileName, "wav"),
          transcodedBy: `silk-wasm@${sampleRate}`,
        };
      } catch (err) {
        decodeErrors.push(`silk-wasm@${sampleRate}: ${String(err?.message || err)}`);
      }
    }
    const decodeSummary = decodeErrors.slice(0, 3).join(" | ");
    throw new Error(decodeSummary ? `audio transcode failed: ${decodeSummary}` : "audio transcode failed");
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-voice-"));
  const inputExt = normalizeAudioExt(normalized.fileName || fileName) || inferAudioExtFromMime(normalized.mimeType || mimeType) || "dat";
  const inputPath = path.join(tempRoot, `input.${inputExt}`);
  const outputPath = path.join(tempRoot, "output.wav");
  fs.writeFileSync(inputPath, normalized.audioBuffer);
  try {
    const ffmpegBins = [...new Set([
      String(process.env.HANAKO_FFMPEG_BIN || "").trim(),
      resolveBundledFfmpegPath(),
      "ffmpeg",
    ].filter(Boolean))];
    const attempts = [
      ...ffmpegBins.map((bin) => ({
        tool: bin,
        toolLabel: bin === "ffmpeg" ? "ffmpeg" : `ffmpeg(${path.basename(bin)})`,
        args: ["-y", "-hide_banner", "-loglevel", "error", "-i", inputPath, "-ar", "16000", "-ac", "1", outputPath],
      })),
      {
        tool: "afconvert",
        toolLabel: "afconvert",
        args: ["-f", "WAVE", "-d", "LEI16@16000", inputPath, outputPath],
      },
      {
        tool: "sox",
        toolLabel: "sox",
        args: [inputPath, "-r", "16000", "-c", "1", "-b", "16", outputPath],
      },
    ];

    const attemptErrors = [];
    for (const item of attempts) {
      try {
        await runAudioCommand(item.tool, item.args);
        const converted = fs.readFileSync(outputPath);
        if (converted?.length > 0) {
          return {
            audioBuffer: converted,
            mimeType: "audio/wav",
            fileName: withReplacedAudioExt(fileName, "wav"),
            transcodedBy: item.toolLabel || item.tool,
          };
        }
        attemptErrors.push(`${item.toolLabel || item.tool}: empty output`);
      } catch (err) {
        attemptErrors.push(`${item.toolLabel || item.tool}: ${String(err?.message || err)}`);
      }
    }
    const detail = attemptErrors.slice(0, 3).join(" | ");
    throw new Error(detail ? `audio transcode failed: ${detail}` : "audio transcode failed");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function listProviderCandidates(engine, preferredProvider) {
  const order = [];
  const seen = new Set();
  const push = (value) => {
    const id = String(value || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    order.push(id);
  };

  push(preferredProvider);
  push(engine.currentModel?.provider);
  try {
    const utility = engine.resolveUtilityConfig?.()?.utility;
    push(utility?.provider);
  } catch {
    // ignore utility resolve errors
  }
  try {
    const all = engine.providerRegistry?.getAll?.();
    if (all?.values) {
      for (const entry of all.values()) {
        push(entry?.id);
      }
    }
  } catch {
    // ignore provider registry read errors
  }
  return order;
}

function resolveTranscribeTarget(engine, preferredProvider) {
  for (const provider of listProviderCandidates(engine, preferredProvider)) {
    const creds = engine.resolveProviderCredentials(provider);
    if (!creds?.base_url || !creds?.api) continue;
    if (!isOpenAICompatibleApi(creds.api)) continue;
    if (!creds.api_key && !isLocalBaseUrl(creds.base_url)) continue;
    return {
      provider,
      api: creds.api,
      api_key: creds.api_key || "",
      base_url: creds.base_url,
    };
  }
  return null;
}

function resolveSharedTranscribeTarget(engine, sharedModels = {}, providerHint) {
  const sharedModelRef = normalizeModelRef(sharedModels?.voice_transcribe);
  if (!sharedModelRef) return null;

  let resolved = null;
  try {
    resolved = engine.resolveModelWithCredentials(sharedModelRef);
  } catch {
    return null;
  }
  if (!resolved?.provider || !resolved?.api || !resolved?.base_url) return null;
  if (providerHint && resolved.provider !== providerHint) return null;
  if (!isOpenAICompatibleApi(resolved.api)) return null;
  if (!resolved.api_key && !isLocalBaseUrl(resolved.base_url)) return null;

  return {
    provider: resolved.provider,
    api: resolved.api,
    api_key: resolved.api_key || "",
    base_url: resolved.base_url,
    shared_voice_model: String(resolved.model || resolved.id || "").trim(),
  };
}

function resolveTranscribeTargetFromModelRef(engine, modelRef, providerHint) {
  const ref = normalizeModelRef(modelRef);
  if (!ref) return null;
  let resolved = null;
  try {
    resolved = engine.resolveModelWithCredentials?.(ref);
  } catch {
    return null;
  }
  if (!resolved?.provider || !resolved?.api || !resolved?.base_url) return null;
  if (providerHint && resolved.provider !== providerHint) return null;
  if (!isOpenAICompatibleApi(resolved.api)) return null;
  if (!resolved.api_key && !isLocalBaseUrl(resolved.base_url)) return null;
  return {
    provider: resolved.provider,
    api: resolved.api,
    api_key: resolved.api_key || "",
    base_url: resolved.base_url,
    shared_voice_model: String(resolved.model || resolved.id || ref).trim(),
  };
}

function buildTranscriptionEndpointCandidates(baseUrl) {
  const trimmed = stripTrailingSlash(baseUrl);
  if (!trimmed) return [];

  const candidates = [];
  const seen = new Set();
  const push = (value) => {
    const endpoint = stripTrailingSlash(value);
    if (!endpoint || seen.has(endpoint)) return;
    seen.add(endpoint);
    candidates.push(endpoint);
  };

  try {
    const parsed = new URL(trimmed);
    const pathname = String(parsed.pathname || "").replace(/\/+$/, "");
    const origin = `${parsed.protocol}//${parsed.host}`;
    if (pathname.endsWith("/v1")) {
      // 优先走 /v1，避免被无效根路径 /audio/transcriptions 覆盖最后错误。
      push(`${trimmed}/audio/transcriptions`);
      push(`${origin}/v1/audio/transcriptions`);
      push(`${origin}/audio/transcriptions`);
    } else {
      push(`${trimmed}/v1/audio/transcriptions`);
      push(`${trimmed}/audio/transcriptions`);
    }
  } catch {
    push(`${trimmed}/v1/audio/transcriptions`);
    push(`${trimmed}/audio/transcriptions`);
  }

  return candidates;
}

async function transcribeAudioWithEngine({
  engine,
  audioBuffer,
  mimeType,
  providerHint,
  model,
  fileName,
}) {
  const sharedModels = engine.getSharedModels?.() || {};
  const prefsVoiceModel = normalizeModelRef(engine.getPreferences?.()?.voice_transcribe_model);
  const preferredVoiceModel = normalizeModelRef(sharedModels?.voice_transcribe || prefsVoiceModel || "");
  const preferredTarget = resolveTranscribeTargetFromModelRef(
    engine,
    preferredVoiceModel,
    providerHint,
  );
  const sharedTarget = resolveSharedTranscribeTarget(
    engine,
    sharedModels,
    providerHint,
  );
  const target = preferredTarget || sharedTarget || resolveTranscribeTarget(
    engine,
    providerHint || preferredTarget?.provider || sharedTarget?.provider,
  );
  if (!target) {
    throw new Error("No OpenAI-compatible provider credentials found for voice transcription.");
  }

  const preferredModelHint = preferredTarget && preferredTarget.provider === target.provider
    ? String(preferredTarget.shared_voice_model || "").trim()
    : "";
  const sharedModelHint = sharedTarget && sharedTarget.provider === target.provider
    ? String(sharedTarget.shared_voice_model || "").trim()
    : "";
  const modelCandidates = [...new Set([
    normalizeModelRef(model),
    preferredModelHint,
    sharedModelHint,
    normalizeModelRef(process.env.HANA_VOICE_TRANSCRIBE_MODEL || ""),
    target.provider === "siliconflow" ? "TeleAI/TeleSpeechASR" : "",
    target.provider === "siliconflow" ? "FunAudioLLM/SenseVoiceSmall" : "",
    "gpt-4o-mini-transcribe",
    "whisper-1",
  ].filter(Boolean))];
  const endpointCandidates = buildTranscriptionEndpointCandidates(target.base_url);
  if (!endpointCandidates.length) {
    throw new Error("Voice transcription endpoint is empty");
  }
  debugLog()?.log(
    "bridge",
    `voice transcribe target=${target.provider} models=${JSON.stringify(modelCandidates.slice(0, 4))}`,
  );

  const authHeaders = buildProviderAuthHeaders(target.api, target.api_key, {
    allowMissingApiKey: isLocalBaseUrl(target.base_url),
  });
  delete authHeaders["Content-Type"];
  delete authHeaders["content-type"];

  let lastError = "Voice transcription failed";
  let lastStatus = 0;
  let lastEndpoint = "";
  let preferredError = null;
  const uploadMimeType = normalizeAudioMime(mimeType, fileName) || "audio/webm";

  for (const endpoint of endpointCandidates) {
    for (const item of modelCandidates) {
      const uploadExt = normalizeAudioExt(fileName) || inferAudioExtFromMime(uploadMimeType) || "webm";
      const uploadName = `bridge-voice-input.${uploadExt}`;
      const form = new FormData();
      form.append(
        "file",
        new Blob([audioBuffer], { type: uploadMimeType }),
        uploadName,
      );
      form.append("model", item);
      form.append("response_format", "json");

      const res = await fetch(endpoint, {
        method: "POST",
        headers: authHeaders,
        body: form,
        signal: AbortSignal.timeout(BRIDGE_TRANSCRIBE_TIMEOUT_MS),
      });

      const rawText = await res.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = { message: rawText || "" };
      }

      if (!res.ok) {
        const message = parseErrorMessage(data, `Transcription API error (${res.status})`);
        const status = Number(res.status || 0);
        lastError = message;
        lastStatus = status;
        lastEndpoint = endpoint;
        if (status !== 404 && !preferredError) {
          preferredError = { message, endpoint, status };
        }
        // 认证问题直接抛出，避免无意义重试。
        if (status === 401 || status === 403) {
          throw new Error(message);
        }
        if (status === 400) {
          continue;
        }
        if (status === 404) {
          continue;
        }
        // 其余（含 5xx）继续尝试下一候选模型，尽量提高成功率。
        continue;
      }

      const text = String(data?.text || data?.transcript || "").trim();
      return {
        text,
        provider: target.provider,
        model: item,
      };
    }
  }

  const finalMessage = preferredError?.message || lastError;
  const finalEndpoint = preferredError?.endpoint || lastEndpoint;
  const endpointSuffix = finalEndpoint ? ` (endpoint: ${finalEndpoint})` : "";
  throw new Error(`${finalMessage}${endpointSuffix}`);
}

export class BridgeManager {
  /**
   * @param {object} opts
   * @param {import('../../core/engine.js').HanaEngine} opts.engine
   * @param {import('../../hub/index.js').Hub} opts.hub
   */
  constructor({ engine, hub }) {
    this.engine = engine;
    this._hub = hub;
    /** @type {Map<string, { adapter, status: string, error?: string }>} */
    this._platforms = new Map();
    /** per-sessionKey 消息缓冲（debounce + abort） */
    this._pending = new Map();
    /** per-sessionKey 处理锁（防止 debounce 触发和 abort 重发并发） */
    this._processing = new Set();
    /** per-sessionKey 停止版本：/stop 或 /new 时递增，用于丢弃未完成请求的迟到输出 */
    this._stopVersion = new Map();
    /** 最近消息环形缓冲（最多 200 条） */
    this._messageLog = [];
    this._messageLogMax = 200;

    // 初始化媒体本地路径白名单（对标 OpenClaw mediaLocalRoots，对齐 fs.js getAllowedRoots）
    const roots = [];
    if (engine.hanakoHome) roots.push(engine.hanakoHome);
    const homeFolder = typeof engine.getHomeFolder === "function" ? engine.getHomeFolder() : null;
    if (homeFolder) roots.push(homeFolder);
    if (engine.homeCwd) roots.push(engine.homeCwd);
    if (engine.cwd) roots.push(engine.cwd);
    if (engine.deskCwd) roots.push(engine.deskCwd);
    const deskHome = engine.agent?.deskManager?.homePath;
    if (deskHome) roots.push(deskHome);
    const userHome = os.homedir();
    if (userHome) {
      roots.push(path.join(userHome, "Documents"));
      roots.push(path.join(userHome, "Desktop"));
      roots.push(path.join(userHome, "Downloads"));
      roots.push(path.join(userHome, "Pictures"));
    }
    roots.push(os.tmpdir());
    setMediaLocalRoots(roots);
    /** block streaming 模式（默认开，多气泡发送） */
    this.blockStreaming = true;
  }

  /** 读取 preferences 中的 bridge 配置，自动启动已启用的平台 */
  autoStart() {
    const prefs = this.engine.getPreferences();
    const bridge = prefs.bridge || {};

    // 多 bot 平台
    for (const platform of ["telegram", "feishu", "qq"]) {
      this.startPlatformFromConfig(platform, bridge[platform] || {});
    }
    // 单 bot 平台
    this.startPlatformFromConfig("wechat", bridge.wechat || {});
  }

  _resolvePlatformAgentId(platform, cfg) {
    return cfg?.agentId || null;
  }

  _resolveBotAgentId(bot) {
    return bot?.agentId || null;
  }

  /**
   * 解析平台实例当前应路由到的 agent：
   * 1) 优先读取 settings 中 bot 绑定（以设置页为准）
   * 2) 回退运行时 entry.agentId
   * 3) 最后回退当前焦点 agent（兼容旧配置）
   */
  _resolveTargetAgentId(platformKey, runtimeAgentId = null) {
    const normalizeId = (value) => (typeof value === "string" ? value.trim() : "");
    const candidates = [];

    try {
      const { platform, botId } = parsePlatformKey(platformKey);
      const prefs = this.engine.getPreferences?.() || {};
      const cfg = prefs.bridge?.[platform];
      if (platform && cfg) {
        const bots = normalizeBridgeBots(platform, cfg);
        let hit = null;
        if (botId) hit = bots.find((b) => normalizeId(b?.id) === botId);
        if (!hit && !botId && bots.length === 1) hit = bots[0];
        if (!hit) hit = bots.find((b) => normalizeId(b?.id) === "default");
        if (hit?.agentId) candidates.push(normalizeId(hit.agentId));
      }
    } catch (err) {
      debugLog()?.warn("bridge", `resolve target agent from prefs failed (${platformKey}): ${err.message}`);
    }

    candidates.push(normalizeId(runtimeAgentId));
    candidates.push(normalizeId(this.engine.currentAgentId));

    for (const id of candidates) {
      if (!id) continue;
      if (typeof this.engine.getAgent === "function") {
        if (this.engine.getAgent(id)) return id;
        continue;
      }
      return id;
    }
    return null;
  }

  /**
   * 从 preferences 配置启动平台（route 层用，不需要知道凭证结构）
   * @param {string} platform
   * @param {object} cfg - prefs.bridge[platform] 的完整配置
   */
  startPlatformFromConfig(platform, cfg) {
    const spec = ADAPTER_REGISTRY[platform];
    if (!spec) return;

    if (platform === "wechat") {
      this.stopPlatform(platform);
      const creds = spec.getCredentials({
        ...(cfg || {}),
        _hanaHome: this.engine.hanakoHome,
      });
      if (!creds) return;
      this.startPlatform(platform, creds, {
        agentId: this._resolvePlatformAgentId(platform, cfg),
      });
      return;
    }

    // 多 bot：先停同平台全部，再按 bots 启动
    if (platform === "telegram" || platform === "feishu" || platform === "qq") {
      this.stopPlatform(platform);
      const bots = normalizeBridgeBots(platform, cfg);
      for (const bot of bots) {
        const creds = spec.getCredentials({ ...bot, enabled: bot.enabled !== false });
        if (!creds) continue;
        this.startPlatform(platform, creds, {
          botId: bot.id || null,
          agentId: this._resolveBotAgentId(bot),
          label: bot.name || null,
        });
      }
      return;
    }
  }

  /**
   * 启动指定平台（支持多 bot）
   * @param {string} platform
   * @param {object} credentials
   * @param {object} [opts]
   * @param {string|null} [opts.botId]
   * @param {string|null} [opts.agentId]
   * @param {string|null} [opts.label]
   */
  startPlatform(platform, credentials, opts = {}) {
    const platformKey = buildPlatformKey(platform, opts.botId || null);
    this.stopPlatform(platformKey);

    const spec = ADAPTER_REGISTRY[platform];
    if (!spec) throw new Error(`Unknown platform: ${platform}`);

    try {
      const onMessage = (msg) => this._handleMessage(platformKey, msg);
      const hooks = {
        onEvent: (evt) => this._hub.eventBus.emit(evt, null),
        onQqDmGuild: (userId, guildId) => this._persistQqDmGuild(userId, guildId, platformKey),
        onStatus: (status, error) => {
          const entry = this._platforms.get(platformKey);
          if (entry) { entry.status = status; entry.error = error || null; }
          this._emitStatus(platform, status, error, opts.botId || null);
        },
      };
      const adapter = spec.create(credentials, onMessage, hooks);

      this._platforms.set(platformKey, {
        adapter,
        status: "connected",
        error: null,
        platform,
        platformKey,
        botId: opts.botId || null,
        agentId: opts.agentId || null,
        label: opts.label || null,
      });
      console.log(`[bridge] ${platformKey} 已启动`);
      debugLog()?.log("bridge", `${platformKey} started`);

      this._emitStatus(platform, "connected", null, opts.botId || null);
    } catch (err) {
      console.error(`[bridge] ${platformKey} 启动失败:`, err.message);
      debugLog()?.error("bridge", `${platformKey} start failed: ${err.message}`);
      this._platforms.set(platformKey, {
        adapter: null,
        status: "error",
        error: err.message,
        platform,
        platformKey,
        botId: opts.botId || null,
        agentId: opts.agentId || null,
        label: opts.label || null,
      });
      this._emitStatus(platform, "error", err.message, opts.botId || null);
    }
  }

  /** 持久化 QQ userId→guildId 映射到 preferences（debounced） */
  _persistQqDmGuild(userId, guildId, platformKey = "qq") {
    try {
      const prefs = this.engine.getPreferences();
      if (!prefs.bridge) prefs.bridge = {};
      const qqCfg = prefs.bridge.qq || {};
      const { botId } = parsePlatformKey(platformKey);

      if (botId && Array.isArray(qqCfg.bots)) {
        const idx = qqCfg.bots.findIndex((b) => b?.id === botId);
        if (idx >= 0) {
          const bot = { ...qqCfg.bots[idx] };
          const map = { ...(bot.dmGuildMap || {}) };
          if (map[userId] === guildId) return;
          map[userId] = guildId;
          bot.dmGuildMap = map;
          qqCfg.bots[idx] = bot;
          prefs.bridge.qq = qqCfg;
        }
      } else {
        const map = { ...(qqCfg.dmGuildMap || {}) };
        if (map[userId] === guildId) return;
        map[userId] = guildId;
        qqCfg.dmGuildMap = map;
        prefs.bridge.qq = qqCfg;
      }

      // debounce: 合并短时间内的多次映射发现，避免每条私信都同步写盘
      if (!this._qqDmGuildFlushTimer) {
        this._qqDmGuildFlushTimer = setTimeout(() => {
          this._qqDmGuildFlushTimer = null;
          try { this.engine.savePreferences(this.engine.getPreferences()); }
          catch (e) { console.error("[bridge] flush QQ dmGuildMap failed:", e.message); }
        }, 5_000);
      }
    } catch (err) {
      console.error("[bridge] persist QQ dmGuildMap failed:", err.message);
    }
  }

  _stopPlatformKey(platformKey) {
    const entry = this._platforms.get(platformKey);
    if (!entry) return;
    try {
      entry.adapter?.stop();
    } catch {}
    this._platforms.delete(platformKey);
    console.log(`[bridge] ${platformKey} 已停止`);
    debugLog()?.log("bridge", `${platformKey} stopped`);
    this._emitStatus(entry.platform || platformKey, "disconnected", null, entry.botId || null);
  }

  /** 停止指定平台（支持 base platform 或 platformKey） */
  stopPlatform(platformOrKey) {
    if (this._platforms.has(platformOrKey)) {
      this._stopPlatformKey(platformOrKey);
      return;
    }
    const keys = [...this._platforms.entries()]
      .filter(([, entry]) => entry?.platform === platformOrKey)
      .map(([k]) => k);
    for (const k of keys) this._stopPlatformKey(k);
  }

  /** 停止所有平台 */
  stopAll() {
    const keys = [...this._platforms.keys()];
    for (const key of keys) this._stopPlatformKey(key);
    if (this._qqDmGuildFlushTimer) {
      clearTimeout(this._qqDmGuildFlushTimer);
      this._qqDmGuildFlushTimer = null;
      try { this.engine.savePreferences(this.engine.getPreferences()); }
      catch {}
    }
  }

  /** 获取所有平台状态（key 为 platformKey） */
  getStatus() {
    const result = {};
    for (const [platformKey, entry] of this._platforms) {
      result[platformKey] = {
        status: entry.status,
        error: entry.error || null,
        platform: entry.platform,
        botId: entry.botId || null,
      };
    }
    return result;
  }

  _hasExplicitMediaSuppressIntent(userPrompt = "") {
    const text = String(userPrompt || "").trim();
    if (!text) return false;
    const lower = text.toLowerCase();

    if (/(不要|别|无需|不用|不需要|先别|暂时别).{0,8}(发|发送|传|上传|分享)/.test(text)) return true;
    if (/(don't|do not|no need to|not need to).{0,20}(send|upload|attach|share)/i.test(lower)) return true;
    return false;
  }

  _hasExplicitMediaSendIntent(userPrompt = "") {
    const text = String(userPrompt || "").trim();
    if (!text) return false;
    const lower = text.toLowerCase();

    // 中英文显式“发送媒体”意图（兼容“给我看图/给我文件/导出文件”等常见说法）
    if (/(发给我|发我|传给我|传我|给我发|给我传|发送给我|上传给我)/.test(text)) return true;
    if (/(给我.{0,12}(看|发|传|发来|传来).{0,24}(图片|图|照片|截图|文件|文档|视频|音频|语音|pdf|附件))/.test(text)) return true;
    if (/(把.{0,24}(图片|图|照片|截图|文件|文档|视频|音频|语音|pdf|附件).{0,12}(发|传|上传|给我|发来|传来|给我看))/.test(text)) return true;
    if (/(导出|生成|画|绘制|输出|提供).{0,16}(图片|图|照片|截图|文件|文档|视频|音频|pdf|附件)/.test(text)) return true;
    if (/(send (me|it|them)|send .* to me|upload .*?(image|file|photo|screenshot|video|audio|document)|attach .*?(image|file|photo|document)|share .*?(image|file|photo|document)|export .*?(image|file|document))/i.test(lower)) return true;
    if (/(show me .*?(image|photo|file|document)|give me .*?(image|file|document))/i.test(lower)) return true;

    return false;
  }

  _shouldDispatchMedia(userPrompt = "", nonMediaReplyText = "") {
    // 仅在用户明确说“不要发送”时拦截。
    // 之前要求“显式发送意图”导致大量正常场景（如“画一张图给我看”）被误拦截。
    if (this._hasExplicitMediaSuppressIntent(userPrompt)) return false;
    if (this._hasExplicitMediaSendIntent(userPrompt)) return true;
    void nonMediaReplyText;
    return true;
  }

  _buildMediaSuppressedText(userPrompt = "") {
    const isZh = /[\u4e00-\u9fff]/.test(String(userPrompt || ""));
    if (isZh) {
      return "检测到媒体路径，但你刚刚提到先不要发送，我已按你的要求不自动发送。需要时请直接说“把图片/文件发给我”。";
    }
    return "I detected media paths, but you asked not to send them right now. I kept them unsent as requested.";
  }

  _getStopVersion(sessionKey) {
    return this._stopVersion.get(sessionKey) || 0;
  }

  _bumpStopVersion(sessionKey) {
    const next = this._getStopVersion(sessionKey) + 1;
    this._stopVersion.set(sessionKey, next);
    return next;
  }

  _isStopVersionCurrent(sessionKey, version) {
    return this._getStopVersion(sessionKey) === version;
  }

  /**
   * 核心：收到外部消息
   *
   * 群聊：直接发送，不 debounce 不 abort（轻量 guest 快速回复）
   * 私聊：debounce 聚合 → 如正在处理则 abort → 合并发送
   */
  async _handleMessage(platformKey, msg) {
    const { sessionKey: rawSessionKey, senderName, avatarUrl, userId, isGroup, chatId, attachments } = msg;
    const text = typeof msg.text === "string" ? msg.text : "";
    const entry = this._platforms.get(platformKey);
    if (!entry?.adapter) return;
    const platform = entry.platform || platformKey;
    const agentId = this._resolveTargetAgentId(platformKey, entry.agentId);
    const sessionKey = buildSessionKey(platformKey, rawSessionKey);

    const hasAttachments = attachments?.length > 0;
    debugLog()?.log("bridge", `← ${platformKey} ${isGroup ? "group" : "dm"} (${text.length} chars${hasAttachments ? `, ${attachments.length} attachment(s)` : ""})`);

    // 广播收到的消息
    this._pushMessage({
      platform, direction: "in", sessionKey,
      sender: senderName || "用户", text: text || (hasAttachments ? `[${attachments.length} 个附件]` : ""),
      isGroup, ts: Date.now(),
    });

    const command = text.trim();

    // ── /stop 命令：abort 当前生成，不触发新回复 ──
    if (/^\/(stop|abort)$/i.test(command)) {
      const v = this._bumpStopVersion(sessionKey);
      this.engine.abortBridgeSession(sessionKey).catch(() => {});
      debugLog()?.log("bridge", `abort ${platform} active session: /stop command (v${v})`);
      const pending = this._pending.get(sessionKey);
      if (pending?.timer) clearTimeout(pending.timer);
      this._pending.delete(sessionKey);
      return;
    }

    // ── /new 命令：重置上下文（兼容 /reset）──
    if (/^\/(new|reset)$/i.test(command)) {
      const v = this._bumpStopVersion(sessionKey);
      await this.engine.abortBridgeSession(sessionKey).catch(() => {});
      const pending = this._pending.get(sessionKey);
      if (pending?.timer) clearTimeout(pending.timer);
      this._pending.delete(sessionKey);

      const ok = await this.engine.resetBridgeSession(sessionKey, { agentId }).catch(() => false);
      if (ok) {
        debugLog()?.log("bridge", `reset ${platformKey} session by command: ${command} (v${v})`);
        try {
          await entry.adapter.sendReply(chatId, "已开启新对话。");
          this._pushMessage({
            platform, direction: "out", sessionKey,
            sender: this.engine.agentName, text: "已开启新对话。",
            isGroup, ts: Date.now(),
          });
        } catch {}
      }
      return;
    }

    // ── 群聊：快速路径，不 debounce 不 abort ──
    if (isGroup) {
      const line = senderName ? `${senderName}: ${text}` : text;
      const meta = { name: senderName, avatarUrl, userId, platform, platformKey, chatId };
      await this._flushGroupMessage(platformKey, chatId, sessionKey, line, meta, attachments);
      return;
    }

    // ── 私聊：debounce + abort ──
    const line = senderName ? `${senderName}: ${text}` : text;

    let pending = this._pending.get(sessionKey);
    if (!pending) {
      pending = { lines: [], attachments: [], platform, platformKey, chatId, senderName, avatarUrl, userId, isGroup, agentId };
      this._pending.set(sessionKey, pending);
    }
    pending.lines.push(line);
    if (hasAttachments) pending.attachments.push(...attachments);
    Object.assign(pending, { platform, platformKey, chatId, senderName, avatarUrl, userId, isGroup, agentId });

    const isActive = this.engine.isBridgeSessionStreaming(sessionKey);

    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this._flushPending(sessionKey), isActive ? 1000 : 2000);
  }

  /**
   * 解析附件：图片 → base64（给 LLM），其他 → 文本描述
   * @returns {{ images: Array, textNotes: string }}
   */
  async _resolveAttachments(platformKey, attachments) {
    const images = [];
    const notes = [];
    if (!attachments?.length) return { images, textNotes: "" };

    const entry = this._platforms.get(platformKey);
    const adapter = entry?.adapter;

    for (const att of attachments) {
      try {
        if (att.type === "image") {
          let buffer;
          if (att.url) {
            buffer = await downloadMedia(att.url);
          } else if (att.platformRef && adapter?.downloadImage) {
            buffer = await adapter.downloadImage(att.platformRef);
          }
          if (buffer) {
            const mime = detectMime(buffer, att.mimeType || "image/jpeg");
            images.push({ type: "image", data: bufferToBase64(buffer), mimeType: mime });
          }
        } else if (att.type === "audio") {
          let transcriptText = String(att.asrReferText || att.transcript || "").trim();
          let audioBuffer = null;
          const downloadUrl = att.voiceWavUrl || att.url;
          const pathHint = att.filename || downloadUrl;
          const fallbackMime = inferAudioMimeFromPath(pathHint);
          if (!transcriptText) {
            try {
              if (downloadUrl && adapter?.downloadAttachment) {
                audioBuffer = await adapter.downloadAttachment(downloadUrl);
              } else if (downloadUrl) {
                audioBuffer = await downloadMedia(downloadUrl);
              } else if (att.platformRef && adapter?.downloadAudio) {
                audioBuffer = await adapter.downloadAudio(att.platformRef);
              }
            } catch (err) {
              debugLog()?.warn("bridge", `语音下载失败: ${err.message}`);
            }
          }

          if (!transcriptText && audioBuffer?.length > 0 && audioBuffer.length <= BRIDGE_TRANSCRIBE_MAX_AUDIO_BYTES) {
            const normalizedPayload = normalizeIncomingVoicePayload({
              audioBuffer,
              mimeType: att.mimeType || fallbackMime,
              fileName: pathHint,
            });
            const declaredMime = normalizeAudioMime(att.mimeType || "", pathHint);
            const detectedMime = detectMime(
              normalizedPayload.audioBuffer,
              normalizedPayload.mimeType || declaredMime || fallbackMime || "audio/webm",
            );
            let mimeType = normalizeAudioMime(detectedMime, normalizedPayload.fileName || pathHint)
              || normalizedPayload.mimeType
              || fallbackMime
              || "audio/webm";
            let uploadBuffer = normalizedPayload.audioBuffer;
            let uploadFileName = normalizedPayload.fileName || pathHint || "";
            if (shouldTranscodeForOpenAICompat(mimeType, uploadFileName)) {
              try {
                const transcoded = await transcodeAudioToWav({
                  audioBuffer: uploadBuffer,
                  mimeType,
                  fileName: uploadFileName,
                });
                uploadBuffer = transcoded.audioBuffer;
                mimeType = transcoded.mimeType;
                uploadFileName = transcoded.fileName;
                debugLog()?.log(
                  "bridge",
                  `voice transcode ok tool=${transcoded.transcodedBy} file=${String(uploadFileName).slice(-48)}`,
                );
              } catch (err) {
                debugLog()?.warn("bridge", `voice transcode failed: ${err.message}`);
              }
            }
            debugLog()?.log(
              "bridge",
              `voice attachment meta file=${String(uploadFileName || att.filename || "").slice(-48) || "(none)"} `
              + `mime=${mimeType} size=${uploadBuffer.length} `
              + `magic=${uploadBuffer.subarray(0, 8).toString("hex")} `
              + `off(silk=${normalizedPayload.silkOffset},amr=${normalizedPayload.amrOffset})`,
            );
            try {
              const result = await transcribeAudioWithEngine({
                engine: this.engine,
                audioBuffer: uploadBuffer,
                mimeType,
                fileName: uploadFileName || pathHint || "",
              });
              transcriptText = String(result?.text || "").trim();
            } catch (err) {
              debugLog()?.warn("bridge", `语音转写失败: ${err.message}`);
            }
          }
          const dur = att.duration ? ` ${Math.round(att.duration)}秒` : "";
          notes.push(`[收到语音${dur}]`);
          if (transcriptText) {
            notes.push(`[语音转写] ${transcriptText}`);
          }
        } else if (att.type === "video") {
          notes.push(`[收到视频: ${att.filename || "video"}]`);
        } else {
          const size = att.size ? ` (${formatSize(att.size)})` : "";
          notes.push(`[收到文件: ${att.filename || "file"}${size}]`);
        }
      } catch (err) {
        debugLog()?.warn("bridge", `附件解析失败: ${err.message}`);
        notes.push(`[附件加载失败: ${att.filename || att.type}]`);
      }
    }
    return { images, textNotes: notes.join("\n") };
  }

  async _flushGroupMessage(platformKey, chatId, sessionKey, line, meta, attachments) {
    const entry = this._platforms.get(platformKey);
    if (!entry?.adapter) return;
    const platform = entry.platform || platformKey;
    const agentId = this._resolveTargetAgentId(platformKey, entry.agentId);
    const stopVersion = this._getStopVersion(sessionKey);
    let staleLogged = false;
    const ensureReplyAllowed = () => {
      if (this._isStopVersionCurrent(sessionKey, stopVersion)) return true;
      if (!staleLogged) {
        staleLogged = true;
        debugLog()?.log("bridge", `discard stale ${platformKey} group reply after stop/new`);
      }
      return false;
    };

    debugLog()?.log("bridge", `flush ${platformKey} group message (${line.length} chars)`);

    // 解析附件
    const { images, textNotes } = await this._resolveAttachments(platformKey, attachments);
    const prompt = textNotes ? `${line}\n${textNotes}` : line;

    const tagged = `${timeTag()} ${prompt}`;
    try {
      const reply = await this._hub.send(tagged, {
        sessionKey,
        agentId,
        meta,
        isGroup: true,
        images: images.length ? images : undefined,
      });

      if (reply && entry?.adapter) {
        if (!ensureReplyAllowed()) return;
        const cleaned = this._cleanReplyForPlatform(reply);
        // batch 模式：提取媒体
        const { text: textOnly, mediaUrls, mediaErrors = [] } = splitMediaFromOutput(cleaned);
        if (mediaErrors.length) {
          debugLog()?.warn("bridge", `media parse warning (${platformKey}): ${mediaErrors.join(" | ")}`);
        }
        const replyText = [textOnly.trim(), ...mediaErrors].filter(Boolean).join("\n");
        if (replyText) {
          if (!ensureReplyAllowed()) return;
          await entry.adapter.sendReply(chatId, replyText);
        }
        const shouldSendMedia = this._shouldDispatchMedia(prompt, replyText);
        if (!shouldSendMedia && mediaUrls.length) {
          debugLog()?.log("bridge", `media suppressed (${platformKey} group): no explicit send intent`);
          if (!replyText) {
            if (!ensureReplyAllowed()) return;
            await entry.adapter.sendReply(chatId, this._buildMediaSuppressedText(prompt));
          }
        } else {
          for (const url of mediaUrls) {
            try {
              if (!ensureReplyAllowed()) return;
              await this._sendMediaItem(entry.adapter, chatId, url, { userId: meta?.userId, isGroup: true });
            } catch (err) {
              debugLog()?.warn("bridge", `media send failed, fallback to text (${platformKey}): ${err.message}`);
              if (!ensureReplyAllowed()) return;
              await entry.adapter.sendReply(chatId, this._buildMediaFallbackText(url, err));
            }
          }
        }
        debugLog()?.log("bridge", `→ ${platform} group reply (${cleaned.length} chars)`);
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender: this.engine.agentName, text: cleaned,
          isGroup: true, ts: Date.now(),
        });
      }
    } catch (err) {
      if (!err.message?.includes("aborted")) {
        console.error(`[bridge] ${platform} 群聊消息处理失败:`, err.message);
        debugLog()?.error("bridge", `${platform} group message failed: ${err.message}`);
      }
    }
  }

  /**
   * debounce 到期：合并缓冲消息并发送给 LLM
   */
  async _flushPending(sessionKey) {
    const pending = this._pending.get(sessionKey);
    if (!pending || pending.lines.length === 0) return;

    // 防止并发触发
    if (this._processing.has(sessionKey)) return;

    // 取出所有缓冲消息和附件
    const lines = pending.lines.splice(0);
    const pendingAttachments = pending.attachments?.splice(0) || [];
    const { platform, platformKey, chatId, senderName, avatarUrl, userId, isGroup, agentId } = pending;
    const stopVersion = this._getStopVersion(sessionKey);
    this._pending.delete(sessionKey);
    let staleLogged = false;
    const ensureReplyAllowed = () => {
      if (this._isStopVersionCurrent(sessionKey, stopVersion)) return true;
      if (!staleLogged) {
        staleLogged = true;
        debugLog()?.log("bridge", `discard stale ${platformKey} reply after stop/new`);
      }
      return false;
    };

    // 解析附件
    const { images, textNotes } = await this._resolveAttachments(platformKey, pendingAttachments);
    const prompt = textNotes ? `${lines.join("\n")}\n${textNotes}` : lines.join("\n");
    const merged = `${timeTag()} ${prompt}`;
    const meta = { name: senderName, avatarUrl, userId, platform, platformKey, chatId };

    // 如果 agent 正在 streaming，用 steer 注入而不是新建 prompt
    // 但如果有图片附件，不走 steer，等当前回复结束后正常处理
    if (!images.length && this.engine.steerBridgeSession(sessionKey, merged)) {
      debugLog()?.log("bridge", `steer ${platformKey} dm (${lines.length} msg(s))`);
      return;
    }

    this._processing.add(sessionKey);

    debugLog()?.log("bridge", `flush ${platformKey} dm (${lines.length} msg(s), ${merged.length} chars${images.length ? `, ${images.length} image(s)` : ""})`);

    const entry = this._platforms.get(platformKey);
    const adapter = entry?.adapter;

    // ── 平台回复默认仅发送最终结果（不流式外发中间过程）──
    // 目标：避免思考过程/中间草稿被提前发到外部 IM。
    const canStream = false;
    const useBlockStream = canStream && this.blockStreaming;
    const useDraft = canStream && !this.blockStreaming && !!adapter?.sendDraft;

    let cleaner = null;
    let chunker = null;
    let blockSentAny = false;
    let lastDraftTs = 0;
    let draftFailed = false;
    const THROTTLE = 500;

    // block streaming: 多气泡发送
    if (useBlockStream) {
      cleaner = new StreamCleaner();
      chunker = new BlockChunker({
        onFlush: async (text) => {
          blockSentAny = true;
          await adapter.sendBlockReply(chatId, text);
        },
      });
    }

    const onDelta = canStream ? (_delta) => {
      if (useBlockStream) {
        const inc = cleaner.feed(_delta);
        if (inc) chunker.feed(inc);
      } else if (useDraft) {
        if (draftFailed) return;
        if (!cleaner) cleaner = new StreamCleaner();
        cleaner.feed(_delta);
        const now = Date.now();
        if (now - lastDraftTs < THROTTLE) return;
        if (!cleaner.cleaned.trim()) return;
        lastDraftTs = now;
        adapter.sendDraft(chatId, cleaner.cleaned).catch(() => { draftFailed = true; });
      }
    } : undefined;

    try {
      const reply = await this._hub.send(merged, {
        sessionKey,
        agentId,
        meta,
        isGroup: false,
        onDelta,
        images: images.length ? images : undefined,
      });

      if (reply && adapter) {
        if (!ensureReplyAllowed()) return;
        const cleaned = this._cleanReplyForPlatform(reply);
        let allMediaUrls = [];
        let nonMediaReplyText = "";

        // flush StreamCleaner 行缓冲中剩余的不完整行
        if (cleaner) {
          const tail = cleaner.flushLineBuf();
          if (tail) cleaner.cleaned += tail;
        }

        if (useBlockStream && chunker) {
          await chunker.finish();
          allMediaUrls = cleaner?.extractedMedia || [];
          nonMediaReplyText = (cleaner?.cleaned || "").trim();
          if (!blockSentAny) {
            const textOnly = (cleaner?.cleaned || cleaned).trim();
            if (textOnly) {
              if (!ensureReplyAllowed()) return;
              await adapter.sendReply(chatId, textOnly);
            }
          }
        } else if (useDraft && cleaner) {
          // draft 模式：用 cleaner.cleaned（已剥离媒体标记）发送最终文本
          allMediaUrls = cleaner.extractedMedia || [];
          const textOnly = cleaner.cleaned.trim();
          nonMediaReplyText = textOnly;
          if (textOnly) {
            if (!ensureReplyAllowed()) return;
            try { await adapter.sendDraft(chatId, textOnly); }
            catch { await adapter.sendReply(chatId, textOnly); }
          }
        } else {
          // batch 模式：提取媒体
          const { text: textOnly, mediaUrls, mediaErrors = [] } = splitMediaFromOutput(cleaned);
          if (mediaErrors.length) {
            debugLog()?.warn("bridge", `media parse warning (${platformKey}): ${mediaErrors.join(" | ")}`);
          }
          allMediaUrls = mediaUrls;
          const replyText = [textOnly.trim(), ...mediaErrors].filter(Boolean).join("\n");
          nonMediaReplyText = replyText;
          if (replyText) {
            if (!ensureReplyAllowed()) return;
            await adapter.sendReply(chatId, replyText);
          }
        }

        // 统一发送所有提取到的媒体（带发送意图守门，避免误触发）
        const shouldSendMedia = this._shouldDispatchMedia(prompt, nonMediaReplyText);
        if (!shouldSendMedia && allMediaUrls.length) {
          debugLog()?.log("bridge", `media suppressed (${platformKey} dm): no explicit send intent`);
          if (!nonMediaReplyText) {
            if (!ensureReplyAllowed()) return;
            await adapter.sendReply(chatId, this._buildMediaSuppressedText(prompt));
          }
        } else {
          for (const url of allMediaUrls) {
            try {
              if (!ensureReplyAllowed()) return;
              await this._sendMediaItem(adapter, chatId, url, { userId, isGroup });
            } catch (err) {
              debugLog()?.warn("bridge", `media send failed, fallback to text (${platformKey}): ${err.message}`);
              if (!ensureReplyAllowed()) return;
              await adapter.sendReply(chatId, this._buildMediaFallbackText(url, err));
            }
          }
        }

        debugLog()?.log("bridge", `→ ${platform} reply (${cleaned.length} chars, mode: ${useBlockStream ? "block" : useDraft ? "draft" : "batch"}${allMediaUrls.length ? `, ${allMediaUrls.length} media` : ""})`);
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender: this.engine.agentName, text: cleaned,
          isGroup, ts: Date.now(),
        });
      }
    } catch (err) {
      if (!err.message?.includes("aborted")) {
        console.error(`[bridge] ${platform} 消息处理失败:`, err.message);
        debugLog()?.error("bridge", `${platform} message handling failed: ${err.message}`);
      }
    } finally {
      this._processing.delete(sessionKey);
    }

    // 处理期间可能又有新消息进来了，检查并重新 flush
    const newPending = this._pending.get(sessionKey);
    if (newPending && newPending.lines.length > 0) {
      if (newPending.timer) clearTimeout(newPending.timer);
      newPending.timer = setTimeout(() => this._flushPending(sessionKey), 500);
    }
  }

  /**
   * 发送单个媒体项（URL 或本地路径）到平台
   * 本地路径走 sendMediaBuffer，URL 走 sendMedia
   */
  async _sendMediaItem(adapter, chatId, source, ctx = {}) {
    const userId = ctx?.userId ? String(ctx.userId) : undefined;
    const isLocal = source.startsWith("/") || source.startsWith("file://");
    if (isLocal && adapter.sendMediaBuffer) {
      const buffer = await downloadMedia(source); // downloadMedia 已有路径安全校验
      const mime = detectMime(buffer, "application/octet-stream");
      const filename = path.basename(source.startsWith("file://") ? source.replace(/^file:\/\//, "") : source);
      await adapter.sendMediaBuffer(chatId, buffer, { mime, filename, userId });
    } else if (adapter.sendMedia) {
      await adapter.sendMedia(chatId, source, { userId });
    } else {
      await adapter.sendReply(chatId, source);
    }
  }

  _buildMediaFallbackText(source, err) {
    const msg = String(err?.message || "");
    const low = msg.toLowerCase();

    if (low.includes("413") || low.includes("too large") || low.includes("request entity too large")) {
      return "文件发送失败：文件过大，平台拒绝上传。请换小文件或压缩后重试。";
    }
    if (low.includes("path outside allowed roots") || low.includes("file not found")) {
      return "文件发送失败：本地路径不可访问或文件不存在。请提供绝对路径并确认文件仍在。";
    }
    if (low.includes("qq") && low.includes("file_type=4")) {
      return "文件发送失败：QQ 当前会话类型不支持普通文件。可改发图片/视频或下载链接。";
    }

    if (typeof source === "string" && /^https?:\/\//i.test(source)) return source;
    const name = typeof source === "string" ? path.basename(source) : "文件";
    return `文件发送失败：${name}。请稍后重试或换一种发送方式。`;
  }

  /**
   * 清理发给外部平台的回复：
   * - 去除中间思考代码块
   * - 去除 <tool_code> 标签
   */
  _cleanReplyForPlatform(text) {
    let cleaned = String(text || "");

    // 若模型显式给出 <final>，只发送 final；否则退化到 <replying>。
    const finalMatches = [...cleaned.matchAll(/<final>\s*([\s\S]*?)\s*<\/final>/gi)];
    if (finalMatches.length) {
      cleaned = finalMatches[finalMatches.length - 1][1];
    } else {
      const replyingMatches = [...cleaned.matchAll(/<replying>\s*([\s\S]*?)\s*<\/replying>/gi)];
      if (replyingMatches.length) {
        cleaned = replyingMatches[replyingMatches.length - 1][1];
      }
    }

    // 丢弃所有中间思考块（而不是仅去标签保留内容）
    cleaned = cleaned.replace(/```(?:think|analysis|commentary|summary)[\s\S]*?```\n*/gi, "");
    cleaned = cleaned.replace(/<(?:think|analysis|commentary|summary)>[\s\S]*?<\/(?:think|analysis|commentary|summary)>\s*/gi, "");
    cleaned = cleaned.replace(/<xing\s+title=["\u201C\u201D][^"\u201C\u201D]*["\u201C\u201D]>[\s\S]*?<\/xing>\s*/gi, "");
    cleaned = cleaned.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/gi, "");
    cleaned = cleaned.replace(/<mouth\b[^>]*>[\s\S]*?<\/mouth>\s*/gi, "");
    cleaned = cleaned.replace(/<meta\b[^>]*>[\s\S]*?<\/meta>\s*/gi, "");

    // final/replying 只保留内容，移除可能残留的包裹标签
    cleaned = cleaned.replace(/<\/?(?:final|replying)\s*>/gi, "");
    return cleaned.trim();
  }


  /**
   * 主动发送消息给最近私聊对象（不需要用户先发消息）
   * 用于心跳/cron 升级到 IM 的场景。
   *
   * @param {string} text - 要发送的文本（会自动 clean 控制标签）
   * @param {{ agentId?: string|null, platform?: "wechat"|"telegram"|"feishu"|"qq"|null, strict?: boolean }} [opts]
   * @returns {{ platform: string, chatId: string } | null} 发送成功返回平台信息，失败返回 null
   */
  async sendProactive(text, opts = {}) {
    const scopedAgentId = typeof opts?.agentId === "string" ? opts.agentId.trim() : "";
    const scopedPlatform = (() => {
      const v = String(opts?.platform || "").trim().toLowerCase();
      return (v === "wechat" || v === "telegram" || v === "feishu" || v === "qq") ? v : "";
    })();
    const strictMode = opts?.strict === true;
    const cleaned = this._cleanReplyForPlatform(text);
    if (!cleaned) return null;

    let matchedPlatform = 0;
    let matchedConnected = 0;
    let noTargetCount = 0;
    let lastSendError = null;

    // 按优先级尝试已连接的平台
    for (const [platformKey, entry] of this._platforms) {
      const basePlatform = entry.platform || parsePlatformKey(platformKey).platform || platformKey;
      if (scopedPlatform && basePlatform !== scopedPlatform) continue;
      if (scopedPlatform) matchedPlatform++;
      if (entry.status !== "connected" || !entry.adapter) continue;
      if (scopedPlatform) matchedConnected++;
      const resolvedAgentId = this._resolveTargetAgentId(platformKey, entry?.agentId);

      // 指定 agentId 时，仅向同 agent 绑定的平台实例发送，避免跨 agent 串推送。
      if (scopedAgentId && resolvedAgentId && resolvedAgentId !== scopedAgentId) continue;

      const ownerAgentId = resolvedAgentId || scopedAgentId || null;
      const target = this._pickLatestDmTarget(platformKey, ownerAgentId);
      if (!target) {
        noTargetCount++;
        continue;
      }

      // QQ 私信可能需要 guild_id，通过 adapter 做 userId -> guildId 解析
      const chatId = basePlatform === "qq"
        ? (entry.adapter.resolveOwnerChatId?.(target.chatId) || target.chatId)
        : target.chatId;
      try {
        await entry.adapter.sendReply(chatId, cleaned);
        debugLog()?.log("bridge", `→ ${platformKey} proactive to latest dm (${cleaned.length} chars)`);
        this._pushMessage({
          platform: basePlatform, direction: "out", sessionKey: target.sessionKey,
          sender: this.engine.agentName, text: cleaned,
          isGroup: false, ts: Date.now(),
        });

        return { platform: basePlatform, chatId, sessionKey: target.sessionKey };
      } catch (err) {
        lastSendError = err;
        console.error(`[bridge] proactive send failed (${platformKey}): ${err.message}`);
        debugLog()?.error("bridge", `proactive send failed (${platformKey}): ${err.message}`);
      }
    }

    if (strictMode && scopedPlatform) {
      if (matchedPlatform === 0) throw new Error(`未找到平台 ${scopedPlatform} 的绑定实例`);
      if (matchedConnected === 0) throw new Error(`平台 ${scopedPlatform} 未连接`);
      if (lastSendError) throw new Error(`平台 ${scopedPlatform} 发送失败: ${lastSendError.message}`);
      if (noTargetCount > 0) throw new Error(`平台 ${scopedPlatform} 暂无可用私聊会话，无法主动提醒`);
      throw new Error(`平台 ${scopedPlatform} 发送失败`);
    }

    return null;
  }

  /** 为指定平台实例（platformKey）选择最近活跃的私聊目标 */
  _pickLatestDmTarget(platformKey, agentId = null) {
    const index = this.engine.getBridgeIndex?.(agentId) || {};
    const ownerAgent = agentId ? this.engine.getAgent?.(agentId) : this.engine.agent;
    const bridgeDir = path.join(ownerAgent?.sessionDir || this.engine.agent.sessionDir, "bridge");
    let best = null;

    for (const [sessionKey, raw] of Object.entries(index)) {
      const entry = typeof raw === "string" ? { file: raw } : raw;
      if (!entry?.file) continue;

      const parsed = parseSessionKey(sessionKey);
      if (parsed.platformKey !== platformKey || parsed.chatType !== "dm") continue;

      const sessionPath = path.join(bridgeDir, entry.file);
      let lastActive = 0;
      try {
        lastActive = fs.statSync(sessionPath).mtimeMs || 0;
      } catch {}

      if (!best || lastActive > best.lastActive) {
        best = { sessionKey, chatId: parsed.chatId, lastActive };
      }
    }

    return best ? { sessionKey: best.sessionKey, chatId: best.chatId } : null;
  }

  /**
   * 从桌面端发送本地文件到 bridge 平台
   * @param {string} platform
   * @param {string} chatId
   * @param {string} filePath - 已校验过安全性的本地文件路径
   */
  async sendMediaFile(platform, chatId, filePath) {
    const entry = this._platforms.get(platform)
      || [...this._platforms.values()].find((e) => e?.platform === platform && e?.status === "connected")
      || [...this._platforms.values()].find((e) => e?.platform === platform);
    if (!entry?.adapter) throw new Error(`platform ${platform} not connected`);

    const buffer = fs.readFileSync(filePath);
    const mime = detectMime(buffer, "application/octet-stream");
    const filename = path.basename(filePath);

    // 优先用 sendMediaBuffer（接受 Buffer 的直传方法），fallback 到 sendMedia（URL）
    const ownerUserId = entry?.platform === "qq"
      ? (entry.adapter.resolveOwnerUserId?.(chatId) || null)
      : null;

    if (entry.adapter.sendMediaBuffer) {
      await entry.adapter.sendMediaBuffer(chatId, buffer, { mime, filename, userId: ownerUserId || undefined });
    } else if (mime.startsWith("image/") && entry.adapter.sendMedia) {
      // data URL fallback（飞书 sendMedia 内部通过 downloadMedia 解析 data URL）
      // 注：QQ 的 sendMedia 需要公开 HTTP URL，data URL 不支持
      const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
      await entry.adapter.sendMedia(chatId, dataUrl, { userId: ownerUserId || undefined });
    } else {
      await entry.adapter.sendReply(chatId, `[文件: ${filename}]`);
    }
  }

  /** 广播状态到前端（通过 Hub EventBus） */
  _emitStatus(platform, status, error, botId = null) {
    this._hub.eventBus.emit(
      { type: "bridge_status", platform, botId, status, error: error || null },
      null,
    );
  }

  /** 记录消息并广播到前端 */
  _pushMessage(entry) {
    this._messageLog.push(entry);
    if (this._messageLog.length > this._messageLogMax) {
      this._messageLog.shift();
    }
    this._hub.eventBus.emit(
      { type: "bridge_message", message: entry },
      null,
    );
  }

  /** 获取最近消息日志（供 REST API 使用） */
  getMessages(limit = 50) {
    return this._messageLog.slice(-limit);
  }
}
