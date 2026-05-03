import { describe, expect, it } from "vitest";
import { normalizeFact } from "./deep-memory.js";

describe("deep-memory fact normalization", () => {
  it("generates a fallback state_key for stateful facts with distinctive tags", () => {
    const fact = normalizeFact({
      fact: "当前不再持有中国核建",
      tags: ["中国核建", "持仓", "状态变更"],
      timeliness: "stateful",
      state_key: "",
      time: "2026-05-04T10:00",
    }, { referenceTime: "2026-05-04T11:00:00.000Z" });

    expect(fact.timeliness).toBe("stateful");
    expect(fact.state_key).toBe("中国核建/持仓/状态变更/状态");
  });

  it("downgrades stateful facts without a usable key to ephemeral", () => {
    const fact = normalizeFact({
      fact: "当前状态不明",
      tags: ["状态"],
      timeliness: "stateful",
    }, { referenceTime: "2026-05-04T11:00:00.000Z" });

    expect(fact.timeliness).toBe("ephemeral");
    expect(fact.state_key).toBeNull();
  });

  it("drops fact times that are far after the source summary time", () => {
    const fact = normalizeFact({
      fact: "助手反馈原 API 限流无法使用",
      tags: ["API", "限流"],
      timeliness: "ephemeral",
      time: "2026-05-20T01:04",
    }, { referenceTime: "2026-05-01T17:16:27.540Z" });

    expect(fact.time).toBeNull();
  });
});
