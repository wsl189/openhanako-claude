import fs from "fs";

function replaceSessionExt(sessionPath = "") {
  return String(sessionPath || "").replace(/\.session\.json$/i, "");
}

export function messageLogPathForSession(sessionPath = "") {
  const base = replaceSessionExt(sessionPath);
  if (!base) return "";
  return `${base}.jsonl`;
}

export function hasSessionMessageLog(sessionPath = "") {
  const logPath = messageLogPathForSession(sessionPath);
  return !!(logPath && fs.existsSync(logPath));
}

export function appendSessionMessageLog(sessionPath, message, timestamp = new Date().toISOString()) {
  const logPath = messageLogPathForSession(sessionPath);
  if (!logPath) throw new Error("sessionPath is required");
  fs.mkdirSync(requireDirname(logPath), { recursive: true });
  fs.appendFileSync(
    logPath,
    JSON.stringify({
      type: "message",
      timestamp,
      message,
    }) + "\n",
    "utf-8",
  );
  return logPath;
}

export function readSessionMessageEntries(sessionPath, { limit = null } = {}) {
  const logPath = messageLogPathForSession(sessionPath);
  if (!logPath || !fs.existsSync(logPath)) return [];
  try {
    const raw = fs.readFileSync(logPath, "utf-8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const slice = limit && limit > 0 ? lines.slice(-limit) : lines;
    return slice.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function readSessionMessagesFromLog(sessionPath, { limit = null } = {}) {
  return readSessionMessageEntries(sessionPath, { limit })
    .map((entry) => entry?.message || null)
    .filter(Boolean);
}

function requireDirname(filePath) {
  const idx = String(filePath).lastIndexOf("/");
  return idx >= 0 ? filePath.slice(0, idx) : ".";
}
