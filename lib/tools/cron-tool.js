/**
 * cron-tool.js — Agent 使用的定时任务工具
 *
 * 让 agent 能通过对话创建、管理定时任务。
 * Agent 读取 jian.md 上的自然语言任务后，
 * 可以翻译成 cron job 来执行。
 *
 * 支持三种调度类型：
 * - at：一次性（"2026-02-24T09:00:00"）
 * - every：间隔（毫秒数，如 3600000 = 1小时）
 * - cron：标准 cron 表达式（"0 7 * * *" = 每天早上7点）
 */

import { Type } from "@sinclair/typebox";
import { Cron } from "croner";
import { t, getLocale } from "../../server/i18n.js";
import { readSessionMetadata } from "../../core/claude-session-store.js";
import { normalizeEverySchedule } from "../desk/cron-schedule.js";

const ACTIONS = new Set(["list", "add", "remove", "toggle"]);
const COMMAND_KV_RE = /(?:^|\s)(prompt|label|notifyTarget|notifyPlatform|model|type|schedule|id)\s+(?:"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’|`([^`]*)`|([^\s]+))/gi;
const KNOWN_NOTIFY_PLATFORMS = new Set(["wechat", "telegram", "feishu", "qq"]);

function pickQuotedMatchValue(match) {
  for (let i = 2; i <= 7; i++) {
    if (match[i] !== undefined) return match[i];
  }
  return "";
}

function normalizeHourMinute(hour, minute, marker = "") {
  let h = Number(hour);
  const m = Number(minute);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (m < 0 || m > 59) return null;

  const markerNorm = String(marker || "").toLowerCase();
  if (markerNorm === "pm" && h < 12) h += 12;
  if (markerNorm === "am" && h === 12) h = 0;
  if ((markerNorm === "下午" || markerNorm === "晚上") && h < 12) h += 12;
  if (markerNorm === "中午" && h < 11) h += 12;
  if (h < 0 || h > 23) return null;

  return `${m} ${h} * * *`;
}

function parseDailyCronSchedule(text) {
  const raw = String(text || "");

  // English: "every day at 18:10", "daily 6:10 pm"
  const en = raw.match(/\b(?:every\s*day|daily)\b[\s,]*(?:at\s*)?(\d{1,2})[:：](\d{1,2})(?:\s*(am|pm))?/i);
  if (en) {
    const expr = normalizeHourMinute(en[1], en[2], en[3]);
    if (expr) return expr;
  }

  // Chinese: "每天18:10" / "每天下午6:10"
  const zhColon = raw.match(/每天[\s在]*(上午|下午|晚上|中午)?\s*(\d{1,2})[:：](\d{1,2})/i);
  if (zhColon) {
    const expr = normalizeHourMinute(zhColon[2], zhColon[3], zhColon[1]);
    if (expr) return expr;
  }

  // Chinese: "每天6点10分" / "每天下午6点"
  const zhPoint = raw.match(/每天[\s在]*(上午|下午|晚上|中午)?\s*(\d{1,2})\s*[点时時]\s*(\d{1,2})?\s*(?:分)?/i);
  if (zhPoint) {
    const minute = zhPoint[3] ?? "0";
    const expr = normalizeHourMinute(zhPoint[2], minute, zhPoint[1]);
    if (expr) return expr;
  }

  return null;
}

function extractCronExpressionShape(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const m = raw.match(/^([^\s]+\s+[^\s]+\s+[^\s]+\s+[^\s]+\s+[^\s]+)$/);
  return m ? m[1] : null;
}

function isSemanticallyValidCronExpression(expr) {
  try {
    const parser = new Cron(expr, { catch: false });
    const next = parser.nextRun(new Date());
    return next instanceof Date && Number.isFinite(next.getTime());
  } catch {
    return false;
  }
}

function parseCronExpression(text) {
  const shape = extractCronExpressionShape(text);
  if (!shape) return null;
  return isSemanticallyValidCronExpression(shape) ? shape : null;
}

function parseNaturalEverySchedule(schedule) {
  if (schedule === null || schedule === undefined) return null;

  const raw = String(schedule).trim();
  if (!raw) return null;

  // "every minute" / "every 5 minutes" / "every hour"
  const en = raw.match(/^every\s*(\d+)?\s*(minute|minutes|min|mins|hour|hours|hr|hrs)$/i);
  if (en) {
    const n = Math.max(1, parseInt(en[1] || "1", 10));
    const unit = en[2].toLowerCase();
    const shorthand = /hour|hr/.test(unit) ? `${n}h` : `${n}m`;
    return normalizeEverySchedule(shorthand);
  }

  // "每分钟" / "每5分钟" / "每小时" / "每2小时"
  const zh = raw.match(/^每\s*(\d+)?\s*(分(?:钟)?|(?:小)?时)$/);
  if (zh) {
    const n = Math.max(1, parseInt(zh[1] || "1", 10));
    const unit = zh[2];
    const shorthand = unit.includes("时") ? `${n}h` : `${n}m`;
    return normalizeEverySchedule(shorthand);
  }

  return normalizeEverySchedule(raw);
}

function isSimpleDailyCron(expr) {
  const raw = String(expr || "").trim();
  if (!raw) return false;
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dayOfMonth, month, dayOfWeek] = parts;
  const isNumber = (v) => /^\d+$/.test(v);
  return isNumber(min)
    && isNumber(hour)
    && dayOfMonth === "*"
    && month === "*"
    && dayOfWeek === "*";
}

