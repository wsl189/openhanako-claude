import { Type } from "@sinclair/typebox";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { callProviderVision } from "../llm/provider-client.js";
import { getLocale, t } from "../../server/i18n.js";
import { readSessionMetadata } from "../../core/claude-session-store.js";
import { buildSessionMessagesFromSession } from "../../core/claude-transcript.js";

function dedupeIds(ids = [], max) {
  const set = new Set();
  for (const raw of ids) {
    const n = Number(raw);
    if (!Number.isInteger(n)) continue;
    if (n < 1 || n > max) continue;
    set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

function pickImages(allImages, ids = []) {
  if (!ids.length) {
    return allImages.map((img, idx) => ({ ...img, imageId: idx + 1 }));
  }
  return ids
    .map((id) => ({ ...allImages[id - 1], imageId: id }))
    .filter((img) => img?.data);
}

function defaultPrompt() {
  const isZh = getLocale().startsWith("zh");
  return isZh
    ? "请逐张描述图片中的关键内容，并提取与用户问题相关的信息。"
    : "Describe each image and extract details relevant to the user's request.";
}

const MIME_BY_EXT = {
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
  return !!MIME_BY_EXT[ext];
}

function sanitizeInputPath(rawPath = "") {
  let p = String(rawPath || "").trim();
  if (!p) return "";
  if (p.startsWith("<") && p.endsWith(">")) p = p.slice(1, -1).trim();
  p = p.replace(/^["']|["']$/g, "");
  p = p.replace(/\\ /g, " ");
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      // ignore invalid file:// URI and keep original value
    }
  }
  if (p.includes("%")) {
    try {
      p = decodeURIComponent(p);
    } catch {
      // ignore malformed percent-encoding
    }
  }
  return p;
}

function isAbsolutePathAnyPlatform(filePath = "") {
  const p = String(filePath || "");
  return path.isAbsolute(p) || path.win32.isAbsolute(p);
}

function getExplicitImagePaths(params = {}) {
  const raw = [];
  if (Array.isArray(params?.image_paths)) raw.push(...params.image_paths);
  else if (typeof params?.image_paths === "string") raw.push(params.image_paths);
  if (typeof params?.image_path === "string") raw.push(params.image_path);

  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const p = sanitizeInputPath(item);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (!c) return "";
        if (typeof c === "string") return c;
        if (c.type === "text" && typeof c.text === "string") return c.text;
        if (typeof c.content === "string") return c.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function extractImagePathsFromMessages(messages = []) {
  const candidates = [];
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    // 频道/桥接场景里，附件路径可能出现在 custom/system 转写消息里，不只 user 角色。
    const text = extractText(m?.content || "");
    if (!text) continue;

    const lines = text.split(/\r?\n/);
    for (const lineRaw of lines) {
      const line = String(lineRaw || "").trim();
      if (!line) continue;

      // 匹配前端拼接的附件行：`[附件] /abs/path/to/file.png`
      const tagged = line.match(/(?:^|\s)\[(?:附件|attachment)\]\s+(.+)$/i);
      if (tagged?.[1]) {
        const p = tagged[1]
          .trim()
          .replace(/^["']|["']$/g, "")
          .replace(/[),.;:!?]+$/g, "");
        if (p) candidates.push(p);
        continue;
      }

      // 兜底：行内直接出现的绝对图片路径（支持路径里有空格）
      const absPathMatches = line.match(/(\/[^\n]*?\.(?:png|jpe?g|gif|webp|bmp|svg|ico))/ig);
      if (absPathMatches?.length) {
        for (const hit of absPathMatches) {
          const p = hit
            .trim()
            .replace(/^["']|["']$/g, "")
            .replace(/[),.;:!?]+$/g, "");
          if (p) candidates.push(p);
        }
      }
    }
  }
  const unique = [];
  const seen = new Set();
  for (const p of candidates) {
    if (seen.has(p)) continue;
    seen.add(p);
    unique.push(p);
  }
  return unique;
}

function readSessionMessagesFromFile(sessionPath = "") {
  const fp = String(sessionPath || "").trim();
  if (!fp) return [];
  try {
    const metadata = readSessionMetadata(fp);
    return buildSessionMessagesFromSession({
      sessionId: metadata.sessionId,
      cwd: metadata.cwd,
      limit: 200,
    });
  } catch {
    return [];
  }
}

function readImagesFromPaths(paths = [], maxCount = 10) {
  const out = [];
  for (const p of paths) {
    if (out.length >= maxCount) break;
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) continue;
      if (!isImagePath(p)) continue;
      const ext = path.extname(p).toLowerCase();
      const mimeType = MIME_BY_EXT[ext] || "image/png";
      const data = fs.readFileSync(p).toString("base64");
      if (!data) continue;
      out.push({ data, mimeType, sourcePath: p });
    } catch {
      // ignore unreadable/non-existent path
    }
  }
  return out;
}

function readImagesFromExplicitPaths(paths = [], maxCount = 10) {
  const out = [];
  const errors = [];

  for (const p of paths) {
    if (out.length >= maxCount) break;

    if (!isAbsolutePathAnyPlatform(p)) {
      errors.push(t("error.imageToolPathNotAbsolute", { path: p }));
      continue;
    }

    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) {
        errors.push(t("error.imageToolPathNotFound", { path: p }));
        continue;
      }
    } catch {
      errors.push(t("error.imageToolPathNotFound", { path: p }));
      continue;
    }

    if (!isImagePath(p)) {
      errors.push(t("error.imageToolPathNotImage", { path: p }));
      continue;
    }

    try {
      const ext = path.extname(p).toLowerCase();
      const mimeType = MIME_BY_EXT[ext] || "image/png";
      const data = fs.readFileSync(p).toString("base64");
      if (!data) {
        errors.push(t("error.imageToolPathNotFound", { path: p }));
        continue;
      }
      out.push({ data, mimeType, sourcePath: p });
    } catch {
      errors.push(t("error.imageToolPathNotFound", { path: p }));
    }
  }

  return { images: out, errors: [...new Set(errors)] };
}

