#!/usr/bin/env node
import { spawnSync } from "node:child_process";

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

console.log("[prepack] refreshing open-computer-use to latest...");
run(npmCmd, [
  "install",
  "open-computer-use@latest",
  "--save-exact",
  "--no-audit",
  "--no-fund",
]);
console.log("[prepack] open-computer-use updated to latest.");
