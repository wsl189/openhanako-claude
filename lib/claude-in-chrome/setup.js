import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import {
  getAllowedExtensionOrigins,
  getNativeHostIdentifier,
  getNativeHostManifestName,
  getNativeMessagingManifestDirs,
  getWindowsRegistryNativeHostKeys,
} from "./common.js";

let installPromise = null;

function getHanakoHome() {
  const raw = String(process.env.HANA_HOME || "").trim();
  if (raw) return path.resolve(raw.replace(/^~/, os.homedir()));
  return path.join(os.homedir(), ".hanako");
}

function quoteShellArg(input) {
  const s = String(input || "");
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function resolveEntryPath(explicitEntryPath) {
  if (explicitEntryPath) return path.resolve(explicitEntryPath);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "entry.js");
}

function createWrapperScript({ entryPath }) {
  const hanakoHome = getHanakoHome();
  const chromeDir = path.join(hanakoHome, "chrome");
  const isWin = process.platform === "win32";
  const wrapperPath = isWin
    ? path.join(chromeDir, "chrome-native-host.bat")
    : path.join(chromeDir, "chrome-native-host");

  fs.mkdirSync(chromeDir, { recursive: true });

  const nodeBin = process.execPath;
  const content = isWin
    ? [
      "@echo off",
      "REM Hanako Chrome native host wrapper (generated)",
      `\"${nodeBin}\" \"${entryPath}\" --chrome-native-host`,
      "",
    ].join("\n")
    : [
      "#!/bin/sh",
      "# Hanako Chrome native host wrapper (generated)",
      `exec ${quoteShellArg(nodeBin)} ${quoteShellArg(entryPath)} --chrome-native-host`,
      "",
    ].join("\n");

  const prev = fs.existsSync(wrapperPath)
    ? fs.readFileSync(wrapperPath, "utf8")
    : null;
  if (prev !== content) {
    fs.writeFileSync(wrapperPath, content, "utf8");
    if (!isWin) fs.chmodSync(wrapperPath, 0o755);
  }

  return wrapperPath;
}

function installManifestFiles({ wrapperPath, env = process.env }) {
  const hostIdentifier = getNativeHostIdentifier(env);
  const manifestName = getNativeHostManifestName(env);
  const manifest = {
    name: hostIdentifier,
    description: "Hanako Browser Extension Native Host",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: getAllowedExtensionOrigins(env),
  };
  const content = JSON.stringify(manifest, null, 2);
  const dirs = getNativeMessagingManifestDirs();

  const written = [];
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, manifestName);
      const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      if (prev !== content) {
        fs.writeFileSync(file, content, "utf8");
      }
      written.push(file);
    } catch {
      // Keep best-effort semantics: some browsers may not be installed.
    }
  }

  return { hostIdentifier, manifestName, written };
}

function registerWindowsNativeHosts({ manifestPath, hostIdentifier }) {
  if (process.platform !== "win32") return;
  const keys = getWindowsRegistryNativeHostKeys(hostIdentifier);
  for (const key of keys) {
    execFile(
      "reg",
      [
        "add",
        key,
        "/ve",
        "/t",
        "REG_SZ",
        "/d",
        manifestPath,
        "/f",
      ],
      { windowsHide: true },
      () => {
        // Best effort.
      },
    );
  }
}

export function ensureNativeHostInstalled(opts = {}) {
  if (installPromise) return installPromise;

  installPromise = Promise.resolve().then(() => {
    const env = opts.env || process.env;
    const entryPath = resolveEntryPath(opts.entryPath);
    const wrapperPath = createWrapperScript({ entryPath });
    const manifest = installManifestFiles({ wrapperPath, env });

    if (process.platform === "win32" && manifest.written.length > 0) {
      registerWindowsNativeHosts({
        manifestPath: manifest.written[0],
        hostIdentifier: manifest.hostIdentifier,
      });
    }

    return {
      entryPath,
      wrapperPath,
      ...manifest,
    };
  }).catch((err) => {
    installPromise = null;
    throw err;
  });

  return installPromise;
}
