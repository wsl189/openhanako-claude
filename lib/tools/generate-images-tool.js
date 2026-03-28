import { Type } from "@sinclair/typebox";
import fs from "fs";
import path from "path";
import { callProviderImageGeneration, callModelscopeImageGeneration } from "../llm/provider-client.js";
import { t } from "../../server/i18n.js";

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

function isImagePath(filePath = "") {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return !!MIME_BY_EXT[ext];
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
    const text = extractText(m?.content || "");
    if (!text) continue;

    const lines = text.split(/\r?\n/);
    for (const lineRaw of lines) {
      const line = String(lineRaw || "").trim();
      if (!line) continue;

      const tagged = line.match(/(?:^|\s)\[(?:附件|attachment)\]\s+(.+)$/i);
      if (tagged?.[1]) {
        const p = tagged[1]
          .trim()
          .replace(/^["']|["']$/g, "")
          .replace(/[),.;:!?]+$/g, "");
        if (p) candidates.push(p);
        continue;
      }

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
    const raw = fs.readFileSync(fp, "utf-8");
    if (!raw.trim()) return [];
    const lines = raw.split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      const s = String(line || "").trim();
      if (!s) continue;
      try {
        const entry = JSON.parse(s);
        if (entry?.type === "message" && entry?.message) {
          out.push(entry.message);
        }
      } catch {
        // ignore malformed lines
      }
    }
    return out;
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

function sanitizeBase64(input = "") {
  const text = String(input || "").trim();
  if (!text) return "";
  const match = text.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/i);
  return (match?.[1] || text).trim();
}

function resolveMinimaxImageBaseUrl(rawBaseUrl = "") {
  const input = String(rawBaseUrl || "").trim();
  if (!input) return "https://api.minimaxi.com/v1";
  // 聊天常用 anthropic 网关，生图需走 /v1/image_generation
  if (/\/anthropic(?:\/v1)?\/?$/i.test(input)) {
    return input.replace(/\/anthropic(?:\/v1)?\/?$/i, "/v1");
  }
  return input;
}

function isModelscopeProvider(provider = "") {
  return String(provider || "").toLowerCase().includes("modelscope");
}

function providerFamily(provider = "") {
  return isModelscopeProvider(provider) ? "modelscope" : "minimax";
}

function normalizeProviderChoice(input = "") {
  const v = String(input || "").trim().toLowerCase();
  if (v === "modelscope") return "modelscope";
  return "minimax";
}

function resolveOutputDir(ctx) {
  const cwd = ctx?.sessionManager?.getCwd?.() || process.cwd();
  // 直接保存到工作区根目录，避免额外隐藏目录
  return path.resolve(cwd);
}

export function createGenerateImagesTool({
  getSessionImages,
  getCurrentSessionPath,
  getLatestSessionImages,
  getSessionMessages,
  resolveImageGenerationModel,
} = {}) {
  return {
    name: "generate_images",
    label: t("toolDef.generateImages.label"),
    description: t("toolDef.generateImages.description"),
    parameters: Type.Object({
      prompt: Type.String({ description: t("toolDef.generateImages.promptDesc") }),
      mode: Type.Optional(Type.Union([
        Type.Literal("auto"),
        Type.Literal("text2image"),
        Type.Literal("image2image"),
      ], { description: t("toolDef.generateImages.modeDesc") })),
      image_ids: Type.Optional(
        Type.Array(Type.Number({ description: t("toolDef.generateImages.imageIdsDesc") })),
      ),
      provider: Type.Optional(Type.Union([
        Type.Literal("minimax"),
        Type.Literal("modelscope"),
      ], { description: t("toolDef.generateImages.providerDesc") })),
      reference_type: Type.Optional(Type.String({ description: t("toolDef.generateImages.referenceTypeDesc") })),
      count: Type.Optional(Type.Number({ description: t("toolDef.generateImages.countDesc") })),
      width: Type.Optional(Type.Number({ description: t("toolDef.generateImages.widthDesc") })),
      height: Type.Optional(Type.Number({ description: t("toolDef.generateImages.heightDesc") })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const prompt = String(params?.prompt || "").trim();
      if (!prompt) {
        return {
          content: [{ type: "text", text: t("error.imageGenPromptRequired") }],
          details: { error: "missing_prompt" },
        };
      }

      let resolved = null;
      try {
        resolved = resolveImageGenerationModel?.();
      } catch (err) {
        return {
          content: [{ type: "text", text: err?.message || t("error.providerMissingCreds", { provider: "minimax" }) }],
          details: { error: "resolve_model_failed", message: err?.message || "" },
        };
      }

      const requestedMode = String(params?.mode || "auto").toLowerCase();
      const count = Math.max(1, Math.min(4, Number(params?.count) || 1));
      const width = Math.max(256, Math.min(2048, Number(params?.width) || 1024));
      const height = Math.max(256, Math.min(2048, Number(params?.height) || 1024));
      const referenceType = String(params?.reference_type || "character").trim() || "character";

      const sessionPath =
        ctx?.sessionManager?.getSessionFile?.() ||
        getCurrentSessionPath?.() ||
        null;

      let allImages = getSessionImages?.(sessionPath) || [];
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
          messages = readSessionMessagesFromFile(msgSessionPath);
        }
        const imagePaths = extractImagePathsFromMessages(messages);
        allImages = readImagesFromPaths(imagePaths, 10);
      }

      const ids = dedupeIds(params?.image_ids || [], allImages.length);
      const selectedImages = pickImages(allImages, ids);

      const mode = requestedMode === "auto"
        ? (selectedImages.length ? "image2image" : "text2image")
        : requestedMode;

      if (mode === "image2image" && selectedImages.length === 0) {
        return {
          content: [{ type: "text", text: t("error.imageGenI2INoImages") }],
          details: { error: "no_images_for_i2i" },
        };
      }

      const subjectReference = mode === "image2image"
        ? selectedImages.slice(0, 4).map((img) => ({
            type: referenceType,
            image_file: `data:${img.mimeType || "image/png"};base64,${img.data}`,
          }))
        : undefined;

      try {
        const resolvePrimaryCandidate = () => {
          const provider = String(resolved?.provider || "").toLowerCase();
          if (isModelscopeProvider(provider)) {
            return {
              provider: "modelscope",
              api: "openai-completions",
              api_key: resolved.api_key,
              base_url: resolved.base_url,
              model: resolved.model || "Qwen/Qwen-Image-2512",
            };
          }
          return {
            provider: resolved?.provider || "minimax",
            api: "openai-completions",
            api_key: resolved.api_key,
            base_url: resolveMinimaxImageBaseUrl(resolved.base_url),
            model: "image-01",
          };
        };
        const primary = resolvePrimaryCandidate();
        const fallbackRaw = resolved?.fallback || null;
        const fallback = fallbackRaw
          ? {
              provider: fallbackRaw.provider || "modelscope",
              api: fallbackRaw.api || "openai-completions",
              api_key: fallbackRaw.api_key || "",
              base_url: fallbackRaw.base_url || "",
              model: fallbackRaw.model || "Qwen/Qwen-Image-2512",
            }
          : null;

        const requestedProvider = normalizeProviderChoice(params?.provider);

        const callWithCandidate = async (candidate) => {
          if (isModelscopeProvider(candidate.provider)) {
            return callModelscopeImageGeneration({
              api_key: candidate.api_key,
              base_url: candidate.base_url,
              model: candidate.model || "Qwen/Qwen-Image-2512",
              prompt,
              n: count,
            });
          }
          return callProviderImageGeneration({
            api: candidate.api || "openai-completions",
            api_key: candidate.api_key,
            base_url: candidate.base_url,
            model: candidate.model || "image-01",
            prompt,
            n: count,
            width,
            height,
            response_format: "base64",
            subject_reference: subjectReference,
          });
        };

        const minimaxCandidate = providerFamily(primary.provider) === "minimax"
          ? primary
          : (fallback && providerFamily(fallback.provider) === "minimax" ? fallback : null);
        const modelscopeCandidate = providerFamily(primary.provider) === "modelscope"
          ? primary
          : (fallback && providerFamily(fallback.provider) === "modelscope" ? fallback : null);

        let generatedList = null;
        let effective = primary;
        let fallbackFrom = null;

        if (requestedProvider === "modelscope") {
          if (!modelscopeCandidate) {
            throw new Error(t("error.providerMissingCreds", { provider: "modelscope" }));
          }
          generatedList = await callWithCandidate(modelscopeCandidate);
          effective = modelscopeCandidate;
        } else {
          if (!minimaxCandidate) {
            throw new Error(t("error.providerMissingCreds", { provider: "minimax" }));
          }
          try {
            generatedList = await callWithCandidate(minimaxCandidate);
            effective = minimaxCandidate;
          } catch (primaryErr) {
            if (!modelscopeCandidate) throw primaryErr;
            generatedList = await callWithCandidate(modelscopeCandidate);
            effective = modelscopeCandidate;
            fallbackFrom = minimaxCandidate.model || "image-01";
          }
        }

        const outputDir = resolveOutputDir(ctx);
        fs.mkdirSync(outputDir, { recursive: true });

        const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
        const writtenFiles = generatedList.map((raw, idx) => {
          const cleaned = sanitizeBase64(raw);
          const providerTag = isModelscopeProvider(effective.provider) ? "modelscope" : "minimax";
          const fileName = `${providerTag}-${mode}-${ts}-${String(idx + 1).padStart(2, "0")}.png`;
          const filePath = path.resolve(outputDir, fileName);
          fs.writeFileSync(filePath, Buffer.from(cleaned, "base64"));
          return {
            filePath,
            label: fileName,
            ext: "png",
            base64: cleaned,
          };
        });

        const summary = writtenFiles.map((f) => f.filePath).join("\n");
        const imageBlocks = writtenFiles.map((f) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: f.base64,
          },
        }));
        return {
          content: [
            { type: "text", text: t("error.imageGenSaved", { count: writtenFiles.length, paths: summary }) },
            ...imageBlocks,
          ],
          details: {
            model: effective.model,
            chatModel: resolved.model || null,
            provider: effective.provider,
            providerSelection: requestedProvider,
            api: effective.api,
            base_url: effective.base_url,
            fallbackFrom,
            mode,
            width,
            height,
            files: writtenFiles.map(({ base64, ...rest }) => rest),
            imageCount: writtenFiles.length,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: t("error.imageGenFailed", { msg: err?.message || "" }) }],
          details: { error: "image_generation_failed", message: err?.message || "" },
        };
      }
    },
  };
}
