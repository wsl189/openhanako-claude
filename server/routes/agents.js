/**
 * 助手管理 REST 路由
 *
 * GET    /api/agents              — 列出所有助手
 * POST   /api/agents              — 创建新助手
 * DELETE /api/agents/:id          — 删除助手
 * GET    /api/agents/:id/avatar   — 获取指定助手的头像
 * POST   /api/agents/:id/avatar   — 上传指定助手的头像
 * GET    /api/agents/:id/config   — 读取指定助手的 config
 * PUT    /api/agents/:id/config   — 写入指定助手的 config
 * GET    /api/agents/:id/identity — 读取 identity.md
 * PUT    /api/agents/:id/identity — 写入 identity.md
 * GET    /api/agents/:id/ishiki   — 读取 ishiki.md
 * PUT    /api/agents/:id/ishiki   — 写入 ishiki.md
 * GET    /api/agents/:id/pinned   — 读取 pinned.md
 * PUT    /api/agents/:id/pinned   — 写入 pinned.md
 * GET    /api/agents/:id/experience — 读取经验（合并）
 * PUT    /api/agents/:id/experience — 写入经验（拆分）
 */
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import YAML from "js-yaml";
import { saveConfig, getAllProviders, saveGlobalProviders, clearConfigCache } from "../../lib/memory/config-loader.js";
import { rebuildIndex } from "../../lib/tools/experience.js";
import { getBuiltinExternalMcpServers, getBuiltinExternalMcpServerNames } from "../../core/builtin-mcp-servers.js";

// ── 工具函数 ──
const REMOVED_EXTERNAL_MCP_SERVER_NAMES = new Set(["claude_in_chrome"]);

function validateId(id) {
  return id && !id.includes("..") && !id.includes("/") && !id.includes("\\");
}

function agentDir(engine, id) {
  return path.join(engine.agentsDir, id);
}

function agentExists(engine, id) {
  return fsSync.existsSync(path.join(agentDir(engine, id), "config.yaml"));
}

function isActiveAgent(engine, id) {
  return id === engine.currentAgentId;
}

function mask(key) {
  if (!key) return "";
  if (key.length < 8) return "****";
  return key.slice(0, 4) + "..." + key.slice(-4);
}

const DEFAULT_YUAN_CANDIDATES = ["hanako", "butter", "ming", "kong"];

function readTextSafe(p) {
  try { return fsSync.readFileSync(p, "utf-8"); } catch { return ""; }
}

function resolvePersonaTemplate(productDir, kind, yuan, isZh) {
  const baseDir = kind === "identity" ? "identity-templates" : "ishiki-templates";
  const example = kind === "identity" ? "identity.example.md" : "ishiki.example.md";
  const langDir = isZh ? "" : "en/";
  return readTextSafe(path.join(productDir, baseDir, `${langDir}${yuan}.md`))
    || readTextSafe(path.join(productDir, baseDir, `${yuan}.md`))
    || readTextSafe(path.join(productDir, example));
}

function fillPersonaTemplate(tmpl, ctx) {
  return String(tmpl || "")
    .replace(/\{\{agentName\}\}/g, ctx.agentName || "")
    .replace(/\{\{userName\}\}/g, ctx.userName || "")
    .replace(/\{\{agentId\}\}/g, ctx.agentId || "");
}

function normalizeSandboxPatch(rawSandbox) {
  if (rawSandbox === undefined || rawSandbox === null) return null;
  if (typeof rawSandbox === "boolean") return { mode: "full-access" };
  if (typeof rawSandbox !== "object") return null;
  return { mode: "full-access" };
}

function normalizeToolsPatch(rawTools) {
  if (rawTools === undefined || rawTools === null) return null;
  if (typeof rawTools !== "object") {
    throw new Error("tools must be an object");
  }
  const next = {};
  if (rawTools.builtin_enabled !== undefined) {
    if (!Array.isArray(rawTools.builtin_enabled)) {
      throw new Error("tools.builtin_enabled must be an array");
    }
    next.builtin_enabled = rawTools.builtin_enabled.map(v => String(v || "").trim()).filter(Boolean);
  }
  if (rawTools.custom_enabled !== undefined) {
    if (!Array.isArray(rawTools.custom_enabled)) {
      throw new Error("tools.custom_enabled must be an array");
    }
    next.custom_enabled = rawTools.custom_enabled.map(v => String(v || "").trim()).filter(Boolean);
  }
  return next;
}

