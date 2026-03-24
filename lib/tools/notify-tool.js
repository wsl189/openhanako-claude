/**
 * notify-tool.js — 桌面通知工具
 *
 * 让 agent 能主动向用户发送系统通知（macOS 桌面弹窗）。
 * 仅在用户明确要求提醒/通知时使用，普通任务完成不调用。
 */

import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";

/**
 * @param {{ onNotify: (title: string, body: string, opts?: { target?: "local"|"platform"|"auto" }) => Promise<object|void> | object | void }} opts
 */
export function createNotifyTool({ onNotify }) {
  return {
    name: "notify",
    label: t("toolDef.notify.label"),
    description: t("toolDef.notify.description"),
    parameters: Type.Object({
      title: Type.String({ description: t("toolDef.notify.titleDesc") }),
      body: Type.String({ description: t("toolDef.notify.bodyDesc") }),
      target: Type.Optional(Type.Union([
        Type.Literal("local"),
        Type.Literal("platform"),
        Type.Literal("auto"),
      ], { description: "提醒发送目标：local（本地弹窗）| platform（平台私聊）| auto（优先平台）" })),
    }),
    execute: async (_toolCallId, params) => {
      const { title, body } = params;
      const rawTarget = String(params?.target || "auto").toLowerCase();
      const target = (rawTarget === "local" || rawTarget === "platform" || rawTarget === "auto")
        ? rawTarget
        : "auto";
      try {
        const result = await onNotify?.(title, body, { target });
        return {
          content: [{ type: "text", text: t("error.notifySent", { title }) }],
          details: {
            title,
            body,
            target,
            sent: true,
            ...(result && typeof result === "object" ? result : {}),
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: t("error.notifyFailed", { msg: err.message }) }],
          details: { title, body, target, sent: false, error: err.message },
        };
      }
    },
  };
}
