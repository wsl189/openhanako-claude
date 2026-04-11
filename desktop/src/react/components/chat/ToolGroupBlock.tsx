/**
 * ToolGroupBlock — 工具调用组，含展开/折叠
 */

import { memo, useMemo, useState } from 'react';
import { extractToolDetail } from '../../utils/message-parser';
import type { ToolCall } from '../../stores/chat-types';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
  tools: ToolCall[];
  agentName: string;
  dimmed?: boolean;
}

const TOOL_PANEL_TEXT_MAX_LEN = 10_000;

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

function normalizePreviewText(raw: unknown, maxLen = TOOL_PANEL_TEXT_MAX_LEN): string {
  const text = String(raw ?? '')
    .replace(/\r/g, '')
    .trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function looksLikeBase64(value: string): boolean {
  if (value.length < 120) return false;
  if (/\s/.test(value)) return false;
  return /^[A-Za-z0-9+/=]+$/.test(value);
}

function previewReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    if (looksLikeBase64(value)) return `[omitted base64, ${value.length} chars]`;
    if (value.length > 1600) return `${value.slice(0, 1600)}… (${value.length} chars)`;
  }
  return value;
}

function stringifyPreview(value: unknown): string {
  if (value == null) return '';
  try {
    return normalizePreviewText(JSON.stringify(value, previewReplacer, 2));
  } catch {
    return normalizePreviewText(String(value));
  }
}

function getCommandInput(args?: Record<string, unknown>): string {
  if (!args || typeof args !== 'object') return '';
  const direct = normalizePreviewText(args.command ?? args.cmd);
  if (direct) return direct;
  return '';
}

function getInputText(args?: Record<string, unknown>): string {
  if (!args || typeof args !== 'object') return '';
  const command = getCommandInput(args);
  if (command) return command;
  return stringifyPreview(args);
}

function getOutputText(tool: ToolCall): string {
  const direct = normalizePreviewText(tool.resultText);
  if (direct) return direct;
  if (!tool.details || typeof tool.details !== 'object') return '';
  const keys = ['error', 'summary', 'message', 'output', 'result'];
  for (const key of keys) {
    const value = tool.details[key];
    const text = normalizePreviewText(value);
    if (text) return text;
  }
  return '';
}

function getDetailsText(tool: ToolCall): string {
  if (!tool.details || typeof tool.details !== 'object') return '';
  const details = { ...tool.details };
  if ('content' in details) delete (details as any).content;
  if ('thumbnail' in details) delete (details as any).thumbnail;
  if ('base64' in details) delete (details as any).base64;
  return stringifyPreview(details);
}

export const ToolGroupBlock = memo(function ToolGroupBlock({ tools, agentName, dimmed = false }: Props) {
  return (
    <div className={`tool-group proma-like${dimmed ? ' dimmed' : ''}`}>
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
  const [expanded, setExpanded] = useState(false);
  const detail = extractToolDetail(tool.name, tool.args);
  const phase = (tool.done ? (tool.success ? 'done' : 'failed') : 'running') as 'running' | 'done' | 'failed';
  const label = getToolLabel(tool.name, phase, agentName, tool.args);
  const actionLine = buildToolActionLine(tool.name, phase, detail);
  const t = (window as any).t;
  const doneText = stripLeadingEmoji(t?.('tool._line.done') || '完成');
  const failedText = stripLeadingEmoji(t?.('tool._line.failed') || '失败');
  const inputText = useMemo(() => getInputText(tool.args), [tool.args]);
  const outputText = useMemo(() => getOutputText(tool), [tool.resultText, tool.details]);
  const detailsText = useMemo(() => getDetailsText(tool), [tool.details]);
  const canExpand = !!(inputText || outputText || detailsText || tool.toolUseId);

  // 如果 args 里有 tag 类型信息（如 agent 名）
  const tag = tool.args?.agentId as string | undefined;

  return (
    <div className={`tool-item ${expanded ? 'expanded' : ''}`} data-phase={phase} data-tool={tool.name}>
      <button
        type="button"
        className={`tool-indicator ${phase}${canExpand ? ' expandable' : ''}`}
        data-phase={phase}
        data-tool={tool.name}
        data-done={String(tool.done)}
        onClick={() => { if (canExpand) setExpanded((v) => !v); }}
        aria-expanded={canExpand ? expanded : undefined}
        disabled={!canExpand}
        title={label}
      >
        <span className="tool-leading">{phase === 'failed' ? '!' : (phase === 'done' ? '✓' : '›')}</span>
        <span className="tool-desc">{actionLine}</span>
        {tag && <span className="tool-tag">{tag}</span>}
        {tool.done ? (
          <span className={`tool-status ${tool.success ? 'done' : 'failed'}`}>
            {tool.success ? doneText : failedText}
          </span>
        ) : (
          <span className="tool-dots"><span /><span /><span /></span>
        )}
        {canExpand && <span className="tool-expand">{expanded ? '▾' : '▸'}</span>}
      </button>

      {expanded && canExpand && (
        <div className="tool-panel">
          {!!tool.toolUseId && (
            <div className="tool-panel-row">
              <div className="tool-panel-label">Tool ID</div>
              <pre className="tool-panel-pre">{tool.toolUseId}</pre>
            </div>
          )}
          {!!inputText && (
            <div className="tool-panel-row">
              <div className="tool-panel-label">Input</div>
              <pre className="tool-panel-pre">{inputText}</pre>
            </div>
          )}
          {!!outputText && (
            <div className="tool-panel-row">
              <div className="tool-panel-label">Output</div>
              <pre className="tool-panel-pre">{outputText}</pre>
            </div>
          )}
          {!!detailsText && detailsText !== outputText && (
            <div className="tool-panel-row">
              <div className="tool-panel-label">Details</div>
              <pre className="tool-panel-pre">{detailsText}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
