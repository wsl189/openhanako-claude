/**
 * 供应商管理 REST 路由
 */
import { getAllProviders } from "../../lib/memory/config-loader.js";
import { buildProviderAuthHeaders } from "../../lib/llm/provider-client.js";

function maskKey(key) {
  if (!key || key.length < 8) return key ? "***" : "";
  return key.slice(0, 4) + "..." + key.slice(-4);
}

function isModelscopeTarget(name, baseUrl) {
  const lowerName = String(name || "").trim().toLowerCase();
  if (lowerName === "modelscope") return true;
  const lowerBase = String(baseUrl || "").trim().toLowerCase();
  return lowerBase.includes("api-inference.modelscope.cn");
}

function normalizeApiKey(value) {
  return String(value || "").replace(/[^\x20-\x7E]/g, "").trim();
}

function buildModelEndpointCandidates(baseUrl, api) {
  const normalized = String(baseUrl || "").replace(/\/+$/, "");
  const candidates = [];
  const push = (url) => {
    if (!url || candidates.includes(url)) return;
    candidates.push(url);
  };

  // Anthropic 网关常见形态：.../anthropic -> .../anthropic/v1/models
  if (api === "anthropic-messages" && /\/anthropic$/i.test(normalized)) {
    push(`${normalized}/v1/models`);
    push(`${normalized}/models`);
    return candidates;
  }

  push(`${normalized}/models`);
  // 对非 /v1 结尾的 base_url，额外尝试 /v1/models（很多服务是这个路径）
  if (!/\/v1$/i.test(normalized)) {
    push(`${normalized}/v1/models`);
  }
  return candidates;
}

export function buildAnthropicMessagesEndpoint(baseUrl) {
  const normalized = String(baseUrl || "")
    .replace(/\/+$/, "")
    .replace(/\/(v1\/)?messages$/i, "");
  if (!normalized) return "";
  return /\/v1$/i.test(normalized)
    ? `${normalized}/messages`
    : `${normalized}/v1/messages`;
}

export function isAnthropicProbeAuthenticated(status, bodyText = "") {
  if (status >= 200 && status < 300) return true;
  if (status === 401 || status === 403) return false;

  const body = String(bodyText || "").toLowerCase();
  const authError =
    /unauthori[sz]ed|authentication|permission denied/.test(body)
    || /(?:invalid|incorrect|missing|expired).{0,24}(?:api[_ -]?key|token)/.test(body)
    || /(?:api[_ -]?key|token).{0,24}(?:invalid|incorrect|missing|expired)/.test(body);
  if (authError) return false;

  // 400/422 from a Messages probe usually means the endpoint and key were accepted,
  // but the deliberately tiny probe body/model was rejected by validation.
  if (status === 400 || status === 422) return true;

  // Some compatible gateways report an unknown probe model as 404.
  if (status === 404 && /model/.test(body) && /not found|does not exist|unknown/.test(body)) {
    return true;
  }

  return false;
}

function normalizeRemoteModels(data) {
  const remoteList = Array.isArray(data?.data)
    ? data.data
    : (Array.isArray(data?.models) ? data.models : []);

  return remoteList
    .map((m) => ({
      id: m?.id || m?.name || "",
      name: m?.display_name || m?.name || m?.id || "",
      context: m?.context_length || m?.context_window || m?.max_context_length || null,
      maxOutput: m?.max_output_tokens || m?.max_completion_tokens || null,
    }))
    .filter((m) => m.id);
}

