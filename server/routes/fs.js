/**
 * fs.js — 文件系统 API（Web 客户端用）
 *
 * Electron 环境下这些操作走 IPC（preload.cjs），
 * Web / 云部署环境下前端通过这些 HTTP 端点读取文件。
 *
 * 安全：路径限定在 ~/.hanako/ 和 desk 工作空间内。
 */

import fs from "fs";
import os from "os";
import path from "path";

function toRealPath(p) {
  if (!p) return null;
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    try {
      return path.resolve(p);
    } catch {
      return null;
    }
  }
}

/** 安全路径校验：resolved 必须在 allowedRoots 之一内部 */
function isSafePath(filePath, allowedRoots) {
  const resolved = toRealPath(filePath);
  if (!resolved) return false;
  return allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
}

export default async function fsRoute(app, { engine }) {
  const hanakoHome = path.resolve(engine.hanakoHome);
  const MIME_BY_EXT = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    json: "application/json; charset=utf-8",
  };

  // 收集允许的根目录
  function getAllowedRoots() {
    // 允许读取：
    // 1) ~/.hanako
    // 2) 书桌 home（配置）
    // 3) 当前 desk 工作目录（会话 cwd）
    // 4) 当前会话 cwd（与 deskCwd 基本一致，但保守兜底）
    // 5) 用户 Home（与 /api/desk/files 的目录覆盖规则保持一致）
    const candidates = [
      hanakoHome,
      engine.getHomeFolder?.(),
      engine.homeCwd,
      engine.deskCwd,
      engine.cwd,
      engine.agent?.deskManager?.homePath,
      os.homedir(),
    ].filter(Boolean);

    const roots = [];
    for (const p of candidates) {
      const resolved = toRealPath(p);
      if (resolved && !roots.includes(resolved)) roots.push(resolved);
    }
    return roots;
  }

  function validateReadableFile(filePath) {
    if (!filePath) return { ok: false, code: 400, error: "missing path" };
    if (!isSafePath(filePath, getAllowedRoots())) {
      return { ok: false, code: 403, error: "path not allowed" };
    }
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return { ok: false, code: 404, error: "file not found" };
      return { ok: true, stat };
    } catch {
      return { ok: false, code: 404, error: "file not found" };
    }
  }

  // GET /api/fs/read?path=... → UTF-8 文本
  app.get("/api/fs/read", async (req, reply) => {
    const filePath = req.query.path;
    const checked = validateReadableFile(filePath);
    if (!checked.ok) return reply.code(checked.code).send({ error: checked.error });
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      reply.type("text/plain").send(content);
    } catch {
      reply.code(404).send({ error: "file not found" });
    }
  });

  // GET /api/fs/read-base64?path=... → base64 编码
  app.get("/api/fs/read-base64", async (req, reply) => {
    const filePath = req.query.path;
    const checked = validateReadableFile(filePath);
    if (!checked.ok) return reply.code(checked.code).send({ error: checked.error });
    try {
      const buf = fs.readFileSync(filePath);
      reply.type("text/plain").send(buf.toString("base64"));
    } catch {
      reply.code(404).send({ error: "file not found" });
    }
  });

  // GET /api/fs/file?path=... → 二进制流（PDF/图片等）
  app.get("/api/fs/file", async (req, reply) => {
    const filePath = req.query.path;
    const checked = validateReadableFile(filePath);
    if (!checked.ok) return reply.code(checked.code).send({ error: checked.error });
    try {
      const ext = (path.extname(filePath).slice(1) || "").toLowerCase();
      reply.header("Content-Type", MIME_BY_EXT[ext] || "application/octet-stream");
      reply.header("Cache-Control", "no-store");
      return reply.send(fs.createReadStream(filePath));
    } catch {
      return reply.code(404).send({ error: "file not found" });
    }
  });

  // GET /api/fs/docx-html?path=... → docx 转 HTML（mammoth）
  app.get("/api/fs/docx-html", async (req, reply) => {
    const filePath = req.query.path;
    const checked = validateReadableFile(filePath);
    if (!checked.ok) return reply.code(checked.code).send({ error: checked.error });
    if (checked.stat.size > 20 * 1024 * 1024) {
      return reply.code(413).send({ error: "file too large" });
    }
    try {
      const mammothNs = await import("mammoth");
      const mammoth = mammothNs?.default || mammothNs;
      const result = await mammoth.convertToHtml({ path: filePath });
      reply.type("text/html; charset=utf-8").send(result.value || "");
    } catch {
      reply.code(500).send({ error: "docx convert failed" });
    }
  });

  // GET /api/fs/xlsx-html?path=... → xlsx 转 HTML（ExcelJS）
  app.get("/api/fs/xlsx-html", async (req, reply) => {
    const filePath = req.query.path;
    const checked = validateReadableFile(filePath);
    if (!checked.ok) return reply.code(checked.code).send({ error: checked.error });
    if (checked.stat.size > 20 * 1024 * 1024) {
      return reply.code(413).send({ error: "file too large" });
    }
    try {
      const excelNs = await import("exceljs");
      const ExcelJS = excelNs?.default || excelNs;
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);
      const sheet = workbook.worksheets[0];
      if (!sheet || sheet.rowCount === 0) {
        reply.type("text/html; charset=utf-8").send("");
        return;
      }
      const esc = (s) => String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      let html = "<table>";
      sheet.eachRow((row) => {
        html += "<tr>";
        row.eachCell({ includeEmpty: true }, (cell) => {
          html += `<td>${esc(cell.text || "")}</td>`;
        });
        html += "</tr>";
      });
      html += "</table>";
      reply.type("text/html; charset=utf-8").send(html);
    } catch {
      reply.code(500).send({ error: "xlsx convert failed" });
    }
  });
}
