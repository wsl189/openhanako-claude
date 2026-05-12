import { describe, expect, it, vi } from "vitest";
import { createNotifyTool } from "./notify-tool.js";

describe("notify-tool no-action guard", () => {
  it("suppresses all-clear notifications from activity sessions", async () => {
    const onNotify = vi.fn(async () => ({ delivered: true }));
    const tool = createNotifyTool({ onNotify });

    const result = await tool.execute(
      "tc_1",
      { title: "巡检结果", body: "无异常，无需处理" },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "/tmp/agents/a1/activity/hb_1.json" } },
    );

    expect(onNotify).not.toHaveBeenCalled();
    expect(result.details?.sent).toBe(false);
    expect(result.details?.suppressed).toBe(true);
    expect(result.details?.suppressedReason).toBe("all_clear_activity");
  });

  it("keeps actionable activity notifications", async () => {
    const onNotify = vi.fn(async () => ({ delivered: "platform" }));
    const tool = createNotifyTool({ onNotify });

    const result = await tool.execute(
      "tc_2",
      { title: "巡检告警", body: "发现异常：核心接口连续失败，请尽快处理" },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "/tmp/agents/a1/activity/hb_2.json" } },
    );

    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(result.details?.sent).toBe(true);
    expect(result.details?.suppressed).not.toBe(true);
  });

  it("does not suppress all-clear notifications in normal chat sessions", async () => {
    const onNotify = vi.fn(async () => ({ delivered: "local" }));
    const tool = createNotifyTool({ onNotify });

    const result = await tool.execute(
      "tc_3",
      { title: "状态播报", body: "目前无异常，无需处理" },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => "/tmp/agents/a1/sessions/chat_1.json" } },
    );

    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(result.details?.sent).toBe(true);
    expect(result.details?.suppressed).not.toBe(true);
  });

  it("defaults target to local when target/platform are omitted", async () => {
    const onNotify = vi.fn(async () => ({ delivered: "local" }));
    const tool = createNotifyTool({ onNotify });

    await tool.execute("tc_4", { title: "提醒", body: "看下消息" });

    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(onNotify.mock.calls[0][2]).toMatchObject({ target: "local", platform: null });
  });

  it("defaults target to platform when platform is provided", async () => {
    const onNotify = vi.fn(async () => ({ delivered: "platform" }));
    const tool = createNotifyTool({ onNotify });

    await tool.execute("tc_5", { title: "提醒", body: "看下消息", platform: "wechat" });

    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(onNotify.mock.calls[0][2]).toMatchObject({ target: "platform", platform: "wechat" });
  });
});
