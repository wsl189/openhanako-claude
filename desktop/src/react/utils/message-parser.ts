/**
 * message-parser.ts — 消息解析工具函数
 *
 * 从 app-messages-shim.ts 和 chat-render-shim.ts 提取，
 * 供 React 组件和 history-builder 共用。
 */

// ── Mood 解析 ──

const YUAN_LABELS: Record<string, string> = { hanako: '✿ MOOD', butter: '❊ PULSE', ming: '◈ REFLECT' };

export function moodLabel(yuan: string): string {
  return YUAN_LABELS[yuan] || YUAN_LABELS.hanako;
}

export function parseMoodFromContent(content: string): { mood: string | null; yuan: string | null; text: string } {
  if (!content) return { mood: null, yuan: null, text: '' };
  // 兼容旧接口：不再解析/剥离 mood 标签
  return { mood: null, yuan: null, text: content };
}

// ── Xing 解析 ──

export interface ParsedXing { title: string; content: string }

export function parseXingFromContent(text: string): { xingBlocks: ParsedXing[]; text: string } {
  const xingRe = /<xing\s+title=["\u201C\u201D]([^"\u201C\u201D]*)["\u201C\u201D]>([\s\S]*?)<\/xing>/g;
  const blocks: ParsedXing[] = [];
  let match;
  while ((match = xingRe.exec(text)) !== null) {
    blocks.push({ title: match[1], content: match[2].trim() });
  }
  const remaining = text.replace(xingRe, '').replace(/^\n+/, '').trim();
  return { xingBlocks: blocks, text: remaining };
}

// ── 用户附件解析 ──

export interface ParsedAttachments {
  text: string;
  files: Array<{ path: string; name: string; isDirectory: boolean }>;
  deskContext: { dir: string; fileCount: number } | null;
}

export function parseUserAttachments(content: string): ParsedAttachments {
  if (!content) return { text: '', files: [], deskContext: null };
  const lines = content.split('\n');
  const textLines: string[] = [];
  const files: Array<{ path: string; name: string; isDirectory: boolean }> = [];
  const attachRe = /^\[(附件|目录)\]\s+(.+)$/;
  let deskContext: { dir: string; fileCount: number } | null = null;
  let inDeskBlock = false;

  for (const line of lines) {
    const deskMatch = line.match(/^\[当前书桌目录\]\s+(.+)$/);
    if (deskMatch) {
      inDeskBlock = true;
      deskContext = { dir: deskMatch[1].trim(), fileCount: 0 };
      continue;
    }
    if (inDeskBlock) {
      if (line.startsWith('  ') || line.startsWith('...')) {
        if (line.startsWith('  ')) deskContext!.fileCount++;
        continue;
      }
      inDeskBlock = false;
    }

    const m = line.match(attachRe);
    if (m) {
      const isDir = m[1] === '目录';
      const p = m[2].trim();
      const name = p.split('/').pop() || p;
      files.push({ path: p, name, isDirectory: isDir });
    } else {
      textLines.push(line);
    }
  }
  const text = textLines.join('\n').replace(/\n+$/, '').trim();
  return { text, files, deskContext };
}

// ── 工具详情提取 ──

const TOOL_DETAIL_PATH_MAX = 72;
const TOOL_DETAIL_COMMAND_MAX = 120;
const TOOL_DETAIL_TEXT_MAX = 96;

export function truncatePath(p: string): string {
  if (!p || p.length <= TOOL_DETAIL_PATH_MAX) return p;
  return '…' + p.slice(-(TOOL_DETAIL_PATH_MAX - 1));
}

export function extractHostname(u: string): string {
  if (!u) return '';
  try { return new URL(u).hostname; } catch { return u; }
}

