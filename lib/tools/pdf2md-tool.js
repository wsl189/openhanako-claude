import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MAX_PREVIEW_CHARS = 12000;

function sanitizeInputPath(rawPath = "") {
  let p = String(rawPath || "").trim();
  if (!p) return "";
  if (p.startsWith("<") && p.endsWith(">")) p = p.slice(1, -1).trim();
  p = p.replace(/^["']|["']$/g, "");
  p = p.replace(/\\ /g, " ");
  if (/^file:\/\//i.test(p)) {
    try { p = fileURLToPath(p); } catch {}
  }
  if (p.includes("%")) {
    try { p = decodeURIComponent(p); } catch {}
  }
  return p;
}

function isAbsolutePathAnyPlatform(filePath = "") {
  const p = String(filePath || "");
  return path.isAbsolute(p) || path.win32.isAbsolute(p);
}

function getServiceBaseUrl(env = process.env, config = {}) {
  return String(
    config.base_url
      || config.baseUrl
      || env.HANA_PDF2MD_BASE_URL
      || env.PDF2MD_SERVICE_URL
      || env.MINERU_PDF2MD_BASE_URL
      || "",
  ).trim().replace(/\/+$/, "");
}

function getServiceApiKey(env = process.env, config = {}) {
  return String(config.api_key || config.apiKey || env.HANA_PDF2MD_API_KEY || env.PDF2MD_API_KEY || "").trim();
}

function getTimeoutMs(env = process.env, config = {}) {
  const n = Number.parseInt(config.timeout_ms || config.timeoutMs || env.HANA_PDF2MD_TIMEOUT_MS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function safeOutputStem(filePath) {
  const stem = path.basename(filePath, path.extname(filePath)).replace(/[^\w.-]+/g, "_") || "document";
  const hash = crypto.createHash("sha1").update(filePath).digest("hex").slice(0, 10);
  return `${stem}.${hash}`;
}

function resolveOutputPath(filePath, requested, ctx) {
  const explicit = sanitizeInputPath(requested || "");
  if (explicit) return path.resolve(explicit);
  const cwd = ctx?.sessionManager?.getCwd?.() || process.cwd();
  const baseDir = path.join(cwd, ".hanako", "pdf2md");
  return path.join(baseDir, `${safeOutputStem(filePath)}.md`);
}

function buildPreview(markdown, maxChars) {
  const limit = Math.max(1000, Math.min(Number(maxChars || DEFAULT_MAX_PREVIEW_CHARS), 50000));
  if (markdown.length <= limit) return { preview: markdown, truncated: false };
  return { preview: markdown.slice(0, limit), truncated: true };
}

export function createPdf2MdTool({ env = process.env, fetchImpl = globalThis.fetch, getConfig = () => ({}) } = {}) {
  return {
    name: "pdf2md",
    label: t("toolDef.pdf2md.label"),
    description: t("toolDef.pdf2md.description"),
    parameters: Type.Object({
      file_path: Type.String({ description: t("toolDef.pdf2md.filePathDesc") }),
      output_path: Type.Optional(Type.String({ description: t("toolDef.pdf2md.outputPathDesc") })),
      parse_method: Type.Optional(Type.Union([
        Type.Literal("auto"),
        Type.Literal("ocr"),
        Type.Literal("txt"),
      ], { description: t("toolDef.pdf2md.parseMethodDesc"), default: "auto" })),
      language: Type.Optional(Type.String({ description: t("toolDef.pdf2md.languageDesc"), default: "ch" })),
      start_page: Type.Optional(Type.Number({ description: t("toolDef.pdf2md.startPageDesc") })),
      end_page: Type.Optional(Type.Number({ description: t("toolDef.pdf2md.endPageDesc") })),
      max_preview_chars: Type.Optional(Type.Number({ description: t("toolDef.pdf2md.maxPreviewCharsDesc"), default: DEFAULT_MAX_PREVIEW_CHARS })),
    }),
    execute: async (_toolCallId, params, signal, _messages, ctx) => {
      const config = getConfig?.() || {};
      const baseUrl = getServiceBaseUrl(env, config);
      if (!baseUrl) {
        return {
          content: [{ type: "text", text: t("toolDef.pdf2md.missingServiceUrl") }],
          details: { error: "missing_service_url" },
        };
      }
      if (typeof fetchImpl !== "function") {
        return {
          content: [{ type: "text", text: t("toolDef.pdf2md.missingFetch") }],
          details: { error: "missing_fetch" },
        };
      }

      const filePath = sanitizeInputPath(params.file_path);
      if (!filePath || !isAbsolutePathAnyPlatform(filePath)) {
        return {
          content: [{ type: "text", text: t("toolDef.pdf2md.needAbsolutePdf") }],
          details: { error: "invalid_path" },
        };
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return {
          content: [{ type: "text", text: t("toolDef.pdf2md.fileNotFound", { path: filePath }) }],
          details: { error: "file_not_found" },
        };
      }
      if (path.extname(filePath).toLowerCase() !== ".pdf") {
        return {
          content: [{ type: "text", text: t("toolDef.pdf2md.notPdf", { path: filePath }) }],
          details: { error: "not_pdf" },
        };
      }

      const outputPath = resolveOutputPath(filePath, params.output_path, ctx);
      const form = new FormData();
      const bytes = fs.readFileSync(filePath);
      form.append("input_pdf_file", new Blob([bytes], { type: "application/pdf" }), path.basename(filePath));
      form.append("parse_method", params.parse_method || "auto");
      form.append("language", params.language || "ch");
      form.append("backend", "pipeline");
      form.append("max_chars", "0");
      if (params.start_page !== undefined) form.append("start_page", String(params.start_page));
      if (params.end_page !== undefined) form.append("end_page", String(params.end_page));

      const headers = {};
      const apiKey = getServiceApiKey(env, config);
      if (apiKey) headers["x-api-key"] = apiKey;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("pdf2md timeout")), getTimeoutMs(env, config));
      const abortForwarder = () => controller.abort(signal?.reason || new Error("aborted"));
      if (signal) {
        if (signal.aborted) abortForwarder();
        else signal.addEventListener("abort", abortForwarder, { once: true });
      }

      try {
        const res = await fetchImpl(`${baseUrl}/convert/by-upload`, {
          method: "POST",
          headers,
          body: form,
          signal: controller.signal,
        });
        const raw = await res.text();
        let data;
        try { data = JSON.parse(raw); } catch { data = null; }
        if (!res.ok) {
          const detail = data?.detail ? JSON.stringify(data.detail) : raw.slice(0, 2000);
          return {
            content: [{ type: "text", text: t("toolDef.pdf2md.serviceError", { status: res.status, detail }) }],
            details: { error: "service_error", status: res.status, detail },
          };
        }
        const markdown = String(data?.markdown || "");
        if (!markdown.trim()) {
          return {
            content: [{ type: "text", text: t("toolDef.pdf2md.emptyMarkdown") }],
            details: { error: "empty_markdown", response: data },
          };
        }

        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, markdown, "utf-8");
        const { preview, truncated } = buildPreview(markdown, params.max_preview_chars);
        const header = t("toolDef.pdf2md.success", {
          outputPath,
          remotePath: data?.markdown_path || "",
        });
        const suffix = truncated ? t("toolDef.pdf2md.previewTruncated", { outputPath }) : "";
        return {
          content: [{ type: "text", text: `${header}\n\n${preview}${suffix}` }],
          details: {
            outputPath,
            remoteMarkdownPath: data?.markdown_path || null,
            remoteOutputDir: data?.output_dir || null,
            sourcePdf: filePath,
            markdownChars: markdown.length,
          },
        };
      } catch (err) {
        const msg = err?.name === "AbortError" ? "timeout or aborted" : err.message;
        return {
          content: [{ type: "text", text: t("toolDef.pdf2md.callFailed", { msg }) }],
          details: { error: "call_failed", message: msg },
        };
      } finally {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener?.("abort", abortForwarder);
      }
    },
  };
}

export const _pdf2mdInternals = {
  sanitizeInputPath,
  getServiceBaseUrl,
  resolveOutputPath,
  buildPreview,
};
