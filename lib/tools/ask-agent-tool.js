/**
 * ask-agent-tool.js — 跨 Agent 调用
 *
 * 借用另一个 agent 的身份视角和模型能力做单次回复。
 * 被调用方带 personality（identity + ishiki + 用户信息），但不带记忆和工具。
 * Session 不保留，不进记忆系统。
 */

import { Type } from "@sinclair/typebox";
import { getLocale, t } from "../../server/i18n.js";
import { runAgentSession } from "../../hub/agent-executor.js";
import { appendMessage, getChannelAnnouncementFromMeta, getChannelMeta } from "../channels/channel-store.js";
import fs from "fs";
import path from "path";

function isZhLocale() {
  return getLocale().startsWith("zh");
}

function normalizeId(v) {
  return String(v || "").trim();
}

function isSafeChannelId(v) {
  return /^[A-Za-z0-9._-]+$/.test(normalizeId(v));
}

function emitChannelAgentActivity(engine, channelName, targetAgentId, active) {
  if (!channelName || !targetAgentId) return;
  engine?._hub?.eventBus?.emit(
    {
      type: "channel_agent_activity",
      channelName,
      agentId: targetAgentId,
      active: !!active,
      timestamp: new Date().toISOString(),
    },
    null,
  );
}

function emitChannelNewMessage(engine, channelName, senderId) {
  if (!channelName || !senderId) return;
  engine?._hub?.eventBus?.emit(
    { type: "channel_new_message", channelName, sender: senderId },
    null,
  );
}

function resolveChannelContext(engine, rawChannelName) {
  const channelName = normalizeId(rawChannelName);
  if (!channelName) return null;

  if (!engine?.channelsDir) {
    throw new Error("channel mode not enabled");
  }
  if (!isSafeChannelId(channelName)) {
    throw new Error(`invalid channel id: ${channelName}`);
  }

  const channelFile = path.join(engine.channelsDir, `${channelName}.md`);
  if (!fs.existsSync(channelFile)) {
    throw new Error(`channel not found: ${channelName}`);
  }

  const meta = getChannelMeta(channelFile);
  const members = Array.isArray(meta?.members) ? meta.members : [];
  const memberSet = new Set(members.map((m) => normalizeId(m)).filter(Boolean));
  const announcement = String(getChannelAnnouncementFromMeta(meta) || "").trim();
  return { channelName, channelFile, memberSet, announcement };
}

function assertTargetIsChannelMember(channelCtx, target) {
  if (!channelCtx?.channelName) return;
  const memberSet = channelCtx.memberSet;
  if (!memberSet || memberSet.size === 0) return;
  const targetId = normalizeId(target?.id);
  const targetName = normalizeId(target?.name);
  if (!memberSet.has(targetId) && (!targetName || !memberSet.has(targetName))) {
    throw new Error(`agent "${targetId}" is not a member of #${channelCtx.channelName}`);
  }
}

function canTargetRunInChannel(channelCtx, target) {
  if (!channelCtx?.channelName) return true;
  const memberSet = channelCtx.memberSet;
  if (!memberSet || memberSet.size === 0) return true;
  const targetId = normalizeId(target?.id);
  const targetName = normalizeId(target?.name);
  return memberSet.has(targetId) || (!!targetName && memberSet.has(targetName));
}

function buildDelegationAnnouncement(targetLabels, task) {
  const targets = (targetLabels || []).map((v) => normalizeId(v)).filter(Boolean);
  const taskText = String(task || "").replace(/\r/g, "").trim();
  if (!targets.length) return taskText;

  // 分配公告更口语化：直接 @目标 + 任务正文，避免“我已分配给/任务：”的机械格式。
  if (targets.length === 1) {
    return taskText ? `@${targets[0]}，${taskText}` : `@${targets[0]}`;
  }
  const mentionHead = targets.map((name) => `@${name}`).join(" ");
  return taskText ? `${mentionHead}，${taskText}` : mentionHead;
}

function buildReplyToDelegatorText(replyText, delegatorLabel) {
  const delegator = normalizeId(delegatorLabel);
  const body = String(replyText || "").trim();
  if (!delegator) return body;
  if (!body) return `@${delegator}`;
  return `@${delegator}\n\n${body}`;
}

