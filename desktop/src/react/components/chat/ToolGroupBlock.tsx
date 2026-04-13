/**
 * ToolGroupBlock — 工具调用组，含展开/折叠
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { extractToolDetail } from '../../utils/message-parser';
import type { ToolCall } from '../../stores/chat-types';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
  tools: ToolCall[];
  agentName: string;
  dimmed?: boolean;
  animate?: boolean;
}

const TOOL_PANEL_TEXT_MAX_LEN = 10_000;
const TOOL_PREVIEW_EMPTY_LINE = '\u200B';
const TOOL_REVEAL_BASE_DELAY_MS = 150;
const TOOL_REVEAL_MAX_DELAY_MS = 480;
const TOOL_REVEAL_AFTER_THINKING_DELAY_MS = 260;

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

function renderActionLineWithDiffColors(text: string) {
  const parts = String(text || '').split(/(\s[+-]\d+(?=\s|$))/g);
  return parts.map((part, idx) => {
    const m = part.match(/^(\s)([+-]\d+)$/);
    if (!m) return part;
    const cls = m[2].startsWith('+') ? 'tool-diff-plus' : 'tool-diff-minus';
    return (
      <span key={`diff-${idx}`}>
        {m[1]}
        <span className={cls}>{m[2]}</span>
      </span>
    );
  });
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

function normalizeToolName(name: string): string {
  return String(name || '').trim().toLowerCase();
}

type StructuredToolInput =
  | { kind: 'none' }
  | { kind: 'write'; filePath: string; content: string; lineCount: number }
  | { kind: 'edit'; filePath: string; oldText: string; newText: string; replaceAll: boolean };

function splitPreviewLines(text: string): string[] {
  if (!text) return [TOOL_PREVIEW_EMPTY_LINE];
  return text.split('\n').map((line) => line || TOOL_PREVIEW_EMPTY_LINE);
}

function buildStructuredToolInput(name: string, args?: Record<string, unknown>): StructuredToolInput {
  if (!args || typeof args !== 'object') return { kind: 'none' };
  const tool = normalizeToolName(name);
  const filePath = normalizePreviewText(args.file_path ?? args.path ?? args.filePath);

  if (tool === 'write') {
    const content = normalizePreviewText(args.content);
    if (!filePath && !content) return { kind: 'none' };
    const lineCount = content ? content.split('\n').length : 0;
    return { kind: 'write', filePath, content, lineCount };
  }

  if (tool === 'edit' || tool === 'edit-diff') {
    const oldText = normalizePreviewText(args.old_string ?? args.old_text);
    const newText = normalizePreviewText(args.new_string ?? args.new_text);
    const replaceAll = args.replace_all === true;
    if (!filePath && !oldText && !newText) return { kind: 'none' };
    return { kind: 'edit', filePath, oldText, newText, replaceAll };
  }

  return { kind: 'none' };
}

function ToolCodeLines({ text, symbol, tone }: { text: string; symbol: string; tone: 'write' | 'old' | 'new' }) {
  const lines = splitPreviewLines(text);
  return (
    <div className={`tool-code-block ${tone}`}>
      {lines.map((line, idx) => (
        <div className="tool-code-line" key={`${symbol}-${idx}`}>
          <span className="tool-code-prefix">{symbol}</span>
          <span className="tool-code-content">{line}</span>
        </div>
      ))}
    </div>
  );
}

function StructuredInputPanel({ input }: { input: StructuredToolInput }) {
  if (input.kind === 'none') return null;
  if (input.kind === 'write') {
    return (
      <div className="tool-structured">
        {!!input.filePath && (
          <div className="tool-structured-meta">
            <span>file_path: {input.filePath}</span>
            {input.lineCount > 0 && <span className="tool-structured-flag">{input.lineCount} lines</span>}
          </div>
        )}
        <ToolCodeLines text={input.content} symbol="+" tone="write" />
      </div>
    );
  }
  return (
    <div className="tool-structured">
      {!!input.filePath && (
        <div className="tool-structured-meta">
          <span>file_path: {input.filePath}</span>
          {input.replaceAll && <span className="tool-structured-flag">replace_all</span>}
        </div>
      )}
      {!!input.oldText && (
        <div className="tool-structured-section">
          <div className="tool-structured-section-title">old_string</div>
          <ToolCodeLines text={input.oldText} symbol="-" tone="old" />
        </div>
      )}
      {!!input.newText && (
        <div className="tool-structured-section">
          <div className="tool-structured-section-title">new_string</div>
          <ToolCodeLines text={input.newText} symbol="+" tone="new" />
        </div>
      )}
    </div>
  );
}

function getWriteInputText(args?: Record<string, unknown>): string {
  if (!args || typeof args !== 'object') return '';
  const filePath = normalizePreviewText(args.file_path ?? args.path ?? args.filePath);
  const content = normalizePreviewText(args.content);
  if (!filePath && !content) return '';
  const parts: string[] = [];
  if (filePath) parts.push(`file_path: ${filePath}`);
  if (content) {
    if (parts.length > 0) parts.push('');
    parts.push(content);
  }
  return parts.join('\n');
}

function getEditInputText(args?: Record<string, unknown>): string {
  if (!args || typeof args !== 'object') return '';
  const filePath = normalizePreviewText(args.file_path ?? args.path ?? args.filePath);
  const oldText = normalizePreviewText(args.old_string ?? args.old_text);
  const newText = normalizePreviewText(args.new_string ?? args.new_text);
  const replaceAll = args.replace_all === true;
  if (!filePath && !oldText && !newText) return '';
  const parts: string[] = [];
  if (filePath) parts.push(`file_path: ${filePath}`);
  if (replaceAll) parts.push('replace_all: true');
  if (oldText) {
    if (parts.length > 0) parts.push('');
    parts.push('--- old_string ---');
    parts.push(oldText);
  }
  if (newText) {
    if (parts.length > 0) parts.push('');
    parts.push('--- new_string ---');
    parts.push(newText);
  }
  return parts.join('\n');
}

function getInputText(name: string, args?: Record<string, unknown>): string {
  if (!args || typeof args !== 'object') return '';
  const tool = normalizeToolName(name);
  if (tool === 'write') {
    const writeText = getWriteInputText(args);
    if (writeText) return writeText;
  }
  if (tool === 'edit' || tool === 'edit-diff') {
    const editText = getEditInputText(args);
    if (editText) return editText;
  }
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

export const ToolGroupBlock = memo(function ToolGroupBlock({
  tools,
  agentName,
  dimmed = false,
  animate = false,
}: Props) {
  const [revealedToolCount, setRevealedToolCount] = useState(() => (
    animate ? Math.min(1, tools.length) : tools.length
  ));
  const nextToolDone = tools[revealedToolCount]?.done ?? true;

  useEffect(() => {
    if (!animate) {
      setRevealedToolCount(tools.length);
      return;
    }
    if (revealedToolCount > tools.length) {
      setRevealedToolCount(tools.length);
      return;
    }
    if (revealedToolCount === 0 && tools.length > 0) {
      setRevealedToolCount(1);
    }
  }, [animate, tools.length, revealedToolCount]);

  useEffect(() => {
    if (!animate) return;
    if (revealedToolCount >= tools.length) return;

    const nextIndex = revealedToolCount;
    let delay = TOOL_REVEAL_BASE_DELAY_MS + Math.min(4, Math.max(0, tools.length - nextIndex)) * 18;
    if (!nextToolDone) delay = Math.max(delay, TOOL_REVEAL_AFTER_THINKING_DELAY_MS);
    delay = Math.min(delay, TOOL_REVEAL_MAX_DELAY_MS);

    const timer = window.setTimeout(() => {
      setRevealedToolCount((count) => Math.min(tools.length, count + 1));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [animate, revealedToolCount, tools.length, nextToolDone]);

  const visibleTools = useMemo(
    () => (animate ? tools.slice(0, Math.max(0, revealedToolCount)) : tools),
    [animate, tools, revealedToolCount],
  );

  return (
    <div className={`tool-group proma-like${dimmed ? ' dimmed' : ''}${animate ? ' streaming' : ''}`}>
      <div className="tool-group-content">
        {visibleTools.map((tool, i) => (
          <ToolIndicator
            key={tool.toolUseId || `${tool.name}-${i}`}
            tool={tool}
            agentName={agentName}
            order={i}
          />
        ))}
      </div>
    </div>
  );
});

// ── ToolIndicator ──

const ToolIndicator = memo(function ToolIndicator({
  tool,
  agentName,
  order,
}: {
  tool: ToolCall;
  agentName: string;
  order: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const detail = extractToolDetail(tool.name, tool.args);
  const phase = (tool.done ? (tool.success ? 'done' : 'failed') : 'running') as 'running' | 'done' | 'failed';
  const label = getToolLabel(tool.name, phase, agentName, tool.args);
  const actionLine = buildToolActionLine(tool.name, phase, detail);
  const t = (window as any).t;
  const doneText = stripLeadingEmoji(t?.('tool._line.done') || '完成');
  const failedText = stripLeadingEmoji(t?.('tool._line.failed') || '失败');
  const outputText = useMemo(() => getOutputText(tool), [tool.resultText, tool.details]);
  const canExpand = !!outputText;

  // 如果 args 里有 tag 类型信息（如 agent 名）
  const tag = tool.args?.agentId as string | undefined;

  return (
    <div
      className={`tool-item ${expanded ? 'expanded' : ''}`}
      data-phase={phase}
      data-tool={tool.name}
      style={{ animationDelay: `${Math.min(order, 10) * 45}ms` }}
    >
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
        <span className="tool-desc">{renderActionLineWithDiffColors(actionLine)}</span>
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
          <pre className="tool-panel-pre">{outputText}</pre>
        </div>
      )}
    </div>
  );
});
