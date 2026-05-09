import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { Type } from "@sinclair/typebox";
import { sanitizeSkillName } from "../skills/skill-name.js";

function toText(v) {
  return String(v ?? "").trim();
}

function normalizeMcpServerKey(name) {
  return toText(name).replace(/[^A-Za-z0-9_]/g, "_");
}

function parseMcpArgs(rawArgs) {
  if (Array.isArray(rawArgs)) return rawArgs.map((v) => toText(v)).filter(Boolean);
  const text = toText(rawArgs);
  return text ? text.split(/\s+/).map((v) => toText(v)).filter(Boolean) : [];
}

function normalizeStringMap(rawMap) {
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) return {};
  const out = {};
  for (const [key, value] of Object.entries(rawMap)) {
    const k = toText(key);
    if (!k) continue;
    out[k] = String(value ?? "");
  }
  return out;
}

function parseSkillNameFromContent(content) {
  const text = String(content || "");
  const fmMatch = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/mi);
    if (nameMatch) return toText(nameMatch[1]).replace(/^["']|["']$/g, "");
  }
  return "";
}

function ensureSkillFrontmatter(skillMdPath, fallbackName) {
  const content = fs.readFileSync(skillMdPath, "utf-8");
  const currentName = parseSkillNameFromContent(content);
  if (sanitizeSkillName(currentName)) return currentName;

  const safeName = sanitizeSkillName(fallbackName) || "imported-skill";
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (fmMatch) {
    const body = content.slice(fmMatch[0].length);
    const rewritten = `---\n${fmMatch[1].trim()}\nname: "${safeName}"\n---\n\n${body}`;
    fs.writeFileSync(skillMdPath, rewritten, "utf-8");
    return safeName;
  }

  const rewritten = `---\nname: "${safeName}"\n---\n\n${content}`;
  fs.writeFileSync(skillMdPath, rewritten, "utf-8");
  return safeName;
}

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function parseTutorialJson(tutorial) {
  const raw = String(tutorial || "");
  if (!raw.trim()) return {};

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [
    fenced?.[1] || "",
    raw.trim(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

function normalizeInputPath(rawPath = "") {
  let p = toText(rawPath);
  if (!p) return "";
  if (p.startsWith("<") && p.endsWith(">")) p = p.slice(1, -1).trim();
  p = p.replace(/^["']|["']$/g, "");
  p = p.replace(/\\ /g, " ");
  if (p.startsWith("~")) p = path.join(os.homedir(), p.slice(1));
  if (/^file:\/\//i.test(p)) {
    try { p = fileURLToPath(p); } catch {}
  }
  if (p.includes("%")) {
    try { p = decodeURIComponent(p); } catch {}
  }
  return p;
}

function isAbsolutePathAnyPlatform(filePath = "") {
  const p = String(filePath || "");
  return path.isAbsolute(p) || path.win32.isAbsolute(p);
}

function commandExists(command) {
  const cmd = toText(command);
  if (!cmd) return false;
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd);
  if (process.platform === "win32") {
    const r = spawnSync("where", [cmd], { stdio: "ignore" });
    return r.status === 0;
  }
  const r = spawnSync("sh", ["-lc", `command -v ${JSON.stringify(cmd)} >/dev/null 2>&1`], { stdio: "ignore" });
  return r.status === 0;
}

function normalizeMcpPayload(rawMcp) {
  if (!rawMcp || typeof rawMcp !== "object" || Array.isArray(rawMcp)) return null;
  const name = normalizeMcpServerKey(rawMcp.name);
  if (!name) throw new Error("mcp.name is required");
  const type = toText(rawMcp.type || (rawMcp.url ? "sse" : "stdio")) || "stdio";
  if (type === "stdio") {
    const command = toText(rawMcp.command);
    if (!command) throw new Error("mcp.command is required for stdio");
    return {
      name,
      config: {
        type: "stdio",
        command,
        ...(parseMcpArgs(rawMcp.args).length > 0 ? { args: parseMcpArgs(rawMcp.args) } : {}),
        ...(Object.keys(normalizeStringMap(rawMcp.env)).length > 0 ? { env: normalizeStringMap(rawMcp.env) } : {}),
        ...(rawMcp.disabled === true ? { disabled: true } : {}),
      },
      command,
    };
  }
  if (type === "sse" || type === "http") {
    const url = toText(rawMcp.url);
    if (!url) throw new Error("mcp.url is required for sse/http");
    return {
      name,
      config: {
        type,
        url,
        ...(Object.keys(normalizeStringMap(rawMcp.headers)).length > 0 ? { headers: normalizeStringMap(rawMcp.headers) } : {}),
        ...(rawMcp.disabled === true ? { disabled: true } : {}),
      },
      command: "",
    };
  }
  throw new Error("mcp.type must be stdio, sse, or http");
}

function buildMergedSpec(params) {
  const parsed = parseTutorialJson(params?.tutorial);
  return {
    agent: (params?.agent && typeof params.agent === "object") ? params.agent : parsed.agent,
    skill: (params?.skill && typeof params.skill === "object") ? params.skill : parsed.skill,
    mcp: (params?.mcp && typeof params.mcp === "object") ? params.mcp : parsed.mcp,
  };
}

export function createSetupSettingsTool({ engine }) {
  return {
    name: "setup_settings",
    label: "Setup Settings",
    description: "Apply a single install tutorial to set agent identity/ishiki, install skill to the correct location, and write MCP parameters.",
    parameters: Type.Object({
      tutorial: Type.Optional(Type.String({
        description: "One install tutorial text. Recommended to include a JSON block with {agent, skill, mcp}.",
      })),
      agent: Type.Optional(Type.Object({
        name: Type.Optional(Type.String()),
        yuan: Type.Optional(Type.String()),
        identity_markdown: Type.Optional(Type.String()),
        ishiki_markdown: Type.Optional(Type.String()),
      })),
      skill: Type.Optional(Type.Object({
        source_path: Type.Optional(Type.String({ description: "Absolute path to a local skill directory containing SKILL.md." })),
        name: Type.Optional(Type.String({ description: "Override installed skill name." })),
        enable_for_current_agent: Type.Optional(Type.Boolean({ default: true })),
      })),
      mcp: Type.Optional(Type.Object({
        name: Type.String(),
        type: Type.Optional(Type.Union([Type.Literal("stdio"), Type.Literal("sse"), Type.Literal("http")])),
        command: Type.Optional(Type.String()),
        args: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
        env: Type.Optional(Type.Record(Type.String(), Type.String())),
        url: Type.Optional(Type.String()),
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
        disabled: Type.Optional(Type.Boolean()),
      })),
      dry_run: Type.Optional(Type.Boolean({ default: false })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const dryRun = params?.dry_run === true;
        const spec = buildMergedSpec(params);
        const details = {
          dryRun,
          applied: {
            agent: null,
            skill: null,
            mcp: null,
          },
          locations: {
            hanako_home: engine.hanakoHome,
            skills_global_dir: engine.userSkillsDir || engine.skillsDir || "",
            current_agent_dir: engine.agentDir || "",
          },
          checks: [],
        };

        let shouldRefreshAgentPrompt = false;

        if (spec.agent && typeof spec.agent === "object") {
          const patch = {};
          const identityName = toText(spec.agent.name);
          const identityYuan = toText(spec.agent.yuan);
          if (identityName || identityYuan) {
            patch.agent = {};
            if (identityName) patch.agent.name = identityName;
            if (identityYuan) patch.agent.yuan = identityYuan;
          }
          if (!dryRun && Object.keys(patch).length > 0) {
            await engine.updateConfig(patch);
          }
          const identityMd = spec.agent.identity_markdown;
          if (typeof identityMd === "string") {
            if (!dryRun) {
              fs.writeFileSync(path.join(engine.agentDir, "identity.md"), identityMd, "utf-8");
            }
            shouldRefreshAgentPrompt = true;
          }
          const ishikiMd = spec.agent.ishiki_markdown;
          if (typeof ishikiMd === "string") {
            if (!dryRun) {
              fs.writeFileSync(path.join(engine.agentDir, "ishiki.md"), ishikiMd, "utf-8");
            }
            shouldRefreshAgentPrompt = true;
          }
          details.applied.agent = {
            ...(identityName ? { name: identityName } : {}),
            ...(identityYuan ? { yuan: identityYuan } : {}),
            ...(typeof identityMd === "string" ? { identity_markdown_updated: true } : {}),
            ...(typeof ishikiMd === "string" ? { ishiki_markdown_updated: true } : {}),
          };
        }

        if (spec.skill && typeof spec.skill === "object" && toText(spec.skill.source_path)) {
          const sourcePath = normalizeInputPath(spec.skill.source_path);
          if (!isAbsolutePathAnyPlatform(sourcePath)) throw new Error("skill.source_path must be absolute");
          if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
            throw new Error(`skill source path not found: ${sourcePath}`);
          }
          const skillMdPath = path.join(sourcePath, "SKILL.md");
          if (!fs.existsSync(skillMdPath)) {
            throw new Error(`SKILL.md not found in: ${sourcePath}`);
          }

          const hintedName = toText(spec.skill.name) || parseSkillNameFromContent(fs.readFileSync(skillMdPath, "utf-8")) || path.basename(sourcePath);
          const safeName = sanitizeSkillName(hintedName) || sanitizeSkillName(path.basename(sourcePath));
          if (!safeName) throw new Error(`invalid skill name: ${hintedName}`);

          const globalSkillsDir = engine.userSkillsDir || engine.skillsDir;
          const installedGlobalPath = path.join(globalSkillsDir, safeName);
          const enableForAgent = spec.skill.enable_for_current_agent !== false;

          if (!dryRun) {
            fs.mkdirSync(globalSkillsDir, { recursive: true });
            if (fs.existsSync(installedGlobalPath)) fs.rmSync(installedGlobalPath, { recursive: true, force: true });
            copyDirSync(sourcePath, installedGlobalPath);
            ensureSkillFrontmatter(path.join(installedGlobalPath, "SKILL.md"), safeName);
            await engine.reloadSkills();
            const found = (engine.getAllSkills() || []).find((s) => s?.name === safeName);
            if (!found) throw new Error(`skill install check failed: ${safeName} not found after reload`);

            if (enableForAgent) {
              const agentId = path.basename(engine.agentDir || "");
              const agentSkillsDir = path.join(engine.agentsDir, agentId, "skills");
              const agentSkillPath = path.join(agentSkillsDir, safeName);
              fs.mkdirSync(agentSkillsDir, { recursive: true });
              if (fs.existsSync(agentSkillPath)) fs.rmSync(agentSkillPath, { recursive: true, force: true });
              copyDirSync(installedGlobalPath, agentSkillPath);
              const currentEnabled = Array.isArray(engine.config?.skills?.enabled) ? engine.config.skills.enabled : [];
              const nextEnabled = [...new Set([...currentEnabled, safeName])];
              await engine.updateConfig({ skills: { enabled: nextEnabled } });
              await engine.reloadSkills();
            }
          }

          details.applied.skill = {
            name: safeName,
            source_path: sourcePath,
            installed_global_path: installedGlobalPath,
            enabled_for_current_agent: enableForAgent,
          };
          details.checks.push({
            type: "skill_path_valid",
            ok: true,
            path: sourcePath,
          });
        }

        if (spec.mcp && typeof spec.mcp === "object") {
          const normalized = normalizeMcpPayload(spec.mcp);
          if (!normalized) throw new Error("invalid mcp payload");
          if (normalized.command) {
            details.checks.push({
              type: "mcp_command_exists",
              ok: commandExists(normalized.command),
              command: normalized.command,
            });
          }
          if (!dryRun) {
            engine.patchExternalMcpServers?.({ [normalized.name]: normalized.config });
            await engine.refreshCurrentSessionTools?.();
          }
          details.applied.mcp = {
            name: normalized.name,
            config: normalized.config,
          };
        }

        if (!dryRun && shouldRefreshAgentPrompt) {
          await engine.updateConfig({});
        }

        if (!details.applied.agent && !details.applied.skill && !details.applied.mcp) {
          return {
            content: [{
              type: "text",
              text: "No actionable setup data found. Provide tutorial JSON or explicit agent/skill/mcp fields.",
            }],
            details,
          };
        }

        return {
          content: [{
            type: "text",
            text: dryRun
              ? "Dry run passed. Parsed setup tutorial and validated install targets/parameters."
              : "Setup applied. Skill path and MCP parameters were written to Hanako settings.",
          }],
          details,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err || "setup failed");
        return {
          content: [{ type: "text", text: `setup_settings failed: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

export const _setupSettingsToolInternals = {
  normalizeInputPath,
  isAbsolutePathAnyPlatform,
};
