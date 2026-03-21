/**
 * delegate-tool.js — Sub-agent 委派工具
 *
 * 将独立子任务委派给隔离的 agent session 执行。
 * 子任务在独立上下文中运行，只返回最终结果，
 * 不占用主对话的上下文窗口。
 *
 * 底层复用 executeIsolated，并行由 PI SDK 的
 * 多 tool_call 机制自然支持。
 */

import { Type } from "@sinclair/typebox";
import { t, getLocale } from "../../server/i18n.js";

/** sub-agent 可用的 custom tools（只读/研究类） */
const DELEGATE_CUSTOM_TOOLS = [
  "search_memory", "recall_experience",
  "web_search", "web_fetch",
];

const DELEGATE_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

/** 注入到子任务 prompt 前的前导指令 */
function getDelegatePreamble() {
  const isZh = getLocale().startsWith("zh");
  if (isZh) {
    return "你现在是一个调研子任务。要求：\n" +
      "- 不需要 MOOD 区块\n" +
      "- 不需要寒暄，直接给结论\n" +
      "- 输出简洁、结构化，附上关键证据和来源\n" +
      "- 如果信息不足，明确说明缺什么\n\n" +
      "任务：\n";
  }
  return "You are a research sub-task. Requirements:\n" +
    "- No MOOD block\n" +
    "- No pleasantries — go straight to conclusions\n" +
    "- Output should be concise, structured, with key evidence and sources\n" +
    "- If information is insufficient, state clearly what is missing\n\n" +
    "Task:\n";
}

let activeCount = 0;
const MAX_CONCURRENT = 3;

/**
 * 创建 delegate 工具
 * @param {object} deps
 * @param {(prompt: string, opts: object) => Promise} deps.executeIsolated
 * @param {() => string|null} deps.resolveUtilityModel
 * @param {string[]} deps.readOnlyBuiltinTools
 * @returns {import('@mariozechner/pi-coding-agent').ToolDefinition}
 */
export function createDelegateTool(deps) {
  return {
    name: "delegate",
    label: t("toolDef.delegate.label"),
    description: t("toolDef.delegate.description"),
    parameters: Type.Object({
      task: Type.String({ description: t("toolDef.delegate.taskDesc") }),
      model: Type.Optional(Type.String({ description: t("toolDef.delegate.modelDesc") })),
    }),

    execute: async (_toolCallId, params, signal) => {
      if (activeCount >= MAX_CONCURRENT) {
        return {
          content: [{ type: "text", text: t("error.delegateMaxConcurrent", { max: MAX_CONCURRENT }) }],
        };
      }

      // 合并外部 signal 和超时 signal
      const timeoutSignal = AbortSignal.timeout(DELEGATE_TIMEOUT_MS);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      activeCount++;
      try {
        const result = await deps.executeIsolated(
          getDelegatePreamble() + params.task,
          {
            model: params.model || deps.resolveUtilityModel(),
            toolFilter: DELEGATE_CUSTOM_TOOLS,
            builtinFilter: deps.readOnlyBuiltinTools,
            signal: combinedSignal,
          },
        );

        if (result.error) {
          return {
            content: [{ type: "text", text: t("error.delegateFailed", { msg: result.error }) }],
          };
        }
        return {
          content: [{ type: "text", text: result.replyText || t("error.delegateNoOutput") }],
        };
      } finally {
        activeCount--;
      }
    },
  };
}
