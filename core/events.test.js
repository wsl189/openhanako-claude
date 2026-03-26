import { describe, expect, it } from "vitest";
import { MoodParser } from "./events.js";

function runMoodParser(chunks) {
  const parser = new MoodParser();
  const events = [];
  for (const chunk of chunks) {
    parser.feed(chunk, (evt) => events.push(evt));
  }
  parser.flush((evt) => events.push(evt));
  return events;
}

describe("MoodParser", () => {
  it("parses mood blocks with attributes and spaced closing tags", () => {
    const events = runMoodParser(['<reflect mode="deep">思考内容</reflect   >\n正文']);
    const text = events.filter((e) => e.type === "text").map((e) => e.data).join("");
    const mood = events.filter((e) => e.type === "mood_text").map((e) => e.data).join("");

    expect(mood).toBe("思考内容");
    expect(text).toBe("正文");
    expect(events.some((e) => e.type === "mood_start")).toBe(true);
    expect(events.some((e) => e.type === "mood_end")).toBe(true);
  });

  it("handles split open/close tags across streaming chunks", () => {
    const events = runMoodParser([
      "前缀<ref",
      'lect mode="x">内',
      "省</refl",
      "ect>\n后缀",
    ]);
    const text = events.filter((e) => e.type === "text").map((e) => e.data).join("");
    const mood = events.filter((e) => e.type === "mood_text").map((e) => e.data).join("");

    expect(mood).toBe("内省");
    expect(text).toBe("前缀后缀");
  });
});

