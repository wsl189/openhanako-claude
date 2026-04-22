/**
 * media-utils.js — Bridge 媒体工具层
 *
 * 对标 OpenClaw 的 loadWebMedia + splitMediaFromOutput。
 * 集中处理入站媒体下载和出站回复媒体提取。
 */

import fs from "fs";
import path from "path";

// ── 本地路径安全白名单（对标 OpenClaw mediaLocalRoots）────

let _allowedRoots = [];

/**
 * 设置允许读取的本地目录白名单。
 * 由 BridgeManager 初始化时调用，传入 HANA_HOME 和 workspace。
 */
export function setMediaLocalRoots(roots) {
  const dedup = new Set();
  const resolved = [];
  for (const r of roots || []) {
    if (!r) continue;
    let p;
    try { p = path.resolve(r); }
    catch { continue; }
    if (dedup.has(p)) continue;
    dedup.add(p);
    resolved.push(p);
  }
  _allowedRoots = resolved;
}

function isPathAllowed(filePath) {
  const resolved = path.resolve(filePath);
  return _allowedRoots.some(root =>
    resolved === root || resolved.startsWith(root + path.sep)
  );
}

function resolveFilesAlias(localPath) {
  const match = /^\/?files\/(.+)$/.exec(String(localPath || ""));
  if (!match) return null;
  const relRaw = match[1];
  let rel = relRaw;
  try { rel = decodeURIComponent(relRaw); }
  catch { rel = relRaw; }

  const parts = rel.split(/[\\/]+/).filter(Boolean);
  const base = parts[parts.length - 1] || path.basename(rel);
  const relDropFirst = parts.length > 1 ? parts.slice(1).join(path.sep) : "";

  for (const root of _allowedRoots) {
    const candidates = [
      path.resolve(root, rel),
      path.resolve(root, "files", rel),
      relDropFirst ? path.resolve(root, relDropFirst) : null,
      relDropFirst ? path.resolve(root, "files", relDropFirst) : null,
      base ? path.resolve(root, base) : null,
      base ? path.resolve(root, "files", base) : null,
    ];
    const uniqCandidates = [...new Set(candidates.filter(Boolean))];
    for (const candidate of uniqCandidates) {
      try {
        const real = fs.realpathSync(candidate);
        if (isPathAllowed(real)) return real;
      } catch {
        // try next candidate
      }
    }
  }
  return null;
}

function resolveLocalPath(localPath) {
  const s = String(localPath || "");

  // 兼容模型输出的 /files/<relative> 别名（映射到 allowedRoots 下存在的文件）
  const fromAlias = resolveFilesAlias(s);
  if (fromAlias) return fromAlias;

  if (!path.isAbsolute(s)) {
    throw new Error(`unsupported media source: ${s.slice(0, 30)}`);
  }

  let realPath;
  try { realPath = fs.realpathSync(s); }
  catch { throw new Error(`file not found: ${s}`); }
  if (!isPathAllowed(realPath)) {
    throw new Error(`path outside allowed roots`);
  }
  return realPath;
}

// ── 入站：下载媒体 ──────────────────────────────────────

/**
 * 下载媒体资源，返回 Buffer。
 * 支持 http:// / https:// / data: / 本地路径（需在白名单内）。
 */
