#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function run(bin, args, opts = {}) {
  const res = spawnSync(bin, args, {
    stdio: "inherit",
    shell: false,
    ...opts,
  });
  if (res.error) throw res.error;
  if (typeof res.status === "number" && res.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")} failed with exit code ${res.status}`);
  }
}

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const argv = process.argv.slice(2);
const shouldSkip = argv.includes("--skip") || isTruthy(process.env.HANAKO_SKIP_OPEN_COMPUTER_USE_REFRESH);

if (shouldSkip) {
  console.log("[prepack] skipping open-computer-use refresh for this build target.");
  process.exit(0);
}

console.log("[prepack] refreshing open-computer-use to latest...");
run(npmCmd, [
  "install",
  "open-computer-use@latest",
  "--save-exact",
  "--no-audit",
  "--no-fund",
]);
console.log("[prepack] open-computer-use updated to latest.");
