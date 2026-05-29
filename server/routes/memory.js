import { MemoryService } from "../../lib/memory/memory-service.js";

function resolveService(engine, agentId = null) {
  const service = MemoryService.fromEngine(engine, agentId);
  return {
    service,
    close: () => {
      if (service?._isDetached) service.close();
    },
  };
}

function scheduleDetachedMemoryJobs(engine, agentId) {
  const targetAgentId = String(agentId || "").trim() || null;
  const timer = setTimeout(() => {
    const runner = MemoryService.fromEngine(engine, targetAgentId);
    Promise.resolve(runner.runJobs())
      .catch(() => {})
      .finally(() => {
        if (runner?._isDetached) runner.close();
      });
  }, 0);
  if (timer.unref) timer.unref();
}

function normalizeLegacyImportPayload(body = {}) {
  const payload = (body && typeof body === "object") ? body : {};
  if (
    Array.isArray(payload.evidence)
    || Array.isArray(payload.episodes)
    || Array.isArray(payload.playbooks)
    || Array.isArray(payload.marks)
    || payload.profile
    || payload.summary
    || payload.version
  ) {
    return payload;
  }
  const entries = Array.isArray(payload.facts) ? payload.facts : payload.memories;
  return Array.isArray(entries) ? { facts: entries } : payload;
}

