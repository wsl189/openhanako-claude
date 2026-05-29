/**
 * pinned-memory.js — pin_memory / unpin_memory 自定义工具
 *
 * 让 agent 通过工具调用来管理置顶记忆，替代之前在 yuan.md 中
 * 指导 agent 手动 read→append→write pinned.md 的方式。
 */

import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";
import { scrubPII } from "../pii-guard.js";

/**
 * 创建 pin_memory + unpin_memory 工具
 * @param {import('../memory/memory-service.js').MemoryService} memoryService
 * @returns {[object, object]}
 */
export function createPinnedMemoryTools(memoryService) {
  const pinTool = {
    name: "pin_memory",
    label: t("toolDef.pinnedMemory.pinLabel"),
    description: t("toolDef.pinnedMemory.pinDescription"),
    parameters: Type.Object({
      content: Type.String({ description: t("toolDef.pinnedMemory.pinContentDesc") }),
    }),
    execute: async (_toolCallId, params) => {
      const { cleaned, detected } = scrubPII(params.content);
      if (detected.length > 0) {
        console.warn(`[pin_memory] PII detected (${detected.join(", ")}), redacted before storage`);
      }

      const content = cleaned.trim();
      if (!content) {
        return {
          content: [{ type: "text", text: t("error.pinnedEmptyInput") }],
          details: {},
        };
      }
      const existing = memoryService.listMarks({ activeOnly: true });
      if (existing.some((item) => item.text === content)) {
        return {
          content: [{ type: "text", text: t("error.pinnedAlreadyExists") }],
          details: {},
        };
      }
      memoryService.addMark({ text: content });

      return {
        content: [{ type: "text", text: t("error.pinnedAdded", { content }) }],
        details: {},
      };
    },
  };

  const unpinTool = {
    name: "unpin_memory",
    label: t("toolDef.pinnedMemory.unpinLabel"),
    description: t("toolDef.pinnedMemory.unpinDescription"),
    parameters: Type.Object({
      keyword: Type.String({ description: t("toolDef.pinnedMemory.unpinKeywordDesc") }),
    }),
    execute: async (_toolCallId, params) => {
      const existing = memoryService.listMarks({ activeOnly: true });
      if (existing.length === 0) {
        return {
          content: [{ type: "text", text: t("error.pinnedEmpty") }],
          details: {},
        };
      }
      const removed = existing.filter((item) => item.text.toLowerCase().includes(params.keyword.toLowerCase()));

      if (removed.length === 0) {
        return {
          content: [{ type: "text", text: t("error.pinnedNotFound", { keyword: params.keyword }) }],
          details: {},
        };
      }
      memoryService.archive(removed.map((item) => `mark:${item.id}`));

      return {
        content: [{ type: "text", text: t("error.pinnedRemoved", { count: removed.length, items: removed.map((item) => item.text).join(", ") }) }],
        details: { removedCount: removed.length },
      };
    },
  };

  return [pinTool, unpinTool];
}
