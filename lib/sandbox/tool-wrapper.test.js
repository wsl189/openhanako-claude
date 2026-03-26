import path from "path";
import { describe, expect, it, vi } from "vitest";
import { extractDeleteTargets, wrapBashTool } from "./tool-wrapper.js";

function createGuard(workspace = "/workspace") {
  return {
    check: vi.fn((targetPath, operation) => {
      const insideWorkspace = targetPath === workspace || targetPath.startsWith(workspace + path.sep);
      if (operation === "delete" && !insideWorkspace) {
        return { allowed: false, reason: `delete denied: ${targetPath}` };
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
});
