import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./llm/provider-client.js", () => ({
  callProviderText: vi.fn(),
}));

import { callProviderText } from "./llm/provider-client.js";
import { extractSessionExperiences } from "./experience-extractor.js";

function createResolvedModel() {
  return {
    model: "mock-model",
    api: "mock-api",
    api_key: "mock-key",
    base_url: "https://example.test",
  };
}

describe("experience-extractor evidence-first", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips extraction when no evidence is provided", async () => {
    const memoryService = { addPlaybook: vi.fn() };
    const result = await extractSessionExperiences({
      episodeAnchor: "用户纠正了工具使用方式",
      evidenceRows: [],
      memoryService,
      resolvedModel: createResolvedModel(),
      origin: "session",
    });

    expect(result).toEqual({ extracted: 0 });
    expect(callProviderText).not.toHaveBeenCalled();
    expect(memoryService.addPlaybook).not.toHaveBeenCalled();
  });

  it("writes extracted playbooks with evidence refs", async () => {
    const memoryService = { addPlaybook: vi.fn() };
    vi.mocked(callProviderText).mockResolvedValue(JSON.stringify([
      {
        category: "工具使用",
        trigger: "需要在代码库中定位文本或文件",
        wrong_path: "直接全量扫描",
        root_cause: "未先收敛范围",
        fix_steps: "先用快速索引再展开",
        validation: "最少读取文件定位目标",
      },
    ]));

    const result = await extractSessionExperiences({
      episodeAnchor: "本轮总结",
      evidenceRows: [
        { id: "evidence_1", content: "用户指出应先检索" },
        { id: "evidence_2", content: "助手确认并修正方案" },
      ],
      memoryService,
      resolvedModel: createResolvedModel(),
      origin: "session",
    });

    expect(result).toEqual({ extracted: 1 });
    expect(memoryService.addPlaybook).toHaveBeenCalledTimes(1);
    expect(memoryService.addPlaybook).toHaveBeenCalledWith(expect.objectContaining({
      category: "工具使用",
      origin: "session",
      sourceRefs: [
        { layer: "evidence", id: "evidence_1" },
        { layer: "evidence", id: "evidence_2" },
      ],
    }));
    expect(callProviderText).toHaveBeenCalledTimes(1);
  });
});