function buildAskChannelSystemAppend(channelCtx) {
  if (!channelCtx?.channelName) return "";
  const isZh = isZhLocale();
  const announcement = String(channelCtx.announcement || "").trim();
  if (!announcement) return "";
  if (isZh) {
    return [
      "# 频道公告（ask_agent 注入）",
      `- 当前频道：#${channelCtx.channelName}`,
      "- 你必须严格遵守以下群公告内容：",
      announcement,
      "- 若群公告与一般偏好冲突，以群公告为准；若与系统/安全硬约束冲突，以系统/安全约束为准。",
    ].join("\n");
  }
  return [
    "# Channel Announcement (injected by ask_agent)",
    `- Current channel: #${channelCtx.channelName}`,
    "- You must strictly follow the announcement below:",
    announcement,
    "- If it conflicts with general preferences, prioritize the announcement. If it conflicts with system/safety hard constraints, prioritize system/safety constraints.",
  ].join("\n");
}

async function runSingleAsk({
  fromAgentId,
  fromAgentLabel,
  target,
  task,
  signal,
  engine,
  channelCtx,
}) {
  const targetId = normalizeId(target?.id);
  const targetName = normalizeId(target?.name) || targetId;

  try {
    assertTargetIsChannelMember(channelCtx, target);
  } catch (err) {
    return {
      ok: false,
      from: fromAgentId,
      to: targetId,
      agentName: targetName,
      postedToChannel: false,
      error: err.message,
    };
  }

  if (channelCtx?.channelName) {
    emitChannelAgentActivity(engine, channelCtx.channelName, targetId, true);
  }

  try {
    const reply = await runAgentSession(
      targetId,
      [{ text: task, capture: true }],
      {
        engine,
        signal,
        sessionSuffix: "ask-temp",
        keepSession: false,
        noMemory: true,
        readOnly: true,
        systemAppend: buildAskChannelSystemAppend(channelCtx),
      },
    );

    const replyText = reply || t("error.agentNoReply", { name: targetName });
    let postedToChannel = false;
    let channelTimestamp = null;

    if (channelCtx?.channelName) {
      const channelReplyText = buildReplyToDelegatorText(replyText, fromAgentLabel);
      const { timestamp } = appendMessage(channelCtx.channelFile, targetId, channelReplyText);
      postedToChannel = true;
      channelTimestamp = timestamp;
      emitChannelNewMessage(engine, channelCtx.channelName, targetId);
    }

    return {
      ok: true,
      from: fromAgentId,
      to: targetId,
      agentName: targetName,
      replyText,
      postedToChannel,
      channel: postedToChannel ? channelCtx.channelName : undefined,
      channelTimestamp: postedToChannel ? channelTimestamp : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      from: fromAgentId,
      to: targetId,
      agentName: targetName,
      postedToChannel: false,
      error: err.message,
    };
  } finally {
    if (channelCtx?.channelName) {
      emitChannelAgentActivity(engine, channelCtx.channelName, targetId, false);
    }
  }
}

/**
 * @param {object} opts
 * @param {string} opts.agentId - 当前 agent ID
 * @param {() => Array<{id: string, name: string}>} opts.listAgents
 * @param {import('../../core/engine.js').HanaEngine} opts.engine
 */
