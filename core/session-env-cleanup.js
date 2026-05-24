import fs from "fs";
import path from "path";

const DEFAULT_TEMP_DIR_MIN_AGE_MS = 60 * 60 * 1000;
const DEFAULT_SCRIPT_TEMP_FILE_MIN_AGE_MS = 10 * 60 * 1000;
const SKILL_TEMP_DIR_RE = /^\.tmp-(?:install|clawhub-install)-/;
const SANDBOX_TEMP_FILE_RE = /^\.hana-sandbox-[A-Za-z0-9-]+\.(?:sh|sb)$/;

function safeReadDir(dir, stats) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    stats.errors++;
    return [];
  }
}

function removeFile(filePath, stats, key = "filesRemoved") {
  try {
    fs.unlinkSync(filePath);
    stats[key]++;
  } catch {
    stats.errors++;
  }
}

function collectSessionEnvDirs(rootDir, stats) {
  const dirs = [];
  const visit = (dir) => {
    for (const entry of safeReadDir(dir, stats)) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(fullPath);
        visit(fullPath);
      } else if (entry.isFile() && entry.name === ".DS_Store") {
        removeFile(fullPath, stats, "filesRemoved");
      }
    }
  };
  visit(rootDir);
  return dirs;
}

/**
 * Remove stale Claude SDK session-env directories under each Hanako agent.
 *
 * Claude's SDK may create agents/<agent>/session-env/<session-id>/ to hold
 * temporary hook scripts. Hanako only removes directories that are empty after
 * harmless Finder metadata is discarded; directories with real files are kept.
 */
export function cleanupEmptySessionEnvDirs(agentsDir) {
  const stats = {
    agentsScanned: 0,
    rootsScanned: 0,
    dirsRemoved: 0,
    filesRemoved: 0,
    dirsKept: 0,
    errors: 0,
  };

  if (!agentsDir || !fs.existsSync(agentsDir)) return stats;

  let agents;
  try {
    agents = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    stats.errors++;
    return stats;
  }

  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    stats.agentsScanned++;

    const rootDir = path.join(agentsDir, agent.name, "session-env");
    let rootStat;
    try {
      rootStat = fs.statSync(rootDir);
    } catch {
      continue;
    }
    if (!rootStat.isDirectory()) continue;
    stats.rootsScanned++;

    const dirs = collectSessionEnvDirs(rootDir, stats)
      .sort((a, b) => b.length - a.length);

    for (const dir of dirs) {
      try {
        fs.rmdirSync(dir);
        stats.dirsRemoved++;
      } catch (err) {
        if (err?.code === "ENOTEMPTY") stats.dirsKept++;
        else stats.errors++;
      }
    }
  }

  return stats;
}

function removeFinderMetadata(rootDir, stats) {
  if (!rootDir || !fs.existsSync(rootDir)) return;
  let rootStat;
  try {
    rootStat = fs.statSync(rootDir);
  } catch {
    stats.errors++;
    return;
  }
  if (!rootStat.isDirectory()) return;

  const visit = (dir) => {
    for (const entry of safeReadDir(dir, stats)) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && entry.name === ".DS_Store") {
        removeFile(fullPath, stats, "finderFilesRemoved");
      }
    }
  };
  visit(rootDir);
}

function isOlderThan(dirPath, now, minAgeMs, stats) {
  if (minAgeMs <= 0) return true;
  try {
    const st = fs.statSync(dirPath);
    return now - st.mtimeMs >= minAgeMs;
  } catch {
    stats.errors++;
    return false;
  }
}

function cleanupSkillTempDirs(skillsDir, stats, opts) {
  if (!skillsDir || !fs.existsSync(skillsDir)) return;
  const now = opts.now ?? Date.now();
  const minAgeMs = opts.tempDirMinAgeMs ?? DEFAULT_TEMP_DIR_MIN_AGE_MS;

  for (const entry of safeReadDir(skillsDir, stats)) {
    if (!entry.isDirectory() || !SKILL_TEMP_DIR_RE.test(entry.name)) continue;
    const fullPath = path.join(skillsDir, entry.name);
    if (!isOlderThan(fullPath, now, minAgeMs, stats)) {
      stats.tempDirsKept++;
      continue;
    }
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
      stats.tempDirsRemoved++;
    } catch {
      stats.errors++;
    }
  }
}

