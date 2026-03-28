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
    expect(result.details?.job?.notifyTarget).toBe("auto");
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
});
