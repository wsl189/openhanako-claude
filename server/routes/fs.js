/**
 * fs.js — 文件系统 API（Web 客户端用）
 *
 * Electron 环境下这些操作走 IPC（preload.cjs），
 * Web / 云部署环境下前端通过这些 HTTP 端点读取文件。
 *
 * 安全：路径限定在 ~/.hanako/ 和 desk 工作空间内。
 */

import fs from "fs";
import path from "path";

/** 安全路径校验：resolved 必须在 allowedRoots 之一内部 */
function isSafePath(filePath, allowedRoots) {
  const resolved = path.resolve(filePath);
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
    const candidates = [
      hanakoHome,
      engine.getHomeFolder?.(),
      engine.deskCwd,
      engine.cwd,
      engine.agent?.deskManager?.homePath,
    ].filter(Boolean);

    const roots = [];
    for (const p of candidates) {
      try {
        const resolved = path.resolve(p);
        if (!roots.includes(resolved)) roots.push(resolved);
      } catch {}
    }
    return roots;
  }

  // GET /api/fs/read?path=... → UTF-8 文本
  app.get("/api/fs/read", async (req, reply) => {
    const filePath = req.query.path;
    if (!filePath) return reply.code(400).send({ error: "missing path" });
    if (!isSafePath(filePath, getAllowedRoots())) {
      return reply.code(403).send({ error: "path not allowed" });
    }
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
    if (!filePath) return reply.code(400).send({ error: "missing path" });
    if (!isSafePath(filePath, getAllowedRoots())) {
      return reply.code(403).send({ error: "path not allowed" });
    }
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
    if (!filePath) return reply.code(400).send({ error: "missing path" });
    if (!isSafePath(filePath, getAllowedRoots())) {
      return reply.code(403).send({ error: "path not allowed" });
    }
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return reply.code(404).send({ error: "file not found" });
      const ext = (path.extname(filePath).slice(1) || "").toLowerCase();
      reply.header("Content-Type", MIME_BY_EXT[ext] || "application/octet-stream");
      reply.header("Cache-Control", "no-store");
      return reply.send(fs.createReadStream(filePath));
    } catch {
      return reply.code(404).send({ error: "file not found" });
    }
  });
}