function normalizeMcpServerKey(name) {
  return String(name || "").trim().replace(/[^A-Za-z0-9_]/g, "_");
}

function isRemovedExternalMcpServer(name) {
  return REMOVED_EXTERNAL_MCP_SERVER_NAMES.has(normalizeMcpServerKey(name));
}

function parseMcpArgs(rawArgs) {
  if (Array.isArray(rawArgs)) {
    return rawArgs.map(v => String(v || "").trim()).filter(Boolean);
  }
  const text = String(rawArgs || "").trim();
  if (!text) return [];
  return text.split(/\s+/).map(v => v.trim()).filter(Boolean);
}

function normalizeStringMap(rawMap, label) {
  if (rawMap === undefined || rawMap === null || rawMap === "") return undefined;
  if (typeof rawMap !== "object" || Array.isArray(rawMap)) {
    throw new Error(`${label} must be an object`);
  }
  const out = {};
  for (const [key, value] of Object.entries(rawMap)) {
    const name = String(key || "").trim();
    if (!name) continue;
    out[name] = String(value ?? "");
  }
  return out;
}

function normalizeExternalMcpServer(rawServer) {
  if (!rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) {
    throw new Error("mcp.external_servers entries must be objects");
  }
  const type = String(rawServer.type || (rawServer.url ? "sse" : "stdio")).trim() || "stdio";
  const disabled = rawServer.disabled === true || rawServer.enabled === false;
  const shouldClearDisabled = rawServer.disabled === false || rawServer.enabled === true;
  if (type === "stdio") {
    const command = String(rawServer.command || "").trim();
    if (!command) throw new Error("mcp stdio server command is required");
    const args = parseMcpArgs(rawServer.args);
    const env = normalizeStringMap(rawServer.env, "mcp env");
    return {
      type: "stdio",
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
      ...(disabled ? { disabled: true } : {}),
      ...(shouldClearDisabled ? { disabled: null, enabled: null } : {}),
    };
  }
  if (type === "sse" || type === "http") {
    const url = String(rawServer.url || "").trim();
    if (!url) throw new Error("mcp url is required");
    const headers = normalizeStringMap(rawServer.headers, "mcp headers");
    return {
      type,
      url,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      ...(disabled ? { disabled: true } : {}),
      ...(shouldClearDisabled ? { disabled: null, enabled: null } : {}),
    };
  }
  throw new Error("mcp server type must be stdio, sse, or http");
}

function normalizeMcpPatch(rawMcp) {
  if (rawMcp === undefined || rawMcp === null) return rawMcp;
  if (typeof rawMcp !== "object" || Array.isArray(rawMcp)) {
    throw new Error("mcp must be an object");
  }
  const out = { ...rawMcp };
  if (rawMcp.external_servers !== undefined) {
    if (!rawMcp.external_servers || typeof rawMcp.external_servers !== "object" || Array.isArray(rawMcp.external_servers)) {
      throw new Error("mcp.external_servers must be an object");
    }
    out.external_servers = {};
    for (const [rawName, rawServer] of Object.entries(rawMcp.external_servers)) {
      const name = normalizeMcpServerKey(rawName);
      if (!name) throw new Error("mcp server name is required");
      if (isRemovedExternalMcpServer(name)) continue;
      out.external_servers[name] = rawServer === null ? null : normalizeExternalMcpServer(rawServer);
    }
  }
  if (rawMcp.disabled_servers !== undefined) {
    if (!Array.isArray(rawMcp.disabled_servers)) {
      throw new Error("mcp.disabled_servers must be an array");
    }
    out.disabled_servers = rawMcp.disabled_servers
      .map(name => normalizeMcpServerKey(name))
      .filter(Boolean);
  }
  return out;
}

