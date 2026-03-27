import path from "path";
import { describe, expect, it, vi } from "vitest";
import { extractDeleteTargets, extractGuardPaths, wrapBashTool } from "./tool-wrapper.js";

function createGuard(workspace = "/workspace") {
  return {
    check: vi.fn((targetPath, operation) => {
      const insideWorkspace = targetPath === workspace || targetPath.startsWith(workspace + path.sep);
      if ((operation === "read" || operation === "delete") && !insideWorkspace) {
        return { allowed: false, reason: `${operation} denied: ${targetPath}` };
      }
      return { allowed: true };
    }),
  };
}

describe("sandbox bash delete guard", () => {
  it("extracts delete targets from rm and find -delete commands", () => {
    const rmTargets = extractDeleteTargets("rm -rf ./tmp ../build", "/workspace/app");
    expect(rmTargets).toEqual([
      "/workspace/app/tmp",
      "/workspace/build",
    ]);

    const findTargets = extractDeleteTargets("find /tmp -name '*.tmp' -delete", "/workspace/app");
    expect(findTargets).toEqual(["/tmp"]);
  });

  it("extracts guard paths and tracks cd across command segments", () => {
    const paths = extractGuardPaths("cd ../ && cat ./notes.md && ls /workspace/app/src", "/workspace/app");
    expect(paths).toEqual([
      "/workspace",
      "/workspace/notes.md",
      "/workspace/app/src",
    ]);

    const skipCommandPath = extractGuardPaths("/bin/ls /workspace/app", "/workspace/app");
    expect(skipCommandPath).toEqual(["/workspace/app"]);
  });

  it("blocks deleting paths outside workspace", async () => {
    const guard = createGuard("/workspace");
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const wrapped = wrapBashTool({ name: "bash", execute }, guard, "/workspace");

    const result = await wrapped.execute("tc-1", { command: "rm -rf /tmp/secret.txt" });

    expect(execute).not.toHaveBeenCalled();
    expect(result?.content?.[0]?.type).toBe("text");
  });

  it("allows deleting paths inside workspace", async () => {
    const guard = createGuard("/workspace");
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const wrapped = wrapBashTool({ name: "bash", execute }, guard, "/workspace");

    await wrapped.execute("tc-2", { command: "rm -rf ./cache/file.txt" });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("tracks cd before rm and blocks when resulting path is outside workspace", async () => {
    const guard = createGuard("/workspace");
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const wrapped = wrapBashTool({ name: "bash", execute }, guard, "/workspace");

    await wrapped.execute("tc-3", { command: "cd /tmp && rm old.log" });

    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks reading explicit paths outside workspace", async () => {
    const guard = createGuard("/workspace");
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const wrapped = wrapBashTool({ name: "bash", execute }, guard, "/workspace");

    await wrapped.execute("tc-4", { command: "cat /tmp/secret.txt" });

    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks reading paths outside workspace after cd", async () => {
    const guard = createGuard("/workspace");
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const wrapped = wrapBashTool({ name: "bash", execute }, guard, "/workspace/app");

    await wrapped.execute("tc-5", { command: "cd ../.. && cat notes.txt" });

    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks reading env-var-expanded paths outside workspace", async () => {
    const guard = createGuard("/workspace");
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const wrapped = wrapBashTool({ name: "bash", execute }, guard, "/workspace");

    await wrapped.execute("tc-5b", { command: "cat $HOME/Desktop/secret.txt" });

    expect(execute).not.toHaveBeenCalled();
  });

  it("allows reading explicit paths inside workspace", async () => {
    const guard = createGuard("/workspace");
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const wrapped = wrapBashTool({ name: "bash", execute }, guard, "/workspace/app");

    await wrapped.execute("tc-6", { command: "cat ./notes.txt" });

    expect(execute).toHaveBeenCalledTimes(1);
  });
});
