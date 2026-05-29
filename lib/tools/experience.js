/**
 * experience.js — recall_experience / record_experience 工具
 *
 * v4 起经验以结构化 playbook 存在 DB 中，兼容 markdown 文件仅作为投影视图。
 */

import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";

function resolveExperienceScope(params = {}, ctx = {}) {
  const executionMode = String(ctx?.executionMode || "").trim().toLowerCase();
  const memoryScope = String(ctx?.memoryScope || "").trim().toLowerCase();
  if (memoryScope === "channel" || executionMode === "channel") return "channel";
  const requested = String(params?.scope || "").trim().toLowerCase();
  if (requested === "channel" || requested === "agent" || requested === "auto") return requested;
  return "agent";
}

function formatPlaybookList(playbooks) {
  return playbooks.map((item, index) => {
    const lines = [
      `${index + 1}. ${item.trigger}`,
      `   wrong_path: ${item.wrongPath}`,
      `   root_cause: ${item.rootCause}`,
      `   fix_steps: ${item.fixSteps}`,
      `   validation: ${item.validation}`,
    ];
    if (item.category) lines.splice(1, 0, `   category: ${item.category}`);
    return lines.join("\n");
  }).join("\n\n");
}

/**
 * 创建 recall_experience + record_experience 工具
 * @param {import('../memory/memory-service.js').MemoryService} memoryService
 * @returns {object[]}
 */
export function createExperienceTools(memoryService) {
  const recallTool = {
    name: "recall_experience",
    label: t("toolDef.experience.recallLabel"),
    description: t("toolDef.experience.recallDescription"),
    parameters: Type.Object({
      category: Type.Optional(
        Type.String({ description: t("toolDef.experience.recallCategoryDesc") }),
      ),
      scope: Type.Optional(
        Type.String({ description: t("toolDef.experience.scopeDesc") }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _meta, ctx = {}) => {
      const category = params.category?.trim();
      const scope = resolveExperienceScope(params, ctx);
      const all = memoryService.listPlaybooks({ activeOnly: true, scope });
      const rows = category ? all.filter((item) => item.category === category) : all;

      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: category ? t("error.expCategoryNotFound", { category }) : t("error.expEmpty") }],
          details: {},
        };
      }

      const grouped = category
        ? `# ${category}\n\n${formatPlaybookList(rows)}`
        : rows.reduce((blocks, item) => {
          const key = item.category || "General";
          if (!blocks.has(key)) blocks.set(key, []);
          blocks.get(key).push(item);
          return blocks;
        }, new Map());

      const text = typeof grouped === "string"
        ? grouped
        : [...grouped.entries()].map(([name, items]) => `# ${name}\n\n${formatPlaybookList(items)}`).join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: { category: category || null, count: rows.length, scope },
      };
    },
  };

  const recordTool = {
    name: "record_experience",
    label: t("toolDef.experience.recordLabel"),
    description: t("toolDef.experience.recordDescription"),
    parameters: Type.Object({
      category: Type.Optional(Type.String({
        description: t("toolDef.experience.recordCategoryDesc"),
      })),
      scope: Type.Optional(Type.String({
        description: t("toolDef.experience.scopeDesc"),
      })),
      trigger: Type.String({
        description: t("toolDef.experience.recordTriggerDesc"),
      }),
      wrong_path: Type.String({
        description: t("toolDef.experience.recordWrongPathDesc"),
      }),
      root_cause: Type.String({
        description: t("toolDef.experience.recordRootCauseDesc"),
      }),
      fix_steps: Type.String({
        description: t("toolDef.experience.recordFixStepsDesc"),
      }),
      validation: Type.String({
        description: t("toolDef.experience.recordValidationDesc"),
      }),
    }),
    execute: async (_toolCallId, params, _signal, _meta, ctx = {}) => {
      try {
        const scope = resolveExperienceScope(params, ctx);
        const playbook = memoryService.addPlaybook({
          category: params.category,
          trigger: params.trigger,
          wrong_path: params.wrong_path,
          root_cause: params.root_cause,
          fix_steps: params.fix_steps,
          validation: params.validation,
          scope: scope === "auto" ? "agent" : scope,
          origin: scope === "channel" ? "channel" : "assistant",
        });
        return {
          content: [{ type: "text", text: t("error.expRecorded", { category: playbook.category || "General", content: playbook.trigger }) }],
          details: {
            id: playbook.id,
            category: playbook.category,
            scope: playbook.scope,
          },
        };
      } catch (error) {
        const rawMessage = String(error?.message || error || "");
        const message = rawMessage.includes("playbook missing required fields")
          ? t("error.expEmptyInput")
          : (rawMessage || t("error.expEmptyInput"));
        return {
          content: [{ type: "text", text: message }],
          details: {},
        };
      }
    },
  };

  return [recallTool, recordTool];
}