function injectGlobalMcpConfig(engine, config) {
  const globalServers = engine.getExternalMcpServers?.() || {};
  const builtinServers = getBuiltinExternalMcpServers(process.env);
  const mergedServers = {};
  const sources = [
    (globalServers && typeof globalServers === "object" ? globalServers : {}),
    (builtinServers && typeof builtinServers === "object" ? builtinServers : {}),
  ];
  for (const source of sources) {
    for (const [rawName, value] of Object.entries(source)) {
      const name = normalizeMcpServerKey(rawName);
      if (!name || isRemovedExternalMcpServer(name)) continue;
      mergedServers[name] = value;
    }
  }
  const disabledServers = Array.isArray(config?.mcp?.disabled_servers)
    ? config.mcp.disabled_servers.map(name => normalizeMcpServerKey(name)).filter(Boolean)
    : [];
  config.mcp = {
    ...(config.mcp || {}),
    external_servers: mergedServers,
    disabled_servers: disabledServers,
    builtin_servers: getBuiltinExternalMcpServerNames(process.env),
  };
}

function promoteLegacyExternalMcpServers(engine, config, configPath) {
  const legacyServers = config?.mcp?.external_servers;
  if (!legacyServers || typeof legacyServers !== "object" || Array.isArray(legacyServers)) return;
  const currentGlobal = engine.getExternalMcpServers?.() || {};
  const builtinServerNames = new Set(getBuiltinExternalMcpServerNames(process.env));
  const globalPatch = {};
  const cleanupPatch = {};
  for (const [rawName, rawServer] of Object.entries(legacyServers)) {
    const name = normalizeMcpServerKey(rawName);
    if (!name) continue;
    cleanupPatch[name] = null;
    if (isRemovedExternalMcpServer(name)) continue;
    if (builtinServerNames.has(name)) continue;
    if (rawServer === null || currentGlobal[name] !== undefined) continue;
    globalPatch[name] = rawServer;
  }
  if (Object.keys(globalPatch).length > 0) {
    engine.patchExternalMcpServers?.(globalPatch);
  }
  if (Object.keys(cleanupPatch).length > 0 && configPath) {
    try {
      const cleanup = { mcp: { external_servers: cleanupPatch } };
      if (engine.agent?.configPath === configPath && typeof engine.agent.updateConfig === "function") {
        engine.agent.updateConfig(cleanup);
      } else {
        saveConfig(configPath, cleanup);
      }
    } catch {}
  }
  delete config.mcp.external_servers;
}

function extractGlobalMcpPatch(engine, partial) {
  if (!partial?.mcp || typeof partial.mcp !== "object") return false;
  if (partial.mcp.external_servers === undefined) return false;
  const builtinServerNames = new Set(getBuiltinExternalMcpServerNames(process.env));
  const patch = {};
  const blocked = [];
  for (const [rawName, value] of Object.entries(partial.mcp.external_servers || {})) {
    const name = normalizeMcpServerKey(rawName);
    if (!name) continue;
    if (isRemovedExternalMcpServer(name)) continue;
    if (builtinServerNames.has(name)) {
      blocked.push(name);
      continue;
    }
    patch[name] = value;
  }
  if (blocked.length > 0) {
    throw new Error(`built-in MCP cannot be modified: ${blocked.join(", ")}`);
  }
  if (Object.keys(patch).length > 0) {
    engine.patchExternalMcpServers?.(patch);
  }
  delete partial.mcp.external_servers;
  if (Object.keys(partial.mcp).length === 0) delete partial.mcp;
  return Object.keys(patch).length > 0;
}

function buildDefaultPersonaSet(productDir, kind, ctx) {
  const out = new Set();
  for (const isZh of [true, false]) {
    for (const yuan of DEFAULT_YUAN_CANDIDATES) {
      const tmpl = resolvePersonaTemplate(productDir, kind, yuan, isZh);
      if (!tmpl) continue;
      const filled = fillPersonaTemplate(tmpl, ctx).trim();
      if (filled) out.add(filled);
    }
  }
  return out;
}

function isDefaultPersonaContent(content, productDir, kind, contexts) {
  const cur = String(content || "").trim();
  if (!cur) return true;
  for (const ctx of contexts) {
    const defaults = buildDefaultPersonaSet(productDir, kind, ctx);
    if (defaults.has(cur)) return true;
  }
  return false;
}

