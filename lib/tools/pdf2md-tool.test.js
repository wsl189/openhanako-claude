import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadLocale } from "../../server/i18n.js";
import { createPdf2MdTool, _pdf2mdInternals } from "./pdf2md-tool.js";

const cleanupDirs = [];

function mktemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

beforeAll(() => {
  loadLocale("en");
});

afterEach(() => {
  for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("pdf2md tool", () => {
  it("reports missing service URL", async () => {
    const tool = createPdf2MdTool({ env: {}, fetchImpl: vi.fn() });
    const result = await tool.execute("tc_1", { file_path: "/tmp/demo.pdf" });

    expect(result.details?.error).toBe("missing_service_url");
  });

  it("uploads a PDF and saves returned markdown", async () => {
    const dir = mktemp("pdf2md-tool-");
    const pdfPath = path.join(dir, "scan.pdf");
    const outputPath = path.join(dir, "scan.md");
    fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n"));

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      markdown: "# Converted\n\nHello PDF",
      markdown_path: "/remote/out/scan.md",
      output_dir: "/remote/out",
      source_pdf: "/remote/input/scan.pdf",
      backend: "pipeline",
      parse_method: "auto",
      language: "ch",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const tool = createPdf2MdTool({
      env: {},
      fetchImpl,
      getConfig: () => ({ base_url: "http://127.0.0.1:9280", api_key: "secret" }),
    });
    const result = await tool.execute("tc_2", {
      file_path: pdfPath,
      output_path: outputPath,
      parse_method: "ocr",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:9280/convert/by-upload");
    expect(init.headers["x-api-key"]).toBe("secret");
    expect(fs.readFileSync(outputPath, "utf-8")).toBe("# Converted\n\nHello PDF");
    expect(result.details?.outputPath).toBe(outputPath);
    expect(result.content[0].text).toContain("Hello PDF");
  });

  it("reuses cached markdown from .hanako/pdf2md before calling service", async () => {
    const dir = mktemp("pdf2md-cache-hit-");
    const pdfPath = path.join(dir, "cached.pdf");
    fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n"));

    const cacheDir = path.join(dir, ".hanako", "pdf2md");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cachePath = _pdf2mdInternals.resolveCachePath(pdfPath, { sessionManager: { getCwd: () => dir } });
    fs.writeFileSync(cachePath, "# Cached\n\nAlready converted", "utf-8");

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ markdown: "# should not be called" }), { status: 200 }));
    const tool = createPdf2MdTool({
      env: {},
      fetchImpl,
      getConfig: () => ({ base_url: "http://127.0.0.1:9280" }),
    });

    const result = await tool.execute(
      "tc_3",
      { file_path: pdfPath },
      null,
      [],
      { sessionManager: { getCwd: () => dir } },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.details?.cacheHit).toBe(true);
    expect(result.details?.cachePath).toContain(path.join(".hanako", "pdf2md"));
    expect(result.content[0].text).toContain("Already converted");
  });

  it("cleans cache files older than 7 days", async () => {
    const dir = mktemp("pdf2md-cache-cleanup-");
    const pdfPath = path.join(dir, "doc.pdf");
    fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n"));

    const cacheDir = path.join(dir, ".hanako", "pdf2md");
    fs.mkdirSync(cacheDir, { recursive: true });
    const stalePath = path.join(cacheDir, "stale.md");
    fs.writeFileSync(stalePath, "old", "utf-8");
    const nowSec = Date.now() / 1000;
    fs.utimesSync(stalePath, nowSec - (9 * 24 * 60 * 60), nowSec - (9 * 24 * 60 * 60));

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      markdown: "# Fresh",
      markdown_path: "/remote/fresh.md",
      output_dir: "/remote",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const tool = createPdf2MdTool({
      env: {},
      fetchImpl,
      getConfig: () => ({ base_url: "http://127.0.0.1:9280" }),
    });

    const result = await tool.execute(
      "tc_4",
      { file_path: pdfPath },
      null,
      [],
      { sessionManager: { getCwd: () => dir } },
    );

    expect(fs.existsSync(stalePath)).toBe(false);
    expect(result.details?.cachePruned).toBeGreaterThanOrEqual(1);
    expect(result.details?.cacheHit).toBe(false);
  });
});
