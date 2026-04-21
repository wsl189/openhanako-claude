import { describe, expect, it } from "vitest";
import {
  buildNativeHostWrapperContent,
  shouldRunNativeHostAsNode,
} from "./setup.js";

describe("claude-in-chrome native host setup", () => {
  it("enables run-as-node mode for non-node executables", () => {
    const runAsNode = shouldRunNativeHostAsNode({
      executable: "/Applications/Hanako.app/Contents/MacOS/Hanako",
      env: {},
    });
    expect(runAsNode).toBe(true);
  });

  it("keeps node executable in normal mode", () => {
    const runAsNode = shouldRunNativeHostAsNode({
      executable: "/usr/local/bin/node",
      env: {},
    });
    expect(runAsNode).toBe(false);
  });

  it("respects force-run-as-node env override", () => {
    const runAsNode = shouldRunNativeHostAsNode({
      executable: "/usr/local/bin/node",
      env: { HANAKO_CLAUDE_IN_CHROME_FORCE_RUN_AS_NODE: "1" },
    });
    expect(runAsNode).toBe(true);
  });

  it("renders POSIX wrapper with ELECTRON_RUN_AS_NODE when required", () => {
    const script = buildNativeHostWrapperContent({
      executable: "/Applications/Hanako.app/Contents/MacOS/Hanako",
      entryPath: "/tmp/entry.js",
      isWin: false,
      runAsNode: true,
    });

    expect(script).toContain("exec ELECTRON_RUN_AS_NODE=1");
    expect(script).toContain("'/Applications/Hanako.app/Contents/MacOS/Hanako' '/tmp/entry.js' --chrome-native-host");
  });

  it("renders Windows wrapper with ELECTRON_RUN_AS_NODE when required", () => {
    const script = buildNativeHostWrapperContent({
      executable: "C:\\Hanako\\Hanako.exe",
      entryPath: "C:\\hanako\\entry.js",
      isWin: true,
      runAsNode: true,
    });

    expect(script).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(script).toContain('"C:\\Hanako\\Hanako.exe" "C:\\hanako\\entry.js" --chrome-native-host');
  });
});
