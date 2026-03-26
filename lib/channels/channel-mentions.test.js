import { describe, expect, it } from "vitest";
import { collectMentionedAgentIds, hasMentionAll } from "./channel-mentions.js";

describe("channel mentions parser", () => {
  const agents = [
    { id: "macro", name: "宏观政策分析师" },
    { id: "overseas", name: "外盘联动分析师" },
    { id: "tech", name: "技术结构分析师" },
  ];
  const allowedIds = agents.map((a) => a.id);

  it("parses @name followed by full-width colon", () => {
    const text = "• @宏观政策分析师：请先分析行业政策";
    expect(collectMentionedAgentIds(text, agents, allowedIds)).toEqual(["macro"]);
  });

  it("supports full-width at sign", () => {
    const text = "请 ＠外盘联动分析师：补充一下外盘走势";
    expect(collectMentionedAgentIds(text, agents, allowedIds)).toEqual(["overseas"]);
  });

  it("treats full-width colon after mention-all as mention-all", () => {
    const text = "@全体成员：现在开始分工";
    expect(hasMentionAll(text)).toBe(true);
    expect(collectMentionedAgentIds(text, agents, allowedIds)).toEqual(["macro", "overseas", "tech"]);
  });

  it("supports channel members whitelist provided as display names", () => {
    const text = "@宏观政策分析师：先看政策；@外盘联动分析师：补充外盘";
    const allowedNames = ["宏观政策分析师", "外盘联动分析师"];
    expect(collectMentionedAgentIds(text, agents, allowedNames)).toEqual(["macro", "overseas"]);
  });

  it("matches allowed display names case-insensitively", () => {
    const enAgents = [
      { id: "macro", name: "Macro Analyst" },
      { id: "overseas", name: "Overseas Analyst" },
    ];
    const text = "@Macro Analyst please lead";
    expect(collectMentionedAgentIds(text, enAgents, ["macro analyst"])).toEqual(["macro"]);
  });

  it("parses mentions wrapped in markdown bold", () => {
    const text = "**@宏观政策分析师** 请先看政策，**@外盘联动分析师** 补充外盘";
    expect(collectMentionedAgentIds(text, agents, allowedIds)).toEqual(["macro", "overseas"]);
  });

  it("parses mentions wrapped by markdown decorators", () => {
    const text = "__@技术结构分析师__ 跟进形态，~~@外盘联动分析师~~ 对照外盘，`@宏观政策分析师` 看政策";
    expect(collectMentionedAgentIds(text, agents, allowedIds)).toEqual(["macro", "overseas", "tech"]);
  });
});
