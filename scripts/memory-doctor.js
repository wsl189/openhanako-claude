#!/usr/bin/env node
import { formatMemoryDoctorReport, runMemoryDoctor } from "../lib/memory/memory-doctor.js";

function parseArgs(argv) {
  const opts = {
    dryRun: true,
    fix: false,
    all: false,
    limit: 10,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fix") opts.fix = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--apply") opts.dryRun = false;
    else if (arg === "--all") opts.all = true;
    else if (arg === "--hanako-home") opts.hanakoHome = argv[++i];
    else if (arg === "--limit") opts.limit = Number.parseInt(argv[++i], 10) || opts.limit;
    else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    }
  }

  return opts;
}

function printHelp() {
  console.log(`Usage: npm run memory:doctor -- [options]

Options:
  --all                    Show agents with no issues too
  --fix --dry-run          Show what would be fixed (default dry-run)
  --fix --apply            Mark malformed summaries invalid and soft-deactivate fixable facts
  --hanako-home <path>     Override Hanako home directory
  --limit <n>              Issue samples per agent (default 10)
`);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  printHelp();
  process.exit(0);
}

try {
  const report = runMemoryDoctor(opts);
  console.log(formatMemoryDoctorReport(report, opts));
} catch (err) {
  const msg = String(err?.message || err);
  if (msg.includes("better_sqlite3.node") && msg.includes("NODE_MODULE_VERSION")) {
    console.error("memory:doctor cannot open better-sqlite3 with this Node runtime.");
    console.error("Run `npm run rebuild:node` first, then rerun memory:doctor.");
    process.exit(2);
  }
  throw err;
}
