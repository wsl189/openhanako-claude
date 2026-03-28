import { describe, expect, it } from "vitest";
import { ThinkTagParser } from "./events.js";

function runThinkParser(chunks) {
  const parser = new ThinkTagParser();
  const events = [];
  for (const chunk of chunks) {
    parser.feed(chunk, (evt) => events.push(evt));
  }
  parser.flush((evt) => events.push(evt));
  return events;
}

describe("ThinkTagParser", () => {
  it("parses think blocks", () => {
    const events = runThinkParser(["前缀<think>思考内容</think>正文"]);
    const text = events.filter((e) => e.type === "text").map((e) => e.data).join("");
    const think = events.filter((e) => e.type === "think_text").map((e) => e.data).join("");

    expect(think).toBe("思考内容");
    expect(text).toBe("前缀正文");
    expect(events.some((e) => e.type === "think_start")).toBe(true);
    expect(events.some((e) => e.type === "think_end")).toBe(true);
  });

  it("handles split open/close tags across streaming chunks", () => {
    const events = runThinkParser([
      "前缀<th",
      "ink>内",
      "省</thi",
      "nk>\n后缀",
    ]);
    const text = events.filter((e) => e.type === "text").map((e) => e.data).join("");
    const think = events.filter((e) => e.type === "think_text").map((e) => e.data).join("");

    expect(think).toBe("内省");
    expect(text).toBe("前缀后缀");
  });
});
