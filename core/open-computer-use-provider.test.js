import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { resolveOpenComputerUseExternalServer } from "./open-computer-use-provider.js";

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFakeOpenComputerUsePackage(rootDir, { includeWindowsExe = false } = {}) {
  const entryPath = path.join(rootDir, "bin", "open-computer-use");
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, "#!/usr/bin/env node\n", "utf8");

  if (includeWindowsExe) {
    const exePath = path.join(rootDir, "dist", "windows", "amd64", "open-computer-use.exe");
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    fs.writeFileSync(exePath, "", "utf8");
  }

  return entryPath;
}

describe("resolveOpenComputerUseExternalServer", () => {
  it("uses native Windows executable by default when available", () => {
    const root = mkTempDir("hanako-ocu-provider-win-");
    try {
      const entryPath = createFakeOpenComputerUsePackage(root, { includeWindowsExe: true });
      const runtime = {
        platform: "win32",
        arch: "x64",
        execPath: "C:\\Hanako\\Hanako.exe",
        versions: { electron: "38.8.4" },
      };

      const resolved = resolveOpenComputerUseExternalServer({
        HANAKO_OPEN_COMPUTER_USE_ENTRY: entryPath,
      }, runtime);

      expect(resolved?.server).toEqual({
        type: "stdio",
        command: path.join(root, "dist", "windows", "amd64", "open-computer-use.exe"),
        args: ["mcp"],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to node entry when native Windows executable is missing", () => {
    const root = mkTempDir("hanako-ocu-provider-win-fallback-");
    try {
      const entryPath = createFakeOpenComputerUsePackage(root, { includeWindowsExe: false });
      const runtime = {
        platform: "win32",
        arch: "x64",
        execPath: "C:\\Hanako\\Hanako.exe",
        versions: { electron: "38.8.4" },
      };

      const resolved = resolveOpenComputerUseExternalServer({
        HANAKO_OPEN_COMPUTER_USE_ENTRY: entryPath,
      }, runtime);

      expect(resolved?.server).toEqual({
        type: "stdio",
        command: "C:\\Hanako\\Hanako.exe",
        args: [entryPath, "mcp"],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("respects explicit command override", () => {
    const root = mkTempDir("hanako-ocu-provider-explicit-");
    try {
      const entryPath = createFakeOpenComputerUsePackage(root, { includeWindowsExe: true });
      const runtime = {
        platform: "win32",
        arch: "x64",
        execPath: "C:\\Hanako\\Hanako.exe",
        versions: { electron: "38.8.4" },
      };

      const resolved = resolveOpenComputerUseExternalServer({
        HANAKO_OPEN_COMPUTER_USE_ENTRY: entryPath,
        HANAKO_OPEN_COMPUTER_USE_COMMAND: "open-computer-use",
      }, runtime);

      expect(resolved?.server).toEqual({
        type: "stdio",
        command: "open-computer-use",
        args: ["mcp"],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores Windows app-launch/focus env toggles", () => {
    const root = mkTempDir("hanako-ocu-provider-win-disable-launch-");
    try {
      const entryPath = createFakeOpenComputerUsePackage(root, { includeWindowsExe: true });
      const runtime = {
        platform: "win32",
        arch: "x64",
        execPath: "C:\\Hanako\\Hanako.exe",
        versions: { electron: "38.8.4" },
      };

      const resolved = resolveOpenComputerUseExternalServer({
        HANAKO_OPEN_COMPUTER_USE_ENTRY: entryPath,
        HANAKO_OPEN_COMPUTER_USE_DISABLE_WINDOWS_APP_LAUNCH: "1",
        HANAKO_OPEN_COMPUTER_USE_DISABLE_WINDOWS_FOCUS_ACTIONS: "1",
      }, runtime);

      expect(resolved?.server).toEqual({
        type: "stdio",
        command: path.join(root, "dist", "windows", "amd64", "open-computer-use.exe"),
        args: ["mcp"],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