export default async function agentsRoute(app, { engine }) {

  // ════════════════════════════
  //  列表 / 创建 / 删除
  // ════════════════════════════

  app.get("/api/agents", async (req, reply) => {
    try {
      return { agents: engine.listAgents() };
    } catch (err) {
      const msg = String(err?.message || "");
      if (msg.startsWith("sandbox.") || msg.startsWith("tools")) reply.code(400);
      else reply.code(500);
      return { error: err.message };
    }
  });

  app.post("/api/agents", async (req, reply) => {
    try {
      const { name, id, yuan } = req.body || {};
      if (!name?.trim()) {
        reply.code(400);
        return { error: "name is required" };
      }
      const result = await engine.createAgent({ name, id, yuan });
      return { ok: true, ...result };
    } catch (err) {
      const isConflict = err?.code === "AGENT_NAME_EXISTS"
        || err?.code === "AGENT_ID_EXISTS"
        || err.message.includes("已存在")
        || err.message.includes("already exists");
      reply.code(isConflict ? 409 : 500);
      return { error: err.message };
    }
  });

  app.delete("/api/agents/:id", async (req, reply) => {
    try {
      const { id } = req.params;
      if (!validateId(id)) { reply.code(400); return { error: "invalid id" }; }
      await engine.deleteAgent(id);
      return { ok: true };
    } catch (err) {
      const code = err?.code === "AGENT_DELETE_LAST" ? 400
        : err.message.includes("不能删除当前") ? 400
        : err.message.includes("至少保留一个助手") ? 400
        : err.message.includes("does not exist") || err.message.includes("不存在") ? 404
        : 500;
      reply.code(code);
      return { error: err.message };
    }
  });

  // ════════════════════════════
  //  排序
  // ════════════════════════════

  app.put("/api/agents/order", async (req, reply) => {
    try {
      const { order } = req.body || {};
      if (!Array.isArray(order)) {
        reply.code(400);
        return { error: "order must be an array" };
      }
      engine.saveAgentOrder(order);
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ════════════════════════════
  //  头像
  // ════════════════════════════

  app.get("/api/agents/:id/avatar", async (req, reply) => {
    const { id } = req.params;
    if (!validateId(id)) {
      reply.code(400);
      return { error: "invalid id" };
    }
    const avatarPath = path.join(agentDir(engine, id), "avatars");
    const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      const p = path.join(avatarPath, `agent.${ext}`);
      try {
        await fs.access(p);
        const buf = await fs.readFile(p);
        reply.header("Content-Type", mimeMap[ext]);
        reply.header("Cache-Control", "no-cache");
        return reply.send(buf);
      } catch {}
    }
    reply.code(404);
    return { error: "no avatar" };
  });

  app.post("/api/agents/:id/avatar", { bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => {
    const { id } = req.params;
    if (!validateId(id) || !agentExists(engine, id)) {
      reply.code(404);
      return { error: "agent not found" };
    }
    const { data } = req.body || {};
    if (!data || typeof data !== "string") {
      reply.code(400);
      return { error: "data (base64) is required" };
    }
    const match = data.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
    if (!match) {
      reply.code(400);
      return { error: "invalid data URL format" };
    }
    const ext = match[1] === "jpeg" ? "jpg" : match[1];
    const buf = Buffer.from(match[2], "base64");
    const dir = path.join(agentDir(engine, id), "avatars");
    await fs.mkdir(dir, { recursive: true });
    for (const oldExt of ["png", "jpg", "jpeg", "webp"]) {
      try { await fs.unlink(path.join(dir, `agent.${oldExt}`)); } catch {}
    }
    await fs.writeFile(path.join(dir, `agent.${ext}`), buf);
    engine.invalidateAgentListCache();
    return { ok: true, ext };
  });

  app.delete("/api/agents/:id/avatar", async (req, reply) => {
    const { id } = req.params;
    if (!validateId(id) || !agentExists(engine, id)) {
      reply.code(404);
      return { error: "agent not found" };
    }
    const dir = path.join(agentDir(engine, id), "avatars");
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      try { await fs.unlink(path.join(dir, `agent.${ext}`)); } catch {}
    }
    engine.invalidateAgentListCache();
    return { ok: true };
  });

  // ════════════════════════════
  //  Config（config.yaml）
  // ════════════════════════════

  app.get("/api/agents/:id/config", async (req, reply) => {
    const { id } = req.params;
    if (!validateId(id) || !agentExists(engine, id)) {
      reply.code(404);
      return { error: "agent not found" };
    }
    try {
      const configPath = path.join(agentDir(engine, id), "config.yaml");
      // 直接解析 YAML，不走 loadConfig 全局缓存
      const config = YAML.load(await fs.readFile(configPath, "utf-8")) || {};
      promoteLegacyExternalMcpServers(engine, config, configPath);

      // 脱敏 API key
      if (config.api) config.api = { ...config.api, api_key: mask(config.api.api_key) };
      if (config.embedding_api) config.embedding_api = { ...config.embedding_api, api_key: mask(config.embedding_api.api_key) };
      if (config.utility_api) config.utility_api = { ...config.utility_api, api_key: mask(config.utility_api.api_key) };
      if (config.search) config.search = { ...config.search, api_key: mask(config.search?.api_key) };

      // 附带 raw 结构
      config._raw = {
        api: { provider: config.api?.provider || "", base_url: config.api?.base_url || "" },
        embedding_api: { provider: config.embedding_api?.provider || "", base_url: config.embedding_api?.base_url || "" },
        utility_api: { provider: config.utility_api?.provider || "", base_url: config.utility_api?.base_url || "" },
      };

      // 注入全局设置（存于 preferences，跨 agent 共享）
      if (!config.desk) config.desk = {};
      config.desk.home_folder = engine.getHomeFolder(id) || "";
      const permissions = engine.getAgentPermissionConfig(id);
      config.sandbox = permissions.sandbox;
      config.tools = permissions.tools;
      config._toolCatalog = permissions.tool_catalog;
      injectGlobalMcpConfig(engine, config);
      const globalLocale = engine.getLocale();
      if (globalLocale) config.locale = globalLocale;
      const globalTz = engine.getTimezone();
      if (globalTz) config.timezone = globalTz;
      config.thinking_level = engine.getThinkingLevel();
      const globalUserName = engine.getUserName?.() || "";
      config.user = { ...(config.user || {}), name: globalUserName || config.user?.name || "" };

      // 供应商列表
      try {
        const providers = getAllProviders(configPath);
        const maskedProviders = {};
        for (const [name, p] of Object.entries(providers)) {
          maskedProviders[name] = {
            base_url: p.base_url || "",
            api: p.api || "",
            api_key: mask(p.api_key),
            models: p.models || [],
            custom_models: p.custom_models || [],
            model_count: (p.models || []).length,
          };
        }
        config.providers = maskedProviders;
      } catch {
        config.providers = {};
      }

      return config;
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  app.put("/api/agents/:id/config", async (req, reply) => {
    const { id } = req.params;
    if (!validateId(id) || !agentExists(engine, id)) {
      reply.code(404);
      return { error: "agent not found" };
    }
    try {
      const partial = req.body;
      if (!partial || typeof partial !== "object") {
        reply.code(400);
        return { error: "invalid JSON body" };
      }
      const configPath = path.join(agentDir(engine, id), "config.yaml");
      const oldCfg = YAML.load(fsSync.readFileSync(configPath, "utf-8")) || {};
      const oldYuan = oldCfg?.agent?.yuan || "hanako";
      const oldName = oldCfg?.agent?.name || id;
      const oldUserName = engine.getUserName?.() || oldCfg?.user?.name || "";
      const oldCtx = { agentId: id, agentName: oldName, userName: oldUserName };
      const identityPath = path.join(agentDir(engine, id), "identity.md");
      const ishikiPath = path.join(agentDir(engine, id), "ishiki.md");
      const identityBefore = readTextSafe(identityPath);
      const ishikiBefore = readTextSafe(ishikiPath);
      // ── 全局设置拦截：存 preferences / providers.yaml 而非 agent config ──
      let externalMcpChanged = false;

      // thinking_level → 全局 preferences
      if (partial.thinking_level !== undefined) {
        engine.setThinkingLevel(partial.thinking_level);
        delete partial.thinking_level;
      }

      if (partial.sandbox !== undefined) {
        partial.sandbox = normalizeSandboxPatch(partial.sandbox);
      }

      if (partial.tools !== undefined) {
        partial.tools = normalizeToolsPatch(partial.tools);
      }

      if (partial.mcp !== undefined) {
        partial.mcp = normalizeMcpPatch(partial.mcp);
        externalMcpChanged = extractGlobalMcpPatch(engine, partial);
      }

      // locale → 全局 preferences
      if (partial.locale !== undefined) {
        engine.setLocale(partial.locale);
        delete partial.locale;
      }

      // timezone → 全局 preferences
      if (partial.timezone !== undefined) {
        engine.setTimezone(partial.timezone);
        delete partial.timezone;
      }

      // user.name → 全局 preferences（跨 agent 共享）
      if (partial.user !== undefined && partial.user !== null && typeof partial.user === "object") {
        if (Object.prototype.hasOwnProperty.call(partial.user, "name")) {
          engine.setUserName(partial.user.name);
          delete partial.user.name;
        }
        if (Object.keys(partial.user).length === 0) {
          delete partial.user;
        }
      }

      // providers 块 → 全局 providers.yaml
      let providersChanged = false;
      if (partial.providers) {
        saveGlobalProviders({ providers: partial.providers });
        delete partial.providers;
        providersChanged = true;
      }

      // 内联 API 凭证 → 全局 providers.yaml 对应条目
      for (const blockName of ["api", "embedding_api", "utility_api"]) {
        const block = partial[blockName];
        if (block?.api_key || block?.base_url) {
          const cfgPath = path.join(agentDir(engine, id), "config.yaml");
          const agentCfg = YAML.load(fsSync.readFileSync(cfgPath, "utf-8")) || {};
          const provName = typeof block.provider === "string" && block.provider.trim()
            ? block.provider.trim()
            : (agentCfg[blockName]?.provider || "").trim();
          if (!provName) {
            reply.code(400);
            return { error: `${blockName}.provider is required when saving credentials` };
          }
          const provUpdate = {};
          if (block.api_key) provUpdate.api_key = block.api_key;
          if (block.base_url) provUpdate.base_url = block.base_url;
          saveGlobalProviders({ providers: { [provName]: provUpdate } });
          block.api_key = "";
          block.base_url = "";
          providersChanged = true;
        }
      }

      if (providersChanged) {
        try { engine.providerRegistry?.reload?.(); } catch {}
        try { engine._models?.authStore?.load?.(); } catch {}
      }

      // providers 变更后确保运行时刷新
      if (providersChanged) clearConfigCache();

      // providers 是全局状态，变更后无论编辑的是哪个 agent，运行时都要刷新
      if (providersChanged) {
        await engine.updateConfig({});
        try {
          await engine.syncModelsAndRefresh();
        } catch (err) {
          console.error("[agents] syncModelsAndRefresh after provider change failed:", err.message);
        }
      }

      if (Object.keys(partial).length === 0) {
        if (externalMcpChanged) {
          try { await engine.refreshCurrentSessionTools?.(); } catch {}
        }
        return { ok: true };
      }

      // 记忆总开关：写入时间戳（用于过滤关闭期间的 session）
      if (partial.memory && "enabled" in partial.memory) {
        const now = new Date().toISOString();
        if (partial.memory.enabled === false) {
          partial.memory.disabledSince = now;
        } else {
          partial.memory.reenableAt = now;
        }
      }

      // active agent 走统一更新链路（含模型/会话联动）
      if (isActiveAgent(engine, id)) {
        await engine.updateConfig(partial);
      } else {
        // 非 active agent 也要刷新内存实例，避免 ask_agent / dm 继续使用旧身份
        const targetAgent = engine.getAgent(id);
        if (targetAgent) targetAgent.updateConfig(partial);
        else saveConfig(configPath, partial);
      }
      engine.invalidateAgentListCache();
      // 记忆总开关：无论是否 active agent，都需要刷新运行时状态（因为 ticker 后台在跑）
      if (partial.memory && "enabled" in partial.memory) {
        engine.setMemoryMasterEnabled(id, partial.memory.enabled !== false);
      }
      if (externalMcpChanged) {
        try { await engine.refreshCurrentSessionTools?.(); } catch {}
      }

      // 切换 yuan：默认内容自动切到新模板；用户自定义内容保持不动
      const newYuan = partial?.agent?.yuan;
      if (newYuan && newYuan !== oldYuan) {
        const newCfg = YAML.load(fsSync.readFileSync(configPath, "utf-8")) || {};
        const globalUserName = engine.getUserName?.() || "";
        const newCtx = {
          agentId: id,
          agentName: newCfg?.agent?.name || oldName || id,
          userName: globalUserName || newCfg?.user?.name || oldUserName || "",
        };
        const contexts = [newCtx, oldCtx];
        let personaTouched = false;
        const isZh = String(newCfg?.locale || engine.getLocale?.() || "").startsWith("zh");

        if (isDefaultPersonaContent(identityBefore, engine.productDir, "identity", contexts)) {
          const tmpl = resolvePersonaTemplate(engine.productDir, "identity", newYuan, isZh);
          if (tmpl) {
            fsSync.writeFileSync(identityPath, fillPersonaTemplate(tmpl, newCtx), "utf-8");
            personaTouched = true;
          }
        }
        if (isDefaultPersonaContent(ishikiBefore, engine.productDir, "ishiki", contexts)) {
          const tmpl = resolvePersonaTemplate(engine.productDir, "ishiki", newYuan, isZh);
          if (tmpl) {
            fsSync.writeFileSync(ishikiPath, fillPersonaTemplate(tmpl, newCtx), "utf-8");
            personaTouched = true;
          }
        }
        if (personaTouched) {
          engine.invalidateAgentListCache();
          const targetAgent = engine.getAgent(id);
          if (targetAgent) targetAgent.refreshSystemPrompt();
        }
      }

      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ════════════════════════════
  //  Identity（identity.md）
  // ════════════════════════════

  app.get("/api/agents/:id/identity", async (req, reply) => {
    const { id } = req.params;
    if (!validateId(id) || !agentExists(engine, id)) {
      reply.code(404);
      return { error: "agent not found" };
    }
    try {
      const content = await fs.readFile(path.join(agentDir(engine, id), "identity.md"), "utf-8");
      return { content };
    } catch (err) {
      if (err.code === "ENOENT") return { content: "" };
      reply.code(500);
      return { error: err.message };
    }
  });

  app.put("/api/agents/:id/identity", async (req, reply) => {
    const { id } = req.params;
    if (!validateId(id) || !agentExists(engine, id)) {
      reply.code(404);
      return { error: "agent not found" };
    }
    try {
      const { content } = req.body || {};
      if (typeof content !== "string") {
        reply.code(400);
        return { error: "content must be a string" };
      }
      await fs.writeFile(path.join(agentDir(engine, id), "identity.md"), content, "utf-8");
      engine.invalidateAgentListCache();
      const targetAgent = engine.getAgent(id);
      if (targetAgent) targetAgent.refreshSystemPrompt();
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ════════════════════════════
  //  Ishiki（ishiki.md）
  // ════════════════════════════

  app.get("/api/agents/:id/ishiki", async (req, reply) => {
    const { id } = req.params;
    if (!validateId(id) || !agentExists(engine, id)) {
      reply.code(404);
      return { error: "agent not found" };
    }
    try {
      const content = await fs.readFile(path.join(agentDir(engine, id), "ishiki.md"), "utf-8");
      return { content };
    } catch (err) {
      if (err.code === "ENOENT") return { content: "" };
      reply.code(500);
      return { error: err.message };
    }
  });

  app.put("/api/agents/:id/ishiki", async (req, reply) => {
    const { id } = req.params;
    if (!validateId(id) || !agentExists(engine, id)) {
      reply.code(404);
      return { error: "agent not found" };
    }
    try {
      const { content } = req.body || {};
      if (typeof content !== "string") {
        reply.code(400);
        return { error: "content must be a string" };
      }
      await fs.writeFile(path.join(agentDir(engine, id), "ishiki.md"), content, "utf-8");
      const targetAgent = engine.getAgent(id);
      if (targetAgent) targetAgent.refreshSystemPrompt();
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ════════════════════════════
  //  Public Ishiki（public-ishiki.md）
  // ════════════════════════════

  app.get("/api/agents/:id/public-ishiki", async (req, reply) => {
    const { id } = req.params;
    if (!validateId(id) || !agentExists(engine, id)) {
      reply.code(404);
      return { error: "agent not found" };
    }
    try {
      const content = await fs.readFile(path.join(agentDir(engine, id), "public-ishiki.md"), "utf-8");
      return { content };
    } catch (err) {
      if (err.code === "ENOENT") return { content: "" };
      reply.code(500);
      return { error: err.message };
    }
  });

  app.put("/api/agents/:id/public-ishiki", async (req, reply) => {
    const { id } = req.params;
    if (!validateId(id) || !agentExists(engine, id)) {
      reply.code(404);
      return { error: "agent not found" };
    }
    try {
      const { content } = req.body || {};
      if (typeof content !== "string") {
        reply.code(400);
        return { error: "content must be a string" };
      }
      await fs.writeFile(path.join(agentDir(engine, id), "public-ishiki.md"), content, "utf-8");
      if (isActiveAgent(engine, id)) await engine.updateConfig({});
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ════════════════════════════
  //  Pinned（pinned.md）
  // ════════════════════════════

  app.get("/api/agents/:id/pinned", async (req, reply) => {
    const { id } = req.params;
    if (!validateId(id) || !agentExists(engine, id)) {
      reply.code(404);
      return { error: "agent not found" };
    }
    try {
      const content = await fs.readFile(path.join(agentDir(engine, id), "pinned.md"), "utf-8");
      const pins = content
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => line.replace(/^-\s*/, ""));
      return { pins };
    } catch (err) {
      if (err.code === "ENOENT") return { pins: [] };
      reply.code(500);
      return { error: err.message };
    }
  });

  app.put("/api/agents/:id/pinned", async (req, reply) => {
    const { id } = req.params;
    if (!validateId(id) || !agentExists(engine, id)) {
      reply.code(404);
      return { error: "agent not found" };
    }
    try {
      const { pins } = req.body || {};
      if (!Array.isArray(pins)) {
        reply.code(400);
        return { error: "pins must be an array" };
      }
      const content = pins
        .map(p => (typeof p === "string" ? p.trim() : ""))
        .filter(p => p.length > 0)
        .map(p => `- ${p}`)
        .join("\n")
        + "\n";
      await fs.writeFile(path.join(agentDir(engine, id), "pinned.md"), content, "utf-8");
      if (isActiveAgent(engine, id)) await engine.updateConfig({});
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ════════════════════════════
  //  Experience（experience/ 目录）
  // ════════════════════════════

  app.get("/api/agents/:id/experience", async (req, reply) => {
    const { id } = req.params;
    if (!validateId(id) || !agentExists(engine, id)) {
      reply.code(404);
      return { error: "agent not found" };
    }
    try {
      const expDir = path.join(agentDir(engine, id), "experience");
      if (!fsSync.existsSync(expDir)) return { content: "" };

      const files = (await fs.readdir(expDir)).filter((f) => f.endsWith(".md")).sort();
      if (files.length === 0) return { content: "" };

      const blocks = [];
      for (const file of files) {
        const category = file.replace(/\.md$/, "");
        const body = await fs.readFile(path.join(expDir, file), "utf-8");
        blocks.push(`# ${category}\n${body.trimEnd()}`);
      }
      return { content: blocks.join("\n\n") + "\n" };
    } catch (err) {
      if (err.code === "ENOENT") return { content: "" };
      reply.code(500);
      return { error: err.message };
    }
  });

  app.put("/api/agents/:id/experience", async (req, reply) => {
    const { id } = req.params;
    if (!validateId(id) || !agentExists(engine, id)) {
      reply.code(404);
      return { error: "agent not found" };
    }
    try {
      const { content } = req.body || {};
      if (typeof content !== "string") {
        reply.code(400);
        return { error: "content must be a string" };
      }

      const dir = agentDir(engine, id);
      const expDir = path.join(dir, "experience");
      const indexPath = path.join(dir, "experience.md");

      // 解析合并 markdown → 按 ^# 分割成分类
      const categories = new Map();
      let currentCat = null;
      const lines = content.split("\n");

      for (const line of lines) {
        const headingMatch = line.match(/^#\s+(.+)/);
        if (headingMatch) {
          currentCat = headingMatch[1].trim();
          if (!categories.has(currentCat)) categories.set(currentCat, []);
        } else if (currentCat !== null) {
          categories.get(currentCat).push(line);
        }
      }

      // 确保目录存在
      await fs.mkdir(expDir, { recursive: true });

      // 写入各分类文件
      const newFiles = new Set();
      for (const [cat, catLines] of categories) {
        const body = catLines.join("\n").trim();
        if (!body) continue;
        const filename = `${cat}.md`;
        newFiles.add(filename);
        await fs.writeFile(path.join(expDir, filename), body + "\n", "utf-8");
      }

      // 清除不再存在的旧文件
      try {
        const existing = await fs.readdir(expDir);
        for (const f of existing) {
          if (f.endsWith(".md") && !newFiles.has(f)) {
            await fs.unlink(path.join(expDir, f));
          }
        }
      } catch {}

      // 重建索引
      rebuildIndex(expDir, indexPath);

      if (isActiveAgent(engine, id)) await engine.updateConfig({});
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });
}
