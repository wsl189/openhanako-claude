/**
 * notify-tool.js — 桌面通知工具
 *
 * 让 agent 能主动向用户发送系统通知（macOS 桌面弹窗）。
 * 仅在用户明确要求提醒/通知时使用，普通任务完成不调用。
 */

import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";

function isActivitySession(ctx) {
  const sessionPath = String(ctx?.sessionManager?.getSessionFile?.() || "").trim();
  return /[\\/]activity[\\/]/i.test(sessionPath);
}

function shouldSuppressNoActionNotify(title, body, ctx) {
  if (!isActivitySession(ctx)) return false;
  const text = `${String(title || "")}\n${String(body || "")}`.toLowerCase();
  if (!text.trim()) return false;

  const hasAllClear = /一切正常|无异常|没有异常|未发现异常|系统运行正常|all clear|no (issues?|anomal(?:y|ies)|abnormalit(?:y|ies))|everything (looks )?(normal|fine)/i.test(text);
  const hasNoAction = /无需(处理|操作)|no action needed|nothing (to do|requires action)/i.test(text);
  const hasIncident = /异常|告警|警报|错误|失败|故障|风险|中断|down|incident|outage|failed|failure|error|critical|urgent|warn(?:ing)?|alert/i.test(text);

  return hasAllClear || (hasNoAction && !hasIncident);
}

/**
 * @param {{ onNotify: (title: string, body: string, opts?: { target?: "local"|"platform", platform?: "wechat"|"telegram"|"feishu"|"qq"|null, strict?: boolean }) => Promise<object|void> | object | void }} opts
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
      ], { description: "提醒发送目标：local（本地弹窗）| platform（平台私聊）" })),
      platform: Type.Optional(Type.Union([
        Type.Literal("wechat"),
        Type.Literal("telegram"),
        Type.Literal("feishu"),
        Type.Literal("qq"),
      ], { description: "指定发送平台。设置后将优先（或仅）发送到该平台。" })),
      strict: Type.Optional(Type.Boolean({ description: "当指定平台发送失败时，true=不回退本地弹窗并直接报错；false=允许回退策略。" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const { title, body } = params;
      const rawTarget = String(params?.target || "").toLowerCase();
      const rawPlatform = String(params?.platform || "").trim().toLowerCase();
      const platform = (rawPlatform === "wechat" || rawPlatform === "telegram" || rawPlatform === "feishu" || rawPlatform === "qq")
        ? rawPlatform
        : null;
      const targetFallback = platform ? "platform" : "local";
      const target = (rawTarget === "local" || rawTarget === "platform")
        ? rawTarget
        : targetFallback;
      const strict = params?.strict === true || (!!platform && params?.strict !== false);
      if (shouldSuppressNoActionNotify(title, body, ctx)) {
        return {
          content: [{ type: "text", text: t("error.notifySuppressedNoAction") }],
          details: {
            title,
            body,
            target,
            platform,
            strict,
            sent: false,
            suppressed: true,
            suppressedReason: "all_clear_activity",
          },
        };
      }
      try {
        const result = await onNotify?.(title, body, { target, platform, strict });
        return {
          content: [{ type: "text", text: t("error.notifySent", { title }) }],
          details: {
            title,
            body,
            target,
            platform,
            strict,
            sent: true,
            ...(result && typeof result === "object" ? result : {}),
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: t("error.notifyFailed", { msg: err.message }) }],
          details: { title, body, target, platform, strict, sent: false, error: err.message },
        };
      }
    },
  };
}
