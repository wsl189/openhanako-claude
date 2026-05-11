import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { CronStore } from "./cron-store.js";

let cleanupDirs = [];

afterEach(() => {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs = [];
});

function createStores() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-store-test-"));
  const jobsPath = path.join(dir, "cron-jobs.json");
  const runsDir = path.join(dir, "cron-runs");
  const storeA = new CronStore(jobsPath, runsDir);
  const storeB = new CronStore(jobsPath, runsDir);
  cleanupDirs.push(dir);
  return { storeA, storeB };
}

describe("cron-store multi-instance safety", () => {
  it("does not resurrect a deleted job when another instance marks run", () => {
    const { storeA, storeB } = createStores();
    const job = storeA.addJob({
      type: "every",
      schedule: 60_000,
      prompt: "test",
    });

    // storeB 持有旧快照（模拟 scheduler 与 API 使用不同实例）
    const before = storeB.listJobs();
    expect(before.some(j => j.id === job.id)).toBe(true);

    // 在另一个实例删除任务
    const removed = storeA.removeJob(job.id);
    expect(removed).toBe(true);
    expect(storeA.listJobs().some(j => j.id === job.id)).toBe(false);

    // 旧实例在任务结束时 markRun，不应把已删任务写回
    storeB.markRun(job.id);

    const jobsAfter = storeA.listJobs();
    expect(jobsAfter.some(j => j.id === job.id)).toBe(false);
  });
});

describe("cron-store cron expression support", () => {
  it("computes next run for complex range+step weekday expressions", () => {
    const { storeA } = createStores();
    const from = new Date("2026-03-30T08:58:30").toISOString();
    const next = storeA._calcNextRun("cron", "*/5 9-14 * * 1-5", from);
    const expected = new Date("2026-03-30T09:00:00").toISOString();
    expect(next).toBe(expected);
  });

  it("returns null for invalid cron expressions", () => {
    const { storeA } = createStores();
    const from = new Date("2026-03-30T08:58:30").toISOString();
    const next = storeA._calcNextRun("cron", "not-a-valid-cron", from);
    expect(next).toBeNull();
  });

  it("pins notifyTarget to platform when notifyPlatform is set", () => {
    const { storeA } = createStores();
    const job = storeA.addJob({
      type: "every",
      schedule: 60_000,
      prompt: "notify",
      notifyTarget: "auto",
      notifyPlatform: "wechat",
    });
    expect(job.notifyPlatform).toBe("wechat");
    expect(job.notifyTarget).toBe("platform");
  });
});
