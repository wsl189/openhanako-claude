import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  spawnSync: vi.fn(),
  spawnAndStream: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal()),
  existsSync: mocks.existsSync,
}));

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal()),
  spawnSync: mocks.spawnSync,
}));

vi.mock("./exec-helper.js", () => ({
  spawnAndStream: mocks.spawnAndStream,
}));

import { createWin32Exec, __win32ExecInternals } from "./win32-exec.js";

const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
const originalEnv = { ...process.env };

function setResourcesPath(value) {
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value,
  });
}

describe("win32 exec shell discovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    __win32ExecInternals._resetCachedShellForTests();
    setResourcesPath(undefined);
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: "" });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    __win32ExecInternals._resetCachedShellForTests();
    if (originalResourcesPath) {
      Object.defineProperty(process, "resourcesPath", originalResourcesPath);
    } else {
      delete process.resourcesPath;
    }
  });

  it("discovers bundled MinGit BusyBox ash.exe", () => {
    setResourcesPath("/app/resources");
    mocks.existsSync.mockImplementation((p) => p === "/app/resources/git/mingw64/bin/ash.exe");

    const candidates = __win32ExecInternals.getAllShellCandidates();

    expect(candidates).toContainEqual({
      shell: "/app/resources/git/mingw64/bin/ash.exe",
      args: ["-c"],
      label: "Bundled MinGit BusyBox ash (/app/resources/git/mingw64/bin/ash.exe)",
    });
  });

  it("keeps the original shell failure when no fallback shell exists", async () => {
    const primaryShell = "C:\\Program Files\\Git\\bin\\bash.exe";
    process.env.ProgramFiles = "C:\\Program Files";
    mocks.existsSync.mockImplementation((p) => p === primaryShell);
    mocks.spawnSync.mockImplementation((cmd) => {
      if (cmd === primaryShell) return { status: 0, stdout: "__hana_probe_ok__\n" };
      return { status: 1, stdout: "" };
    });
    mocks.spawnAndStream.mockRejectedValue(Object.assign(new Error("spawn ENOENT"), {
      code: "ENOENT",
      path: primaryShell,
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const exec = createWin32Exec();

    await expect(exec("echo ok", "C:\\work", {
      onData: () => {},
      timeout: 1,
      env: {},
    })).rejects.toThrow("[win32-exec] Cannot execute shell command.");
  });
});
