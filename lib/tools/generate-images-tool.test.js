import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadLocale } from "../../server/i18n.js";

vi.mock("../llm/provider-client.js", () => ({
  callProviderImageGeneration: vi.fn(async () => ["ZmFrZS1pbWFnZS1ieXRlcw=="]),
  callModelscopeImageGeneration: vi.fn(async () => ["bW9kZWxzY29wZS1mYWtlLWltYWdl"]),
}));

import { callModelscopeImageGeneration, callProviderImageGeneration } from "../llm/provider-client.js";
import { createGenerateImagesTool } from "./generate-images-tool.js";

function createTool(overrides = {}) {
  return createGenerateImagesTool({
    getSessionImages: () => [],
    getCurrentSessionPath: () => null,
    getLatestSessionImages: () => [],
    getSessionMessages: () => [],
    resolveImageGenerationModel: () => ({
      provider: "minimax",
      api: "openai-completions",
      api_key: "test-key",
      base_url: "https://api.minimaxi.com/v1",
      model: "image-01",
    }),
    ...overrides,
  });
}

let cleanupDirs = [];

beforeAll(() => {
  loadLocale("en");
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs = [];
});

describe("generate-images-tool", () => {
  it("returns resolve_model_failed when minimax credentials are unavailable", async () => {
    const tool = createTool({
      resolveImageGenerationModel: () => { throw new Error("provider \"minimax\" missing credentials"); },
    });

    const result = await tool.execute("tc_1", { prompt: "draw a red cat" });

    expect(callProviderImageGeneration).not.toHaveBeenCalled();
    expect(result.details?.error).toBe("resolve_model_failed");
  });

  it("generates and saves image files for text2image", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-image-tool-"));
    cleanupDirs.push(dir);
    const tool = createTool();

    const result = await tool.execute(
      "tc_2",
      { prompt: "draw a mountain at sunrise" },
      null,
      null,
      { sessionManager: { getCwd: () => dir } },
    );

    expect(callProviderImageGeneration).toHaveBeenCalledTimes(1);
    const payload = callProviderImageGeneration.mock.calls[0][0];
    expect(payload.prompt).toBe("draw a mountain at sunrise");
    expect(payload.n).toBe(1);
    expect(payload.width).toBe(1024);
    expect(payload.height).toBe(1024);
    expect(result.details?.imageCount).toBe(1);
    expect(result.details?.files?.length).toBe(1);
    expect(fs.existsSync(result.details.files[0].filePath)).toBe(true);
  });

  it("returns no_images_for_i2i when image2image has no references", async () => {
    const tool = createTool();

    const result = await tool.execute("tc_3", { prompt: "restyle this image", mode: "image2image" });

    expect(callProviderImageGeneration).not.toHaveBeenCalled();
    expect(result.details?.error).toBe("no_images_for_i2i");
  });

  it("falls back to ModelScope when minimax image-01 call fails", async () => {
    callProviderImageGeneration.mockImplementationOnce(async () => {
      throw new Error("image-01 unavailable");
    });
    const tool = createTool({
      resolveImageGenerationModel: () => ({
        provider: "minimax",
        api: "openai-completions",
        api_key: "minimax-key",
        base_url: "https://api.minimaxi.com/v1",
        model: "image-01",
        fallback: {
          provider: "modelscope",
          api: "openai-completions",
          api_key: "ms-key",
          base_url: "https://api-inference.modelscope.cn/v1",
          model: "Qwen/Qwen-Image-2512",
        },
      }),
    });

    const result = await tool.execute("tc_4", { prompt: "stormy sea at sunrise" });

    expect(callProviderImageGeneration).toHaveBeenCalledTimes(1);
    expect(callModelscopeImageGeneration).toHaveBeenCalledTimes(1);
    expect(result.details?.provider).toBe("modelscope");
    expect(result.details?.fallbackFrom).toBe("image-01");
  });

  it("uses modelscope when provider=modelscope is explicitly selected", async () => {
    const tool = createTool({
      resolveImageGenerationModel: () => ({
        provider: "minimax",
        api: "openai-completions",
        api_key: "minimax-key",
        base_url: "https://api.minimaxi.com/v1",
        model: "image-01",
        fallback: {
          provider: "modelscope",
          api: "openai-completions",
          api_key: "ms-key",
          base_url: "https://api-inference.modelscope.cn/v1",
          model: "Qwen/Qwen-Image-2512",
        },
      }),
    });

    const result = await tool.execute("tc_5", {
      prompt: "a calm ocean at dusk",
      provider: "modelscope",
    });

    expect(callModelscopeImageGeneration).toHaveBeenCalledTimes(1);
    expect(callProviderImageGeneration).not.toHaveBeenCalled();
    expect(result.details?.provider).toBe("modelscope");
    expect(result.details?.providerSelection).toBe("modelscope");
  });

  it("auto-selects minimax when provider is omitted and minimax is available", async () => {
    const tool = createTool({
      resolveImageGenerationModel: () => ({
        provider: "minimax",
        api: "openai-completions",
        api_key: "minimax-key",
        base_url: "https://api.minimaxi.com/v1",
        model: "image-01",
        fallback: {
          provider: "modelscope",
          api: "openai-completions",
          api_key: "ms-key",
          base_url: "https://api-inference.modelscope.cn/v1",
          model: "Qwen/Qwen-Image-2512",
        },
      }),
    });

    const result = await tool.execute("tc_6", {
      prompt: "a calm beach at sunset",
    });

    expect(callProviderImageGeneration).toHaveBeenCalledTimes(1);
    expect(callModelscopeImageGeneration).not.toHaveBeenCalled();
    expect(result.details?.provider).toBe("minimax");
    expect(result.details?.providerSelection).toBe("auto");
  });

  it("auto-selects modelscope when provider is omitted and minimax is unavailable", async () => {
    const tool = createTool({
      resolveImageGenerationModel: () => ({
        provider: "modelscope",
        api: "openai-completions",
        api_key: "ms-key",
        base_url: "https://api-inference.modelscope.cn/v1",
        model: "Qwen/Qwen-Image-2512",
      }),
    });

    const result = await tool.execute("tc_7", {
      prompt: "a fox in watercolor style",
    });

    expect(callModelscopeImageGeneration).toHaveBeenCalledTimes(1);
    expect(callProviderImageGeneration).not.toHaveBeenCalled();
    expect(result.details?.provider).toBe("modelscope");
    expect(result.details?.providerSelection).toBe("auto");
  });
});
