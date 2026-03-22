/**
 * diary.js — 日记 REST API
 *
 * POST /api/diary/write — 生成当日日记
 * GET  /api/diary/list  — 列出已有日记
 */

import fs from "fs";
import { resolveDiaryDir } from "../../lib/diary/diary-writer.js";

export default async function diaryRoute(app, { engine, hub }) {

  /** POST /api/diary/write — 触发日记生成 */
  app.post("/api/diary/write", async (_req, reply) => {
    try {
      const result = await engine.writeDiary();
      if (result.error) {
        return reply.code(400).send({ error: result.error });
      }
      // 通知前端立即刷新右侧书桌文件列表（让 diary/日记 目录实时可见）
      hub?.eventBus?.emit({ type: "desk_changed" }, null);
      return reply.send({
        filePath: result.filePath,
        content: result.content,
        logicalDate: result.logicalDate,
      });
    } catch (err) {
      console.error(`[diary] write failed: ${err.message}`);
      return reply.code(500).send({ error: err.message });
    }
  });

  /** GET /api/diary/list — 列出已有日记文件 */
  app.get("/api/diary/list", async (_req, reply) => {
    const cwd = engine.homeCwd || process.cwd();
    const diaryDir = resolveDiaryDir(cwd);
    try {
      const files = fs.readdirSync(diaryDir)
        .filter(f => f.endsWith(".md"))
        .sort()
        .reverse();
      return reply.send({ files });
    } catch {
      return reply.send({ files: [] });
    }
  });
}
