import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { ensureFirstRun } from "./first-run.js";

const cleanupDirs = [];

function mktemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ensureFirstRun", () => {
  it("seeds default agent without tools.custom_enabled so custom tools stay enabled by default", () => {
    const hanakoHome = mktemp("hanako-home-");
    const productRoot = mktemp("hanako-product-root-");
    const productDir = path.join(productRoot, "lib");
    fs.mkdirSync(productDir, { recursive: true });

    fs.writeFileSync(path.join(productDir, "config.example.yaml"), [
      "agent:",
      "  name: Hanako",
      "tools:",
      "  custom_enabled: []",
      "  pdf2md:",
      "    base_url: \"\"",
      "",
    ].join("\n"), "utf-8");
    fs.writeFileSync(path.join(productDir, "identity.example.md"), "identity", "utf-8");
    fs.writeFileSync(path.join(productDir, "ishiki.example.md"), "ishiki", "utf-8");

    ensureFirstRun(hanakoHome, productDir);

    const seededConfigPath = path.join(hanakoHome, "agents", "hanako", "config.yaml");
    expect(fs.existsSync(seededConfigPath)).toBe(true);
    const seededConfig = YAML.load(fs.readFileSync(seededConfigPath, "utf-8")) || {};
    expect(seededConfig?.tools?.custom_enabled).toBeUndefined();
    expect(seededConfig?.tools?.pdf2md?.base_url ?? "").toBe("");
  });
});
