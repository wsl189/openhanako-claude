import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionSummaryManager, validateSummary } from "./session-summary.js";

const tempRoots = [];

function createManager() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-summary-"));
  tempRoots.push(root);
  return new SessionSummaryManager(root);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("summary validation", () => {
  it("rejects malformed inventory-style summaries", () => {
    const result = validateSummary("我目前有以下技能可用：\n- pdf\n- docx", { isZh: true });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("bad_start");
    expect(result.reasons).toContain("tool_or_skill_inventory");
  });

  it("rejects repeated summary segments", () => {
    const text = [
      "## 重要事实",
      "用户身份被确认为WSL。",
      "用户身份被确认为WSL。",
      "用户身份被确认为WSL。",
      "用户身份被确认为WSL。",
      "## 事情经过",
      "01:00 用户打招呼。",
    ].join("\n");
    const result = validateSummary(text, { isZh: true });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((reason) => reason.startsWith("repeated_segment"))).toBe(true);
  });

  it("repairs invalid LLM output before saving", async () => {
    const manager = createManager();
    manager._callRollingLLM = async () => "我目前有以下技能可用：\n- pdf";
    manager._repairSummaryLLM = async () => "## 重要事实\n无\n\n## 事情经过\n01:00 用户打招呼，助手回应。";

    const summary = await manager.rollingSummary(
      "s1",
      [{ role: "user", content: "你好", timestamp: "2026-05-04T01:00:00.000Z" }],
      { model: "mock", api: "mock", api_key: "", base_url: "mock" },
    );

    expect(summary).toMatch(/^## 重要事实/);
    expect(manager.getSummary("s1").summary).toBe(summary);
  });

  it("keeps previous summary when repair fails", async () => {
    const manager = createManager();
    manager.saveSummary("s1", {
      session_id: "s1",
      created_at: "2026-05-04T00:00:00.000Z",
      updated_at: "2026-05-04T00:00:00.000Z",
      summary: "## 重要事实\n无\n\n## 事情经过\n00:00 初始摘要。",
      snapshot: "",
      snapshot_at: null,
    });
    manager._callRollingLLM = async () => "bad";
    manager._repairSummaryLLM = async () => "still bad";

    const summary = await manager.rollingSummary(
      "s1",
      [{ role: "user", content: "你好", timestamp: "2026-05-04T01:00:00.000Z" }],
      { model: "mock", api: "mock", api_key: "", base_url: "mock" },
    );

    expect(summary).toContain("初始摘要");
    expect(manager.getSummary("s1").summary).toContain("初始摘要");
  });
});
