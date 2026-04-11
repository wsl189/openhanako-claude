/**
 * 模型管理 REST 路由
 */
import { t } from "../i18n.js";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const _knownModels = _require("../../lib/known-models.json");

function isModelSwitchConflict(err) {
  const message = String(err?.message || "");
  return message === t("error.modelSwitchBusy")
    || message.includes("already running a turn")
    || message.includes("already compacting");
}

function supportsXhigh(model) {
  if (!model || typeof model !== "object") return false;
  if (model.xhigh === true || model.supportsXhigh === true) return true;
  const id = String(model.id || "").toLowerCase();
  return id.includes("opus-4-6") || id.includes("gpt-5.4") || id.includes("gpt-5.3-codex") || id.includes("gpt-5.2");
}

/** 查询模型显示名：overrides > SDK name > known-models > id */
function resolveModelName(id, sdkName, overrides) {
  if (overrides?.[id]?.displayName) return overrides[id].displayName;
  if (sdkName && sdkName !== id) return sdkName;
  if (_knownModels[id]?.name) return _knownModels[id].name;
  return sdkName || id;
}

function resolveModelRef(modelRef, availableModels, modelCatalog) {
  const ref = String(modelRef || "").trim();
  if (!ref) return null;

  const direct = availableModels.find((model) => {
    if (model.id === ref) return true;
    return !!(model.provider && `${model.provider}/${model.id}` === ref);
  });
  if (direct) return direct;

  const entry = modelCatalog?.resolve?.(ref);
  if (!entry) return null;

  return (
    availableModels.find((model) => model.id === entry.modelId && model.provider === entry.providerId)
    || modelCatalog.toSdkEntry(entry)
  );
}

function isCurrentModelRef(modelRef, currentModel, modelCatalog) {
  if (!currentModel) return false;
  const ref = String(modelRef || "").trim();
  if (!ref) return false;

  if (ref === currentModel.id) return true;
  if (currentModel.provider && ref === `${currentModel.provider}/${currentModel.id}`) return true;

  const currentKey = currentModel.provider
    ? `${currentModel.provider}/${currentModel.id}`
    : currentModel.id;
  const currentEntry = modelCatalog?.resolve?.(currentKey);
  const refEntry = modelCatalog?.resolve?.(ref);
  return !!(currentEntry && refEntry && currentEntry.key === refEntry.key);
}

export default async function modelsRoute(app, { engine }) {
  const modelCatalog = engine._models?.modelCatalog || null;

  // 列出可用模型
  app.get("/api/models", async (req, reply) => {
    try {
      const overrides = engine.config?.models?.overrides;
      const models = engine.availableModels.map(m => ({
        id: m.id,
        name: resolveModelName(m.id, m.name, overrides),
        provider: m.provider,
        isCurrent: isCurrentModelRef(m.provider ? `${m.provider}/${m.id}` : m.id, engine.currentModel, modelCatalog),
      }));
      return {
        models,
        current: engine.currentModel
          ? (engine.currentModel.provider ? `${engine.currentModel.provider}/${engine.currentModel.id}` : engine.currentModel.id)
          : null,
      };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 收藏模型列表（给聊天页面用，直接读 favorites，和设置页同源）
  app.get("/api/models/favorites", async (req, reply) => {
    try {
      const favorites = engine.readFavorites();
      const available = engine.availableModels;

      const overrides = engine.config?.models?.overrides;
      const result = favorites.map(id => {
        const m = resolveModelRef(id, available, modelCatalog);
        return {
          id,
          name: resolveModelName(id, m?.name, overrides),
          provider: m?.provider || "",
          isCurrent: isCurrentModelRef(id, engine.currentModel, modelCatalog),
          reasoning: m ? !!m.reasoning : false,
          xhigh: m ? supportsXhigh(m) : false,
        };
      });

      const current = favorites.find((id) => isCurrentModelRef(id, engine.currentModel, modelCatalog))
        || (engine.currentModel
          ? (engine.currentModel.provider ? `${engine.currentModel.provider}/${engine.currentModel.id}` : engine.currentModel.id)
          : null);

      return {
        models: result,
        current,
        hasFavorites: favorites.length > 0,
      };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });


  // 健康检测：发一个最小请求测试模型连通性
  app.post("/api/models/health", async (req, reply) => {
    try {
      const { modelId } = req.body || {};
      if (!modelId) { reply.code(400); return { error: "modelId required" }; }

      const model = engine.availableModels.find(m => m.id === modelId);
      if (!model) { reply.code(404); return { error: `model "${modelId}" not found` }; }

      // 凭证解析：providers.yaml → auth.json OAuth（含 resourceUrl）→ 模型对象自带 baseUrl
      const creds = engine._resolveProviderCredentials(model.provider);

      // OAuth provider 可能有 resourceUrl（实际使用的域名，可能和内置不同）
      const oauthCred = engine.authStorage.get(model.provider);
      const oauthBaseUrl = oauthCred?.type === "oauth" ? oauthCred.resourceUrl : "";

      const baseUrl = creds.base_url || oauthBaseUrl || model.baseUrl || "";
      if (!baseUrl) return { ok: false, error: "no base_url" };

      let apiKey = creds.api_key;
      if (!apiKey) {
        try { apiKey = await engine.authStorage.getApiKey(model.provider); } catch {}
      }
      if (!apiKey) return { ok: false, error: "no api_key" };

      const { buildProviderAuthHeaders } = await import("../../lib/llm/provider-client.js");
      const api = creds.api || model.api || "openai-completions";

      // Anthropic 兼容 API：发最小 messages 请求
      if (api === "anthropic-messages") {
        const url = baseUrl.replace(/\/+$/, "") + "/v1/messages";
        const headers = buildProviderAuthHeaders(api, apiKey);
        const res = await fetch(url, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: "user", content: "." }] }),
          signal: AbortSignal.timeout(10000),
        });
        // 200 或 400（参数错误但连通）都算健康
        return { ok: res.ok || res.status === 400, status: res.status, provider: model.provider };
      }

      // OpenAI Codex Responses API：无法通过简单请求检测（Cloudflare 反爬），跳过
      if (api === "openai-codex-responses") {
        return { ok: true, status: 0, provider: model.provider, skipped: t("error.codexNoHealthCheck") };
      }

      // OpenAI 兼容 API：用 /models 端点
      const url = baseUrl.replace(/\/+$/, "") + "/models";
      const headers = buildProviderAuthHeaders(api, apiKey);
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      return { ok: res.ok, status: res.status, provider: model.provider };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 切换模型
  app.post("/api/models/set", async (req, reply) => {
    try {
      const { modelId } = req.body || {};
      if (!modelId) {
        reply.code(400);
        return { error: t("error.missingParam", { param: "modelId" }) };
      }
      await engine.setModel(modelId);
      return { ok: true, model: engine.currentModel?.name };
    } catch (err) {
      reply.code(isModelSwitchConflict(err) ? 409 : 500);
      return { error: err.message };
    }
  });
}
