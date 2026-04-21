import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "./fact-store.js";

const tempRoots = [];
let warnedNativeAbiMismatch = false;

function isNativeAbiMismatchError(err) {
  const msg = String(err?.message || "");
  return msg.includes("better_sqlite3.node") && msg.includes("NODE_MODULE_VERSION");
}

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-fact-store-"));
  tempRoots.push(root);
  const dbPath = path.join(root, "facts.db");
  try {
    return new FactStore(dbPath);
  } catch (err) {
    if (isNativeAbiMismatchError(err)) {
      if (!warnedNativeAbiMismatch) {
        warnedNativeAbiMismatch = true;
        console.warn("[fact-store.test] skip due to better-sqlite3 ABI mismatch in current runtime");
      }
      return null;
    }
    throw err;
  }
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("fact-store timeliness", () => {
  it("keeps only latest active fact for same state_key", () => {
    const store = createStore();
    if (!store) return;
    try {
      const now = Date.now();
      const t1 = new Date(now - 2 * 86400000).toISOString().slice(0, 16);
      const t2 = new Date(now - 1 * 86400000).toISOString().slice(0, 16);

      store.add({
        fact: "当前持有中国核建",
        tags: ["中国核建", "持仓"],
        time: t1,
        timeliness: "stateful",
        state_key: "投资组合/中国核建/持仓状态",
        session_id: "s1",
      });
      store.add({
        fact: "当前不再持有中国核建",
        tags: ["中国核建", "持仓", "状态变更"],
        time: t2,
        timeliness: "stateful",
        state_key: "投资组合/中国核建/持仓状态",
        session_id: "s2",
      });

      const active = store.searchByTags(["中国核建"], undefined, 20);
      expect(active).toHaveLength(1);
      expect(active[0].fact).toContain("不再持有");
      expect(active[0].is_active).toBe(true);

      const all = store.searchByTags(["中国核建"], undefined, 20, { includeInactive: true });
      expect(all).toHaveLength(2);
      expect(all.filter((x) => x.is_active)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("expires ephemeral facts by ttl", () => {
    const store = createStore();
    if (!store) return;
    try {
      store.add({
        fact: "这周临时改为晚间复盘",
        tags: ["临时安排", "复盘"],
        time: "2020-01-01T00:00",
        timeliness: "ephemeral",
        ttl_days: 2,
        session_id: "s1",
      });

      const active = store.searchByTags(["临时安排"], undefined, 20);
      expect(active).toHaveLength(0);

      const all = store.searchByTags(["临时安排"], undefined, 20, { includeInactive: true });
      expect(all).toHaveLength(1);
      expect(all[0].is_active).toBe(false);
      expect(all[0].valid_to).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it("deactivates legacy facts when a stateful replacement arrives", () => {
    const store = createStore();
    if (!store) return;
    try {
      const now = Date.now();
      const t1 = new Date(now - 3 * 86400000).toISOString().slice(0, 16);
      const t2 = new Date(now - 1 * 86400000).toISOString().slice(0, 16);

      // 模拟历史数据：没有 timeliness/state_key 的旧事实
      store.add({
        fact: "当前持有中国核建",
        tags: ["中国核建", "持仓"],
        time: t1,
        session_id: "legacy",
      });

      store.add({
        fact: "当前不再持有中国核建",
        tags: ["中国核建", "持仓", "状态变更"],
        time: t2,
        timeliness: "stateful",
        state_key: "投资组合/中国核建/持仓状态",
        session_id: "s2",
      });

      const active = store.searchByTags(["中国核建"], undefined, 20);
      expect(active).toHaveLength(1);
      expect(active[0].fact).toContain("不再持有");
    } finally {
      store.close();
    }
  });
});