export default async function memoryRoute(app, { engine }) {
  app.get("/api/memory/status", async (req, reply) => {
    const { service, close } = resolveService(engine, req.query.agentId);
    try {
      const targetAgent = req.query.agentId
        ? (engine.getAgent(req.query.agentId) || null)
        : engine.agent;
      const enabled = targetAgent?.memoryMasterEnabled ?? true;
      const needsUtilityModel = !targetAgent?.resolvedMemoryModel;
      return service.getStatus({ enabled, needsUtilityModel });
    } catch (error) {
      reply.code(500);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.get("/api/memory/profile", async (_req, reply) => {
    const { service, close } = resolveService(engine, engine.currentAgentId);
    try {
      return service.getProfile();
    } catch (error) {
      reply.code(500);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.get("/api/memory/profile/blocks", async (req, reply) => {
    const { service, close } = resolveService(engine, req.query.agentId || engine.currentAgentId);
    try {
      const blocks = service.getProfileBlocks({
        includePinned: req.query.includePinned !== "false",
        includeManualSupplement: true,
      });
      return {
        title: "Current Profile Blocks",
        content: service.renderProfilePrompt({ includePinned: req.query.includePinned !== "false" }),
        blocks,
      };
    } catch (error) {
      reply.code(500);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.put("/api/memory/profile", async (req, reply) => {
    const { service, close } = resolveService(engine, engine.currentAgentId);
    try {
      const { content } = req.body || {};
      if (typeof content !== "string") {
        reply.code(400);
        return { error: "content must be a string" };
      }
      return { ok: true, profile: service.upsertProfile(content) };
    } catch (error) {
      reply.code(500);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.get("/api/memory/marks", async (req, reply) => {
    const { service, close } = resolveService(engine, req.query.agentId);
    try {
      return { items: service.listMarks({ activeOnly: req.query.includeInactive !== "true" }) };
    } catch (error) {
      reply.code(500);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.post("/api/memory/marks", async (req, reply) => {
    const { service, close } = resolveService(engine, req.body?.agentId || engine.currentAgentId);
    try {
      const item = service.addMark(req.body || {});
      return { ok: true, item };
    } catch (error) {
      reply.code(400);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.put("/api/memory/marks", async (req, reply) => {
    reply.code(410);
    return { error: "whole-list mark replacement has been removed; use POST, PATCH, or /api/memory/archive" };
  });

  app.patch("/api/memory/marks", async (req, reply) => {
    const { service, close } = resolveService(engine, req.body?.agentId || engine.currentAgentId);
    try {
      const { id, ...patch } = req.body || {};
      if (!id) {
        reply.code(400);
        return { error: "id is required" };
      }
      return { ok: true, item: service.updateMark(id, patch) };
    } catch (error) {
      reply.code(400);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.get("/api/memory/summary", async (req, reply) => {
    const { service, close } = resolveService(engine, req.query.agentId);
    try {
      return service.getSummaryProjection();
    } catch (error) {
      reply.code(500);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.get("/api/memory/reflection", async (req, reply) => {
    const { service, close } = resolveService(engine, req.query.agentId);
    try {
      return service.getReflectionProjection();
    } catch (error) {
      reply.code(500);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.post("/api/memory/evidence-cleanup/run", async (req, reply) => {
    const { service, close } = resolveService(engine, req.body?.agentId || engine.currentAgentId);
    try {
      return service.runEvidenceCleanup({ trigger: "manual" });
    } catch (error) {
      reply.code(400);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.get("/api/memory/library", async (req, reply) => {
    const { service, close } = resolveService(engine, req.query.agentId);
    try {
      return service.getLibraryPage({
        layer: req.query.layer,
        cursor: req.query.cursor,
        limit: req.query.limit,
      });
    } catch (error) {
      reply.code(500);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.get("/api/memory/retrievals", async (req, reply) => {
    const { service, close } = resolveService(engine, req.query.agentId);
    try {
      return {
        items: service.listRetrievalLogs({
          limit: req.query.limit,
          layer: req.query.layer,
          query: req.query.query,
        }),
      };
    } catch (error) {
      reply.code(500);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.post("/api/memory/details", async (req, reply) => {
    const { service, close } = resolveService(engine, req.body?.agentId || engine.currentAgentId);
    try {
      const { id, layer } = req.body || {};
      if (!id) {
        reply.code(400);
        return { error: "id is required" };
      }
      return service.getDetails(id, layer);
    } catch (error) {
      reply.code(400);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.get("/api/memory/playbooks", async (req, reply) => {
    const { service, close } = resolveService(engine, req.query.agentId);
    try {
      return { items: service.listPlaybooks({ activeOnly: req.query.includeInactive !== "true" }) };
    } catch (error) {
      reply.code(500);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.post("/api/memory/playbooks", async (req, reply) => {
    const { service, close } = resolveService(engine, req.body?.agentId || engine.currentAgentId);
    try {
      return { ok: true, item: service.addPlaybook(req.body || {}) };
    } catch (error) {
      reply.code(400);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.put("/api/memory/playbooks", async (req, reply) => {
    reply.code(410);
    return { error: "whole-list playbook replacement has been removed; use POST, PATCH, or /api/memory/archive" };
  });

  app.patch("/api/memory/playbooks", async (req, reply) => {
    const { service, close } = resolveService(engine, req.body?.agentId || engine.currentAgentId);
    try {
      const { id, ...patch } = req.body || {};
      if (!id) {
        reply.code(400);
        return { error: "id is required" };
      }
      return { ok: true, item: service.updatePlaybook(id, patch) };
    } catch (error) {
      reply.code(400);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.post("/api/memory/archive", async (req, reply) => {
    const { service, close } = resolveService(engine, req.body?.agentId || engine.currentAgentId);
    try {
      const { ids } = req.body || {};
      if (!Array.isArray(ids)) {
        reply.code(400);
        return { error: "ids must be an array" };
      }
      return service.archive(ids);
    } catch (error) {
      reply.code(400);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.post("/api/memory/restore", async (req, reply) => {
    const { service, close } = resolveService(engine, req.body?.agentId || engine.currentAgentId);
    try {
      const { ids } = req.body || {};
      if (!Array.isArray(ids)) {
        reply.code(400);
        return { error: "ids must be an array" };
      }
      return service.restore(ids);
    } catch (error) {
      reply.code(400);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.post("/api/memory/remove", async (req, reply) => {
    const { service, close } = resolveService(engine, req.body?.agentId || engine.currentAgentId);
    try {
      const { ids } = req.body || {};
      if (!Array.isArray(ids)) {
        reply.code(400);
        return { error: "ids must be an array" };
      }
      return service.remove(ids);
    } catch (error) {
      reply.code(400);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.get("/api/memory/audit/:id", async (req, reply) => {
    const { service, close } = resolveService(engine, req.query.agentId);
    try {
      return service.getAuditTrace(req.params.id);
    } catch (error) {
      reply.code(400);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.get("/api/memory/export", async (req, reply) => {
    const { service, close } = resolveService(engine, req.query.agentId);
    try {
      return service.exportBundle();
    } catch (error) {
      reply.code(500);
      return { error: error.message };
    } finally {
      close();
    }
  });

  app.post("/api/memory/import", async (req, reply) => {
    const targetAgentId = req.query.agentId || req.body?.agentId;
    const { service, close } = resolveService(engine, targetAgentId);
    try {
      const result = service.importBundle(normalizeLegacyImportPayload(req.body || {}));
      if (result.queuedProfileImport && service?._isDetached) {
        scheduleDetachedMemoryJobs(engine, targetAgentId);
      }
      return { ok: true, ...result };
    } catch (error) {
      reply.code(400);
      return { error: error.message };
    } finally {
      close();
    }
  });
}
