import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { PathGuard } from "./path-guard.js";
import { deriveSandboxPolicy } from "./policy.js";

const tempRoots = [];

function createGuardFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-path-guard-"));
  const hanakoHome = path.join(root, ".hanako");
  const agentDir = path.join(hanakoHome, "agents", "hanako");
  const workspace = path.join(root, "workspace");
  tempRoots.push(root);

  fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "experience"), { recursive: true });
  fs.mkdirSync(path.join(hanakoHome, "user"), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "pinned.md"), "");
  fs.writeFileSync(path.join(agentDir, "experience.md"), "");
  fs.writeFileSync(path.join(agentDir, "experience", "General.md"), "");
  fs.writeFileSync(path.join(agentDir, "memory", "memory.md"), "");
  fs.writeFileSync(path.join(hanakoHome, "user", "user.md"), "");
  fs.writeFileSync(path.join(workspace, "notes.txt"), "");

  const policy = deriveSandboxPolicy({
    mode: "full-access",
    hanakoHome,
    agentDir,
    workspace,
  });
  return {
    guard: new PathGuard(policy),
    agentDir,
    hanakoHome,
    workspace,
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("PathGuard projection protection", () => {
  it("still denies projection writes in full-access mode", () => {
    const { guard, agentDir, hanakoHome, workspace } = createGuardFixture();

    expect(guard.check(path.join(agentDir, "pinned.md"), "write").allowed).toBe(false);
    expect(guard.check(path.join(agentDir, "experience", "General.md"), "write").allowed).toBe(false);
    expect(guard.check(path.join(agentDir, "memory", "memory.md"), "write").allowed).toBe(false);
    expect(guard.check(path.join(hanakoHome, "user", "user.md"), "write").allowed).toBe(false);

    expect(guard.check(path.join(agentDir, "pinned.md"), "read")).toEqual({ allowed: true });
    expect(guard.check(path.join(workspace, "notes.txt"), "write")).toEqual({ allowed: true });
  });

  it("denies deleting directories that contain projection-only files", () => {
    const { guard, agentDir } = createGuardFixture();

    expect(guard.check(path.join(agentDir, "experience"), "delete").allowed).toBe(false);
    expect(guard.check(path.join(agentDir, "memory"), "delete").allowed).toBe(false);
  });
});
