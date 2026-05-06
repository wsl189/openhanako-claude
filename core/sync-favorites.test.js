import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache } from "../lib/memory/config-loader.js";
import { syncFavoritesToModelsJson } from "./sync-favorites.js";

describe("syncFavoritesToModelsJson", () => {
  const originalHanakoHome = process.env.HANA_HOME;
  const tempDirs = [];

  afterEach(() => {
    process.env.HANA_HOME = originalHanakoHome;
    clearConfigCache();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps canonical refs pinned to their providers when raw ids overlap", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-sync-favorites-"));
    tempDirs.push(tempDir);
    process.env.HANA_HOME = tempDir;
    clearConfigCache();

    const configPath = path.join(tempDir, "config.yaml");
    const modelsJsonPath = path.join(tempDir, "models.json");
    const providersYamlPath = path.join(tempDir, "providers.yaml");

    fs.writeFileSync(configPath, "models: {}\n", "utf-8");
    fs.writeFileSync(modelsJsonPath, JSON.stringify({ providers: {} }, null, 4) + "\n", "utf-8");
    fs.writeFileSync(
      providersYamlPath,
      [
        "providers:",
        "  openrouter:",
        "    base_url: https://openrouter.ai/api/v1",
        "    api_key: test-openrouter",
        "    api: openai-completions",
        "    models:",
        "      - minimax/minimax-m2.5:free",
        "  minimax:",
        "    base_url: https://api.minimaxi.com/v1",
        "    api_key: test-minimax",
        "    api: openai-completions",
        "    models:",
        "      - minimax-m2.5:free",
        "",
      ].join("\n"),
      "utf-8",
    );

    const changed = syncFavoritesToModelsJson(configPath, {
      modelsJsonPath,
      favorites: [
        "openrouter/minimax/minimax-m2.5:free",
        "minimax/minimax-m2.5:free",
      ],
    });

    expect(changed).toBe(true);

    const written = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(Object.keys(written.providers)).toEqual(["openrouter", "minimax"]);
    expect(written.providers.openrouter.models.map((model) => model.id)).toEqual(["minimax/minimax-m2.5:free"]);
    expect(written.providers.minimax.models.map((model) => model.id)).toEqual(["minimax-m2.5:free"]);
  });
});