function hasRecurringIntent(text) {
  const raw = String(text || "");
  if (!raw) return false;
  return /每天|每日|每周|每月|每年|工作日|周一|周二|周三|周四|周五|周末|every day|daily|every week|weekly|every month|monthly|every year|yearly|weekday|weekdays/i.test(raw);
}

function hasOneShotTimeIntent(text) {
  const raw = String(text || "");
  if (!raw) return false;
  return /今天|明天|后天|今晚|今早|今晨|今夜|this\s+(afternoon|evening|morning|tonight)|today|tomorrow/i.test(raw);
}

function normalizeModelRef(model) {
  const v = String(model || "").trim();
  if (!v) return "";
  const lower = v.toLowerCase();
  if (lower === "default" || lower === "default model" || v === "默认" || v === "默认模型") return "";
  return v;
}

function normalizeNotifyPlatform(value) {
  const v = String(value || "").trim().toLowerCase();
  return KNOWN_NOTIFY_PLATFORMS.has(v) ? v : "";
}

function resolveSessionPath(ctx, getSessionPath) {
  const fromCtx = String(ctx?.sessionManager?.getSessionFile?.() || "").trim();
  if (fromCtx) return fromCtx;
  const fromGetter = String(getSessionPath?.() || "").trim();
  return fromGetter || "";
}

function resolvePlatformFromContext(ctx, getSessionPath) {
  const fromBridgeMeta = normalizeNotifyPlatform(
    ctx?.bridgeMeta?.platform
      || ctx?.bridgeMeta?.platformKey
      || ctx?.meta?.bridge?.platform,
  );
  if (fromBridgeMeta) return fromBridgeMeta;

  const sessionPath = resolveSessionPath(ctx, getSessionPath);
  if (!sessionPath) return "";

  try {
    const metadata = readSessionMetadata(sessionPath);
    return normalizeNotifyPlatform(
      metadata?.bridge?.platform
        || metadata?.bridge?.platformKey,
    );
  } catch {
    return "";
  }
}

