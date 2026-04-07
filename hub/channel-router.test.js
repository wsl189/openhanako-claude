import { describe, expect, it, vi } from "vitest";
import { ChannelRouter } from "./channel-router.js";

describe("ChannelRouter agent post behavior", () => {
  it("does not dispatch mention-triggered replies for agent posts", () => {
    const emit = vi.fn();
    const hub = {
      engine: {},
      eventBus: { emit },
    };
    const router = new ChannelRouter({ hub });
    const triggerSpy = vi.spyOn(router, "triggerImmediate").mockReturnValue(Promise.resolve());

    router._handleAgentPost("ch_team", "alpha", "@beta 请处理这个", { source: "tool" });

    expect(emit).toHaveBeenCalledWith(
      { type: "channel_new_message", channelName: "ch_team", sender: "alpha" },
      null,
    );
    expect(triggerSpy).not.toHaveBeenCalled();
  });
});
