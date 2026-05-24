/**
 * experience.js — recall_experience / record_experience 工具
 *
 * v4 起经验以结构化 playbook 存在 DB 中，兼容 markdown 文件仅作为投影视图。
 */

import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";

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
    }),
    execute: async (_toolCallId, params) => {
      const category = params.category?.trim();
      const all = memoryService.listPlaybooks({ activeOnly: true });
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
        details: { category: category || null, count: rows.length },
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
      trigger: Type.String({
        description: "When should this playbook be used.",
      }),
      wrong_path: Type.String({
        description: "What wrong approach should be avoided.",
      }),
      root_cause: Type.String({
        description: "What underlying cause explains the issue.",
      }),
      fix_steps: Type.String({
        description: "Concrete steps to apply next time.",
      }),
      validation: Type.String({
        description: "How to verify the fix worked.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const playbook = memoryService.addPlaybook({
          category: params.category,
          trigger: params.trigger,
          wrong_path: params.wrong_path,
          root_cause: params.root_cause,
          fix_steps: params.fix_steps,
          validation: params.validation,
        });
        return {
          content: [{ type: "text", text: t("error.expRecorded", { category: playbook.category || "General", content: playbook.trigger }) }],
          details: {
            id: playbook.id,
            category: playbook.category,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error?.message || error || t("error.expEmptyInput")) }],
          details: {},
        };
      }
    },
  };

  return [recallTool, recordTool];
}
