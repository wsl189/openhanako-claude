import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { Type } from "@sinclair/typebox";
import { sanitizeSkillName } from "../skills/skill-name.js";
import { saveConfig } from "../memory/config-loader.js";

const MEMORY_COMPILED_FILES = ["memory.md", "today.md", "week.md", "longterm.md", "facts.md"];

function toText(v) {
  return String(v ?? "").trim();
}

function normalizeMcpServerKey(name) {
  return toText(name).replace(/[^A-Za-z0-9_]/g, "_");
}

function parseMcpArgs(rawArgs) {
  if (Array.isArray(rawArgs)) return rawArgs.map((v) => toText(v)).filter(Boolean);
  const text = toText(rawArgs);
  if (!text) return [];
  // Parse shell-like quoted args: --flag "a b" -> ["--flag", "a b"]
  const tokens = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  for (const match of text.matchAll(re)) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    const unescaped = String(token).replace(/\\(["'\\ ])/g, "$1");
    if (toText(unescaped)) tokens.push(unescaped);
  }
  return tokens.length > 0 ? tokens : text.split(/\s+/).map((v) => toText(v)).filter(Boolean);
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

function normalizeLegacyMcpServers(rawMcpServers) {
  if (!rawMcpServers || typeof rawMcpServers !== "object" || Array.isArray(rawMcpServers)) return [];
  const entries = Object.entries(rawMcpServers).filter(([k, v]) => toText(k) && v && typeof v === "object" && !Array.isArray(v));
  if (!entries.length) return [];
  return entries.map(([name, config]) => ({
    ...(config && typeof config === "object" ? config : {}),
    name: toText(config?.name) || toText(name),
  }));
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

function isPathInside(parentPath, childPath) {
  const parent = path.resolve(String(parentPath || ""));
  const child = path.resolve(String(childPath || ""));
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function normalizeAgentId(rawId) {
  const id = toText(rawId);
  if (!id) return "";
  if (/[\\/]/.test(id) || id.includes("..")) throw new Error(`invalid agent id: ${id}`);
  return id;
}

function parseNameList(raw) {
  if (Array.isArray(raw)) return [...new Set(raw.map((v) => toText(v)).filter(Boolean))];
  const text = toText(raw);
  if (!text) return [];
  return [...new Set(text.split(/[,\n]/).map((v) => toText(v)).filter(Boolean))];
}

function normalizeAgentToolsPayload(rawTools) {
  if (!rawTools || typeof rawTools !== "object" || Array.isArray(rawTools)) return null;
  const enableAll = rawTools.enable_all === true || rawTools.all === true;
  const builtinEnabled = parseNameList(rawTools.builtin_enabled);
  const customEnabled = parseNameList(rawTools.custom_enabled);
  return {
    enable_all: enableAll,
    ...(rawTools.builtin_enabled !== undefined ? { builtin_enabled: builtinEnabled } : {}),
    ...(rawTools.custom_enabled !== undefined ? { custom_enabled: customEnabled } : {}),
  };
}

function getCurrentAgentId(engine) {
  return normalizeAgentId(path.basename(toText(engine?.agentDir)));
}

function resolveAgentContext(engine, rawAgentId = "") {
  const currentAgentId = getCurrentAgentId(engine);
  const targetAgentId = normalizeAgentId(rawAgentId) || currentAgentId;
  if (!targetAgentId) {
    throw new Error("agent_id is required when current agent is unknown");
  }
  return {
    currentAgentId,
    targetAgentId,
    targetAgentDir: path.join(engine.agentsDir, targetAgentId),
    isCurrent: targetAgentId === currentAgentId,
  };
}

async function updateAgentConfigById(engine, targetAgentId, patch) {
  const currentAgentId = getCurrentAgentId(engine);
  if (targetAgentId === currentAgentId && typeof engine.updateConfig === "function") {
    await engine.updateConfig(patch);
    return;
  }
  const targetAgent = engine.getAgent?.(targetAgentId);
  if (targetAgent && typeof targetAgent.updateConfig === "function") {
    targetAgent.updateConfig(patch);
    return;
  }
  const configPath = path.join(engine.agentsDir, targetAgentId, "config.yaml");
  if (!fs.existsSync(configPath)) throw new Error(`target agent not found: ${targetAgentId}`);
  saveConfig(configPath, patch);
}

function resolveGlobalSkillsDir(engine, checks = []) {
  const fallback = path.join(
    toText(engine?.hanakoHome) || path.dirname(toText(engine?.agentDir) || process.cwd()),
    "skills",
  );
  const requestedRaw = toText(engine?.userSkillsDir || engine?.skillsDir || fallback);
  const requested = requestedRaw ? path.resolve(requestedRaw) : path.resolve(fallback);
  const fallbackResolved = path.resolve(fallback);

  if (toText(engine?.hanakoHome) && !isPathInside(engine.hanakoHome, requested)) {
    checks.push({
      type: "skills_global_dir_guard",
      ok: false,
      requested,
      used: fallbackResolved,
      reason: "requested skills dir is outside hanako_home, fallback applied",
    });
    return fallbackResolved;
  }

  checks.push({
    type: "skills_global_dir_guard",
    ok: true,
    requested,
    used: requested,
  });
  return requested;
}

function normalizeMemoryPayload(rawMemory) {
  if (!rawMemory || typeof rawMemory !== "object" || Array.isArray(rawMemory)) return null;
  const action = toText(rawMemory.action || "clear").toLowerCase();
  if (action !== "clear") throw new Error("memory.action must be clear");
  const includePinned = rawMemory.include_pinned === true
    || rawMemory.include_permanent === true
    || rawMemory.clear_pinned === true
    || rawMemory.clear_permanent_memory === true;
  return {
    action,
    agent_id: normalizeAgentId(rawMemory.agent_id),
    include_compiled: rawMemory.include_compiled !== false,
    include_pinned: includePinned,
  };
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
  const type = (toText(rawMcp.type || (rawMcp.url ? "sse" : "stdio")) || "stdio").toLowerCase();
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
  const legacyMcpFromParams = normalizeLegacyMcpServers(params?.mcpServers);
  const legacyMcpFromTutorial = normalizeLegacyMcpServers(parsed?.mcpServers);
  const legacyMcp = legacyMcpFromParams.length > 0 ? legacyMcpFromParams : legacyMcpFromTutorial;
  const selectedLegacyMcp = legacyMcp.length <= 1 ? (legacyMcp[0] || null) : legacyMcp;
  return {
    agent: (params?.agent && typeof params.agent === "object") ? params.agent : parsed.agent,
    skill: (params?.skill && typeof params.skill === "object") ? params.skill : parsed.skill,
    mcp: (params?.mcp && typeof params.mcp === "object")
      ? params.mcp
      : ((parsed?.mcp && typeof parsed.mcp === "object") ? parsed.mcp : selectedLegacyMcp),
    memory: (params?.memory && typeof params.memory === "object") ? params.memory : parsed.memory,
  };
}

export function createSetupSettingsTool({ engine }) {
  return {
    name: "setup_settings",
    label: "Setup Settings",
    description: "Apply Hanako-only setup changes from one tutorial JSON or explicit fields (never configure external products). Supports: agent create/update/delete (profile, model/workspace, tool permissions, identity/ishiki), skill install from local SKILL.md directory (global + optional enable for current agent), MCP registration (stdio/sse/http; include mcp.env when target MCP docs require API key/host or other env vars), memory clear for target agent (compiled files + optional pinned/permanent), and dry-run validation. After installing skill/MCP, run a smoke test; if dependencies/environment are missing, install them into Hanako shared runtime first, then re-test.",
    parameters: Type.Object({
      tutorial: Type.Optional(Type.String({
        description: "Setup tutorial text. Recommended to include a JSON block with top-level keys: {agent, skill, mcp, memory}.",
      })),
      agent: Type.Optional(Type.Object({
        action: Type.Optional(Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")], {
          description: "Agent action. update is default when omitted.",
        })),
        agent_id: Type.Optional(Type.String({ description: "Target agent id for update/delete. Omit on update to target current agent." })),
        id: Type.Optional(Type.String({ description: "Optional explicit agent id for create (alias of agent_id)." })),
        name: Type.Optional(Type.String({ description: "Agent display name (required for create)." })),
        yuan: Type.Optional(Type.String({ description: "Agent persona template id (optional)." })),
        default_workspace: Type.Optional(Type.String({ description: "Default workspace mapped to desk.home_folder for target/new agent." })),
        default_model: Type.Optional(Type.String({ description: "Default chat model mapped to models.chat for target/new agent." })),
        tools: Type.Optional(Type.Object({
          enable_all: Type.Optional(Type.Boolean({ description: "When true, clear per-agent tool whitelists so all available tools are enabled." })),
          builtin_enabled: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], {
            description: "Builtin tool allowlist (array or comma/newline-separated string).",
          })),
          custom_enabled: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], {
            description: "Custom tool allowlist (array or comma/newline-separated string).",
          })),
        })),
        identity_markdown: Type.Optional(Type.String({ description: "Full replacement content for identity.md on target agent." })),
        ishiki_markdown: Type.Optional(Type.String({ description: "Full replacement content for ishiki.md on target agent." })),
      })),
      skill: Type.Optional(Type.Object({
        source_path: Type.Optional(Type.String({ description: "Absolute local directory path containing SKILL.md to install." })),
        name: Type.Optional(Type.String({ description: "Optional installed skill name override (sanitized)." })),
        enable_for_current_agent: Type.Optional(Type.Boolean({ default: true, description: "When true (default), also install/enable for current agent after global install." })),
      })),
      mcp: Type.Optional(Type.Object({
        name: Type.String({ description: "MCP server name (normalized to [A-Za-z0-9_])." }),
        type: Type.Optional(Type.Union([Type.Literal("stdio"), Type.Literal("sse"), Type.Literal("http")], {
          description: "MCP transport type. Defaults to stdio unless url is provided.",
        })),
        command: Type.Optional(Type.String({ description: "Required for stdio type." })),
        args: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], {
          description: "Optional stdio args (array or whitespace string).",
        })),
        env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Stdio env map. Required when the target MCP's docs require environment variables (for example API keys/hosts)." })),
        url: Type.Optional(Type.String({ description: "Required for sse/http type." })),
        headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Optional headers for sse/http type." })),
        disabled: Type.Optional(Type.Boolean({ description: "Whether to register this MCP server as disabled." })),
      })),
      memory: Type.Optional(Type.Object({
        action: Type.Optional(Type.Literal("clear", { description: "Memory action. Only clear is supported." })),
        agent_id: Type.Optional(Type.String({ description: "Target agent id. Omit to use current agent." })),
        include_compiled: Type.Optional(Type.Boolean({ default: true, description: "Whether to clear compiled memory files (memory.md/today/week/longterm/facts)." })),
        include_pinned: Type.Optional(Type.Boolean({ default: false, description: "Whether to also clear pinned.md (persistent memory)." })),
      })),
      dry_run: Type.Optional(Type.Boolean({ default: false, description: "Validate and preview checks only. No files/config are changed." })),
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
            memory: null,
          },
          locations: {
            hanako_home: engine.hanakoHome,
            skills_global_dir: "",
            current_agent_dir: engine.agentDir || "",
          },
          checks: [],
        };
        const globalSkillsDir = resolveGlobalSkillsDir(engine, details.checks);
        details.locations.skills_global_dir = globalSkillsDir;

        let shouldRefreshAgentPrompt = false;

        if (spec.agent && typeof spec.agent === "object") {
          const rawAction = toText(spec.agent.action).toLowerCase();
          const action = rawAction || "update";
          if (!["create", "update", "delete"].includes(action)) {
            throw new Error("agent.action must be create, update, or delete");
          }
          const requestedAgentId = normalizeAgentId(spec.agent.agent_id || spec.agent.id);
          const agentName = toText(spec.agent.name);
          const agentYuan = toText(spec.agent.yuan);
          const defaultWorkspace = toText(spec.agent.default_workspace);
          const defaultModel = toText(spec.agent.default_model);
          const normalizedTools = normalizeAgentToolsPayload(spec.agent.tools);
          const identityMd = spec.agent.identity_markdown;
          const ishikiMd = spec.agent.ishiki_markdown;
          const hasAgentMutationFields = Boolean(
            agentName ||
            agentYuan ||
            defaultWorkspace ||
            defaultModel ||
            normalizedTools ||
            typeof identityMd === "string" ||
            typeof ishikiMd === "string"
          );

          if (!rawAction && !requestedAgentId && hasAgentMutationFields) {
            throw new Error("agent.action is required (create/update/delete) when agent.agent_id is omitted");
          }

          if (action === "create") {
            if (!agentName) throw new Error("agent.name is required for create");
            const createPayload = {
              name: agentName,
              ...(requestedAgentId ? { id: requestedAgentId } : {}),
              ...(agentYuan ? { yuan: agentYuan } : {}),
            };
            const createdAgentId = requestedAgentId || (dryRun ? "dry_run_agent" : "");
            details.checks.push({
              type: "agent_create_payload",
              ok: true,
              payload: createPayload,
            });
            let actualAgentId = createdAgentId;
            if (!dryRun) {
              const created = await engine.createAgent(createPayload);
              actualAgentId = normalizeAgentId(created?.id);
            }

            const patch = {};
            if (defaultWorkspace) patch.desk = { home_folder: defaultWorkspace };
            if (defaultModel) patch.models = { chat: defaultModel };
            if (normalizedTools?.enable_all) {
              patch.tools = { builtin_enabled: null, custom_enabled: null };
            } else if (normalizedTools && (normalizedTools.builtin_enabled || normalizedTools.custom_enabled)) {
              patch.tools = {
                ...(normalizedTools.builtin_enabled ? { builtin_enabled: normalizedTools.builtin_enabled } : {}),
                ...(normalizedTools.custom_enabled ? { custom_enabled: normalizedTools.custom_enabled } : {}),
              };
            }

            if (!dryRun && Object.keys(patch).length > 0 && actualAgentId) {
              await updateAgentConfigById(engine, actualAgentId, patch);
            }
            if (typeof identityMd === "string" && actualAgentId && !dryRun) {
              fs.writeFileSync(path.join(engine.agentsDir, actualAgentId, "identity.md"), identityMd, "utf-8");
            }
            if (typeof ishikiMd === "string" && actualAgentId && !dryRun) {
              fs.writeFileSync(path.join(engine.agentsDir, actualAgentId, "ishiki.md"), ishikiMd, "utf-8");
            }

            details.applied.agent = {
              action: "create",
              agent_id: actualAgentId || createdAgentId,
              name: agentName,
              ...(agentYuan ? { yuan: agentYuan } : {}),
              ...(defaultWorkspace ? { default_workspace: defaultWorkspace } : {}),
              ...(defaultModel ? { default_model: defaultModel } : {}),
              ...(normalizedTools?.enable_all ? { tools: { enable_all: true } } : {}),
              ...(normalizedTools?.builtin_enabled ? { tools_builtin_enabled: normalizedTools.builtin_enabled } : {}),
              ...(normalizedTools?.custom_enabled ? { tools_custom_enabled: normalizedTools.custom_enabled } : {}),
              ...(typeof identityMd === "string" ? { identity_markdown_updated: true } : {}),
              ...(typeof ishikiMd === "string" ? { ishiki_markdown_updated: true } : {}),
            };
          } else if (action === "delete") {
            if (!requestedAgentId) throw new Error("agent.agent_id (or agent.id) is required for delete");
            const targetAgentDir = path.join(engine.agentsDir, requestedAgentId);
            details.checks.push({
              type: "agent_delete_target",
              ok: dryRun ? true : fs.existsSync(targetAgentDir),
              agent_id: requestedAgentId,
            });
            if (!dryRun) {
              await engine.deleteAgent(requestedAgentId);
            }
            details.applied.agent = {
              action: "delete",
              agent_id: requestedAgentId,
            };
          } else {
            const context = resolveAgentContext(engine, requestedAgentId);
            const patch = {};
            if (agentName || agentYuan) {
              patch.agent = {};
              if (agentName) patch.agent.name = agentName;
              if (agentYuan) patch.agent.yuan = agentYuan;
            }
            if (defaultWorkspace) patch.desk = { home_folder: defaultWorkspace };
            if (defaultModel) patch.models = { chat: defaultModel };
            if (normalizedTools?.enable_all) {
              patch.tools = { builtin_enabled: null, custom_enabled: null };
            } else if (normalizedTools && (normalizedTools.builtin_enabled || normalizedTools.custom_enabled)) {
              patch.tools = {
                ...(normalizedTools.builtin_enabled ? { builtin_enabled: normalizedTools.builtin_enabled } : {}),
                ...(normalizedTools.custom_enabled ? { custom_enabled: normalizedTools.custom_enabled } : {}),
              };
            }

            details.checks.push({
              type: "agent_update_target",
              ok: dryRun ? true : fs.existsSync(context.targetAgentDir),
              agent_id: context.targetAgentId,
            });

            if (!dryRun && !fs.existsSync(context.targetAgentDir)) {
              throw new Error(`target agent not found: ${context.targetAgentId}`);
            }
            if (!dryRun && Object.keys(patch).length > 0) {
              await updateAgentConfigById(engine, context.targetAgentId, patch);
            }

            if (typeof identityMd === "string") {
              if (!dryRun) {
                fs.writeFileSync(path.join(context.targetAgentDir, "identity.md"), identityMd, "utf-8");
              }
              if (context.isCurrent) shouldRefreshAgentPrompt = true;
            }
            if (typeof ishikiMd === "string") {
              if (!dryRun) {
                fs.writeFileSync(path.join(context.targetAgentDir, "ishiki.md"), ishikiMd, "utf-8");
              }
              if (context.isCurrent) shouldRefreshAgentPrompt = true;
            }
            if (context.isCurrent && (Object.keys(patch).length > 0 || typeof identityMd === "string" || typeof ishikiMd === "string")) {
              shouldRefreshAgentPrompt = true;
            }

            details.applied.agent = {
              action: "update",
              agent_id: context.targetAgentId,
              ...(agentName ? { name: agentName } : {}),
              ...(agentYuan ? { yuan: agentYuan } : {}),
              ...(defaultWorkspace ? { default_workspace: defaultWorkspace } : {}),
              ...(defaultModel ? { default_model: defaultModel } : {}),
              ...(normalizedTools?.enable_all ? { tools: { enable_all: true } } : {}),
              ...(normalizedTools?.builtin_enabled ? { tools_builtin_enabled: normalizedTools.builtin_enabled } : {}),
              ...(normalizedTools?.custom_enabled ? { tools_custom_enabled: normalizedTools.custom_enabled } : {}),
              ...(typeof identityMd === "string" ? { identity_markdown_updated: true } : {}),
              ...(typeof ishikiMd === "string" ? { ishiki_markdown_updated: true } : {}),
            };
          }
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
          const rawMcpList = Array.isArray(spec.mcp) ? spec.mcp : [spec.mcp];
          const normalizedList = [];
          for (const rawMcp of rawMcpList) {
            const normalized = normalizeMcpPayload(rawMcp);
            if (!normalized) throw new Error("invalid mcp payload");
            if (normalized.command) {
              const exists = commandExists(normalized.command);
              details.checks.push({
                type: "mcp_command_exists",
                ok: exists,
                command: normalized.command,
              });
              if (!exists) {
                throw new Error(`mcp.command not found in PATH: ${normalized.command}`);
              }
            }
            normalizedList.push(normalized);
          }

          if (normalizedList.length > 1) {
            details.checks.push({
              type: "mcp_multi_servers",
              ok: true,
              count: normalizedList.length,
              names: normalizedList.map((item) => item.name),
            });
          }

          if (!dryRun) {
            const patch = {};
            for (const item of normalizedList) patch[item.name] = item.config;
            engine.patchExternalMcpServers?.(patch);
            const refreshResult = await engine.refreshCurrentSessionTools?.();
            if (refreshResult && refreshResult.reloaded === false) {
              details.checks.push({
                type: "mcp_tools_refresh",
                ok: false,
                reason: refreshResult.reason || "unknown",
              });
            } else {
              details.checks.push({
                type: "mcp_tools_refresh",
                ok: true,
              });
            }
          }
          details.applied.mcp = normalizedList.length === 1
            ? {
                name: normalizedList[0].name,
                config: normalizedList[0].config,
              }
            : {
                count: normalizedList.length,
                servers: normalizedList.map((item) => ({ name: item.name, config: item.config })),
              };
        }

        if (spec.memory && typeof spec.memory === "object") {
          const memory = normalizeMemoryPayload(spec.memory);
          if (!memory) throw new Error("invalid memory payload");
          const activeAgentId = normalizeAgentId(path.basename(toText(engine.agentDir)));
          const targetAgentId = memory.agent_id || activeAgentId;
          if (!targetAgentId) throw new Error("memory.agent_id is required when current agent is unknown");
          const targetAgentDir = path.join(engine.agentsDir, targetAgentId);
          if (!dryRun && !fs.existsSync(targetAgentDir)) {
            throw new Error(`target agent not found: ${targetAgentId}`);
          }
          const targetMemoryDir = path.join(targetAgentDir, "memory");
          const targetPinnedPath = path.join(targetAgentDir, "pinned.md");
          const targetFactsDbPath = path.join(targetMemoryDir, "facts.db");
          const memoryFiles = memory.include_compiled ? MEMORY_COMPILED_FILES : ["memory.md"];

          details.checks.push({
            type: "memory_target_agent",
            ok: dryRun ? true : fs.existsSync(targetAgentDir),
            agent_id: targetAgentId,
          });

          if (!dryRun) {
            fs.mkdirSync(targetMemoryDir, { recursive: true });

            if (targetAgentId === activeAgentId && engine.factStore?.clearAll) {
              engine.factStore.clearAll();
            } else {
              for (const dbPath of [targetFactsDbPath, `${targetFactsDbPath}-wal`, `${targetFactsDbPath}-shm`]) {
                try { fs.rmSync(dbPath, { force: true }); } catch {}
              }
            }

            for (const fileName of memoryFiles) {
              const targetPath = path.join(targetMemoryDir, fileName);
              fs.writeFileSync(targetPath, "", "utf-8");
              if (memory.include_compiled) {
                try { fs.unlinkSync(targetPath + ".fingerprint"); } catch {}
              }
            }

            if (memory.include_pinned) {
              fs.writeFileSync(targetPinnedPath, "", "utf-8");
            }
            if (targetAgentId === activeAgentId) shouldRefreshAgentPrompt = true;
          }

          details.applied.memory = {
            action: "clear",
            agent_id: targetAgentId,
            include_compiled: memory.include_compiled,
            include_pinned: memory.include_pinned,
            facts_db_path: targetFactsDbPath,
          };
        }

        if (!dryRun && shouldRefreshAgentPrompt) {
          await engine.updateConfig({});
        }

        if (!details.applied.agent && !details.applied.skill && !details.applied.mcp && !details.applied.memory) {
          return {
            content: [{
              type: "text",
              text: "No actionable setup data found. Provide tutorial JSON or explicit agent/skill/mcp/memory fields.",
            }],
            details,
          };
        }

        const mcpRefreshCheck = (details.checks || []).find((item) => item?.type === "mcp_tools_refresh");
        const mcpRefreshDeferred = mcpRefreshCheck && mcpRefreshCheck.ok === false && mcpRefreshCheck.reason === "streaming";
        return {
          content: [{
            type: "text",
            text: dryRun
              ? "Dry run passed. Parsed setup tutorial and validated install targets/parameters."
              : (mcpRefreshDeferred
                  ? "Setup applied. MCP config was saved, but current session is streaming; MCP tools will reload after this turn ends."
                  : "Setup applied. Hanako settings were updated (agent/skill/MCP/memory as requested, Hanako scope only)."),
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
  resolveGlobalSkillsDir,
  normalizeMemoryPayload,
};
