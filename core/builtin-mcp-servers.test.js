import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { getBuiltinExternalMcpServers } from "./builtin-mcp-servers.js";

function createFakeOpenComputerUseEntry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hanako-builtin-mcp-"));
  const entryPath = path.join(root, "bin", "open-computer-use");
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, "#!/usr/bin/env node\n", "utf8");
  return { root, entryPath };
}

describe("getBuiltinExternalMcpServers", () => {
  it("does not register built-in open_computer_use on Windows", () => {
    const servers = getBuiltinExternalMcpServers({}, { platform: "win32" });
    expect(servers).toEqual({});
  });

  it("keeps built-in open_computer_use on non-Windows platforms", () => {
    const { root, entryPath } = createFakeOpenComputerUseEntry();
    try {
      const servers = getBuiltinExternalMcpServers(
        {
          HANAKO_OPEN_COMPUTER_USE_ENTRY: entryPath,
        },
        { platform: "darwin", arch: "arm64", execPath: process.execPath },
      );

      expect(servers.open_computer_use).toBeTruthy();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
