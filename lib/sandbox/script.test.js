import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, writeProfile, writeScript } from "./script.js";

describe("sandbox script temp location", () => {
  const originalHanaHome = process.env.HANA_HOME;
  const tempDirs = [];

  afterEach(() => {
    process.env.HANA_HOME = originalHanaHome;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("writes temporary script and profile under HANA_HOME/tmp/scripts", () => {
    const hanaHome = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-script-home-"));
    tempDirs.push(hanaHome);
    process.env.HANA_HOME = hanaHome;

    const { scriptPath } = writeScript("echo hello", process.cwd());
    const { profilePath } = writeProfile("(version 1)");

    const expectedRoot = path.join(hanaHome, "tmp", "scripts");
    expect(scriptPath.startsWith(expectedRoot + path.sep)).toBe(true);
    expect(profilePath.startsWith(expectedRoot + path.sep)).toBe(true);
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fs.existsSync(profilePath)).toBe(true);

    cleanup(scriptPath, profilePath);
    expect(fs.existsSync(scriptPath)).toBe(false);
    expect(fs.existsSync(profilePath)).toBe(false);
  });

  it("expands tilde-style HANA_HOME before creating temp files", () => {
    const homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-script-tilde-home-"));
    tempDirs.push(homeTmp);
    const hanaHomeName = `.hanako-test-${Date.now()}`;
    const resolvedHanaHome = path.join(homeTmp, hanaHomeName);

    const originalHome = process.env.HOME;
    process.env.HOME = homeTmp;
    process.env.HANA_HOME = `~/${hanaHomeName}`;
    try {
      const { scriptPath } = writeScript("echo home", process.cwd());
      expect(scriptPath.startsWith(path.join(resolvedHanaHome, "tmp", "scripts") + path.sep)).toBe(true);
      cleanup(scriptPath);
    } finally {
      process.env.HOME = originalHome;
      tempDirs.push(resolvedHanaHome);
    }
  });
});
