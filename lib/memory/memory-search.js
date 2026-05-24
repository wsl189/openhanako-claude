/**
 * memory-search.js — search_memory 工具（v2 标签检索）
 *
 * 替代 v1 的 embedding KNN + 混合排序 + 链接展开。
 * v2 用标签匹配 + 日期过滤 + FTS5 全文搜索兜底。
 *
 * 标签由 LLM 在元事实拆分时生成，也由 LLM 在搜索时生成查询标签，
 * 两边的"语言习惯"天然接近，一致性有保障。
 */

import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";

function resolveForcedScope(params = {}, ctx = {}) {
  const requestedScope = typeof params?.scope === "string" ? params.scope : "auto";
  const executionMode = String(ctx?.executionMode || "").trim().toLowerCase();
  const memoryScope = String(ctx?.memoryScope || "").trim().toLowerCase();
  if (memoryScope === "channel" || executionMode === "channel") {
    return "channel";
  }
  return requestedScope || "auto";
}

/**
 * 创建 search_memory 工具定义
 * @param {import('./memory-service.js').MemoryService} memoryService
 * @param {object} [opts]
 * @param {function} [opts.getMemoryMasterEnabled] - 返回 agent 级别记忆总开关状态
 * @returns {object}
 */
export function createMemorySearchTool(memoryService, opts = {}) {
  return {
    name: "search_memory",
    label: t("error.memorySearchLabel"),
    description: t("error.memorySearchDesc"),
    parameters: Type.Object({
      query: Type.String({ description: t("error.memorySearchQueryDesc") }),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: t("error.memorySearchTagsDesc"),
        }),
      ),
      date_from: Type.Optional(
        Type.String({ description: t("error.memorySearchDateFromDesc") }),
      ),
      date_to: Type.Optional(
        Type.String({ description: t("error.memorySearchDateToDesc") }),
      ),
      intent: Type.Optional(
        Type.String({ description: "profile | state | decision | episode | playbook | auto" }),
      ),
      layers: Type.Optional(
        Type.String({ description: "facts | episodes | playbooks | auto" }),
      ),
      scope: Type.Optional(
        Type.String({ description: "agent | profile | channel | auto" }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _meta, ctx = {}) => {
      try {
        const t0 = performance.now();

        const hasFacts = Number(memoryService?.factStore?.size || 0) > 0;
        const hasNonFactSearch = typeof memoryService?.searchMemories === "function";
        if (!hasFacts && !hasNonFactSearch) {
          return {
            content: [{ type: "text", text: t("error.memorySearchEmpty") }],
            details: {},
          };
        }

        const dateRange = {};
        if (params.date_from) dateRange.from = params.date_from;
        if (params.date_to) dateRange.to = params.date_to + "T23:59";

        const resolvedScope = resolveForcedScope(params, ctx);
        const results = typeof memoryService.searchMemories === "function"
          ? memoryService.searchMemories({
            query: params.query,
            tags: params.tags || [],
            dateFrom: params.date_from || null,
            dateTo: params.date_to || null,
            intent: params.intent || "auto",
            layers: params.layers || "auto",
            scope: resolvedScope,
            limit: 15,
          })
          : memoryService.searchIndex({
            query: params.query,
            tags: params.tags || [],
            dateFrom: params.date_from || null,
            dateTo: params.date_to || null,
            intent: params.intent || "auto",
            scope: resolvedScope,
            limit: 15,
          });

        const elapsed = performance.now() - t0;
        console.log(
          `\x1b[90m[memory-search] ${elapsed.toFixed(0)}ms | ` +
          `hits: ${results.length}\x1b[0m`,
        );

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: t("error.memorySearchEmpty") }],
            details: {},
          };
        }

        // 格式化输出
        const lines = results.map((r, i) => {
          if (r.itemType === "playbook") {
            const timeStr = r.truthTime ? ` — recorded: ${r.truthTime}` : "";
            return `${i + 1}. ${r.preview} [playbook]${timeStr}`;
          }
          if (r.itemType === "episode") {
            const tags = Array.isArray(r.tags) && r.tags.length > 0 ? ` (${r.tags.join(", ")})` : "";
            const timeStr = r.truthTime ? ` — recorded: ${r.truthTime}` : "";
            return `${i + 1}. ${r.preview} [episode]${tags}${timeStr}`;
          }
          const tagsStr = Array.isArray(r.tags) && r.tags.length > 0 ? ` (${r.tags.join(", ")})` : "";
          const timelinessStr = r.timeliness ? ` [${r.timeliness}]` : "";
          const timeStr = r.time ? ` — recorded: ${r.time}` : "";
          const validToStr = r.valid_to ? ` — valid_to: ${r.valid_to}` : "";
          return `${i + 1}. ${r.fact}${timelinessStr}${tagsStr}${timeStr}${validToStr}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            resultCount: results.length,
            scope: resolvedScope,
            scopeLocked: resolvedScope === "channel" && (ctx?.memoryScope === "channel" || ctx?.executionMode === "channel"),
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: t("error.memorySearchError", { msg: err.message }) }],
          details: {},
        };
      }
    },
  };
}