export function createDescribeImagesTool({
  getSessionImages,
  getCurrentSessionPath,
  getLatestSessionImages,
  getSessionMessages,
  resolveVisionModel,
} = {}) {
  return {
    name: "describe_images",
    label: t("toolDef.describeImages.label"),
    description: t("toolDef.describeImages.description"),
    parameters: Type.Object({
      image_ids: Type.Optional(
        Type.Array(Type.Number({ description: t("toolDef.describeImages.imageIdsDesc") })),
      ),
      image_paths: Type.Optional(
        Type.Array(Type.String(), { description: t("toolDef.describeImages.imagePathsDesc") }),
      ),
      image_path: Type.Optional(Type.String({ description: t("toolDef.describeImages.imagePathDesc") })),
      prompt: Type.Optional(Type.String({ description: t("toolDef.describeImages.promptDesc") })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const sessionPath =
        ctx?.sessionManager?.getSessionFile?.() ||
        getCurrentSessionPath?.() ||
        null;
      const explicitPaths = getExplicitImagePaths(params);
      const hasExplicitPaths = explicitPaths.length > 0;
      let pathErrors = [];

      let allImages = [];
      if (hasExplicitPaths) {
        const fromPaths = readImagesFromExplicitPaths(explicitPaths, 10);
        allImages = fromPaths.images;
        pathErrors = fromPaths.errors;
      } else {
        allImages = getSessionImages?.(sessionPath) || [];
        if (!allImages.length) {
          const activePath = getCurrentSessionPath?.() || null;
          if (activePath && activePath !== sessionPath) {
            allImages = getSessionImages?.(activePath) || [];
          }
        }
        if (!allImages.length) {
          allImages = getLatestSessionImages?.() || [];
        }
        if (!allImages.length) {
          const msgSessionPath = sessionPath || getCurrentSessionPath?.() || null;
          let messages = getSessionMessages?.(msgSessionPath) || [];
          if (!messages.length) {
            // 频道等隔离临时会话不在 engine 的 session map 中，兜底直接读 session 文件。
            messages = readSessionMessagesFromFile(msgSessionPath);
          }
          const imagePaths = extractImagePathsFromMessages(messages);
          allImages = readImagesFromPaths(imagePaths, 10);
        }
      }
      if (!allImages.length) {
        const msg = hasExplicitPaths
          ? (pathErrors.length ? pathErrors.join("\n") : t("error.imageToolNoImagesFromPaths"))
          : t("error.imageToolNoImages");
        return {
          content: [{ type: "text", text: msg }],
          details: {
            error: hasExplicitPaths ? "no_images_from_paths" : "no_images",
            pathErrors: pathErrors.length ? pathErrors : undefined,
          },
        };
      }

      const ids = dedupeIds(params?.image_ids || [], allImages.length);
      const selected = pickImages(allImages, ids);
      if (!selected.length) {
        const msg = hasExplicitPaths ? t("error.imageToolNoImagesFromPaths") : t("error.imageToolNoImages");
        return {
          content: [{ type: "text", text: msg }],
          details: { error: "no_selected_images" },
        };
      }

      let resolved = null;
      try {
        resolved = resolveVisionModel?.();
      } catch (err) {
        return {
          content: [{ type: "text", text: t("error.imageToolNoModel") + ` (${err.message})` }],
          details: { error: "resolve_model_failed", message: err.message },
        };
      }
      if (!resolved?.model || !resolved?.api || !resolved?.base_url) {
        return {
          content: [{ type: "text", text: t("error.imageToolNoModel") }],
          details: { error: "missing_model_config" },
        };
      }

      const toolPrompt = String(params?.prompt || "").trim() || defaultPrompt();
      const imageHeader = selected.map((img) => `Image #${img.imageId}`).join(", ");
      const finalPrompt = `${toolPrompt}\n\n${imageHeader}`;

      try {
        const text = await callProviderVision({
          api: resolved.api,
          api_key: resolved.api_key,
          base_url: resolved.base_url,
          model: resolved.model,
          prompt: finalPrompt,
          images: selected.map((img) => ({ data: img.data, mimeType: img.mimeType })),
          max_tokens: 1200,
        });
        return {
          content: [{ type: "text", text }],
          details: {
            model: resolved.model,
            imageCount: selected.length,
            imageIds: selected.map((img) => img.imageId),
            sourcePaths: selected.map((img) => img.sourcePath).filter(Boolean),
            pathErrors: pathErrors.length ? pathErrors : undefined,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: t("error.imageToolVisionFailed", { msg: err.message }) }],
          details: {
            error: "vision_call_failed",
            message: err.message,
            imageCount: selected.length,
            pathErrors: pathErrors.length ? pathErrors : undefined,
          },
        };
      }
    },
  };
}
