/**
 * ToolGroupBlock — 工具调用组，含展开/折叠
 */

import { memo } from 'react';
import { extractToolDetail } from '../../utils/message-parser';
import type { ToolCall } from '../../stores/chat-types';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
  tools: ToolCall[];
  agentName: string;
}

function humanizeToolName(name: string): string {
  return String(name || '')
    .replace(/^functions\./, '')
    .replace(/^multi_tool_use\./, '')
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

function stripLeadingEmoji(input: string): string {
  return String(input || '')
    .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\s]+/u, '')
    .trim();
}

function getToolLabel(name: string, phase: string, agentName: string, args?: Record<string, unknown>): string {
  const t = (window as any).t;
  const vars = { name: agentName };

  const action = typeof args?.action === 'string' ? args.action.trim().toLowerCase() : '';
  if (action) {
    const actionKey = `tool.${name}.actions.${action}.${phase}`;
    const actionVal = t?.(actionKey, vars);
    if (actionVal && actionVal !== actionKey) return actionVal;
  }

  const val = t?.(`tool.${name}.${phase}`, vars);
  if (val && val !== `tool.${name}.${phase}`) return val;

  const toolName = humanizeToolName(name) || name;
  const fallbackNamedKey = `tool._fallback.${phase}Named`;
  const fallbackNamedVal = t?.(fallbackNamedKey, { ...vars, tool: toolName });
  if (fallbackNamedVal && fallbackNamedVal !== fallbackNamedKey) return fallbackNamedVal;

  const fallbackKey = `tool._fallback.${phase}`;
  const fallbackVal = t?.(fallbackKey, vars);
  if (fallbackVal && fallbackVal !== fallbackKey) return `${fallbackVal} (${toolName})`;

  return toolName;
}

function buildToolActionLine(name: string, phase: 'running' | 'done' | 'failed', detail: string): string {
  const toolName = humanizeToolName(name) || name || 'Tool';
  const t = (window as any).t;

  const phaseMap: Record<typeof phase, string> = {
    running: stripLeadingEmoji(t?.('tool._line.running') || '执行'),
    done: stripLeadingEmoji(t?.('tool._line.done') || '已执行'),
    failed: stripLeadingEmoji(t?.('tool._line.failed') || '执行失败'),
  };

  return detail
    ? `${phaseMap[phase]} ${toolName} · ${detail}`
    : `${phaseMap[phase]} ${toolName}`;
}

export const ToolGroupBlock = memo(function ToolGroupBlock({ tools, agentName }: Props) {
  return (
    <div className="tool-group proma-like">
      <div className="tool-group-content">
        {tools.map((tool, i) => (
          <ToolIndicator key={tool.toolUseId || `${tool.name}-${i}`} tool={tool} agentName={agentName} />
        ))}
      </div>
    </div>
  );
});

// ── ToolIndicator ──

const ToolIndicator = memo(function ToolIndicator({ tool, agentName }: { tool: ToolCall; agentName: string }) {
  const detail = extractToolDetail(tool.name, tool.args);
  const phase = (tool.done ? (tool.success ? 'done' : 'failed') : 'running') as 'running' | 'done' | 'failed';
  const label = getToolLabel(tool.name, phase, agentName, tool.args);
  const actionLine = buildToolActionLine(tool.name, phase, detail);
  const t = (window as any).t;
  const doneText = stripLeadingEmoji(t?.('tool._line.done') || '完成');
  const failedText = stripLeadingEmoji(t?.('tool._line.failed') || '失败');

  // 如果 args 里有 tag 类型信息（如 agent 名）
  const tag = tool.args?.agentId as string | undefined;

  return (
    <div className={`tool-indicator ${phase}`} data-phase={phase} data-tool={tool.name} data-done={String(tool.done)}>
      <span className="tool-leading">{phase === 'failed' ? '!' : (phase === 'done' ? '✓' : '›')}</span>
      <span className="tool-desc" title={label}>{actionLine}</span>
      {tag && <span className="tool-tag">{tag}</span>}
      {tool.done ? (
        <span className={`tool-status ${tool.success ? 'done' : 'failed'}`} title={label}>
          {tool.success ? doneText : failedText}
        </span>
      ) : (
        <span className="tool-dots"><span /><span /><span /></span>
      )}
    </div>
  );
});
