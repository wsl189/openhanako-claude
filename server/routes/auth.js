/**
 * OAuth 认证路由
 *
 * 支持两种 OAuth 流程：
 *   - 授权码流程 (Anthropic)：用户粘贴授权码
 *   - 设备码流程 (MiniMax)：服务端轮询，用户在浏览器授权
 *
 * 交互：
 *   1. POST /api/auth/oauth/start    → { sessionId, url, instructions? }
 *   2. POST /api/auth/oauth/callback → 提交授权码（授权码流程）
 *   3. GET  /api/auth/oauth/poll/:id → 轮询登录状态（设备码流程）
 */
import { OAuthFlowManager } from "../../core/oauth-flow-manager.js";
import { withRetry } from "../../lib/retry.js";

/** 依赖注入工厂 - 方便测试和降低耦合 */
export function createAuthHandler({ getHanakoHome, authStorage, preferences, syncModelsAndRefresh }) {
  const flowManager = new OAuthFlowManager(getHanakoHome());

  /**
   * 登录后同步模型（带重试）
   */
  async function postLoginSync() {
    try {
      await withRetry(() => syncModelsAndRefresh(), {
        maxRetries: 2,
        baseDelay: 500,
        timeout: 15_000,
        shouldRetry: (err) => {
          // 网络错误可重试，业务错误不重试
          const code = err?.code;
          return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND";
        },
      });
    } catch (err) {
      console.error("[auth] post-login model sync failed:", err.message);
    }
  }

  /** @type {Map<string, { resolveCode: Function, rejectCode: Function, loginPromise: Promise<any>, result: any }>} */
  const pendingFlows = new Map();

  return {
    flowManager,
    pendingFlows,

    /**
     * 启动 OAuth 登录
     * body: { provider }
     * → { sessionId, url, instructions? }
     */
    async start(req, reply) {
      const { provider } = req.body || {};
      if (!provider) {
        reply.code(400);
        return { error: "provider is required" };
      }

      // onAuth 回调收集 URL
      let resolveUrl, rejectUrl;
      const urlPromise = new Promise((resolve, reject) => {
        resolveUrl = resolve;
        rejectUrl = reject;
      });

      // onPrompt 回调等待用户粘贴授权码（仅授权码流程）
      let resolveCode, rejectCode;
      const codePromise = new Promise((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
      });

      let authInstructions = null;
      let usesCallbackServer = false;

      // 检查 provider 是否使用本地回调服务器（如 OpenAI Codex）
      const providerObj = authStorage.getOAuthProviders().find(p => p.id === provider);
      if (providerObj?.usesCallbackServer) usesCallbackServer = true;

      // 注册持久化流程
      const { sessionId } = flowManager.register(provider);

      // 启动 OAuth（不 await）
      const loginPromise = authStorage.login(provider, {
        onAuth: (info) => {
          if (usesCallbackServer) {
            authInstructions = null;
          } else {
            authInstructions = info.instructions || null;
          }
          resolveUrl(info.url);
        },
        onPrompt: () => codePromise,
      }).catch(err => {
        rejectUrl(err);
        throw err;
      });

      // 追踪 loginPromise 结果
      const flow = { resolveCode, rejectCode, loginPromise, result: null };
      loginPromise.then(() => {
        flow.result = { ok: true };
      }).catch(err => {
        flow.result = { ok: false, error: err.message };
      });

      try {
        const url = await urlPromise;
        pendingFlows.set(sessionId, flow);

        // 5 分钟超时
        const timer = setTimeout(() => {
          const f = pendingFlows.get(sessionId);
          if (f) {
            f.rejectCode(new Error("OAuth flow timed out"));
            pendingFlows.delete(sessionId);
            flowManager.complete(sessionId, "OAuth flow timed out");
          }
        }, 5 * 60 * 1000);
        timer.unref();

        const resp = { sessionId, url };
        if (authInstructions) resp.instructions = authInstructions;
        if (usesCallbackServer) resp.polling = true;
        return resp;
      } catch (err) {
        flowManager.remove(sessionId);
        reply.code(500);
        return { error: err.message };
      }
    },

    /**
     * 提交授权码（授权码流程）
     * body: { sessionId, code }
     */
    async callback(req, reply) {
      const { sessionId, code } = req.body || {};
      const flow = pendingFlows.get(sessionId);
      if (!flow) {
        reply.code(400);
        return { error: "No pending login flow" };
      }

      flow.resolveCode(code);

      try {
        await flow.loginPromise;
        pendingFlows.delete(sessionId);
        flowManager.complete(sessionId);
        await postLoginSync();
        return { ok: true };
      } catch (err) {
        pendingFlows.delete(sessionId);
        flowManager.complete(sessionId, err.message);
        reply.code(500);
        return { error: err.message };
      }
    },

    /**
     * 轮询登录状态（设备码流程）
     * → { status: "pending" | "done" | "error" | "timeout", error? }
     */
    async poll(req, reply) {
      const { sessionId } = req.params;
      const flowState = flowManager.getFlow(sessionId);

      if (!flowState) {
        reply.code(400);
        return { status: "error", error: "No pending login flow" };
      }

      const flow = pendingFlows.get(sessionId);

      if (flowState.status === "pending") {
        // 流程仍在进行中
        if (!flow?.result) {
          return { status: "pending" };
        }
        // 流程已有结果（登录完成或失败）
        pendingFlows.delete(sessionId);

        if (flow.result.ok) {
          flowManager.complete(sessionId);
          await postLoginSync();
          return { status: "done" };
        }
        flowManager.complete(sessionId, flow.result.error);
        return { status: "error", error: flow.result.error };
      }

      // 已结束（done/error/timeout）
      if (flow) pendingFlows.delete(sessionId);

      if (flowState.status === "done") {
        return { status: "done" };
      }

      if (flowState.status === "timeout") {
        return { status: "timeout", error: flowState.error };
      }

      return { status: "error", error: flowState.error || "Unknown error" };
    },

    /**
     * 查询 OAuth 提供商状态
     * → { anthropic: { name, loggedIn }, minimax: { name, loggedIn }, ... }
     */
    status() {
      const providers = authStorage.getOAuthProviders();
      const status = {};
      for (const p of providers) {
        const cred = authStorage.get(p.id);
        status[p.id] = {
          name: p.name,
          loggedIn: cred?.type === "oauth",
        };
      }
      return status;
    },

    /**
     * 登出
     * body: { provider }
     */
    logout(req, reply) {
      const { provider } = req.body || {};
      if (!provider) {
        reply.code(400);
        return { error: "provider is required" };
      }
      authStorage.logout(provider);
      return { ok: true };
    },

    // ── OAuth 自定义模型 ──

    /** 获取某个 OAuth provider 的自定义模型列表 */
    getCustomModels(req) {
      const custom = preferences.getOAuthCustomModels();
      return { models: custom[req.params.provider] || [] };
    },

    /** 添加自定义模型到 OAuth provider */
    async addCustomModel(req, reply) {
      const { provider } = req.params;
      const { modelId } = req.body || {};
      if (!modelId || typeof modelId !== "string" || !modelId.trim()) {
        reply.code(400);
        return { error: "modelId is required" };
      }
      const id = modelId.trim();
      const custom = preferences.getOAuthCustomModels();
      const list = custom[provider] || [];
      if (list.includes(id)) return { ok: true, models: list };
      list.push(id);
      preferences.setOAuthCustomModels(provider, list);
      await withRetry(() => syncModelsAndRefresh(), {
        maxRetries: 2,
        timeout: 15_000,
      });
      return { ok: true, models: list };
    },

    /** 删除 OAuth provider 的某个自定义模型 */
    async deleteCustomModel(req, reply) {
      const { provider, modelId } = req.params;
      const custom = preferences.getOAuthCustomModels();
      const list = (custom[provider] || []).filter(id => id !== modelId);
      preferences.setOAuthCustomModels(provider, list);
      await withRetry(() => syncModelsAndRefresh(), {
        maxRetries: 2,
        timeout: 15_000,
      });
      return { ok: true, models: list };
    },
  };
}

