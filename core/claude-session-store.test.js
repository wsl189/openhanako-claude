import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

import { createSessionMetadata, listSessionMetadata } from "./claude-session-store.js";

describe("listSessionMetadata", () => {
  it("can exclude nested background session files from the main session list", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-session-store-"));
    const sessionDir = path.join(root, "sessions");
    const nestedDir = path.join(sessionDir, "dms");

    createSessionMetadata(sessionDir, {
      sessionId: "visible-session",
      cwd: root,
      agentId: "alpha",
    });
    createSessionMetadata(nestedDir, {
      sessionId: "hidden-dm-session",
      cwd: root,
      agentId: "alpha",
    });

    const all = listSessionMetadata(sessionDir, { includeArchived: true });
    const directOnly = listSessionMetadata(sessionDir, {
      includeArchived: true,
      directOnly: true,
    });

    expect(all.map((item) => path.relative(sessionDir, item.sessionPath)).sort()).toEqual(
      [
        "visible-session.session.json",
        path.join("dms", "hidden-dm-session.session.json"),
      ].sort(),
    );
    expect(directOnly.map((item) => path.relative(sessionDir, item.sessionPath))).toEqual([
      "visible-session.session.json",
    ]);
  });
});
