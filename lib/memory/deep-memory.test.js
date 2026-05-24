import { describe, expect, it, vi } from "vitest";
import { processDirtySessions } from "./deep-memory.js";

describe("deep-memory evidence gating", () => {
  it("does not mark dirty sessions as processed when evidence is missing", async () => {
    const markProcessed = vi.fn();
    const summaryManager = {
      getDirtySessions: () => [{
        session_id: "session-no-evidence",
        summary: "anchor",
        updated_at: "2026-05-23T10:00:00.000Z",
        created_at: "2026-05-23T10:00:00.000Z",
        snapshot_at: "2026-05-23T10:00:00.000Z",
      }],
      markProcessed,
    };
    const memoryService = {
      listEvidenceBySession: vi.fn(() => []),
      logDiagnostic: vi.fn(),
    };

    const result = await processDirtySessions(summaryManager, memoryService, {
      model: "mock-model",
      api: "mock-api",
      api_key: "mock-key",
      base_url: "https://example.test",
    });

    expect(result).toEqual({ processed: 1, factsAdded: 0 });
    expect(markProcessed).not.toHaveBeenCalled();
    expect(memoryService.logDiagnostic).toHaveBeenCalledWith(
      "missing_evidence_for_dirty_session",
      expect.objectContaining({ sessionId: "session-no-evidence" }),
    );
  });
});