function normalizeAddTypeAndSchedule(typeInput, scheduleInput) {
  const typeRaw = String(typeInput || "").trim().toLowerCase();
  const scheduleText = String(scheduleInput ?? "").trim();

  const everyMs = parseNaturalEverySchedule(scheduleInput);
  const dailyCron = parseDailyCronSchedule(scheduleText);
  const cronShape = extractCronExpressionShape(scheduleText);
  const cronExpr = parseCronExpression(scheduleText);

  // 允许缺省 type：由 schedule 自动推断
  if (!typeRaw) {
    if (everyMs) return { type: "every", schedule: everyMs };
    if (dailyCron) return { type: "cron", schedule: dailyCron };
    if (cronExpr) return { type: "cron", schedule: cronExpr };
    if (cronShape) return { error: "invalid cron schedule" };
    return { error: "invalid schedule" };
  }

  if (typeRaw === "every") {
    if (everyMs) return { type: "every", schedule: everyMs };
    // 容错：agent 可能把 cron 表达式误配到 every，这里自动纠正为 cron。
    if (cronExpr) return { type: "cron", schedule: cronExpr };
    if (cronShape) return { error: "invalid cron schedule" };
    if (dailyCron) return { type: "cron", schedule: dailyCron };
    if (scheduleText) {
      const dt = new Date(scheduleText);
      if (!Number.isNaN(dt.getTime())) return { type: "at", schedule: scheduleText };
    }
    return { error: "invalid every schedule" };
  }

  if (typeRaw === "cron") {
    if (cronExpr) return { type: "cron", schedule: cronExpr };
    if (dailyCron) return { type: "cron", schedule: dailyCron };
    // 容错：agent 常把 "every minute" 误配到 cron，这里自动纠正为 every。
    if (everyMs) return { type: "every", schedule: everyMs };
    return { error: "invalid cron schedule" };
  }

  if (typeRaw === "at") {
    const dt = new Date(scheduleText);
    if (!scheduleText || Number.isNaN(dt.getTime())) return { error: "invalid at schedule" };
    return { type: "at", schedule: scheduleText };
  }

  return { error: "invalid type" };
}

function validateCronAddSemantics(jobType, schedule, prompt) {
  if (jobType !== "cron") return { ok: true };
  if (!isSimpleDailyCron(schedule)) return { ok: true };
  if (hasRecurringIntent(prompt)) return { ok: true };
  if (!hasOneShotTimeIntent(prompt)) return { ok: true };
  return { ok: false, error: "ambiguous cron maybe at" };
}

