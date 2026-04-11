import fs from "fs";
import path from "path";

function stripMarkdown(line = "") {
  return String(line || "")
    .replace(/^#+\s*/, "")
    .replace(/[*_`]/g, "")
    .trim();
}

function readSkillDescription(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split(/\r?\n/).map((line) => line.trim());
    for (const line of lines) {
      if (!line) continue;
      const text = stripMarkdown(line);
      if (!text || /^skill$/i.test(text)) continue;
      return text;
    }
  } catch {}
  return "";
}

function collectSkillDirs(rootDir, out) {
  if (!rootDir || !fs.existsSync(rootDir)) return;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(rootDir, entry.name);
    const skillFile = path.join(fullPath, "SKILL.md");
    if (fs.existsSync(skillFile)) {
      out.push({
        name: entry.name,
        description: readSkillDescription(skillFile),
        filePath: skillFile,
        baseDir: fullPath,
        source: "local",
        _readonly: false,
      });
      continue;
    }
    collectSkillDirs(fullPath, out);
  }
}

export function scanSkillsInPaths(skillPaths = []) {
  const out = [];
  const seen = new Set();
  for (const skillPath of skillPaths || []) {
    const root = String(skillPath || "").trim();
    if (!root || !fs.existsSync(root)) continue;
    const collected = [];
    collectSkillDirs(root, collected);
    for (const skill of collected) {
      const key = `${skill.name}:${skill.filePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(skill);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function formatSkillsForPrompt(skills = []) {
  const blocks = [];
  for (const skill of skills || []) {
    if (!skill?.filePath) continue;
    try {
      const body = fs.readFileSync(skill.filePath, "utf-8").trim();
      if (!body) continue;
      blocks.push(`<skill name="${skill.name}">\n${body}\n</skill>`);
    } catch {
      // ignore unreadable skill
    }
  }
  if (!blocks.length) return "";
  return `\n## Skills\n\n${blocks.join("\n\n")}`;
}

export class SimpleResourceLoader {
  constructor({ systemPromptOverride, additionalSkillPaths = [] } = {}) {
    this._systemPromptOverride = systemPromptOverride || (() => "");
    this._additionalSkillPaths = additionalSkillPaths;
    this._skills = [];
  }

  async reload() {
    this._skills = scanSkillsInPaths(this._additionalSkillPaths);
  }

  getSystemPrompt() {
    return this._systemPromptOverride();
  }

  getSkills() {
    return {
      skills: this._skills,
      diagnostics: [],
    };
  }
}
