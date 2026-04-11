import fs from "fs";
import path from "path";

export const SESSION_METADATA_VERSION = 1;
export const SESSION_FILE_EXT = ".session.json";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function walkSessionFiles(rootDir, out) {
  if (!fs.existsSync(rootDir)) return;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkSessionFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(SESSION_FILE_EXT)) {
      out.push(fullPath);
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function sessionPathForId(sessionDir, sessionId) {
  return path.join(sessionDir, `${sessionId}${SESSION_FILE_EXT}`);
}

export function isClaudeSessionPath(sessionPath = "") {
  return String(sessionPath || "").endsWith(SESSION_FILE_EXT);
}

export function buildSessionMetadata({
  sessionId,
  cwd,
  agentId = null,
  title = null,
  archiveState = "active",
  memoryEnabled = true,
  bridge = null,
  createdAt = nowIso(),
  updatedAt = nowIso(),
} = {}) {
  if (!sessionId) {
    throw new Error("sessionId is required");
  }
  if (!cwd) {
    throw new Error("cwd is required");
  }
  return {
    version: SESSION_METADATA_VERSION,
    kind: "claude-agent-session",
    sessionId,
    cwd,
    agentId,
    title,
    archiveState,
    memoryEnabled: memoryEnabled !== false,
    bridge,
    createdAt,
    updatedAt,
  };
}

export function writeSessionMetadata(sessionPath, metadata) {
  ensureDir(path.dirname(sessionPath));
  fs.writeFileSync(sessionPath, JSON.stringify(metadata, null, 2) + "\n", "utf-8");
  return sessionPath;
}

export function createSessionMetadata(sessionDir, data) {
  const metadata = buildSessionMetadata(data);
  const sessionPath = sessionPathForId(sessionDir, metadata.sessionId);
  writeSessionMetadata(sessionPath, metadata);
  return { sessionPath, metadata };
}

export function readSessionMetadata(sessionPath) {
  const raw = fs.readFileSync(sessionPath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.kind !== "claude-agent-session") {
    throw new Error(`invalid Claude session metadata: ${sessionPath}`);
  }
  return parsed;
}

export function patchSessionMetadata(sessionPath, partial = {}) {
  const current = readSessionMetadata(sessionPath);
  const next = {
    ...current,
    ...partial,
    updatedAt: nowIso(),
  };
  writeSessionMetadata(sessionPath, next);
  return next;
}

function isDirectChildSessionPath(sessionDir, sessionPath) {
  const relative = path.relative(sessionDir, sessionPath);
  if (!relative || relative.startsWith("..")) return false;
  return !relative.includes(path.sep);
}

export function listSessionMetadata(sessionDir, { includeArchived = true, directOnly = false } = {}) {
  if (!fs.existsSync(sessionDir)) return [];
  const out = [];
  const sessionFiles = [];
  walkSessionFiles(sessionDir, sessionFiles);
  for (const sessionPath of sessionFiles) {
    try {
      if (directOnly && !isDirectChildSessionPath(sessionDir, sessionPath)) continue;
      const metadata = readSessionMetadata(sessionPath);
      if (!includeArchived && metadata.archiveState === "archived") continue;
      out.push({ sessionPath, metadata });
    } catch {
      // ignore invalid files
    }
  }
  out.sort((a, b) => String(b.metadata.updatedAt || "").localeCompare(String(a.metadata.updatedAt || "")));
  return out;
}
