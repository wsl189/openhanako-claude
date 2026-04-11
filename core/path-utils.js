import os from "os";
import path from "path";

export function expandHomePath(rawPath) {
  const value = String(rawPath || "").trim();
  if (!value) return "";
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function normalizeWorkspacePath(rawPath, fallback = "") {
  const expanded = expandHomePath(rawPath);
  if (!expanded) {
    const fallbackExpanded = expandHomePath(fallback);
    return fallbackExpanded ? path.resolve(fallbackExpanded) : "";
  }
  return path.resolve(expanded);
}
