import { describe, expect, it } from "vitest";
import { buildCompactionSettings } from "./compaction-settings.js";

describe("buildCompactionSettings", () => {
  it("keeps legacy strategy for large context windows", () => {
    const settings = buildCompactionSettings(128_000);
    expect(settings).toEqual({
      enabled: true,
      reserveTokens: 28_000,
      keepRecentTokens: 20_000,
    });
  });

  it("uses proportional strategy for small context windows", () => {
    const settings = buildCompactionSettings(8_192);
    expect(settings.enabled).toBe(true);
    expect(settings.keepRecentTokens).toBe(2_048);
    expect(settings.reserveTokens).toBe(Math.floor(8_192 * 0.2));
    expect(settings.keepRecentTokens + settings.reserveTokens).toBeLessThan(8_192);
  });

  it("falls back to default window for invalid input", () => {
    const settings = buildCompactionSettings(0);
    expect(settings.enabled).toBe(true);
    expect(settings.keepRecentTokens).toBe(20_000);
    expect(settings.reserveTokens).toBe(100_000);
  });
});