export async function downloadMedia(url) {
  if (!url || typeof url !== "string") {
    throw new Error("missing media source");
  }
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma === -1) throw new Error("invalid data URI");
    return Buffer.from(url.slice(comma + 1), "base64");
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`download failed: ${resp.status} ${resp.statusText}`);
    return Buffer.from(await resp.arrayBuffer());
  }
  // 本地路径（file:// URI 或绝对路径）
  const localPath = url.startsWith("file://") ? fileUrlToPath(url) : url;
  const realPath = resolveLocalPath(localPath);
  // 大小保护（50MB）
  const stat = fs.statSync(realPath);
  if (stat.size > 50 * 1024 * 1024) {
    throw new Error(`file too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
  }
  return fs.readFileSync(realPath);
}

/** file:// URI → 本地路径 */
function fileUrlToPath(fileUrl) {
  try { return new URL(fileUrl).pathname; }
  catch { return fileUrl.replace(/^file:\/\//, ""); }
}

/**
 * Buffer → base64 字符串（不含 data: 前缀）
 */
export function bufferToBase64(buffer) {
  return buffer.toString("base64");
}

// ── MIME 检测（magic bytes）─────────────────────────────

const MAGIC_TABLE = [
  { bytes: [0xFF, 0xD8, 0xFF],                         mime: "image/jpeg" },
  { bytes: [0x89, 0x50, 0x4E, 0x47],                   mime: "image/png" },
  { bytes: [0x47, 0x49, 0x46, 0x38],                   mime: "image/gif" },
  { bytes: [0x23, 0x21, 0x41, 0x4D, 0x52],             mime: "audio/amr" }, // "#!AMR"
  { bytes: [0x23, 0x21, 0x53, 0x49, 0x4C, 0x4B],       mime: "audio/silk" }, // "#!SILK"
  { bytes: [0x52, 0x49, 0x46, 0x46],                   mime: "audio/wav", offset: 8, extra: [0x57, 0x41, 0x56, 0x45] },
  { bytes: [0x52, 0x49, 0x46, 0x46],                   mime: "image/webp", offset: 8, extra: [0x57, 0x45, 0x42, 0x50] },
  { bytes: [0x25, 0x50, 0x44, 0x46],                   mime: "application/pdf" },
  { bytes: [0x49, 0x44, 0x33],                         mime: "audio/mpeg" },
  { bytes: [0x4F, 0x67, 0x67, 0x53],                   mime: "audio/ogg" },
  { bytes: [0x00, 0x00, 0x00],                         mime: "video/mp4", minLen: 8, check: (b) => b.length >= 8 && (b.toString("ascii", 4, 8) === "ftyp") },
];

/**
 * 检测 Buffer 的真实 MIME（magic bytes 优先）。
 * 检测不出时返回 fallback 或 "application/octet-stream"。
 */
export function detectMime(buffer, fallback) {
  for (const entry of MAGIC_TABLE) {
    if (buffer.length < entry.bytes.length) continue;
    const match = entry.bytes.every((b, i) => buffer[i] === b);
    if (!match) continue;
    if (entry.extra) {
      const off = entry.offset || 0;
      if (buffer.length < off + entry.extra.length) continue;
      if (!entry.extra.every((b, i) => buffer[off + i] === b)) continue;
    }
    if (entry.check && !entry.check(buffer)) continue;
    return entry.mime;
  }
  return fallback || "application/octet-stream";
}

// ── 出站：从 LLM 回复中提取媒体 ────────────────────────

const MEDIA_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg|pdf|mp4|mov|mkv|avi|mp3|wav|ogg|m4a|opus|amr|silk|zip|rar|7z|docx?|xlsx?|pptx?|txt|md|json)$/i;

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

  // 支持 MEDIA:<...> 与 MEDIA:"..."
  if (source.startsWith("<") && source.endsWith(">")) {
    source = source.slice(1, -1).trim();
  } else {
    const qm = /^(['"])([\s\S]*?)\1$/.exec(source);
    if (qm) source = qm[2].trim();
  }

  // 容错：如果模型把说明文本拼在同一行，尽量截到真实文件扩展名结束
  if ((source.startsWith("/") || source.startsWith("file://") || source.startsWith("http://") || source.startsWith("https://")) && !MEDIA_EXT_RE.test(source)) {
    const cut = source.match(/^(.*?\.(?:png|jpe?g|gif|webp|bmp|svg|pdf|mp4|mov|mkv|avi|mp3|wav|ogg|m4a|opus|amr|silk|zip|rar|7z|docx?|xlsx?|pptx?|txt|md|json))(?=\s|$)/i);
    if (cut?.[1]) source = cut[1].trim();
  }

  return source;
}
const IMG_MD_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/;

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

function validateMediaSource(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return { ok: true };
    }
    if (u.protocol === "file:") {
      try {
        resolveLocalPath(fileUrlToPath(url));
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: String(err?.message || "invalid local path") };
      }
    }
    return { ok: false, reason: `unsupported protocol: ${u.protocol}` };
  } catch {
    try {
      resolveLocalPath(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String(err?.message || "invalid local path") };
    }
  }
}

function formatMediaError(reason = "") {
  const low = String(reason).toLowerCase();
  if (low.includes("path outside allowed roots")) {
    return "文件发送失败：路径不在允许目录内。";
  }
  if (low.includes("file not found")) {
    return "文件发送失败：未找到本地文件。";
  }
  if (low.includes("unsupported media source")) {
    return "文件发送失败：媒体路径格式无效。";
  }
  return "文件发送失败：媒体路径无效或不可访问。";
}

/**
 * 对标 OpenClaw splitMediaFromOutput()
 *
 * 提取规则（按优先级）：
 * 1. MEDIA:<url> 指令行（主协议，不区分媒体类型）
 * 2. ![alt](url) markdown 图片（弱 fallback）
 *
 * 安全规则：
 * - 不从 fenced code block 内提取
 * - 无效 URL 静默丢弃
 *
 * @param {string} text
 * @returns {{ text: string, mediaUrls: string[] }}
 */
export function splitMediaFromOutput(text) {
  const mediaUrls = [];
  const mediaErrors = [];
  const outputLines = [];
  let inFence = false;
  let inMediaTag = false;
  const mediaTagLines = [];

  const collectMedia = (sourceRaw) => {
    const source = String(sourceRaw || "").trim();
    if (!source) return;
    const verdict = validateMediaSource(source);
    if (verdict.ok) {
      mediaUrls.push(source);
    } else {
      mediaErrors.push(formatMediaError(verdict.reason));
    }
  };

  for (const line of text.split("\n")) {
    // 追踪 code fence 状态
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      outputLines.push(line);
      continue;
    }

    if (inFence) {
      outputLines.push(line);
      continue;
    }

    // 兼容多行 <media> ... </media> 标签块
    if (inMediaTag) {
      const closeIdx = line.toLowerCase().indexOf("</media>");
      if (closeIdx !== -1) {
        mediaTagLines.push(line.slice(0, closeIdx));
        const blockText = mediaTagLines.join("\n").trim();
        const sources = extractMediaSourcesFromBlock(blockText);
        if (sources.length) {
          for (const src of sources) collectMedia(src);
        } else {
          collectMedia(blockText);
        }
        mediaTagLines.length = 0;
        inMediaTag = false;
      } else {
        mediaTagLines.push(line);
      }
      // 无论是否闭合，都不泄漏媒体路径
      continue;
    }

    const trimmed = line.trim();
    if (/^<media>/i.test(trimmed)) {
      const afterOpen = trimmed.slice("<media>".length);
      const closeIdx = afterOpen.toLowerCase().indexOf("</media>");
      if (closeIdx !== -1) {
        const blockText = afterOpen.slice(0, closeIdx).trim();
        const sources = extractMediaSourcesFromBlock(blockText);
        if (sources.length) {
          for (const src of sources) collectMedia(src);
        } else {
          collectMedia(blockText);
        }
      } else {
        inMediaTag = true;
        mediaTagLines.push(afterOpen);
      }
      continue;
    }

    // 1. MEDIA:<url> 指令行
    const mediaSource = extractMediaSourceFromLine(line);
    if (mediaSource !== null) {
      collectMedia(mediaSource);
      // 无论是否有效都从输出中移除（不泄漏）
      continue;
    }

    // 2. ![alt](url) markdown 图片（弱 fallback，只从独立行提取）
    const imgMatch = IMG_MD_RE.exec(line);
    if (imgMatch && line.trim() === imgMatch[0]) {
      // 整行就是一个图片标记
      if (isValidMediaSource(imgMatch[1])) {
        mediaUrls.push(imgMatch[1]);
      }
      continue;
    }

    outputLines.push(line);
  }

  // 未闭合 <media> 标签：回退为普通文本，避免吞掉后续内容
  if (inMediaTag && mediaTagLines.length) {
    outputLines.push(`<media>${mediaTagLines.join("\n")}`);
  }

  return {
    text: outputLines.join("\n").trim(),
    mediaUrls,
    mediaErrors: [...new Set(mediaErrors)],
  };
}

function isValidMediaSource(url) {
  return validateMediaSource(url).ok;
}

// ── 工具函数 ────────────────────────────────────────────

/**
 * Readable stream → Buffer
 */
export async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 格式化文件大小
 */
export function formatSize(bytes) {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