function summarizeBodyPreview(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 120)}...` : compact;
}

async function fetchModelsFromEndpoint(url, headers) {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  const raw = await res.text();
  const preview = summarizeBodyPreview(raw);

  if (!res.ok) {
    const suffix = preview ? ` | body: ${preview}` : "";
    return { ok: false, error: `HTTP ${res.status}: ${res.statusText} @ ${url}${suffix}`, models: [] };
  }

  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    const lower = preview.toLowerCase();
    const hint = lower.includes("<!doctype") || lower.includes("<html")
      ? " (HTML response, Base URL may point to website page instead of API endpoint)"
      : "";
    return { ok: false, error: `Non-JSON response @ ${url}${hint}`, models: [] };
  }

  const models = normalizeRemoteModels(data);
  if (models.length === 0) {
    return { ok: false, error: `Empty model list @ ${url}`, models: [] };
  }
  return { ok: true, models };
}

const MODELSCOPE_AUTH_PROBE_MODEL = "Qwen/Qwen-Image-2512";

export default async function providersRoute(app, { engine }) {

  // ── Provider Summary ──

  /**
   * 统一概览：合并 providers.yaml + OAuth status + favorites + SDK 模型
   * 前端新 ProvidersTab 的核心数据源
   */
  app.get("/api/providers/summary", async () => {
    const providers = getAllProviders(engine.configPath);

    // ProviderRegistry 作为 OAuth 判断的权威来源
    const provRegistry = engine.providerRegistry;

    // OAuth 白名单：authJsonKey 集合（auth.json 中的 key，如 minimax / openai-codex）
    const ALLOWED_OAUTH = provRegistry
      ? new Set(provRegistry.getOAuthProviderIds().map(id => provRegistry.getAuthJsonKey(id)))
      : new Set(["minimax", "openai-codex"]); // fallback

    // authJsonKey → registryId 映射（如 minimax → minimax-oauth）
    const authKeyToRegistryId = new Map();
    if (provRegistry) {
      for (const id of provRegistry.getOAuthProviderIds()) {
        const authKey = provRegistry.getAuthJsonKey(id);
        if (authKey !== id) authKeyToRegistryId.set(authKey, id);
      }
    }

    const favorites = engine.readFavorites();
    const favSet = new Set(favorites);

    // OAuth provider 登录状态（key 是 authJsonKey，如 minimax）
    const oauthProviders = engine.authStorage?.getOAuthProviders?.() || [];
    const oauthLoginMap = new Map();
    for (const p of oauthProviders) {
      const cred = engine.authStorage.get(p.id);
      oauthLoginMap.set(p.id, { name: p.name, loggedIn: cred?.type === "oauth" });
    }

    // OAuth 自定义模型
    const oauthCustom = engine.preferences.getOAuthCustomModels();

    // SDK 可用模型（含 OAuth 注入的）
    const sdkModels = engine.availableModels || [];
    const sdkByProvider = new Map();
    for (const m of sdkModels) {
      if (!sdkByProvider.has(m.provider)) sdkByProvider.set(m.provider, []);
      sdkByProvider.get(m.provider).push(m.id);
    }

    const result = {};

    // 判断 provider 是否为 OAuth 类型（优先用 ProviderRegistry，回退到 oauthLoginMap）
    function isOAuthProvider(name) {
      if (provRegistry) {
        // 直接匹配 registry ID（如 minimax-oauth）
        if (provRegistry.isOAuth(name)) return true;
        // 或者 name 是某个 OAuth provider 的 authJsonKey（如 minimax）
        const registryId = authKeyToRegistryId.get(name);
        if (registryId && provRegistry.isOAuth(registryId)) return true;
        return false;
      }
      return oauthLoginMap.has(name);
    }

    // 获取 OAuth 登录信息（oauthLoginMap 用 authJsonKey 索引）
    function getOAuthLoginInfo(name) {
      if (oauthLoginMap.has(name)) return oauthLoginMap.get(name);
      // name 可能是 registry ID（如 minimax-oauth），查对应的 authJsonKey
      if (provRegistry) {
        const authKey = provRegistry.getAuthJsonKey(name);
        if (authKey !== name && oauthLoginMap.has(authKey)) return oauthLoginMap.get(authKey);
      }
      return null;
    }

    // Coding Plan 判断（id 以 -coding 结尾的 provider）
    function isCodingPlan(name) {
      return name.endsWith("-coding");
    }

    // 先处理 providers.yaml 中的 provider（保持顺序）
    for (const [name, p] of Object.entries(providers)) {
      const isOAuth = isOAuthProvider(name);
      const oauthInfo = getOAuthLoginInfo(name);
      const registryEntry = provRegistry?.get(name) || null;
      const sdkIds = sdkByProvider.get(name) || [];
      // 合并：providers.yaml models + SDK 发现的模型
      const allModels = [...new Set([...(p.models || []), ...sdkIds])];
      const customModels = oauthCustom[name] || [];

      result[name] = {
        type: isOAuth ? "oauth" : "api-key",
        display_name: oauthInfo?.name || name,
        // providers.yaml 可能只存了 api_key，base_url/api 缺失时回填 ProviderRegistry 默认值
        base_url: p.base_url || registryEntry?.baseUrl || "",
        api: p.api || registryEntry?.api || "",
        api_key_masked: p.api_key ? maskKey(p.api_key) : "",
        models: allModels,
        custom_models: customModels,
        has_credentials: !!(p.api_key || (isOAuth && oauthInfo?.loggedIn)),
        logged_in: isOAuth ? !!oauthInfo?.loggedIn : undefined,
        supports_oauth: isOAuth && ALLOWED_OAUTH.has(name),
        is_coding_plan: isCodingPlan(name),
        can_delete: !isOAuth || Object.prototype.hasOwnProperty.call(providers, name),
      };
    }

    // 追加 OAuth-only provider（有 auth.json 但没在 providers.yaml 里）
    // 只暴露白名单内的，其他 coding plan 会封号
    for (const [id, info] of oauthLoginMap) {
      if (result[id]) continue;
      if (!ALLOWED_OAUTH.has(id)) continue;
      const sdkIds = sdkByProvider.get(id) || [];
      const customModels = oauthCustom[id] || [];
      result[id] = {
        type: "oauth",
        display_name: info.name || id,
        base_url: "",
        api: "",
        api_key_masked: "",
        models: sdkIds,
        custom_models: customModels,
        has_credentials: !!info.loggedIn,
        logged_in: !!info.loggedIn,
        supports_oauth: true,
        can_delete: false,
      };
    }

    // 追加 ProviderRegistry 中已声明但尚未出现的 provider（未配置状态）
    // 让用户在设置页看到所有可用供应商，点击即可配置
    if (provRegistry) {
      for (const [id, entry] of provRegistry.getAll()) {
        if (result[id]) continue;
        if (entry.authType === "oauth") continue; // OAuth provider 走上面的白名单逻辑
        const sdkIds = sdkByProvider.get(id) || [];
        result[id] = {
          type: "api-key",
          display_name: entry.displayName || id,
          base_url: entry.baseUrl || "",
          api: entry.api || "",
          api_key_masked: "",
          models: sdkIds,
          custom_models: [],
          has_credentials: false,
          logged_in: undefined,
          supports_oauth: false,
          is_coding_plan: isCodingPlan(id),
          can_delete: false,
        };
      }
    }

    return { providers: result, favorites };
  });

  // ── Fetch / Test ──

  function normalizeRegistryModels(models) {
    return models.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      context: model.contextWindow ?? model.context ?? null,
      maxOutput: model.maxOutputTokens ?? model.maxOutput ?? null,
    }));
  }

  /**
   * 从供应商的 /v1/models (OpenAI 兼容) 端点拉取模型列表
   * body: { name, base_url, api, api_key? }
   */
  app.post("/api/providers/fetch-models", async (req, reply) => {
    const { name, base_url, api: explicitApi, api_key } = req.body || {};
    if (!name && !base_url) {
      reply.code(400);
      return { error: "name or base_url is required" };
    }

    const providers = name ? getAllProviders(engine.configPath) : {};
    const savedProvider = name ? providers[name] || {} : {};
    const savedKey = normalizeApiKey(savedProvider.api_key || "");
    const effectiveBaseUrl = base_url || savedProvider.base_url || "";
    const effectiveApi = explicitApi || savedProvider.api || "";
    const hasExplicitRemoteConfig = !!(effectiveBaseUrl && effectiveApi && (api_key || savedKey));

    const oauthProviderIds = new Set(
      (engine.authStorage?.getOAuthProviders?.() || []).map((provider) => provider.id),
    );
    const isOAuthProvider = !!name && oauthProviderIds.has(name);

    if (isOAuthProvider && !hasExplicitRemoteConfig) {
      try {
        await engine.refreshAvailableModels();
        const registryModels = engine.availableModels.filter((model) => model.provider === name);
        if (registryModels.length > 0) {
          return { source: "registry", models: normalizeRegistryModels(registryModels) };
        }

        return {
          error: `Pi registry has no available models for provider "${name}" yet. Please finish login or re-login, then try again.`,
          models: [],
        };
      } catch (err) {
        return { error: err.message, models: [] };
      }
    }

    if (!effectiveBaseUrl) {
      reply.code(400);
      return { error: "base_url is required for remote model fetch" };
    }

    // 解析 api_key：显式传入 > providers 块 > auth.json OAuth token
    let key = normalizeApiKey(api_key || "");
    let api = explicitApi || "";
    if (!key && name) {
      key = savedKey;
      api = api || savedProvider.api || "";
    }
    // OAuth provider fallback：从 AuthStorage 获取 token
    if (!key && name) {
      try {
        key = normalizeApiKey(await engine.authStorage.getApiKey(name) || "");
      } catch {}
    }

    // Anthropic: 优先用注册表模型，其次尝试远端 /models，最后回退 ProviderRegistry builtinModels
    if (api === "anthropic-messages") {
      const registryModels = engine.modelRegistry
        ? engine.modelRegistry.getAll().filter((m) => m.provider === name)
        : [];
      if (registryModels.length > 0) {
        return { source: "registry", models: normalizeRegistryModels(registryModels) };
      }

      let remoteError = "";
      const headers = buildProviderAuthHeaders(api, key, { allowMissingApiKey: true });
      for (const remoteUrl of buildModelEndpointCandidates(effectiveBaseUrl, api)) {
        try {
          const remoteResult = await fetchModelsFromEndpoint(remoteUrl, headers);
          if (remoteResult.ok) {
            return { source: "remote", models: remoteResult.models };
          }
          remoteError = remoteResult.error;
        } catch (err) {
          remoteError = err.message;
        }
      }

      // fallback：从 ProviderRegistry 的 builtinModels 声明返回
      const provEntry = engine.providerRegistry?.get(name);
      if (provEntry?.builtinModels?.length > 0) {
        return {
          source: "builtin",
          models: provEntry.builtinModels.map(id => ({ id, name: id, context: null, maxOutput: null })),
        };
      }

      return { error: remoteError || "No built-in models found for this provider", models: [] };
    }

    try {
      let headers = { "Content-Type": "application/json" };
      if (key) {
        if (!api) {
          return { error: "api is required when api_key is present", models: [] };
        }
        headers = buildProviderAuthHeaders(api, key);
      }
      let lastError = "";
      for (const url of buildModelEndpointCandidates(effectiveBaseUrl, api)) {
        const result = await fetchModelsFromEndpoint(url, headers);
        if (result.ok) return { models: result.models };
        lastError = result.error;
      }
      return { error: lastError || "Failed to fetch models", models: [] };
    } catch (err) {
      return { error: err.message, models: [] };
    }
  });

  /**
   * 测试供应商连接
   * body: { name?, base_url?, api?, api_key? }
   */
  app.post("/api/providers/test", async (req, reply) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const { base_url } = req.body || {};
    let { api } = req.body || {};
    // 清洗 API key：去除非 ASCII 字符（防止粘贴时输入法带入中文）
    let api_key = normalizeApiKey(req.body?.api_key || "");

    const providers = name ? getAllProviders(engine.configPath) : {};
    const savedProvider = name ? providers[name] || {} : {};
    const effectiveBaseUrl = base_url || savedProvider.base_url || "";
    if (!api) api = savedProvider.api || "";
    if (!api_key) api_key = normalizeApiKey(savedProvider.api_key || "");
    if (!api_key && name) {
      try {
        api_key = normalizeApiKey(await engine.authStorage.getApiKey(name) || "");
      } catch {}
    }

    if (!effectiveBaseUrl) {
      reply.code(400);
      return { error: "base_url is required (or provide a configured provider name)" };
    }

    try {
      const normalizedBaseUrl = effectiveBaseUrl.replace(/\/+$/, "");

      // ModelScope 的 /models 对鉴权不敏感（无 key 也可能 200），
      // 这里改为真实鉴权探针：调用生图接口（异步模式，仅拿 task_id，不轮询下载）。
      if (isModelscopeTarget(name, normalizedBaseUrl)) {
        if (!api_key) {
          reply.code(400);
          return { ok: false, error: "api_key is required for ModelScope auth test" };
        }
        const headers = buildProviderAuthHeaders("openai-completions", api_key);
        const res = await fetch(normalizedBaseUrl + "/images/generations", {
          method: "POST",
          headers: {
            ...headers,
            "X-ModelScope-Async-Mode": "true",
          },
          body: JSON.stringify({
            model: MODELSCOPE_AUTH_PROBE_MODEL,
            prompt: "auth probe",
          }),
          signal: AbortSignal.timeout(10000),
        });
        // 401/403 = 鉴权失败；200 = 鉴权通过且接口可用
        const ok = res.status === 200;
        return { ok, status: res.status };
      }

      // Anthropic 格式没有 /models 端点，用最小化 messages 请求验证认证
      if (api === "anthropic-messages") {
        const headers = buildProviderAuthHeaders(api, api_key);
        const res = await fetch(buildAnthropicMessagesEndpoint(normalizedBaseUrl), {
          method: "POST",
          headers,
          body: JSON.stringify({ model: "test", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
          signal: AbortSignal.timeout(10000),
        });
        const raw = await res.text();
        const authOk = isAnthropicProbeAuthenticated(res.status, raw);
        return { ok: authOk, status: res.status };
      }

      let headers = {};
      if (api_key) {
        if (!api) {
          reply.code(400);
          return { error: "api is required when api_key is present" };
        }
        headers = buildProviderAuthHeaders(api, api_key);
      }
      let lastStatus = 0;
      let lastError = "";
      for (const url of buildModelEndpointCandidates(normalizedBaseUrl, api)) {
        const res = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(10000),
        });
        lastStatus = res.status;
        if (!res.ok) continue;

        const raw = await res.text();
        try {
          const data = raw ? JSON.parse(raw) : {};
          const hasList = Array.isArray(data?.data) || Array.isArray(data?.models);
          if (hasList) return { ok: true, status: res.status };
          lastError = "Model list response did not contain data/models array";
        } catch {
          lastError = "Non-JSON response from /models (check Base URL points to API endpoint)";
        }
      }
      return { ok: false, status: lastStatus || undefined, error: lastError || undefined };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}
