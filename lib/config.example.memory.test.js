import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

describe("config.example memory section", () => {
  it("does not advertise legacy memory scoring knobs", () => {
    const content = fs.readFileSync(path.resolve("lib/config.example.yaml"), "utf-8");
    const banned = [
      "token_budget",
      "decay_per_day",
      "hit_bonus",
      "base_importance",
      "compile_threshold",
      "forget_speed",
      "memory.md 的目标 token 预算",
    ];

    for (const phrase of banned) {
      expect(content.includes(phrase)).toBe(false);
    }
  });
});
