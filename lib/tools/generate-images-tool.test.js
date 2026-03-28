import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadLocale } from "../../server/i18n.js";

vi.mock("../llm/provider-client.js", () => ({
  callProviderImageGeneration: vi.fn(async () => ["ZmFrZS1pbWFnZS1ieXRlcw=="]),
}));

import { callProviderImageGeneration } from "../llm/provider-client.js";
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
  it("returns provider_not_minimax when current provider is not minimax", async () => {
    const tool = createTool({
      resolveImageGenerationModel: () => ({
        provider: "openai",
        api: "openai-completions",
        api_key: "test-key",
        base_url: "https://api.openai.com/v1",
        model: "gpt-image-1",
      }),
    });

    const result = await tool.execute("tc_1", { prompt: "draw a red cat" });

    expect(callProviderImageGeneration).not.toHaveBeenCalled();
    expect(result.details?.error).toBe("provider_not_minimax");
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
});
