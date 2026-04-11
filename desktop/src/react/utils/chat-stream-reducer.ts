import type { ContentBlock, ToolCall } from '../stores/chat-types';

/* eslint-disable @typescript-eslint/no-explicit-any */

type StreamEvent = any;
type CronConfirmBlock = Extract<ContentBlock, { type: 'cron_confirm' }>;

function mergeToolArgs(
  currentArgs: Record<string, unknown> | undefined,
  nextArgs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!nextArgs || typeof nextArgs !== 'object') return currentArgs;
  if (!currentArgs || typeof currentArgs !== 'object') return nextArgs;
  return { ...currentArgs, ...nextArgs };
}

function findToolLocation(
  blocks: ContentBlock[],
  params: {
    toolCallId?: string | null;
    name?: string | null;
    onlyPending?: boolean;
    allowNameFallback?: boolean;
  },
): { blockIndex: number; toolIndex: number } | null {
  const toolCallId = String(params.toolCallId || '').trim();
  const toolName = String(params.name || '').trim();
  const onlyPending = params.onlyPending !== false;
  const allowNameFallback = params.allowNameFallback !== false;

  if (toolCallId) {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const block = blocks[i];
      if (block.type !== 'tool_group') continue;
      const toolIndex = block.tools.findIndex((tool) => (
        tool.toolUseId === toolCallId && (!onlyPending || !tool.done)
      ));
      if (toolIndex >= 0) return { blockIndex: i, toolIndex };
    }
  }

  if (!allowNameFallback) return null;
  if (!toolName) return null;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.type !== 'tool_group') continue;
    const toolIndex = block.tools.findIndex((tool) => (
      tool.name === toolName && (!onlyPending || !tool.done)
    ));
    if (toolIndex >= 0) return { blockIndex: i, toolIndex };
  }

  return null;
}

function normalizeCronEverySchedule(raw: unknown): string {
  const toMinutes = (value: number): number => {
    if (!Number.isFinite(value) || value <= 0) return 1;
    if (value < 1000) return Math.max(1, Math.round(value));
    return Math.max(1, Math.round(value / 60000));
  };

  if (typeof raw === 'number') return `every:${toMinutes(raw)}m`;
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (/^\d+$/.test(text)) return `every:${toMinutes(parseInt(text, 10))}m`;
  const cronEveryMin = text.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (cronEveryMin?.[1]) return `every:${Math.max(1, parseInt(cronEveryMin[1], 10))}m`;
  return text;
}

function normalizeCronJobIdentity(jobData: Record<string, unknown> | undefined) {
  const type = String(jobData?.type ?? '').trim().toLowerCase();
  const prompt = String(jobData?.prompt ?? '').trim();
  const label = String(jobData?.label ?? '').trim();
  const scheduleRaw = jobData?.schedule;
  const schedule = type === 'every'
    ? normalizeCronEverySchedule(scheduleRaw)
    : String(scheduleRaw ?? '').trim();
  return {
    type,
    schedule,
    identityText: prompt || label,
  };
}

function sameCronJob(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  if (!a || !b) return false;
  const na = normalizeCronJobIdentity(a);
  const nb = normalizeCronJobIdentity(b);
  if (!na.type || !nb.type || na.type !== nb.type) return false;
  if (!na.schedule || !nb.schedule || na.schedule !== nb.schedule) return false;
  if (na.identityText && nb.identityText) return na.identityText === nb.identityText;
  return true;
}

function findCronCardIndex(
  blocks: ContentBlock[],
  params: { confirmId?: string; jobData?: Record<string, unknown> },
): number {
  if (params.confirmId) {
    const idx = blocks.findIndex(
      (b: any) => b.type === 'cron_confirm' && b.confirmId === params.confirmId,
    );
    if (idx >= 0) return idx;
  }
  return blocks.findIndex(
    (b: any) => b.type === 'cron_confirm' && sameCronJob(b.jobData, params.jobData),
  );
}

function mergeCronCard(current: CronConfirmBlock, incoming: CronConfirmBlock): CronConfirmBlock {
  const mergedStatus = (
    current.status !== 'pending' && incoming.status === 'pending'
      ? current.status
      : incoming.status
  );

  return {
    ...current,
    confirmId: incoming.confirmId || current.confirmId,
    jobData: { ...(current.jobData || {}), ...(incoming.jobData || {}) },
    status: mergedStatus,
  };
}