export function createAskAgentTool({ agentId, listAgents, engine }) {
  return {
    name: "ask_agent",
    label: t("toolDef.askAgent.label"),
    description: t("toolDef.askAgent.description"),
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: t("toolDef.askAgent.agentDesc") })),
      agents: Type.Optional(Type.Array(Type.String(), { description: t("toolDef.askAgent.agentsDesc") })),
      task: Type.String({ description: t("toolDef.askAgent.taskDesc") }),
      channel: Type.Optional(Type.String({ description: t("toolDef.askAgent.channelDesc") })),
    }),

    execute: async (_toolCallId, params, signal) => {
      const agents = listAgents();
      const byId = new Map(agents.map((a) => [normalizeId(a.id), a]));
      const requestedIds = [
        ...new Set(
          [params.agent, ...(Array.isArray(params.agents) ? params.agents : [])]
            .map((v) => normalizeId(v))
            .filter(Boolean),
        ),
      ];
      if (!requestedIds.length) {
        return {
          content: [{ type: "text", text: isZhLocale() ? "请提供 agent 或 agents 参数" : "Please provide agent or agents" }],
        };
      }

      try {
        const channelCtx = resolveChannelContext(engine, params.channel);
        const delegatorLabel = normalizeId(byId.get(agentId)?.name) || agentId;
        const runnableTargets = requestedIds
          .map((id) => byId.get(id))
          .filter((target) => target && normalizeId(target.id) !== agentId)
          .filter((target) => canTargetRunInChannel(channelCtx, target));
        const runnableTargetLabels = runnableTargets.map((target) => {
          const name = normalizeId(target?.name);
          const id = normalizeId(target?.id);
          return name || id;
        });

        let delegatorPostedToChannel = false;
        let delegatorChannelTimestamp = null;
        if (channelCtx?.channelName && runnableTargetLabels.length > 0) {
          const notice = buildDelegationAnnouncement(runnableTargetLabels, params.task);
          const { timestamp } = appendMessage(channelCtx.channelFile, agentId, notice);
          delegatorPostedToChannel = true;
          delegatorChannelTimestamp = timestamp;
          emitChannelNewMessage(engine, channelCtx.channelName, agentId);
        }

        const jobs = requestedIds.map(async (id) => {
          if (id === agentId) {
            return {
              ok: false,
              from: agentId,
              to: id,
              agentName: id,
              postedToChannel: false,
              error: t("error.cannotCallSelf"),
            };
          }
          const target = byId.get(id);
          if (!target) {
            return {
              ok: false,
              from: agentId,
              to: id,
              agentName: id,
              postedToChannel: false,
              error: t("error.agentNotFoundAvailable", {
                id,
                ids: agents.map((a) => `${a.id} (${a.name})`).join(", ") || "(none)",
              }),
            };
          }
          return runSingleAsk({
            fromAgentId: agentId,
            fromAgentLabel: delegatorLabel,
            target,
            task: params.task,
            signal,
            engine,
            channelCtx,
          });
        });
        const results = await Promise.all(jobs);
        if (results.length === 1) {
          const result = results[0];
          if (!result.ok) {
            return {
              content: [{ type: "text", text: t("error.agentCallFailed", { name: result.agentName || result.to, msg: result.error }) }],
            };
          }
          return {
            content: [{ type: "text", text: result.replyText }],
            details: {
              from: result.from,
              to: result.to,
              agentName: result.agentName,
              postedToChannel: result.postedToChannel,
              channel: result.channel,
              channelTimestamp: result.channelTimestamp,
              delegatorPostedToChannel,
              delegatorChannelTimestamp,
            },
          };
        }

        const success = results.filter((r) => r?.ok).length;
        const failed = results.length - success;
        const isZh = isZhLocale();
        const lines = results.map((r) => {
          if (r?.ok) return `- ${r.to} (${r.agentName}): ${r.replyText}`;
          return isZh
            ? `- ${r?.to || "unknown"}: 失败 - ${r?.error || "unknown error"}`
            : `- ${r?.to || "unknown"}: failed - ${r?.error || "unknown error"}`;
        });
        const summary = isZh
          ? `并行调用完成：成功 ${success}，失败 ${failed}\n${lines.join("\n")}`
          : `Parallel call finished: ${success} succeeded, ${failed} failed\n${lines.join("\n")}`;
        return {
          content: [{ type: "text", text: summary }],
          details: {
            from: agentId,
            total: results.length,
            success,
            failed,
            channel: channelCtx?.channelName || undefined,
            delegatorPostedToChannel,
            delegatorChannelTimestamp,
            results: results.map((r) => ({
              ok: !!r?.ok,
              to: r?.to,
              agentName: r?.agentName,
              postedToChannel: !!r?.postedToChannel,
              channelTimestamp: r?.channelTimestamp || undefined,
              error: r?.error || undefined,
            })),
          },
        };
      } catch (err) {
        const nameForErr = requestedIds.length === 1 ? requestedIds[0] : "batch";
        return {
          content: [{ type: "text", text: t("error.agentCallFailed", { name: nameForErr, msg: err.message }) }],
        };
      }
    },
  };
}