function parseLegacyCronCommand(command) {
  const raw = String(command || "").trim();
  if (!raw) return null;

  const kv = {};
  const stripped = raw
    .replace(COMMAND_KV_RE, (...args) => {
      const match = args;
      const key = String(match[1] || "").trim().toLowerCase();
      const value = pickQuotedMatchValue(match).trim();
      if (key && value && kv[key] === undefined) kv[key] = value;
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();

  const noPrefix = stripped.replace(/^cron\s+/i, "").trim();
  if (!noPrefix) return null;

  const tokens = noPrefix.split(/\s+/).filter(Boolean);
  const action = String(tokens[0] || "").toLowerCase();
  if (!ACTIONS.has(action)) return null;

  if (action === "list") return { action: "list" };

  if (action === "remove" || action === "toggle") {
    return { action, id: kv.id || tokens[1] || "" };
  }

  // add
  let type = String(kv.type || "").toLowerCase();
  let schedule = kv.schedule;
  const prompt = kv.prompt || "";
  const label = kv.label || "";
  const model = kv.model || "";
  const notifyTarget = kv.notifytarget || "";
  const notifyPlatform = kv.notifyplatform || "";
  const rest = tokens.slice(1).join(" ");

  if (!type || !schedule) {
    const daily = parseDailyCronSchedule(rest);
    if (daily) {
      type = "cron";
      schedule = daily;
    }
  }

  if (!type && rest) {
    const cronExprMatch = rest.match(/^([^\s]+\s+[^\s]+\s+[^\s]+\s+[^\s]+\s+[^\s]+)$/);
    if (cronExprMatch) {
      type = "cron";
      schedule = cronExprMatch[1];
    }
  }

  if (!type && rest) {
    const everyMatch = rest.match(/^every\s+(.+)$/i);
    if (everyMatch) {
      type = "every";
      schedule = everyMatch[1].trim();
    }
  }

  if (!type) type = "cron";

  return { action: "add", type, schedule, prompt, label, model, notifyTarget, notifyPlatform };
}

/**
 * 创建 cron 工具
 * @param {import('../desk/cron-store.js').CronStore} cronStore
 * @returns {object}
 */
export function createCronTool(cronStore, { autoApprove = false, getAutoApprove, confirmStore, emitEvent, getSessionPath } = {}) {
  return {
    name: "cron",
    label: t("toolDef.cron.label"),
    description: t("toolDef.cron.description"),
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal("list"),
        Type.Literal("add"),
        Type.Literal("remove"),
        Type.Literal("toggle"),
      ], { description: t("toolDef.cron.actionDesc") })),
      command: Type.Optional(Type.String({
        description: "兼容模式：例如 \"cron add every day at 18:10 prompt '喝水' label '提醒'\"",
      })),
      type: Type.Optional(Type.Union([
        Type.Literal("at"),
        Type.Literal("every"),
        Type.Literal("cron"),
      ], { description: t("toolDef.cron.typeDesc") })),
      schedule: Type.Optional(Type.String({
        description: t("toolDef.cron.scheduleDesc")
      })),
      prompt: Type.Optional(Type.String({
        description: t("toolDef.cron.promptDesc")
      })),
      label: Type.Optional(Type.String({
        description: t("toolDef.cron.labelDesc")
      })),
      model: Type.Optional(Type.String({
        description: t("toolDef.cron.modelDesc")
      })),
      notifyTarget: Type.Optional(Type.Union([
        Type.Literal("local"),
        Type.Literal("platform"),
      ], {
        description: "提醒通知目标：local（本地弹窗）| platform（平台私聊）",
      })),
      notifyPlatform: Type.Optional(Type.Union([
        Type.Literal("wechat"),
        Type.Literal("telegram"),
        Type.Literal("feishu"),
        Type.Literal("qq"),
      ], {
        description: "指定提醒平台：wechat | telegram | feishu | qq。设置后会固定发送到该平台。",
      })),
      id: Type.Optional(Type.String({
        description: t("toolDef.cron.idDesc")
      })),
    }),

    execute: async (_toolCallId, rawParams, _signal, _onUpdate, ctx) => {
      let params = rawParams || {};
      const compat = parseLegacyCronCommand(params.command);
      if (compat) {
        params = { ...params, ...compat };
      }
      if (!params.action) {
        const isZh = getLocale().startsWith("zh");
        return {
          content: [{
            type: "text",
            text: isZh
              ? "错误：缺少 action 参数（支持 list/add/remove/toggle）"
              : "Error: missing action parameter (supported: list/add/remove/toggle)",
          }],
          details: { action: null, jobs: cronStore.listJobs(), error: "action required" },
        };
      }

      switch (params.action) {
        case "list": {
          const jobs = cronStore.listJobs();
          if (jobs.length === 0) {
            return {
              content: [{ type: "text", text: t("error.cronNoJobs") }],
              details: { action: "list", jobs: [] },
            };
          }
          const lines = jobs.map(j => {
            const status = j.enabled ? "✓" : "✗";
            const locale = getLocale() || "zh";
            const localeTag = locale.startsWith("zh") ? "zh-CN" : "en-US";
            const isZh = locale.startsWith("zh");
            const noNext = isZh ? "无" : "none";
            const nextLabel = isZh ? "下次" : "next";
            const next = j.nextRunAt
              ? new Date(j.nextRunAt).toLocaleString(localeTag, { hour12: false })
              : noNext;
            const nt = String(j.notifyTarget || "local").toLowerCase();
            const np = String(j.notifyPlatform || "").toLowerCase();
            const notifyPart = np ? `, notify: ${nt}/${np}` : (nt ? `, notify: ${nt}` : "");
            return `[${status}] ${j.id}: ${j.label} (${j.type}${notifyPart}, ${nextLabel}: ${next})`;
          });
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { action: "list", jobs },
          };
        }

        case "add": {
          if (!params.schedule || !params.prompt) {
            return {
              content: [{ type: "text", text: t("error.cronAddNeedParams") }],
              details: { action: "add", jobs: cronStore.listJobs(), error: "missing params" },
            };
          }

          const normalized = normalizeAddTypeAndSchedule(params.type, params.schedule);
          if (normalized.error) {
            let errText = t("error.cronAddNeedParams");
            if (normalized.error.includes("every")) {
              errText = t("error.cronEveryMustBeNumber");
            } else if (normalized.error.includes("cron")) {
              errText = t("error.cronInvalidSchedule");
            } else if (normalized.error.includes("at")) {
              errText = t("error.cronAtMustBeTime");
            }
            return {
              content: [{ type: "text", text: errText }],
              details: { action: "add", jobs: cronStore.listJobs(), error: normalized.error },
            };
          }
          const jobType = normalized.type;
          const schedule = normalized.schedule;
          const semanticCheck = validateCronAddSemantics(jobType, schedule, params.prompt);
          if (!semanticCheck.ok) {
            return {
              content: [{ type: "text", text: t("error.cronAmbiguousTimeMaybeAt") }],
              details: { action: "add", jobs: cronStore.listJobs(), error: semanticCheck.error },
            };
          }
          const modelRef = normalizeModelRef(params.model);
          const normalizedNotifyTarget = String(params.notifyTarget || "").trim().toLowerCase();
          const hasExplicitNotifyTarget = normalizedNotifyTarget.length > 0;
          const explicitNotifyPlatform = normalizeNotifyPlatform(params.notifyPlatform);
          const implicitNotifyPlatform = explicitNotifyPlatform
            ? ""
            : ((!hasExplicitNotifyTarget || normalizedNotifyTarget !== "local")
              ? resolvePlatformFromContext(ctx, getSessionPath)
              : "");
          const effectiveNotifyPlatform = explicitNotifyPlatform || implicitNotifyPlatform || "";

          const label = params.label || params.prompt.slice(0, 30);
          const jobData = {
            type: jobType,
            schedule,
            prompt: params.prompt,
            label: params.label,
            model: modelRef,
            notifyTarget: params.notifyTarget,
            notifyPlatform: effectiveNotifyPlatform,
          };

          if (getAutoApprove ? getAutoApprove() : autoApprove) {
            const job = cronStore.addJob(jobData);
            emitEvent?.({ type: "cron_changed" });
            return {
              content: [{ type: "text", text: t("error.cronCreated", { label: job.label, id: job.id }) }],
              details: { action: "added", job, jobs: cronStore.listJobs() },
            };
          }

          // 阻塞式确认
          if (confirmStore) {
            const sessionPath = resolveSessionPath(ctx, getSessionPath) || null;
            const { confirmId, promise } = confirmStore.create("cron", { jobData }, sessionPath);
            emitEvent?.({ type: "cron_confirmation", confirmId, jobData });
            const result = await promise;

            if (result.action === "confirmed") {
              const job = cronStore.addJob(jobData);
              emitEvent?.({ type: "cron_changed" });
              return {
                content: [{ type: "text", text: t("error.cronConfirmed", { label: job.label, id: job.id }) }],
                details: { action: "added", job, jobs: cronStore.listJobs() },
              };
            }
            return {
              content: [{ type: "text", text: result.action === "rejected" ? t("error.cronRejected", { label }) : t("error.cronTimeout", { label }) }],
              details: { action: "cancelled", jobs: cronStore.listJobs() },
            };
          }

          // fallback：无 confirmStore 时走旧逻辑
          return {
            content: [{ type: "text", text: t("error.cronPendingConfirm", { label }) }],
            details: {
              action: "pending_add",
              jobData,
            },
          };
        }

        case "remove": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: t("error.cronRemoveNeedId") }],
              details: { action: "remove", jobs: cronStore.listJobs(), error: "id required" },
            };
          }
          const ok = cronStore.removeJob(params.id);
          if (!ok) {
            return {
              content: [{ type: "text", text: t("error.cronJobNotFound", { id: params.id }) }],
              details: { action: "remove", jobs: cronStore.listJobs(), error: "not found" },
            };
          }
          emitEvent?.({ type: "cron_changed" });
          return {
            content: [{ type: "text", text: t("error.cronRemoved", { id: params.id }) }],
            details: { action: "remove", jobs: cronStore.listJobs() },
          };
        }

        case "toggle": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: t("error.cronToggleNeedId") }],
              details: { action: "toggle", jobs: cronStore.listJobs(), error: "id required" },
            };
          }
          const job = cronStore.toggleJob(params.id);
          if (!job) {
            return {
              content: [{ type: "text", text: t("error.cronJobNotFound", { id: params.id }) }],
              details: { action: "toggle", jobs: cronStore.listJobs(), error: "not found" },
            };
          }
          emitEvent?.({ type: "cron_changed" });
          return {
            content: [{ type: "text", text: t("error.cronToggled", { id: job.id, state: job.enabled ? t("error.cronEnabled") : t("error.cronDisabled") }) }],
            details: { action: "toggle", jobs: cronStore.listJobs() },
          };
        }

        default:
          return {
            content: [{ type: "text", text: t("error.unknownAction", { action: params.action }) }],
            details: { action: params.action, jobs: cronStore.listJobs() },
          };
      }
    },
  };
}