export function upsertCronConfirmation(
  blocks: ContentBlock[],
  incoming: {
    confirmId?: string;
    jobData?: Record<string, unknown>;
    status: CronConfirmBlock['status'];
  },
): ContentBlock[] {
  const next = [...(blocks || [])];
  const card: CronConfirmBlock = {
    type: 'cron_confirm',
    confirmId: incoming.confirmId,
    jobData: (incoming.jobData || {}) as Record<string, unknown>,
    status: incoming.status,
  };
  const existingIdx = findCronCardIndex(next, {
    confirmId: incoming.confirmId,
    jobData: card.jobData,
  });
  if (existingIdx >= 0) {
    next[existingIdx] = mergeCronCard(next[existingIdx] as CronConfirmBlock, card);
  } else {
    next.push(card);
  }
  return next;
}

export function applyChatStreamLiveEvent(
  blocks: ContentBlock[],
  msg: StreamEvent,
): ContentBlock[] {
  const next = [...(blocks || [])];

  switch (msg.type) {
    case 'tool_start': {
      const toolCallId = String(msg.toolCallId || '').trim() || undefined;
      const existing = findToolLocation(next, {
        toolCallId,
        name: msg.name,
        onlyPending: false,
        allowNameFallback: !toolCallId,
      });

      if (existing) {
        const group = next[existing.blockIndex] as Extract<ContentBlock, { type: 'tool_group' }>;
        const tools = [...group.tools];
        const current = tools[existing.toolIndex]!;
        tools[existing.toolIndex] = {
          ...current,
          name: msg.name,
          toolUseId: toolCallId || current.toolUseId,
          args: mergeToolArgs(current.args, msg.args),
          done: false,
          success: false,
        };
        next[existing.blockIndex] = { ...group, tools };
        return next;
      }

      const tool: ToolCall = {
        name: msg.name,
        toolUseId: toolCallId,
        args: msg.args,
        done: false,
        success: false,
      };

      let lastToolGroupIndex = -1;
      for (let i = next.length - 1; i >= 0; i -= 1) {
        if (next[i]?.type === 'tool_group') {
          lastToolGroupIndex = i;
          break;
        }
      }

      if (lastToolGroupIndex >= 0) {
        const group = next[lastToolGroupIndex] as Extract<ContentBlock, { type: 'tool_group' }>;
        if (group.tools.some((item) => !item.done)) {
          next[lastToolGroupIndex] = {
            ...group,
            tools: [...group.tools, tool],
          };
          return next;
        }
      }

      next.push({
        type: 'tool_group',
        tools: [tool],
        collapsed: false,
      });
      return next;
    }

    case 'tool_end': {
      const location = findToolLocation(next, {
        toolCallId: msg.toolCallId,
        name: msg.name,
        onlyPending: true,
      });
      if (!location) return blocks;

      const group = next[location.blockIndex] as Extract<ContentBlock, { type: 'tool_group' }>;
      const tools = [...group.tools];
      const current = tools[location.toolIndex]!;
      tools[location.toolIndex] = {
        ...current,
        toolUseId: current.toolUseId || (String(msg.toolCallId || '').trim() || undefined),
        args: mergeToolArgs(current.args, msg.args),
        done: true,
        success: !!msg.success,
      };
      const allDone = tools.every((item) => item.done);
      next[location.blockIndex] = {
        ...group,
        tools,
        collapsed: allDone && tools.length > 1,
      };
      return next;
    }

    case 'file_output':
      next.push({ type: 'file_output', filePath: msg.filePath, label: msg.label, ext: msg.ext });
      return next;

    case 'artifact':
      next.push({
        type: 'artifact',
        artifactId: msg.artifactId || msg.id,
        artifactType: msg.artifactType || msg.type,
        title: msg.title || '',
        content: msg.content || '',
        language: msg.language,
      });
      return next;

    case 'browser_screenshot':
      next.push({ type: 'browser_screenshot', base64: msg.base64, mimeType: msg.mimeType });
      return next;

    case 'skill_activated':
      next.push({ type: 'skill', skillName: msg.skillName, skillFilePath: msg.skillFilePath });
      return next;

    case 'cron_confirmation': {
      return upsertCronConfirmation(next, {
        confirmId: msg.confirmId,
        jobData: msg.jobData,
        status: 'pending',
      });
    }

    case 'settings_confirmation': {
      const existingIdx = next.findIndex(
        (block: any) => block.type === 'settings_confirm' && block.confirmId === msg.confirmId,
      );
      const incoming: Extract<ContentBlock, { type: 'settings_confirm' }> = {
        type: 'settings_confirm',
        confirmId: msg.confirmId,
        settingKey: msg.settingKey,
        cardType: msg.cardType,
        currentValue: msg.currentValue,
        proposedValue: msg.proposedValue,
        options: msg.options,
        optionLabels: msg.optionLabels,
        label: msg.label,
        description: msg.description,
        frontend: msg.frontend,
        status: 'pending',
      };
      if (existingIdx >= 0) next[existingIdx] = incoming;
      else next.push(incoming);
      return next;
    }

    default:
      return blocks;
  }
}
