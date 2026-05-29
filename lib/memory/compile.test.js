import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const compactMock = vi.fn();
const tempRoots = [];

vi.mock("../llm/provider-client.js", () => ({
  callProviderText: (...args) => compactMock(...args),
}));

vi.mock("../../server/i18n.js", () => ({
  getLocale: () => "zh-CN",
}));

function createTempDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-compile-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  compactMock.mockReset();
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("memory compile validation", () => {
  it.each([
    [
      "english let-me preamble",
      [
        "Let me analyze the user's request carefully.",
        "",
        "The user is asking me to consolidate the previous long-term context.",
        "Now let me consolidate:",
      ].join("\n"),
      /missing_final_wrapper/,
    ],
    [
      "english okay preamble",
      "Okay, the user wants me to summarize the durable profile facts. I need to extract stable information first.",
      /missing_final_wrapper/,
    ],
    [
      "english reasoning tag",
      "<think>I need to consolidate the previous context and this week's additions.</think>\n论文项目聚焦四足机器人。",
      /missing_final_wrapper/,
    ],
    [
      "chinese analysis preamble",
      "好的，我需要先分析上一份长期情况和本周新增，再整合成长期背景记录。",
      /missing_final_wrapper/,
    ],
    [
      "chinese step analysis",
      "首先分析输入：用户要求整合长期情况，下面我将提取稳定背景。",
      /missing_final_wrapper/,
    ],
    [
      "prompt echo",
      "## 上一份长期情况\n论文项目聚焦四足机器人。\n\n## 本周新增\n用户继续处理 Rebuttal。",
      /missing_final_wrapper/,
    ],
    [
      "text outside final wrapper",
      "嗯，我需要分析一下...\n<hanako_memory>用户偏好中文摘要，不把临时推理写入长期记忆。</hanako_memory>",
      /missing_final_wrapper/,
    ],
    [
      "wrapped analysis content",
      "<hanako_memory>分析用户提供的资料：用户正在修改四足机器人论文 rebuttal，需要补充实验指标和文献依据。</hanako_memory>",
      /analysis_preamble/,
    ],
  ])("rejects %s instead of writing it to longterm.md", async (_name, badOutput, expectedReason) => {
    const { compileLongterm } = await import("./compile.js");
    const root = createTempDir();
    const weekPath = path.join(root, "week.md");
    const longtermPath = path.join(root, "longterm.md");
    fs.writeFileSync(weekPath, "## 对话概要\n用户正在处理四足机器人论文 Rebuttal。");
    fs.writeFileSync(longtermPath, "论文研究四足机器人深度强化学习运动控制。");

    compactMock.mockResolvedValue(badOutput);

    await expect(compileLongterm(weekPath, longtermPath, {
      model: "mock",
      api: "mock",
      api_key: "",
      base_url: "",
    })).rejects.toThrow(expectedReason);

    expect(fs.readFileSync(longtermPath, "utf8")).toBe("论文研究四足机器人深度强化学习运动控制。");
    expect(fs.existsSync(`${longtermPath}.fingerprint`)).toBe(false);
  });

  it("accepts concise Chinese long-term records with technical English terms", async () => {
    const { compileLongterm } = await import("./compile.js");
    const root = createTempDir();
    const weekPath = path.join(root, "week.md");
    const longtermPath = path.join(root, "longterm.md");
    fs.writeFileSync(weekPath, "用户继续处理 LA-PPO 论文 Rebuttal。");

    compactMock.mockResolvedValue("<hanako_memory>论文项目聚焦四足机器人深度强化学习运动控制，长期任务包括完善 Related Work、LA-PPO 创新说明、网络结构与实验指标。</hanako_memory>");

    await expect(compileLongterm(weekPath, longtermPath, {
      model: "mock",
      api: "mock",
      api_key: "",
      base_url: "",
    })).resolves.toBe("compiled");

    expect(fs.readFileSync(longtermPath, "utf8")).toContain("四足机器人深度强化学习");
    expect(fs.readFileSync(longtermPath, "utf8")).toContain("LA-PPO");
    expect(fs.readFileSync(longtermPath, "utf8")).not.toContain("hanako_memory");
  });

  it("retries once when the model misses the final wrapper", async () => {
    const { compileLongterm } = await import("./compile.js");
    const root = createTempDir();
    const weekPath = path.join(root, "week.md");
    const longtermPath = path.join(root, "longterm.md");
    fs.writeFileSync(weekPath, "用户继续处理 LA-PPO 论文 Rebuttal。");

    compactMock
      .mockResolvedValueOnce("论文项目聚焦四足机器人强化学习运动控制。")
      .mockResolvedValueOnce("<hanako_memory>论文项目聚焦四足机器人强化学习运动控制。</hanako_memory>");

    await expect(compileLongterm(weekPath, longtermPath, {
      model: "mock",
      api: "mock",
      api_key: "",
      base_url: "",
    })).resolves.toBe("compiled");

    expect(compactMock).toHaveBeenCalledTimes(2);
    expect(compactMock.mock.calls[1]?.[0]?.systemPrompt).toContain("上一次输出没有通过记忆摘要格式或质量校验");
    expect(fs.readFileSync(longtermPath, "utf8")).toBe("论文项目聚焦四足机器人强化学习运动控制。");
  });

  it("asks the memory model for a strict final wrapper", async () => {
    const { compileLongterm } = await import("./compile.js");
    const root = createTempDir();
    const weekPath = path.join(root, "week.md");
    const longtermPath = path.join(root, "longterm.md");
    fs.writeFileSync(weekPath, "用户继续处理 LA-PPO 论文 Rebuttal。");

    compactMock.mockResolvedValue("<hanako_memory>论文项目长期聚焦四足机器人强化学习。</hanako_memory>");

    await compileLongterm(weekPath, longtermPath, {
      model: "mock",
      api: "mock",
      api_key: "",
      base_url: "",
    });

    const call = compactMock.mock.calls[0]?.[0];
    expect(call.systemPrompt).toContain("<hanako_memory>");
    expect(call.systemPrompt).toContain("</hanako_memory>");
  });
});