function cleanupAgentSkillTempDirs(agentsDir, stats, opts) {
  if (!agentsDir || !fs.existsSync(agentsDir)) return;
  for (const agent of safeReadDir(agentsDir, stats)) {
    if (!agent.isDirectory()) continue;
    cleanupSkillTempDirs(path.join(agentsDir, agent.name, "skills"), stats, opts);
  }
}

function cleanupEmptyShellSnapshots(agentsDir, stats) {
  if (!agentsDir || !fs.existsSync(agentsDir)) return;
  for (const agent of safeReadDir(agentsDir, stats)) {
    if (!agent.isDirectory()) continue;
    const dir = path.join(agentsDir, agent.name, "shell-snapshots");
    try {
      fs.rmdirSync(dir);
      stats.emptyShellSnapshotDirsRemoved++;
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      if (err?.code === "ENOTEMPTY") {
        stats.emptyShellSnapshotDirsKept++;
        continue;
      }
      stats.errors++;
    }
  }
}

function cleanupSandboxTempScripts(hanakoHome, stats, opts) {
  if (!hanakoHome) return;
  const scriptsDir = path.join(hanakoHome, "tmp", "scripts");
  if (!fs.existsSync(scriptsDir)) return;

  const now = opts.now ?? Date.now();
  const minAgeMs = opts.scriptTempFileMinAgeMs ?? DEFAULT_SCRIPT_TEMP_FILE_MIN_AGE_MS;
  for (const entry of safeReadDir(scriptsDir, stats)) {
    if (!entry.isFile() || !SANDBOX_TEMP_FILE_RE.test(entry.name)) continue;
    const fullPath = path.join(scriptsDir, entry.name);
    if (!isOlderThan(fullPath, now, minAgeMs, stats)) {
      stats.scriptTempFilesKept++;
      continue;
    }
    removeFile(fullPath, stats, "scriptTempFilesRemoved");
  }
}

/**
 * Clean low-risk startup artifacts under Hanako's data directory.
 *
 * This only removes generated metadata, clearly temporary install directories,
 * and empty SDK scratch roots. User data such as sessions, projects, memory,
 * skills, channels, and backups is intentionally left untouched.
 */
export function cleanupStartupArtifacts({ hanakoHome, agentsDir, skillsDir } = {}, opts = {}) {
  const stats = {
    ...cleanupEmptySessionEnvDirs(agentsDir),
    finderFilesRemoved: 0,
    tempDirsRemoved: 0,
    tempDirsKept: 0,
    scriptTempFilesRemoved: 0,
    scriptTempFilesKept: 0,
    emptyShellSnapshotDirsRemoved: 0,
    emptyShellSnapshotDirsKept: 0,
  };

  if (hanakoHome) {
    const rootFinderFile = path.join(hanakoHome, ".DS_Store");
    if (fs.existsSync(rootFinderFile)) {
      removeFile(rootFinderFile, stats, "finderFilesRemoved");
    }
  }

  const roots = [
    agentsDir,
    skillsDir,
    hanakoHome ? path.join(hanakoHome, "user") : null,
    hanakoHome ? path.join(hanakoHome, "plugin-data") : null,
    hanakoHome ? path.join(hanakoHome, "bridge") : null,
    hanakoHome ? path.join(hanakoHome, "channels") : null,
  ];
  const seen = new Set();
  for (const root of roots) {
    const resolved = root ? path.resolve(root) : "";
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    removeFinderMetadata(resolved, stats);
  }

  cleanupSkillTempDirs(skillsDir, stats, opts);
  cleanupAgentSkillTempDirs(agentsDir, stats, opts);
  cleanupSandboxTempScripts(hanakoHome, stats, opts);
  cleanupEmptyShellSnapshots(agentsDir, stats);

  return stats;
}
