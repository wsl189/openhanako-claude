/**
 * 配置管理 REST 路由
 */
import fs from "fs/promises";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { t } from "../i18n.js";
import { debugLog } from "../../lib/debug-log.js";
import { getRawConfig, getAllProviders, saveGlobalProviders, saveConfig, clearConfigCache } from "../../lib/memory/config-loader.js";
import { FactStore } from "../../lib/memory/fact-store.js";
import { getBuiltinExternalMcpServers, getBuiltinExternalMcpServerNames } from "../../core/builtin-mcp-servers.js";

function normalizeSandboxPatch(rawSandbox) {
  if (rawSandbox === undefined || rawSandbox === null) return null;
  if (typeof rawSandbox !== "boolean" && typeof rawSandbox !== "object") {
    throw new Error("sandbox must be an object");
  }
  return { mode: "full-access" };
}

function normalizeApiKey(value) {
  return String(value || "").replace(/[^\x20-\x7E]/g, "").trim();
}

function normalizeMcpServerKey(name) {
  return String(name || "").trim().replace(/[^A-Za-z0-9_]/g, "_");
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
  const mergedServers = {
    ...(globalServers && typeof globalServers === "object" ? globalServers : {}),
    ...(builtinServers && typeof builtinServers === "object" ? builtinServers : {}),
  };
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

function parseMcpHealthTimeoutMs() {
  const raw = Number.parseInt(process.env.HANAKO_MCP_HEALTH_TIMEOUT_MS || "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 8000;
}

function ensurePlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function stringifyError(error) {
  const message = String(error?.message || error || "health check failed").trim();
  return message || "health check failed";
}

async function withTimeout(taskPromise, timeoutMs, label) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(label));
    }, timeoutMs);
  });
  try {
    return await Promise.race([taskPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function buildStreamableTransport(server) {
  const headers = ensurePlainObject(server.headers) ? server.headers : undefined;
  const requestInit = headers ? { headers } : undefined;
  return new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit,
  });
}

function buildSseTransport(server) {
  const headers = ensurePlainObject(server.headers) ? server.headers : undefined;
  const requestInit = headers ? { headers } : undefined;
  const eventSourceInit = headers ? { headers } : undefined;
  return new SSEClientTransport(new URL(server.url), {
    requestInit,
    eventSourceInit,
  });
}

function buildStdioTransport(server) {
  return new StdioClientTransport({
    command: server.command,
    args: Array.isArray(server.args) ? server.args : [],
    env: ensurePlainObject(server.env) ? server.env : undefined,
    stderr: "pipe",
  });
}

async function connectMcpWithFallback(server, timeoutMs) {
  const attempts = [];
  const transportFactories = [];
  if (server.type === "stdio") {
    transportFactories.push(() => buildStdioTransport(server));
  } else if (server.type === "sse") {
    transportFactories.push(() => buildSseTransport(server));
    transportFactories.push(() => buildStreamableTransport(server));
  } else {
    transportFactories.push(() => buildStreamableTransport(server));
    transportFactories.push(() => buildSseTransport(server));
  }
  for (const createTransport of transportFactories) {
    const client = new Client({ name: "hanako-mcp-health-check", version: "1.0.0" });
    const transport = createTransport();
    try {
      await withTimeout(client.connect(transport), timeoutMs, "connect timeout");
      return { client, transport };
    } catch (error) {
      attempts.push(stringifyError(error));
      try { await transport.close(); } catch {}
    }
  }
  throw new Error(attempts.join(" | "));
}

async function checkSingleMcpServerHealth(serverName, server, timeoutMs) {
  const checkedAt = new Date().toISOString();
  const startAt = Date.now();
  if (server?.disabled) {
    return {
      status: "disabled",
      latencyMs: 0,
      checkedAt,
      type: server?.type || "stdio",
      message: "disabled",
    };
  }

  let transport = null;
  let client = null;
  try {
    const connected = await connectMcpWithFallback(server, timeoutMs);
    transport = connected.transport;
    client = connected.client;
    await withTimeout(client.ping(), timeoutMs, "ping timeout");
    return {
      status: "ok",
      latencyMs: Date.now() - startAt,
      checkedAt,
      type: server?.type || "stdio",
      message: "",
    };
  } catch (error) {
    return {
      status: "error",
      latencyMs: Date.now() - startAt,
      checkedAt,
      type: server?.type || "stdio",
      message: `${serverName}: ${stringifyError(error)}`,
    };
  } finally {
    try { await transport?.close?.(); } catch {}
    try { await client?.close?.(); } catch {}
  }
}

export default async function configRoute(app, { engine }) {

  // 读取配置（脱敏：隐藏 API key，附带 _raw 原始结构 + providers）
  app.get("/api/config", async (req, reply) => {
    try {
      const config = { ...engine.config };
      const raw = getRawConfig(engine.configPath) || {};
      promoteLegacyExternalMcpServers(engine, config, engine.configPath);

      // 脱敏 API key
      const mask = (key) => {
        if (!key || key.length < 8) return key ? "****" : "";
        return key.slice(0, 4) + "..." + key.slice(-4);
      };

      if (config.api) {
        config.api = { ...config.api, api_key: mask(config.api.api_key) };
      }
      if (config.embedding_api) {
        config.embedding_api = { ...config.embedding_api, api_key: mask(config.embedding_api.api_key) };
      }
      if (config.utility_api) {
        config.utility_api = { ...config.utility_api, api_key: mask(config.utility_api.api_key) };
      }
      if (config.search) {
        config.search = { ...config.search, api_key: mask(config.search?.api_key) };
      }

      // 附带原始配置结构（未经 fallback 解析，让前端知道用户显式设了什么）
      config._raw = {
        api: { provider: raw.api?.provider || "", base_url: raw.api?.base_url || "" },
        embedding_api: { provider: raw.embedding_api?.provider || "", base_url: raw.embedding_api?.base_url || "" },
        utility_api: { provider: raw.utility_api?.provider || "", base_url: raw.utility_api?.base_url || "" },
      };

      // 供应商列表（脱敏 api_key，附带 model_count）
      const providers = getAllProviders(engine.configPath);
      const maskedProviders = {};
      for (const [name, p] of Object.entries(providers)) {
        maskedProviders[name] = {
          base_url: p.base_url || "",
          api: p.api || "",
          api_key: mask(p.api_key),
          models: p.models || [],
          model_count: (p.models || []).length,
        };
      }
      config.providers = maskedProviders;

      // 注入全局设置（存于 preferences，跨 agent 共享）
      if (!config.desk) config.desk = {};
      config.desk.home_folder = engine.getHomeFolder() || "";
      // 过滤掉已被删除的工作目录
      if (Array.isArray(config.cwd_history)) {
        config.cwd_history = config.cwd_history.filter(p => existsSync(p));
      }
      config.thinking_level = engine.getThinkingLevel();
      const permissions = engine.getAgentPermissionConfig();
      config.sandbox = permissions.sandbox;
      config.tools = permissions.tools;
      config._toolCatalog = permissions.tool_catalog;
      injectGlobalMcpConfig(engine, config);
      const globalLocale = engine.getLocale();
      if (globalLocale) config.locale = globalLocale;
      const globalTz = engine.getTimezone();
      if (globalTz) config.timezone = globalTz;
      const globalUserName = engine.getUserName?.() || "";
      config.user = { ...(config.user || {}), name: globalUserName || config.user?.name || "" };

      return config;
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  app.post("/api/config/mcp/health", async (req, reply) => {
    try {
      const rawBody = ensurePlainObject(req.body) ? req.body : {};
      const incomingServers = ensurePlainObject(rawBody.servers) ? rawBody.servers : null;
      const sourceServers = incomingServers || engine.getExternalMcpServers?.() || {};
      const normalizedServers = {};

      for (const [rawName, rawServer] of Object.entries(sourceServers)) {
        const name = normalizeMcpServerKey(rawName);
        if (!name) continue;
        if (!ensurePlainObject(rawServer)) {
          normalizedServers[name] = {
            status: "error",
            latencyMs: 0,
            checkedAt: new Date().toISOString(),
            type: "stdio",
            message: `${name}: invalid MCP server config`,
          };
          continue;
        }
        try {
          normalizedServers[name] = normalizeExternalMcpServer(rawServer);
        } catch (error) {
          normalizedServers[name] = {
            status: "error",
            latencyMs: 0,
            checkedAt: new Date().toISOString(),
            type: String(rawServer.type || "stdio"),
            message: `${name}: ${stringifyError(error)}`,
          };
        }
      }

      const timeoutMs = parseMcpHealthTimeoutMs();
      const resultEntries = await Promise.all(Object.entries(normalizedServers).map(async ([serverName, server]) => {
        if (ensurePlainObject(server) && typeof server.status === "string" && server.status === "error") {
          return [serverName, server];
        }
        const health = await checkSingleMcpServerHealth(serverName, server, timeoutMs);
        return [serverName, health];
      }));

      const results = Object.fromEntries(resultEntries);
      return { ok: true, timeoutMs, results };
    } catch (error) {
      reply.code(500);
      return { error: stringifyError(error) };
    }
  });

  // 更新配置
  app.put("/api/config", async (req, reply) => {
    try {
      const partial = req.body;
      if (!partial || typeof partial !== "object") {
        reply.code(400);
        return { error: t("error.invalidJson") };
      }
      // ── 全局设置拦截：存 preferences / providers.yaml 而非 agent config ──
      let externalMcpChanged = false;

      // thinking_level → preference（跨 agent 共享）
      if (partial.thinking_level !== undefined) {
        engine.setThinkingLevel(partial.thinking_level);
        delete partial.thinking_level;
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

      // sandbox（per-agent）
      if (partial.sandbox !== undefined) {
        partial.sandbox = normalizeSandboxPatch(partial.sandbox);
      }

      if (partial.mcp !== undefined) {
        partial.mcp = normalizeMcpPatch(partial.mcp);
        externalMcpChanged = extractGlobalMcpPatch(engine, partial);
      }

      // providers 块 → 全局 providers.yaml
      let providersChanged = false;
      if (partial.providers) {
        // 清洗 API key（去掉输入法/复制带入的隐藏字符），避免测试通过但拉模型鉴权失败
        for (const providerPatch of Object.values(partial.providers)) {
          if (providerPatch && typeof providerPatch === "object" && typeof providerPatch.api_key === "string") {
            providerPatch.api_key = normalizeApiKey(providerPatch.api_key);
          }
        }

        // 删除 provider 时（值为 null），同步清理 models.json + favorites
        const deletedProviders = Object.keys(partial.providers)
          .filter(name => partial.providers[name] === null);
        if (deletedProviders.length > 0) {
          // 向后兼容：旧版本可能把 providers 存在 per-agent config.yaml，
          // 仅删除全局 providers.yaml 会被 getAllProviders() 从旧配置“读回来”。
          // 这里做“彻底删除”：清理当前 agent 以及所有 agent 的 legacy providers 残留。
          const legacyDeletes = {};
          for (const name of deletedProviders) legacyDeletes[name] = null;
          saveConfig(engine.configPath, { providers: legacyDeletes });
          try {
            const entries = await fs.readdir(engine.agentsDir, { withFileTypes: true });
            for (const entry of entries) {
              if (!entry.isDirectory()) continue;
              const cfgPath = path.join(engine.agentsDir, entry.name, "config.yaml");
              if (!existsSync(cfgPath) || cfgPath === engine.configPath) continue;
              try {
                saveConfig(cfgPath, { providers: legacyDeletes });
              } catch {}
            }
          } catch {}

          try {
            const modelsJsonPath = engine.modelsJsonPath;
            const modelsJson = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
            // 收集被删 provider 下的所有模型 ID
            const orphanedModels = new Set();
            const orphanedModelRefs = new Set();
            let changed = false;
            for (const name of deletedProviders) {
              const provData = modelsJson.providers?.[name];
              if (provData) {
                for (const m of (provData.models || [])) {
                  const id = typeof m === "string" ? m : m?.id;
                  if (!id) continue;
                  orphanedModels.add(id);
                  orphanedModelRefs.add(`${name}/${id}`);
                }
                delete modelsJson.providers[name];
                changed = true;
              }
            }
            if (changed) {
              writeFileSync(modelsJsonPath, JSON.stringify(modelsJson, null, 4) + "\n", "utf-8");
            }
            // 从 favorites 中移除已删 provider 的模型
            if (orphanedModels.size > 0) {
              const favorites = engine.readFavorites();
              const cleaned = favorites.filter(id => !orphanedModels.has(id) && !orphanedModelRefs.has(id));
              if (cleaned.length !== favorites.length) {
                await engine.saveFavorites(cleaned);
              }
            }
          } catch {}
        }
        saveGlobalProviders({ providers: partial.providers });
        delete partial.providers;
        providersChanged = true;
      }

      // 内联 API 凭证 → 全局 providers.yaml 对应条目
      const rawConfig = getRawConfig(engine.configPath) || {};
      for (const blockName of ["api", "embedding_api", "utility_api"]) {
        const block = partial[blockName];
        if (block?.api_key || block?.base_url) {
          const provName = typeof block.provider === "string" && block.provider.trim()
            ? block.provider.trim()
            : (rawConfig?.[blockName]?.provider || "").trim();
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

      // providers 变更后确保运行时刷新
      // 当同一请求同时提交 models 时，先应用完整 partial，避免先刷新再被模型配置覆盖。
      const needsModelSync = providersChanged && !partial.models;
      if (providersChanged && Object.keys(partial).length === 0) {
        clearConfigCache();
        await engine.updateConfig({});
        if (needsModelSync) {
          try { await engine.syncModelsAndRefresh(); } catch (e) {
            debugLog()?.warn("api", `syncModelsAndRefresh after provider change: ${e.message}`);
          }
        }
        return { ok: true };
      }

      if (Object.keys(partial).length === 0) {
        if (externalMcpChanged) {
          try { await engine.refreshCurrentSessionTools?.(); } catch (e) {
            debugLog()?.warn("api", `refresh tools after external MCP change: ${e.message}`);
          }
        }
        return { ok: true };
      }
      debugLog()?.log("api", `PUT /api/config keys=[${Object.keys(partial).join(",")}]`);
      if (providersChanged) clearConfigCache();
      await engine.updateConfig(partial);
      if (needsModelSync) {
        try { await engine.syncModelsAndRefresh(); } catch (e) {
          debugLog()?.warn("api", `syncModelsAndRefresh after config update: ${e.message}`);
        }
      }
      if (externalMcpChanged) {
        try { await engine.refreshCurrentSessionTools?.(); } catch (e) {
          debugLog()?.warn("api", `refresh tools after external MCP change: ${e.message}`);
        }
      }
      return { ok: true };
    } catch (err) {
      debugLog()?.error("api", `PUT /api/config failed: ${err.message}`);
      const msg = String(err?.message || "");
      if (msg.startsWith("sandbox.")) reply.code(400);
      else reply.code(500);
      return { error: err.message };
    }
  });

  // ── System Prompt（只读，供 DevTools 查看）──

  app.get("/api/system-prompt", async (req, reply) => {
    try {
      return { content: engine.agent.systemPrompt || "" };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 人格文件（ishiki.md）──

  // 读取 ishiki.md 内容
  app.get("/api/ishiki", async (req, reply) => {
    try {
      const ishikiPath = engine.agentDir + "/ishiki.md";
      const content = await fs.readFile(ishikiPath, "utf-8");
      return { content };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 保存 ishiki.md 内容，并触发 system prompt 重建
  app.put("/api/ishiki", async (req, reply) => {
    try {
      const { content } = req.body || {};
      if (typeof content !== "string") {
        reply.code(400);
        return { error: "content must be a string" };
      }
      const ishikiPath = engine.agentDir + "/ishiki.md";
      await fs.writeFile(ishikiPath, content, "utf-8");
      debugLog()?.log("api", `PUT /api/ishiki (saved, ${content.length} chars)`);
      // 触发 system prompt 重建（updateConfig 内部会重新读取 ishiki.md）
      await engine.updateConfig({});
      return { ok: true };
    } catch (err) {
      debugLog()?.error("api", `PUT /api/ishiki failed: ${err.message}`);
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 身份简介（identity.md）──

  app.get("/api/identity", async (req, reply) => {
    try {
      const identityPath = engine.agentDir + "/identity.md";
      const content = await fs.readFile(identityPath, "utf-8");
      return { content };
    } catch (err) {
      if (err.code === "ENOENT") return { content: "" };
      reply.code(500);
      return { error: err.message };
    }
  });

  app.put("/api/identity", async (req, reply) => {
    try {
      const { content } = req.body || {};
      if (typeof content !== "string") {
        reply.code(400);
        return { error: "content must be a string" };
      }
      const identityPath = engine.agentDir + "/identity.md";
      await fs.writeFile(identityPath, content, "utf-8");
      debugLog()?.log("api", `PUT /api/identity (saved, ${content.length} chars)`);
      await engine.updateConfig({});
      return { ok: true };
    } catch (err) {
      debugLog()?.error("api", `PUT /api/identity failed: ${err.message}`);
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 用户档案（user.md）──

  // 读取 user.md 内容
  app.get("/api/user-profile", async (req, reply) => {
    try {
      const userPath = engine.userDir + "/user.md";
      const content = await fs.readFile(userPath, "utf-8");
      return { content };
    } catch (err) {
      // 文件不存在时返回空字符串（user.md 是可选的）
      if (err.code === "ENOENT") return { content: "" };
      reply.code(500);
      return { error: err.message };
    }
  });

  // 保存 user.md 内容，并触发 system prompt 重建
  app.put("/api/user-profile", async (req, reply) => {
    try {
      const { content } = req.body || {};
      if (typeof content !== "string") {
        reply.code(400);
        return { error: "content must be a string" };
      }
      const userPath = engine.userDir + "/user.md";
      await fs.writeFile(userPath, content, "utf-8");
      debugLog()?.log("api", `PUT /api/user-profile (saved, ${content.length} chars)`);
      await engine.updateConfig({});
      return { ok: true };
    } catch (err) {
      debugLog()?.error("api", `PUT /api/user-profile failed: ${err.message}`);
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 置顶记忆（pinned.md）──

  // 读取 pinned.md，解析为逐条数组
  app.get("/api/pinned", async (req, reply) => {
    try {
      const pinnedPath = engine.agentDir + "/pinned.md";
      let content = "";
      try {
        content = await fs.readFile(pinnedPath, "utf-8");
      } catch (err) {
        if (err.code === "ENOENT") return { pins: [] };
        throw err;
      }
      const pins = content
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => line.replace(/^-\s*/, ""));
      return { pins };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 保存 pinned.md（覆盖写入），触发 system prompt 重建
  app.put("/api/pinned", async (req, reply) => {
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
      const pinnedPath = engine.agentDir + "/pinned.md";
      await fs.writeFile(pinnedPath, content, "utf-8");
      debugLog()?.log("api", `PUT /api/pinned (${pins.length} items)`);
      // 触发 system prompt 重建（updateConfig 内部会重新读取 pinned.md）
      await engine.updateConfig({});
      return { ok: true };
    } catch (err) {
      debugLog()?.error("api", `PUT /api/pinned failed: ${err.message}`);
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 记忆管理 ──

  /**
   * 获取指定 agent 的 FactStore。
   * 如果 agentId 就是当前 active agent，直接用 engine.factStore；
   * 否则临时打开那个 agent 的 facts.db。
   * 返回 { store, isTemp }，调用方用完 isTemp===true 的 store 需要 close。
   */
  function getStoreForAgent(agentId) {
    const activeId = path.basename(engine.agent.agentDir);
    if (!agentId || agentId === activeId) {
      return { store: engine.factStore, isTemp: false };
    }
    if (/[\/\\.]/.test(agentId)) {
      throw new Error("Invalid agent ID");
    }
    const dbPath = path.join(engine.agentsDir, agentId, "memory", "facts.db");
    try {
      const store = new FactStore(dbPath);
      return { store, isTemp: true };
    } catch (err) {
      throw new Error(`Cannot open fact DB for agent "${agentId}": ${err.message}`);
    }
  }

  // 获取所有元事实
  app.get("/api/memories", async (req, reply) => {
    let tempStore = null;
    try {
      const { store, isTemp } = getStoreForAgent(req.query.agentId);
      if (isTemp) tempStore = store;
      return { memories: store.exportAll() };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    } finally {
      tempStore?.close();
    }
  });

  // 读取编译后的 memory.md
  app.get("/api/memories/compiled", async (req, reply) => {
    try {
      const agentId = req.query.agentId;
      const activeId = path.basename(engine.agent.agentDir);
      const mdPath = (!agentId || agentId === activeId)
        ? engine.memoryMdPath
        : path.join(engine.agentsDir, agentId, "memory", "memory.md");
      const content = await fs.readFile(mdPath, "utf-8").catch(() => "");
      return { content };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 清除编译产物（today/week/longterm/facts/memory.md + fingerprints）
  app.delete("/api/memories/compiled", async (req, reply) => {
    try {
      const agentId = req.query.agentId;
      const activeId = path.basename(engine.agent.agentDir);
      const memDir = (!agentId || agentId === activeId)
        ? path.dirname(engine.memoryMdPath)
        : path.join(engine.agentsDir, agentId, "memory");
      const targets = ["memory.md", "today.md", "week.md", "longterm.md", "facts.md"];
      for (const f of targets) {
        const p = path.join(memDir, f);
        await fs.writeFile(p, "", "utf-8").catch(() => {});
        await fs.unlink(p + ".fingerprint").catch(() => {});
      }
      debugLog()?.log("api", `DELETE /api/memories/compiled agent=${agentId || activeId}`);
      if (!agentId || agentId === activeId) await engine.updateConfig({});
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 清除所有记忆（facts.db + memory.md）
  app.delete("/api/memories", async (req, reply) => {
    let tempStore = null;
    try {
      const agentId = req.query.agentId;
      const { store, isTemp } = getStoreForAgent(agentId);
      if (isTemp) tempStore = store;
      store.clearAll();
      const activeId = path.basename(engine.agent.agentDir);
      const mdPath = (!agentId || agentId === activeId)
        ? engine.memoryMdPath
        : path.join(engine.agentsDir, agentId, "memory", "memory.md");
      await fs.writeFile(mdPath, "", "utf-8");
      debugLog()?.log("api", `DELETE /api/memories agent=${agentId || activeId}`);
      if (!isTemp) await engine.updateConfig({});
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    } finally {
      tempStore?.close();
    }
  });

  // 导出记忆（JSON）
  app.get("/api/memories/export", async (req, reply) => {
    let tempStore = null;
    try {
      const { store, isTemp } = getStoreForAgent(req.query.agentId);
      if (isTemp) tempStore = store;
      return {
        version: 2,
        exportedAt: new Date().toISOString(),
        facts: store.exportAll(),
      };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    } finally {
      tempStore?.close();
    }
  });

  // 导入记忆（直接写入，无需 embedding）
  app.post("/api/memories/import", async (req, reply) => {
    let tempStore = null;
    try {
      const { facts, memories } = req.body || {};
      // 兼容 v1 导出格式（memories 字段）和 v2 格式（facts 字段）
      const entries = facts || memories;
      if (!Array.isArray(entries) || entries.length === 0) {
        reply.code(400);
        return { error: "facts must be a non-empty array" };
      }

      const importEntries = entries.map((e) => ({
        fact: e.fact || e.content || "",
        tags: e.tags || [],
        time: e.time || e.date || null,
        timeliness: e.timeliness || "persistent",
        state_key: e.state_key || null,
        ttl_days: e.ttl_days ?? null,
        valid_from: e.valid_from || null,
        valid_to: e.valid_to || null,
        session_id: e.session_id || "imported",
      }));

      const { store, isTemp } = getStoreForAgent(req.query.agentId);
      if (isTemp) tempStore = store;
      store.importAll(importEntries);
      debugLog()?.log("api", `POST /api/memories/import: ${importEntries.length} entries`);
      return { ok: true, imported: importEntries.length };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    } finally {
      tempStore?.close();
    }
  });

  // ── 全局 Favorites（跨 agent 共享的收藏模型列表）──

  app.get("/api/favorites", async (req, reply) => {
    try {
      return { favorites: engine.readFavorites() };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  app.put("/api/favorites", async (req, reply) => {
    try {
      const { favorites } = req.body || {};
      if (!Array.isArray(favorites)) {
        reply.code(400);
        return { error: "favorites must be an array" };
      }
      debugLog()?.log("api", `PUT /api/favorites (${favorites.length} items)`);
      await engine.saveFavorites(favorites);
      return { ok: true };
    } catch (err) {
      debugLog()?.error("api", `PUT /api/favorites failed: ${err.message}`);
      reply.code(500);
      return { error: err.message };
    }
  });

}
