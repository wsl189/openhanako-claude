import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { CronStore } from "../desk/cron-store.js";
import { createCronTool } from "./cron-tool.js";

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-tool-test-"));
  const store = new CronStore(
    path.join(dir, "cron-jobs.json"),
    path.join(dir, "cron-runs"),
  );
  const tool = createCronTool(store, { autoApprove: true });
  return { dir, store, tool };
}

let cleanupDirs = [];

afterEach(() => {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs = [];
});

describe("cron-tool command compatibility", () => {
  it("supports legacy command format for daily reminders", async () => {
    const { dir, tool } = createFixture();
    cleanupDirs.push(dir);

    const result = await tool.execute("tc_1", {
      command: "cron add every day at 18:10 prompt '该喝水啦~' label '喝水提醒' notifyTarget 'platform'",
    });

    expect(result.details?.action).toBe("added");
    expect(result.details?.job?.type).toBe("cron");
    expect(result.details?.job?.schedule).toBe("10 18 * * *");
    expect(result.details?.job?.prompt).toBe("该喝水啦~");
    expect(result.details?.job?.label).toBe("喝水提醒");
    expect(result.details?.job?.notifyTarget).toBe("platform");
  });

  it("supports Chinese quotation marks in legacy command format", async () => {
    const { dir, tool } = createFixture();
    cleanupDirs.push(dir);

    const result = await tool.execute("tc_2", {
      command: "cron add every day at 06:05 prompt “早安提醒” label “晨间提醒” notifyTarget “auto”",
    });

    expect(result.details?.action).toBe("added");
    expect(result.details?.job?.schedule).toBe("5 6 * * *");
    expect(result.details?.job?.prompt).toBe("早安提醒");
    expect(result.details?.job?.label).toBe("晨间提醒");
    expect(result.details?.job?.notifyTarget).toBe("local");
  });

  it("supports legacy list/remove command format", async () => {
    const { dir, tool } = createFixture();
    cleanupDirs.push(dir);

    const addRes = await tool.execute("tc_3", {
      command: "cron add every day at 20:00 prompt '晚间复盘' label '复盘'",
    });
    const jobId = addRes.details?.job?.id;
    expect(jobId).toBeTruthy();

    const listRes = await tool.execute("tc_4", { command: "cron list" });
    expect(Array.isArray(listRes.details?.jobs)).toBe(true);
    expect(listRes.details?.jobs.length).toBe(1);

    const removeRes = await tool.execute("tc_5", { command: `cron remove ${jobId}` });
    expect(removeRes.details?.action).toBe("remove");
    expect(removeRes.details?.jobs.length).toBe(0);
  });

  it("auto-corrects cron+every-minute input to every schedule", async () => {
    const { dir, tool } = createFixture();
    cleanupDirs.push(dir);

    const result = await tool.execute("tc_6", {
      action: "add",
      type: "cron",
      schedule: "every minute",
      prompt: "test",
      model: "default",
    });

    expect(result.details?.action).toBe("added");
    expect(result.details?.job?.type).toBe("every");
    expect(result.details?.job?.schedule).toBe(60_000);
    expect(result.details?.job?.model).toBe("");
  });

  it("auto-corrects every+cron-expression input to cron schedule", async () => {
    const { dir, tool } = createFixture();
    cleanupDirs.push(dir);

    const result = await tool.execute("tc_6b", {
      action: "add",
      type: "every",
      schedule: "*/15 * * * *",
      prompt: "test-cron-correction",
    });

    expect(result.details?.action).toBe("added");
    expect(result.details?.job?.type).toBe("cron");
    expect(result.details?.job?.schedule).toBe("*/15 * * * *");
  });

  it("auto-corrects every+iso-time input to at schedule", async () => {
    const { dir, tool } = createFixture();
    cleanupDirs.push(dir);

    const result = await tool.execute("tc_6c", {
      action: "add",
      type: "every",
      schedule: "2030-01-02T03:04:05.000Z",
      prompt: "test-at-correction",
    });

    expect(result.details?.action).toBe("added");
    expect(result.details?.job?.type).toBe("at");
    expect(result.details?.job?.schedule).toBe("2030-01-02T03:04:05.000Z");
  });

  it("rejects invalid cron field like 9:30 with guided error", async () => {
    const { dir, tool, store } = createFixture();
    cleanupDirs.push(dir);

    const result = await tool.execute("tc_6d", {
      action: "add",
      type: "cron",
      schedule: "0 9:30 * * 1-5",
      prompt: "bad cron expr",
    });

    expect(result.details?.action).toBe("add");
    expect(result.details?.error).toBe("invalid cron schedule");
    expect(String(result.content?.[0]?.text || "")).toMatch(/cron/i);
    expect(store.listJobs().length).toBe(0);
  });

  it("rejects invalid cron-shaped schedule even when type is omitted", async () => {
    const { dir, tool, store } = createFixture();
    cleanupDirs.push(dir);

    const result = await tool.execute("tc_6e", {
      action: "add",
      schedule: "0 9:30 * * 1-5",
      prompt: "bad cron expr without type",
    });

    expect(result.details?.action).toBe("add");
    expect(result.details?.error).toBe("invalid cron schedule");
    expect(store.listJobs().length).toBe(0);
  });

  it("rejects ambiguous daily cron when prompt looks one-shot", async () => {
    const { dir, tool, store } = createFixture();
    cleanupDirs.push(dir);

    const result = await tool.execute("tc_6f", {
      action: "add",
      type: "cron",
      schedule: "0 15 * * *",
      prompt: "今天下午3点提醒我开会",
    });

    expect(result.details?.action).toBe("add");
    expect(result.details?.error).toBe("ambiguous cron maybe at");
    expect(String(result.content?.[0]?.text || "")).toMatch(/cronAmbiguousTimeMaybeAt|一次性|one-time|type=at/i);
    expect(store.listJobs().length).toBe(0);
  });

  it("allows daily cron when prompt explicitly says every day", async () => {
    const { dir, tool, store } = createFixture();
    cleanupDirs.push(dir);

    const result = await tool.execute("tc_6g", {
      action: "add",
      type: "cron",
      schedule: "0 15 * * *",
      prompt: "每天下午3点提醒我喝水",
    });

    expect(result.details?.action).toBe("added");
    expect(result.details?.job?.type).toBe("cron");
    expect(result.details?.job?.schedule).toBe("0 15 * * *");
    expect(store.listJobs().length).toBe(1);
  });

  it("infers type=every when type is omitted and schedule is natural language", async () => {
    const { dir, tool } = createFixture();
    cleanupDirs.push(dir);

    const result = await tool.execute("tc_7", {
      action: "add",
      schedule: "每5分钟",
      prompt: "test2",
    });

    expect(result.details?.action).toBe("added");
    expect(result.details?.job?.type).toBe("every");
    expect(result.details?.job?.schedule).toBe(300_000);
  });

  it("accepts complex cron expressions and computes nextRunAt", async () => {
    const { dir, tool } = createFixture();
    cleanupDirs.push(dir);

    const result = await tool.execute("tc_8", {
      action: "add",
      type: "cron",
      schedule: "*/5 9-14 * * 1-5",
      prompt: "stock monitor",
      label: "stock-monitor-realtime",
      notifyTarget: "platform",
    });

    expect(result.details?.action).toBe("added");
    expect(result.details?.job?.type).toBe("cron");
    expect(result.details?.job?.schedule).toBe("*/5 9-14 * * 1-5");
    expect(result.details?.job?.notifyTarget).toBe("platform");
    expect(typeof result.details?.job?.nextRunAt).toBe("string");
  });

  it("supports notifyPlatform and pins notifyTarget to platform", async () => {
    const { dir, tool } = createFixture();
    cleanupDirs.push(dir);

    const result = await tool.execute("tc_9", {
      action: "add",
      type: "every",
      schedule: "1h",
      prompt: "微信提醒",
      notifyTarget: "auto",
      notifyPlatform: "wechat",
    });

    expect(result.details?.action).toBe("added");
    expect(result.details?.job?.notifyPlatform).toBe("wechat");
    expect(result.details?.job?.notifyTarget).toBe("platform");
  });

  it("defaults to source platform when created from platform session", async () => {
    const { dir, tool } = createFixture();
    cleanupDirs.push(dir);

    const result = await tool.execute("tc_10", {
      action: "add",
      type: "every",
      schedule: "30m",
      prompt: "到点提醒我",
    }, undefined, undefined, {
      sessionManager: { getSessionFile: () => "/tmp/sessions/bridge/owner/demo.session.json" },
      bridgeMeta: { platform: "wechat" },
    });

    expect(result.details?.action).toBe("added");
    expect(result.details?.job?.notifyPlatform).toBe("wechat");
    expect(result.details?.job?.notifyTarget).toBe("platform");
  });

  it("keeps explicit local target even from platform session", async () => {
    const { dir, tool } = createFixture();
    cleanupDirs.push(dir);

    const result = await tool.execute("tc_11", {
      action: "add",
      type: "every",
      schedule: "45m",
      prompt: "只弹窗提醒",
      notifyTarget: "local",
    }, undefined, undefined, {
      sessionManager: { getSessionFile: () => "/tmp/sessions/bridge/owner/demo.session.json" },
      bridgeMeta: { platform: "wechat" },
    });

    expect(result.details?.action).toBe("added");
    expect(result.details?.job?.notifyPlatform).toBe("");
    expect(result.details?.job?.notifyTarget).toBe("local");
  });
});