export function truncateHead(s: string, max: number): string {
  if (!s || s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function firstArrayField(value: unknown, field: string): string {
  if (!Array.isArray(value)) return '';
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const text = asText((item as Record<string, unknown>)[field]);
    if (text) return text;
  }
  return '';
}

function summarizeStringArray(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const items = value
    .map((item) => asText(item))
    .filter(Boolean)
    .slice(0, 3);
  if (items.length === 0) return '';
  const suffix = value.length > items.length ? ` +${value.length - items.length}` : '';
  return `${items.join(', ')}${suffix}`;
}

function extractStructuredDetail(args: Record<string, unknown>): string {
  const searchQ = firstArrayField(args.search_query, 'q');
  if (searchQ) return truncateHead(searchQ, TOOL_DETAIL_TEXT_MAX);

  const imageQ = firstArrayField(args.image_query, 'q');
  if (imageQ) return truncateHead(imageQ, TOOL_DETAIL_TEXT_MAX);

  const weatherLocation = firstArrayField(args.weather, 'location');
  if (weatherLocation) return truncateHead(weatherLocation, TOOL_DETAIL_TEXT_MAX);

  const financeTicker = firstArrayField(args.finance, 'ticker');
  if (financeTicker) return truncateHead(financeTicker, TOOL_DETAIL_TEXT_MAX);

  const sportsTeam = firstArrayField(args.sports, 'team');
  if (sportsTeam) return truncateHead(sportsTeam, TOOL_DETAIL_TEXT_MAX);

  const openRef = firstArrayField(args.open, 'ref_id');
  if (openRef) return truncateHead(openRef, TOOL_DETAIL_TEXT_MAX);

  const findPattern = firstArrayField(args.find, 'pattern');
  if (findPattern) return truncateHead(findPattern, TOOL_DETAIL_TEXT_MAX);

  const clickRef = firstArrayField(args.click, 'ref_id');
  const clickId = firstArrayField(args.click, 'id');
  if (clickRef || clickId) return truncateHead([clickRef, clickId].filter(Boolean).join(' #'), TOOL_DETAIL_TEXT_MAX);

  return '';
}

function extractGenericDetail(args: Record<string, unknown>): string {
  const structured = extractStructuredDetail(args);
  if (structured) return structured;

  const scalar = (key: string): string => asText(args[key]);
  const skillLike = scalar('skill')
    || scalar('skill_name')
    || scalar('skillName');
  if (skillLike) return truncateHead(skillLike, TOOL_DETAIL_TEXT_MAX);

  const skillPathLike = scalar('skill_path') || scalar('skillPath');
  if (skillPathLike) {
    const cleaned = skillPathLike.replace(/\\/g, '/').replace(/\/+$/, '');
    const lastSeg = cleaned.split('/').filter(Boolean).pop() || cleaned;
    if (lastSeg) return truncateHead(lastSeg, TOOL_DETAIL_TEXT_MAX);
  }

  const githubUrlLike = scalar('github_url') || scalar('githubUrl');
  if (githubUrlLike) {
    try {
      const u = new URL(githubUrlLike);
      const segs = u.pathname.split('/').filter(Boolean);
      if (segs.length >= 2) return truncateHead(`${segs[0]}/${segs[1].replace(/\.git$/i, '')}`, TOOL_DETAIL_TEXT_MAX);
      if (segs.length === 1) return truncateHead(segs[0].replace(/\.git$/i, ''), TOOL_DETAIL_TEXT_MAX);
    } catch {
      return truncateHead(githubUrlLike, TOOL_DETAIL_TEXT_MAX);
    }
  }

  const pathLike = scalar('path') || scalar('file_path') || scalar('cwd');
  if (pathLike) return truncatePath(pathLike);

  const cmdLike = scalar('cmd') || scalar('command');
  if (cmdLike) return truncateHead(cmdLike, TOOL_DETAIL_COMMAND_MAX);

  const taskLike = scalar('task') || scalar('prompt');
  if (taskLike) return truncateHead(taskLike, TOOL_DETAIL_TEXT_MAX);

  const queryLike = scalar('query') || scalar('q') || scalar('pattern');
  if (queryLike) return truncateHead(queryLike, TOOL_DETAIL_TEXT_MAX);

  const urlLike = scalar('url');
  if (urlLike) return truncateHead(extractHostname(urlLike), TOOL_DETAIL_TEXT_MAX);

  const channelLike = scalar('channel') || scalar('channel_id') || scalar('channelId');
  if (channelLike) return truncateHead(channelLike, TOOL_DETAIL_TEXT_MAX);

  const agentLike = scalar('agent')
    || scalar('to')
    || scalar('target_agent')
    || scalar('targetAgent')
    || summarizeStringArray(args.agents);
  if (agentLike) return truncateHead(agentLike, TOOL_DETAIL_TEXT_MAX);

  const titleLike = scalar('title') || scalar('label') || scalar('name');
  if (titleLike) return truncateHead(titleLike, TOOL_DETAIL_TEXT_MAX);

  const idLike = scalar('id') || scalar('job_id') || scalar('jobId') || scalar('shortcut_id') || scalar('shortcutId');
  if (idLike) return truncateHead(idLike, TOOL_DETAIL_TEXT_MAX);

  const keyLike = scalar('key') || scalar('settingKey');
  if (keyLike) return truncateHead(keyLike, TOOL_DETAIL_TEXT_MAX);

  const targetLike = scalar('target') || scalar('ref_id');
  if (targetLike) return truncateHead(targetLike, TOOL_DETAIL_TEXT_MAX);

  const locationLike = scalar('location') || scalar('ticker');
  if (locationLike) return truncateHead(locationLike, TOOL_DETAIL_TEXT_MAX);

  const textLike = scalar('message') || scalar('body') || scalar('content') || scalar('text') || scalar('value');
  if (textLike) return truncateHead(textLike, TOOL_DETAIL_TEXT_MAX);

  const actionLike = scalar('action') || scalar('mode');
  if (actionLike) return truncateHead(actionLike, TOOL_DETAIL_TEXT_MAX);

  return '';
}

export function extractToolDetail(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  const tool = String(name || '').toLowerCase();
  switch (tool) {
    case 'read':
    case 'write':
    case 'edit':
    case 'edit-diff':
    {
      const filePath = (args.file_path || args.path || args.filePath || '') as string;
      const pathText = truncatePath(filePath);
      if (tool === 'write') {
        const content = typeof args.content === 'string' ? args.content : '';
        const lineCount = content ? content.split('\n').length : 0;
        return lineCount > 0 ? `${pathText} +${lineCount}` : pathText;
      }
      if (tool === 'edit' || tool === 'edit-diff') {
        const oldText = (args.old_string || args.old_text || '') as string;
        const newText = (args.new_string || args.new_text || '') as string;
        const oldLines = oldText ? oldText.split('\n').length : 0;
        const newLines = newText ? newText.split('\n').length : 0;
        if (newLines > 0 || oldLines > 0) {
          const stats = [newLines > 0 ? `+${newLines}` : '', oldLines > 0 ? `-${oldLines}` : '']
            .filter(Boolean)
            .join(' ');
          return stats ? `${pathText} ${stats}` : pathText;
        }
      }
      return pathText;
    }
    case 'bash':
    case 'exec_command':
      return truncateHead(((args.command || args.cmd || '') as string), TOOL_DETAIL_COMMAND_MAX);
    case 'glob':
    case 'find':
      return (args.pattern || '') as string;
    case 'grep':
      return truncateHead((args.pattern || '') as string, TOOL_DETAIL_TEXT_MAX) +
        (args.path ? ` in ${truncatePath(args.path as string)}` : '');
    case 'ls':
      return truncatePath((args.path || '') as string);
    case 'browser':
      return extractHostname((args.url || '') as string) || truncateHead((args.action || '') as string, TOOL_DETAIL_TEXT_MAX);
    case 'search_memory':
      return truncateHead((args.query || '') as string, TOOL_DETAIL_TEXT_MAX);
    case 'generate_images':
      return truncateHead((args.prompt || '') as string, TOOL_DETAIL_TEXT_MAX);
    default:
      return extractGenericDetail(args);
  }
}
