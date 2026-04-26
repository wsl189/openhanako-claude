import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDirs } from "./dirs.js";

let tempRoot = null;

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe("compat dir checks", () => {
  it("creates only core memory dirs and leaves runtime dirs on demand", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-compat-dirs-"));
    const agentDir = path.join(tempRoot, "agent");
    fs.mkdirSync(agentDir, { recursive: true });

    checkDirs({ agentDir });

    expect(fs.existsSync(path.join(agentDir, "memory"))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, "memory", "summaries"))).toBe(true);

    for (const dir of ["sessions", "desk", "heartbeat", "book", "activity", "avatars"]) {
      expect(fs.existsSync(path.join(agentDir, dir))).toBe(false);
    }
  });
});
