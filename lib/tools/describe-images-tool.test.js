import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadLocale } from "../../server/i18n.js";

vi.mock("../llm/provider-client.js", () => ({
  callProviderVision: vi.fn(async () => "mock image description"),
}));

import { callProviderVision } from "../llm/provider-client.js";
import { createDescribeImagesTool } from "./describe-images-tool.js";

function createTool() {
  return createDescribeImagesTool({
    getSessionImages: () => [],
    getCurrentSessionPath: () => null,
    getLatestSessionImages: () => [],
    getSessionMessages: () => [],
    resolveVisionModel: () => ({
      api: "openai",
      api_key: "test-key",
      base_url: "https://example.com/v1",
      model: "vision-test-model",
    }),
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

describe("describe-images-tool path inputs", () => {
  it("reads a single absolute image file path via image_path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "describe-image-tool-"));
    cleanupDirs.push(dir);
    const imagePath = path.join(dir, "sample.png");
    fs.writeFileSync(imagePath, "fake-image-data");

    const tool = createTool();
    const result = await tool.execute("tc_1", { image_path: imagePath, prompt: "describe it" });

    expect(callProviderVision).toHaveBeenCalledTimes(1);
    const payload = callProviderVision.mock.calls[0][0];
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0].mimeType).toBe("image/png");
    expect(result.details?.imageCount).toBe(1);
  });

  it("supports file:// absolute image file path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "describe-image-tool-"));
    cleanupDirs.push(dir);
    const imagePath = path.join(dir, "space image.jpg");
    fs.writeFileSync(imagePath, "fake-image-data");
    const imageUri = pathToFileURL(imagePath).href;

    const tool = createTool();
    const result = await tool.execute("tc_2", { image_path: imageUri });

    expect(callProviderVision).toHaveBeenCalledTimes(1);
    const payload = callProviderVision.mock.calls[0][0];
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0].mimeType).toBe("image/jpeg");
    expect(result.details?.imageCount).toBe(1);
  });

  it("rejects relative image paths", async () => {
    const tool = createTool();
    const result = await tool.execute("tc_3", { image_paths: ["images/demo.png"] });

    expect(callProviderVision).not.toHaveBeenCalled();
    expect(result.details?.error).toBe("no_images_from_paths");
  });
});