/**
 * 注册 auth 路由
 * @param {import('fastify').FastifyInstance} app
 * @param {{ engine: any }} opts
 */
export default async function authRoute(app, { engine }) {
  const handler = createAuthHandler({
    getHanakoHome: () => engine._hanakoHome,
    get authStorage() { return engine.authStorage; },
    get preferences() { return engine.preferences; },
    get syncModelsAndRefresh() { return () => engine.syncModelsAndRefresh(); },
  });

  app.post("/api/auth/oauth/start", async (req, reply) => handler.start(req, reply));

  app.post("/api/auth/oauth/callback", async (req, reply) => handler.callback(req, reply));

  app.get("/api/auth/oauth/poll/:sessionId", async (req, reply) => handler.poll(req, reply));

  app.get("/api/auth/oauth/status", async () => handler.status());

  app.post("/api/auth/oauth/logout", async (req, reply) => handler.logout(req, reply));

  // ── OAuth 自定义模型 ──

  app.get("/api/auth/oauth/:provider/custom-models", async (req) => handler.getCustomModels(req));

  app.post("/api/auth/oauth/:provider/custom-models", async (req, reply) => handler.addCustomModel(req, reply));

  app.delete("/api/auth/oauth/:provider/custom-models/:modelId", async (req, reply) =>
    handler.deleteCustomModel(req, reply)
  );
}
