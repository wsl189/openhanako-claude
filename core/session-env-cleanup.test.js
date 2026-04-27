import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupEmptySessionEnvDirs, cleanupStartupArtifacts } from "./session-env-cleanup.js";

let tmpDir;

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

describe("cleanupEmptySessionEnvDirs", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-env-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes empty session-env children and Finder metadata", () => {
    const agentsDir = path.join(tmpDir, "agents");
    const root = path.join(agentsDir, "hana", "session-env");
    const emptySession = path.join(root, "empty-session");
    const dsOnlySession = path.join(root, "ds-only-session");
    const liveSession = path.join(root, "live-session");

    mkdirp(emptySession);
    mkdirp(dsOnlySession);
    mkdirp(liveSession);
    fs.writeFileSync(path.join(root, ".DS_Store"), "finder");
    fs.writeFileSync(path.join(dsOnlySession, ".DS_Store"), "finder");
    fs.writeFileSync(path.join(liveSession, "cwdchanged-hook-1.sh"), "export A=1");

    const stats = cleanupEmptySessionEnvDirs(agentsDir);

    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(emptySession)).toBe(false);
    expect(fs.existsSync(dsOnlySession)).toBe(false);
    expect(fs.existsSync(path.join(root, ".DS_Store"))).toBe(false);
    expect(fs.existsSync(liveSession)).toBe(true);
    expect(stats.dirsRemoved).toBe(2);
    expect(stats.filesRemoved).toBe(2);
    expect(stats.dirsKept).toBe(1);
    expect(stats.errors).toBe(0);
  });

  it("ignores agents without session-env directories", () => {
    const agentsDir = path.join(tmpDir, "agents");
    mkdirp(path.join(agentsDir, "hana"));

    const stats = cleanupEmptySessionEnvDirs(agentsDir);

    expect(stats.agentsScanned).toBe(1);
    expect(stats.rootsScanned).toBe(0);
    expect(stats.dirsRemoved).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it("cleans low-risk startup artifacts outside session-env", () => {
    const agentsDir = path.join(tmpDir, "agents");
    const skillsDir = path.join(tmpDir, "skills");
    const agentDir = path.join(agentsDir, "hana");
    const emptyShellSnapshots = path.join(agentDir, "shell-snapshots");
    const liveShellSnapshots = path.join(agentsDir, "live", "shell-snapshots");
    const globalTemp = path.join(skillsDir, ".tmp-install-123");
    const agentTemp = path.join(agentDir, "skills", ".tmp-clawhub-install-abc");

    mkdirp(emptyShellSnapshots);
    mkdirp(liveShellSnapshots);
    mkdirp(globalTemp);
    mkdirp(agentTemp);
    fs.writeFileSync(path.join(tmpDir, ".DS_Store"), "finder");
    fs.writeFileSync(path.join(agentDir, ".DS_Store"), "finder");
    fs.writeFileSync(path.join(skillsDir, ".DS_Store"), "finder");
    fs.writeFileSync(path.join(liveShellSnapshots, "snapshot.json"), "{}");
    fs.writeFileSync(path.join(globalTemp, "leftover.txt"), "tmp");
    fs.writeFileSync(path.join(agentTemp, "leftover.txt"), "tmp");

    const stats = cleanupStartupArtifacts({
      hanakoHome: tmpDir,
      agentsDir,
      skillsDir,
    }, { tempDirMinAgeMs: 0 });

    expect(fs.existsSync(path.join(tmpDir, ".DS_Store"))).toBe(false);
    expect(fs.existsSync(path.join(agentDir, ".DS_Store"))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, ".DS_Store"))).toBe(false);
    expect(fs.existsSync(globalTemp)).toBe(false);
    expect(fs.existsSync(agentTemp)).toBe(false);
    expect(fs.existsSync(emptyShellSnapshots)).toBe(false);
    expect(fs.existsSync(liveShellSnapshots)).toBe(true);
    expect(stats.finderFilesRemoved).toBe(3);
    expect(stats.tempDirsRemoved).toBe(2);
    expect(stats.emptyShellSnapshotDirsRemoved).toBe(1);
    expect(stats.emptyShellSnapshotDirsKept).toBe(1);
    expect(stats.errors).toBe(0);
  });
});
