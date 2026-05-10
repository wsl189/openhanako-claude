import type { ChatListItem, ChatMessage, ContentBlock } from '../stores/chat-types';

export type DiffLine = { tone: 'add' | 'remove' | 'context'; text: string };

type StructuredPatchHunk = { lines?: unknown };

export type FileChangeSummary = {
  filePath: string;
  plus: number;
  minus: number;
  diffLines: DiffLine[];
};

export type MessageEditSummary = {
  messageId: string;
  files: FileChangeSummary[];
  totalPlus: number;
  totalMinus: number;
};

const CHAT_EDIT_SUPPORTED_EXTS = new Set([
  'md', 'markdown', 'txt', 'log',
  'js', 'jsx', 'mjs', 'cjs',
  'ts', 'tsx',
  'py', 'sh', 'bash', 'zsh', 'fish',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'css', 'scss', 'less',
  'html', 'htm', 'xml', 'svg',
  'sql',
  'c', 'cc', 'cpp', 'h', 'hpp', 'm', 'mm',
  'go', 'rs', 'java', 'kt', 'swift',
  'rb', 'php', 'lua', 'r',
  'ps1', 'bat',
]);

function normalizeToolName(name: string): string {
  const raw = String(name || '').trim().toLowerCase()
    .replace(/^functions\./, '')
    .replace(/^multi_tool_use\./, '');
  if (!raw.startsWith('mcp__')) return raw;
  const parts = raw.split('__').filter(Boolean);
  if (parts.length < 3) return raw;
  return parts.slice(2).join('__');
}

function isWriteLikeTool(name: string): boolean {
  const normalized = normalizeToolName(name).replace(/[^a-z0-9]+/g, '');
  return ['write', 'writefile', 'edit', 'editdiff', 'applypatch'].includes(normalized);
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function getToolDetails(tool: { details?: Record<string, unknown> }): Record<string, unknown> | null {
  return getRecord(tool.details);
}

function readStringFromRecord(record: Record<string, unknown> | null, keys: string[]): string {
  if (!record) return '';
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return value;
    }
  }
  return '';
}

function getFilePathFromTool(tool: {
  args?: Record<string, unknown>;
  details?: Record<string, unknown>;
}): string {
  const args = getRecord(tool.args);
  const details = getToolDetails(tool);
  return readStringFromRecord(args, ['file_path', 'filePath', 'filepath', 'path'])
    || readStringFromRecord(details, ['filePath', 'file_path', 'filepath', 'path']);
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

function splitLines(text: string): string[] {
  if (!text) return [''];
  return text.split('\n');
}

function isEditableTextFile(filePath: string): boolean {
  const normalized = String(filePath || '').trim();
  if (!normalized) return false;
  const name = normalized.split(/[\\/]/).pop()?.toLowerCase() || '';
  if (!name) return false;
  if (name === 'dockerfile' || name === 'makefile') return true;
  const idx = name.lastIndexOf('.');
  if (idx < 0 || idx === name.length - 1) return false;
  const ext = name.slice(idx + 1).toLowerCase();
  return CHAT_EDIT_SUPPORTED_EXTS.has(ext);
}

export function basename(filePath: string): string {
  const seg = String(filePath || '').split(/[\\/]/).pop();
  return seg || filePath;
}

export function buildDiffContent(lines: DiffLine[]): string {
  return lines.map((line) => {
    const prefix = line.tone === 'add' ? '+' : (line.tone === 'remove' ? '-' : ' ');
    return `${prefix}${line.text}`;
  }).join('\n');
}

function extractStructuredPatch(tool: {
  details?: Record<string, unknown>;
}): StructuredPatchHunk[] {
  const details = getToolDetails(tool);
  const raw = details?.structuredPatch || details?.structured_patch;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => item && typeof item === 'object') as StructuredPatchHunk[];
}

function appendDiffLinesFromStructuredPatch(target: FileChangeSummary, hunks: StructuredPatchHunk[]): boolean {
  let touched = false;
  for (const hunk of hunks) {
    const lines = Array.isArray(hunk.lines) ? hunk.lines : [];
    for (const rawLine of lines) {
      const line = String(rawLine ?? '');
      if (!line || line.startsWith('\\ No newline')) continue;
      if (line.startsWith('+') && !line.startsWith('+++')) {
        target.plus += 1;
        target.diffLines.push({ tone: 'add', text: line.slice(1) });
        touched = true;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        target.minus += 1;
        target.diffLines.push({ tone: 'remove', text: line.slice(1) });
        touched = true;
      } else if (line.startsWith(' ')) {
        target.diffLines.push({ tone: 'context', text: line.slice(1) });
      } else if (line.startsWith('@@')) {
        target.diffLines.push({ tone: 'context', text: line });
      }
    }
  }
  return touched;
}

function getOldAndNewText(tool: {
  args?: Record<string, unknown>;
  details?: Record<string, unknown>;
}, normalizedToolName: string): { oldText: string; newText: string } {
  const args = getRecord(tool.args);
  const details = getToolDetails(tool);
  const oldText = readStringFromRecord(args, ['old_string', 'oldString', 'old_text', 'oldText'])
    || readStringFromRecord(details, ['originalFile', 'old_string', 'oldString', 'old_text', 'oldText']);
  const newText = (normalizedToolName === 'write'
    ? readStringFromRecord(args, ['content', 'new_string', 'newString', 'new_text', 'newText'])
    : readStringFromRecord(args, ['new_string', 'newString', 'new_text', 'newText', 'content']))
    || readStringFromRecord(details, ['content', 'new_string', 'newString', 'new_text', 'newText']);
  return { oldText, newText };
}

function summarizeAssistantMessageEdits(message: ChatMessage): MessageEditSummary | null {
  if (message.role !== 'assistant' || !Array.isArray(message.blocks)) return null;
  const fileMap = new Map<string, FileChangeSummary>();

  const blocks = message.blocks as ContentBlock[];
  for (const block of blocks) {
    if (block.type !== 'tool_group') continue;
    for (const tool of block.tools) {
      if (!tool.done || !tool.success) continue;
      const normalizedTool = normalizeToolName(tool.name);
      if (!isWriteLikeTool(normalizedTool)) continue;

      const filePath = getFilePathFromTool(tool);
      if (!filePath || !isEditableTextFile(filePath)) continue;
      const target = fileMap.get(filePath) || { filePath, plus: 0, minus: 0, diffLines: [] };

      const structuredPatch = extractStructuredPatch(tool);
      const hasPatchStats = appendDiffLinesFromStructuredPatch(target, structuredPatch);
      if (!hasPatchStats) {
        const { oldText, newText } = getOldAndNewText(tool, normalizedTool);
        if (!oldText && !newText) continue;
        target.plus += lineCount(newText);
        target.minus += lineCount(oldText);
        for (const line of splitLines(oldText)) target.diffLines.push({ tone: 'remove', text: line });
        for (const line of splitLines(newText)) target.diffLines.push({ tone: 'add', text: line });
      }
      fileMap.set(filePath, target);
    }
  }

  const files = Array.from(fileMap.values());
  if (files.length === 0) return null;
  return {
    messageId: String(message.id || ''),
    files,
    totalPlus: files.reduce((sum, item) => sum + item.plus, 0),
    totalMinus: files.reduce((sum, item) => sum + item.minus, 0),
  };
}

export function extractLatestEditSummary(items: ChatListItem[] | undefined): MessageEditSummary | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (!item || item.type !== 'message') continue;
    if (item.data.role !== 'assistant') return null;
    return summarizeAssistantMessageEdits(item.data);
  }
  return null;
}
