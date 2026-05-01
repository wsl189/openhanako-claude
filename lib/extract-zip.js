/**
 * extract-zip.js — 跨平台 zip 解压
 *
 * macOS/Linux 用系统 unzip，Windows 用 PowerShell Expand-Archive。
 */

import { execFileSync } from "child_process";

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function extractZip(zipPath, destDir) {
  if (process.platform === "win32") {
    execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)} -Force`,
    ], { stdio: "ignore", windowsHide: true });
  } else {
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", destDir]);
  }
}
