import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const ZH_BANNED = [
  "当下记忆",
  "所有记忆",
  "清除记忆",
  "此操作不可撤销",
  "memory.md 的目标 token 预算",
];

const EN_BANNED = [
  "Compiled memory cleared",
  "All Memories",
  "Always injected into conversations, never decay",
  "Decay coefficient",
  "hit bonus",
  "base importance",
  "compile threshold",
  "forget speed",
];

function collectStrings(value: unknown, out: string[] = []) {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out);
    }
  }
  return out;
}

function loadLocaleStrings(filePath: string) {
  const content = fs.readFileSync(filePath, "utf-8");
  return collectStrings(JSON.parse(content));
}

describe("memory i18n guard", () => {
  it("keeps banned legacy Chinese memory wording out of the locale strings", () => {
    const strings = loadLocaleStrings(path.resolve("desktop/src/locales/zh.json"));
    for (const phrase of ZH_BANNED) {
      expect(strings.some((item) => item.includes(phrase))).toBe(false);
    }
  });

  it("keeps banned legacy English memory wording out of the locale strings", () => {
    const strings = loadLocaleStrings(path.resolve("desktop/src/locales/en.json"));
    const lowered = strings.map((item) => item.toLowerCase());
    for (const phrase of EN_BANNED) {
      expect(lowered.some((item) => item.includes(phrase.toLowerCase()))).toBe(false);
    }
  });
});
