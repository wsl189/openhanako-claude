/**
 * StreamBufferManager — per-session 流式事件节流缓冲
 *
 * WS 事件到达时写入 buffer（纯 JS 对象，不触发 React），
 * 每 FLUSH_INTERVAL ms 批量 flush 到 Zustand store。
 *
 * 设计为 singleton，不依赖 React 组件生命周期。
 * app-ws-shim 直接调用 streamBufferManager.handle(msg)。
 */

import type { ChatMessage, ChatListItem, ContentBlock } from '../stores/chat-types';
import { useStore } from '../stores';
import { renderMarkdown } from '../utils/markdown';
import { applyChatStreamLiveEvent, upsertCronConfirmation } from '../utils/chat-stream-reducer';

/* eslint-disable @typescript-eslint/no-explicit-any */

// 更高刷新频率，让前端流式文字更接近连续输出观感
const FLUSH_INTERVAL = 56;
const NAMED_TOOL_TAGS = [
  'glob',
  'read',
  'read_file',
  'write',
  'write_file',
  'edit',
  'edit_file',
  'bash',
  'grep',
  'find',
  'find_files',
  'list_files',
  'ls',
  'exec',
  'exec_command',
  'command',
];

export function stripSdkDiagnosticLines(text: string): string {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => !line.includes('[ede_diagnostic]'))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n');
}

export function stripStreamToolMarkup(text: string): string {
  return String(text || '')
    .replace(/```[\s\S]*?(?:<assistant\b[^>]*\bto=|<tool_use\b|<minimax:tool_call\b|<function_call\b|<function_calls\b)[\s\S]*?```/gi, ' ')
    .replace(/```[\s\S]*?\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\][\s\S]*?```/gi, ' ')
    .replace(/<assistant\b[^>]*\bto\s*=\s*(?:"[^"]+"|'[^']+'|“[^”]+”|‘[^’]+’|[^\s>]+)[^>]*>[\s\S]*?<\/assistant>\s*/gi, ' ')
    .replace(/<tool_use\b[^>]*\bname\s*=\s*(?:"[^"]+"|'[^']+'|“[^”]+”|‘[^’]+’|[^\s>]+)[^>]*>[\s\S]*?<\/tool_use>\s*/gi, ' ')
    .replace(/<minimax:tool_call\b[^>]*>[\s\S]*?<\/minimax:tool_call>\s*/gi, ' ')
    .replace(/<function_call\b[^>]*>[\s\S]*?<\/function_call>\s*/gi, ' ')
    .replace(/<function_calls\b[^>]*>[\s\S]*?<\/function_calls>\s*/gi, ' ')
    .replace(/(?:^|\n)\s*function_call\s*\n[\s\S]*?<\/function_call>\s*/gi, '\n')
    .replace(new RegExp(
      `<(?:${NAMED_TOOL_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?<\\/(?:${NAMED_TOOL_TAGS.join('|')})>\\s*`,
      'gi',
    ), ' ')
    .replace(new RegExp(`</(?:${NAMED_TOOL_TAGS.join('|')})\\s*>`, 'gi'), ' ')
    .replace(new RegExp(`<(?:${NAMED_TOOL_TAGS.join('|')})\\b[^>]*>`, 'gi'), ' ')
    .replace(/<\/?function_call\b[^>]*>\s*/gi, ' ')
    .replace(/<\/?function_calls\b[^>]*>\s*/gi, ' ')
    .replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter>\s*/gi, ' ')
    .replace(/<\/?parameter\b[^>]*>\s*/gi, ' ')
    .replace(/<\/?invoke\b[^>]*>\s*/gi, ' ')
    .replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]\s*/gi, ' ')
    .replace(/(?:^|\n)\s*tool_call\s*:?[^\n]*(?:\n(?!\s*tool_call_end\b)[^\n]*)*\n\s*tool_call_end\s*:?[^\n]*(?=\n|$)/gi, '\n')
    .replace(/^\s*tool_call(?:_start|_end)?\s*:?[^\n]*$/gim, '')
    .replace(/\bto\s*=\s*[A-Za-z_][\w-]*\b/gi, ' ')
    .replace(/\bcode omitted\b/gi, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

interface Buffer {
  sessionPath: string;
  textAcc: string;
  textAnchorIndex: number | null;
  thinkingAcc: string;
  hadThinking: boolean;
  sawThinkingStreamEvent: boolean;
  xingAcc: string;
  xingTitle: string;
  liveBlocks: ContentBlock[];
  inThinking: boolean;
  inXing: boolean;
  lastFlushTime: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** 当前 turn 是否已追加了空 assistant message */
  messageAppended: boolean;
  /** 最近一次 assistant sdk_message 的离散消息 key（messageId/uuid） */
  lastSdkAssistantMessageKey: string | null;
}

function isReasoningLikeType(type: unknown): boolean {
  const normalized = String(type || '').toLowerCase();
  if (!normalized || normalized === 'text') return false;
  return /(reason|think|analysis|commentary|summary)/.test(normalized);
}

function pickSnapshotText(block: any): string {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  if (typeof block.reasoning === 'string') return block.reasoning;
  if (typeof block.thinking === 'string') return block.thinking;
  if (typeof block.output_text === 'string') return block.output_text;
  return '';
}

function extractSnapshotTextContent(content: any[]): string {
  let text = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use') continue;
    const part = pickSnapshotText(block);
    if (!part) continue;
    if (isReasoningLikeType(block.type)) continue;
    text += part;
  }
  return text;
}

function extractSnapshotThinkingSegments(content: any[]): string[] {
  const thinkingSegments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const part = pickSnapshotText(block);
    if (!part) continue;
    if (block.type === 'thinking' || isReasoningLikeType(block.type)) {
      thinkingSegments.push(part);
    }
  }
  return thinkingSegments;
}

function extractSnapshotToolUses(content: any[]): Array<{ id: string; name: string; args?: Record<string, unknown> }> {
  const out: Array<{ id: string; name: string; args?: Record<string, unknown> }> = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'tool_use' || !block.id) continue;
    out.push({
      id: String(block.id),
      name: String(block.name || ''),
      args: (block.input && typeof block.input === 'object') ? block.input : undefined,
    });
  }
  return out;
}

function hasRenderableAssistantSnapshot(content: any[]): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  if (extractSnapshotToolUses(content).length > 0) return true;
  if (stripStreamToolMarkup(stripSdkDiagnosticLines(extractSnapshotTextContent(content))).trim()) return true;
  const snapshotThinking = extractSnapshotThinkingSegments(content).join('');
  if (stripSdkDiagnosticLines(snapshotThinking).trim()) return true;
  return false;
}

function extractSdkToolResults(content: any[]): Array<{ toolCallId: string; success: boolean }> {
  const out: Array<{ toolCallId: string; success: boolean }> = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'tool_result' || !block.tool_use_id) continue;
    out.push({
      toolCallId: String(block.tool_use_id),
      success: block.is_error !== true,
    });
  }
  return out;
}

function mergeSnapshotText(acc: string, snapshotText: string): string {
  if (!snapshotText) return acc;
  if (!acc) return snapshotText;
  if (snapshotText.startsWith(acc)) return snapshotText;
  if (acc.startsWith(snapshotText)) return acc;
  return mergeDelta(acc, snapshotText);
}

export function mergeDelta(acc: string, rawDelta: unknown): string {
  const delta = typeof rawDelta === 'string' ? rawDelta : '';
  if (!delta) return acc;
  if (!acc) return delta;

  // 完全重复 chunk：忽略
  if (acc.endsWith(delta)) return acc;
  // 累积式 delta（provider 返回“到当前为止的完整内容”）
  if (delta.startsWith(acc)) return delta;

  // 后缀/前缀重叠拼接，避免重复片段
  const max = Math.min(acc.length, delta.length);
  for (let k = max; k > 0; k--) {
    if (acc.slice(-k) === delta.slice(0, k)) {
      return acc + delta.slice(k);
    }
  }

  return acc + delta;
}

function maybeApproveCronCard(blocks: ContentBlock[], msg: any): ContentBlock[] {
  if (msg.name !== 'cron' || !msg.success || msg.details?.action !== 'added') return blocks;

  const job = (msg.details?.job || {}) as Record<string, unknown>;
  const jobData = {
    type: String(job.type || msg.args?.type || ''),
    schedule: job.schedule ?? msg.args?.schedule,
    prompt: String(job.prompt || msg.args?.prompt || ''),
    label: String(job.label || msg.args?.label || ''),
  };

  return upsertCronConfirmation(blocks, {
    confirmId: undefined,
    jobData,
    status: 'approved',
  });
}

function createBuffer(sessionPath: string): Buffer {
  return {
    sessionPath,
    textAcc: '',
    textAnchorIndex: null,
    thinkingAcc: '',
    hadThinking: false,
    sawThinkingStreamEvent: false,
    xingAcc: '',
    xingTitle: '',
    liveBlocks: [],
    inThinking: false,
    inXing: false,
    lastFlushTime: 0,
    flushTimer: null,
    messageAppended: false,
    lastSdkAssistantMessageKey: null,
  };
}

function countSealedThinkingBlocks(buf: Buffer): number {
  let count = 0;
  for (const block of buf.liveBlocks) {
    if (block?.type === 'thinking' && block.sealed) count += 1;
  }
  return count;
}

function appendSealedThinkingSegmentsForDiscreteMessage(
  buf: Buffer,
  thinkingSegments: string[],
  options: { allowUpdateLastSealed: boolean },
): void {
  for (const segment of thinkingSegments) {
    const thinking = sanitizeBufferedThinkingText(String(segment || ''));
    if (!thinking.trim()) continue;

    const last = buf.liveBlocks[buf.liveBlocks.length - 1];
    if (options.allowUpdateLastSealed && last?.type === 'thinking' && last.sealed) {
      const prev = String(last.content || '');
      if (!prev) {
        last.content = thinking;
        continue;
      }
      // 仅做“重复/累计快照”去重，不做任意拼接。
      if (thinking === prev || prev.startsWith(thinking)) {
        continue;
      }
      if (thinking.startsWith(prev)) {
        last.content = thinking;
        continue;
      }
    }

    buf.liveBlocks.push({
      type: 'thinking',
      content: thinking,
      sealed: true,
    });
  }
}

function applySdkMessageThinking(
  buf: Buffer,
  snapshotThinkingSegments: string[],
  sdkMessageKey: string | null,
  options: { preferUpdateLastSealed: boolean },
): void {
  if (snapshotThinkingSegments.length === 0) return;

  const sameSdkMessage = !!(
    sdkMessageKey
    && buf.lastSdkAssistantMessageKey
    && buf.lastSdkAssistantMessageKey === sdkMessageKey
  );

  buf.hadThinking = true;
  // sdk_message 的 assistant 内容是离散消息，不是累计快照。
  // 这里把每段 thinking 作为独立块追加，避免后续段落回写到第一段。
  buf.sawThinkingStreamEvent = true;
  const allowUpdateLastSealed = sameSdkMessage || options.preferUpdateLastSealed;

  if (buf.inThinking) {
    const closedThinkingSegments = snapshotThinkingSegments.slice(0, -1);
    const inProgressSegment = snapshotThinkingSegments[snapshotThinkingSegments.length - 1] || '';
    if (closedThinkingSegments.length > 0) {
      appendSealedThinkingSegmentsForDiscreteMessage(buf, closedThinkingSegments, {
        allowUpdateLastSealed,
      });
    }
    const sanitizedInProgress = sanitizeBufferedThinkingText(inProgressSegment);
    if (sanitizedInProgress.trim()) {
      buf.thinkingAcc = mergeSnapshotText(buf.thinkingAcc, sanitizedInProgress);
    }
    return;
  }

  appendSealedThinkingSegmentsForDiscreteMessage(buf, snapshotThinkingSegments, {
    allowUpdateLastSealed,
  });
  buf.thinkingAcc = '';
}

function hasBufferedRenderableState(buf: Buffer): boolean {
  const hasText = !!String(buf.textAcc || '').trim();
  const hasThinking = !!sanitizeBufferedThinkingText(String(buf.thinkingAcc || '')).trim();
  const hasXing = !!String(buf.xingAcc || '').trim();
  return !!(
    hasText
    || hasThinking
    || hasXing
    || buf.liveBlocks.length > 0
    || buf.inThinking
    || buf.inXing
  );
}

function hasRenderableTextHtml(html: string): boolean {
  const plain = String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return !!plain;
}

function sanitizeBufferedStreamText(text: string): string {
  return stripStreamToolMarkup(stripSdkDiagnosticLines(text))
    .replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, '');
}

function sanitizeBufferedThinkingText(text: string): string {
  return stripStreamToolMarkup(stripSdkDiagnosticLines(text));
}

function buildTextBlockFromBufferedText(text: string): Extract<ContentBlock, { type: 'text' }> | null {
  const displayText = sanitizeBufferedStreamText(text);
  if (!displayText.trim()) return null;
  return { type: 'text', html: renderMarkdown(displayText), raw: displayText };
}

function appendSealedThinkingBlock(buf: Buffer, rawThinking: string): void {
  const thinking = sanitizeBufferedThinkingText(String(rawThinking || ''));
  if (!thinking.trim()) return;

  buf.liveBlocks.push({
    type: 'thinking',
    content: thinking,
    sealed: true,
  });
}

function finalizeBufferedTextSegment(buf: Buffer): void {
  if (!buf.textAcc) {
    buf.textAnchorIndex = null;
    return;
  }
  const rawText = buf.textAcc;
  const anchor = buf.textAnchorIndex;
  buf.textAcc = '';
  buf.textAnchorIndex = null;

  const block = buildTextBlockFromBufferedText(rawText);
  if (!block) return;

  const insertAt = Number.isInteger(anchor)
    ? Math.max(0, Math.min(Number(anchor), buf.liveBlocks.length))
    : buf.liveBlocks.length;
  buf.liveBlocks = [
    ...buf.liveBlocks.slice(0, insertAt),
    block,
    ...buf.liveBlocks.slice(insertAt),
  ];
}

function finalizeBufferedThinkingSegment(buf: Buffer): void {
  const thinking = String(buf.thinkingAcc || '');
  buf.thinkingAcc = '';
  appendSealedThinkingBlock(buf, thinking);
}

function closeOpenThinkingIfNeeded(buf: Buffer): void {
  if (!buf.inThinking) return;
  buf.inThinking = false;
  finalizeBufferedThinkingSegment(buf);
}

function insertSealedThinkingBlockBeforeTextLike(buf: Buffer, thinking: string): void {
  if (!thinking.trim()) return;
  const firstTextLikeIdx = buf.liveBlocks.findIndex((block) => (
    block.type === 'text'
    || block.type === 'tool_group'
    || block.type === 'xing'
    || block.type === 'file_output'
    || block.type === 'artifact'
    || block.type === 'browser_screenshot'
    || block.type === 'skill'
    || block.type === 'cron_confirm'
    || block.type === 'settings_confirm'
  ));
  const insertAt = firstTextLikeIdx >= 0 ? firstTextLikeIdx : buf.liveBlocks.length;
  buf.liveBlocks = [
    ...buf.liveBlocks.slice(0, insertAt),
    { type: 'thinking', content: thinking, sealed: true },
    ...buf.liveBlocks.slice(insertAt),
  ];
}

function upsertSealedThinkingSegmentsFromSnapshot(buf: Buffer, snapshotThinkingSegments: string[]): void {
  const segments = snapshotThinkingSegments
    .map((segment) => sanitizeBufferedThinkingText(String(segment || '')))
    .filter((segment) => !!segment.trim());
  if (!segments.length) return;

  const existingSealedIndices: number[] = [];
  for (let i = 0; i < buf.liveBlocks.length; i += 1) {
    const block = buf.liveBlocks[i];
    if (block?.type === 'thinking' && block.sealed) {
      existingSealedIndices.push(i);
    }
  }

  for (let i = 0; i < segments.length; i += 1) {
    const thinking = segments[i]!;
    if (i < existingSealedIndices.length) {
      const blockIdx = existingSealedIndices[i]!;
      const current = buf.liveBlocks[blockIdx] as Extract<ContentBlock, { type: 'thinking' }>;
      current.content = mergeSnapshotText(current.content || '', thinking);
      continue;
    }
    insertSealedThinkingBlockBeforeTextLike(buf, thinking);
  }
}

function applySnapshotThinking(buf: Buffer, content: any[]): void {
  const snapshotThinkingSegments = extractSnapshotThinkingSegments(content);
  if (snapshotThinkingSegments.length === 0) {
    if (!buf.inThinking) buf.thinkingAcc = '';
    return;
  }

  // 当本轮已收到显式 thinking_start/delta/end 时，
  // 以事件流分段为准，避免 snapshot 的累计 thinking 把多段合并回首段。
  if (buf.sawThinkingStreamEvent) {
    const knownSegments = countSealedThinkingBlocks(buf) + (buf.inThinking ? 1 : 0);
    if (snapshotThinkingSegments.length <= knownSegments) return;
  }

  buf.hadThinking = true;
  if (buf.inThinking) {
    const closedThinkingSegments = snapshotThinkingSegments.slice(0, -1);
    const inProgressSegment = snapshotThinkingSegments[snapshotThinkingSegments.length - 1] || '';
    if (closedThinkingSegments.length > 0) {
      upsertSealedThinkingSegmentsFromSnapshot(buf, closedThinkingSegments);
    }
    const sanitizedInProgress = sanitizeBufferedThinkingText(inProgressSegment);
    if (sanitizedInProgress.trim()) {
      buf.thinkingAcc = mergeSnapshotText(buf.thinkingAcc, sanitizedInProgress);
    }
    return;
  }

  upsertSealedThinkingSegmentsFromSnapshot(buf, snapshotThinkingSegments);
  buf.thinkingAcc = '';
}

function isRenderableBlock(block: ContentBlock): boolean {
  if (!block) return false;
  switch (block.type) {
    case 'text':
      return hasRenderableTextHtml(block.html);
    case 'thinking':
      return !!String(block.content || '').trim();
    case 'xing':
      return !!String(block.content || '').trim();
    case 'tool_group':
      return Array.isArray(block.tools) && block.tools.length > 0;
    default:
      return true;
  }
}

function resetBufferTurnState(buf: Buffer): void {
  buf.textAcc = '';
  buf.textAnchorIndex = null;
  buf.thinkingAcc = '';
  buf.hadThinking = false;
  buf.sawThinkingStreamEvent = false;
  buf.xingAcc = '';
  buf.xingTitle = '';
  buf.liveBlocks = [];
  buf.inThinking = false;
  buf.inXing = false;
  buf.messageAppended = false;
  buf.lastSdkAssistantMessageKey = null;
}

class StreamBufferManager {
  private buffers = new Map<string, Buffer>();

  /** 获取或创建 session buffer */
  private getBuffer(sessionPath: string): Buffer {
    let buf = this.buffers.get(sessionPath);
    if (!buf) {
      buf = createBuffer(sessionPath);
      this.buffers.set(sessionPath, buf);
    }
    return buf;
  }

  /** 确保 store 中已为该 session 追加了一条空 assistant message */
  private ensureMessage(buf: Buffer): void {
    const store = useStore.getState();
    let session = store.chatSessions[buf.sessionPath];
    if (!session) {
      // 新会话在首轮 streaming 时，chatSessions 可能尚未初始化；
      // 先创建空会话，确保 thinking/tool 块可以立即渲染，而不是等 turn_end 后一次性出现。
      store.initSession(buf.sessionPath, [], false);
      session = useStore.getState().chatSessions[buf.sessionPath];
      if (!session) return;
    }

    const items = Array.isArray(session.items) ? session.items : [];
    const last = items[items.length - 1];
    if (last?.type === 'message' && last.data.role === 'assistant') {
      // 真实列表尾部已是 assistant 消息（即使中间经过 compaction 标记切分），
      // 直接复用，避免重复 append。
      buf.messageAppended = true;
      return;
    }

    const id = `stream-${Date.now()}`;
    const msg: ChatMessage = { id, role: 'assistant', blocks: [] };
    store.appendItem(buf.sessionPath, { type: 'message', data: msg });
    buf.messageAppended = true;
  }

  /** 外部可调用：当前轮开始时立即创建 assistant 占位消息（头像/名称可即时显示） */
  startTurn(sessionPath: string): void {
    if (!sessionPath) return;
    const buf = this.getBuffer(sessionPath);
    this.ensureMessage(buf);
  }

  /** 调度节流 flush */
  private scheduleFlush(buf: Buffer): void {
    const now = Date.now();
    if (now - buf.lastFlushTime >= FLUSH_INTERVAL) {
      this.flush(buf);
    } else if (!buf.flushTimer) {
      buf.flushTimer = setTimeout(() => {
        buf.flushTimer = null;
        this.flush(buf);
      }, FLUSH_INTERVAL - (now - buf.lastFlushTime));
    }
  }

  private dropTrailingEmptyAssistantMessage(sessionPath: string): void {
    useStore.setState((state: any) => {
      const session = state.chatSessions?.[sessionPath];
      if (!session || !Array.isArray(session.items) || session.items.length === 0) return {};
      const items: ChatListItem[] = session.items;
      const last = items[items.length - 1];
      if (!last || last.type !== 'message' || last.data.role !== 'assistant') return {};
      const blocks = Array.isArray(last.data.blocks) ? last.data.blocks : [];
      if (blocks.some((block) => isRenderableBlock(block))) return {};
      return {
        chatSessions: {
          ...state.chatSessions,
          [sessionPath]: {
            ...session,
            items: items.slice(0, -1),
          },
        },
      };
    });
  }

  /** 把 buffer 中累积的内容一次性 flush 到 Zustand */
  private flush(buf: Buffer): void {
    // 防止“空 buffer”把上一条消息 blocks 覆盖成 []。
    if (!hasBufferedRenderableState(buf)) return;

    buf.lastFlushTime = Date.now();
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }

    const store = useStore.getState();
    store.updateLastMessage(buf.sessionPath, (msg) => {
      // ── Ordered content (text + tools + files + artifacts ...) ──
      const orderedLiveBlocks = [...buf.liveBlocks];
      if (buf.textAcc) {
        const currentTextBlock = buildTextBlockFromBufferedText(buf.textAcc);
        if (currentTextBlock) {
          const insertAt = Number.isInteger(buf.textAnchorIndex)
            ? Math.max(0, Math.min(Number(buf.textAnchorIndex), orderedLiveBlocks.length))
            : orderedLiveBlocks.length;
          orderedLiveBlocks.splice(insertAt, 0, currentTextBlock);
        }
      }

      // ── Thinking ──
      const liveThinking = sanitizeBufferedThinkingText(buf.thinkingAcc);
      if (buf.inThinking || !!liveThinking.trim()) {
        orderedLiveBlocks.push({
          type: 'thinking',
          content: liveThinking,
          sealed: !buf.inThinking,
        });
      }

      // ── Xing ──
      if (buf.xingAcc || buf.inXing) {
        const xingBlock: ContentBlock = {
          type: 'xing',
          title: buf.xingTitle,
          content: buf.xingAcc,
          sealed: !buf.inXing,
        };
        orderedLiveBlocks.push(xingBlock);
      }

      return { ...msg, blocks: orderedLiveBlocks };
    });
  }

  // ── 公开事件处理器 ──

  handle(msg: any): void {
    const sessionPath = msg.sessionPath || useStore.getState().currentSessionPath;
    if (!sessionPath) return;
    const buf = this.getBuffer(sessionPath);

    switch (msg.type) {
      case 'sdk_message': {
        const role = String(msg.message?.role || '');
        const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
        if (role === 'assistant') {
          const sdkMessageKey = String(
            msg.message?.messageId || msg.message?.id || msg.message?.uuid || '',
          ).trim() || null;
          const snapshotThinkingSegments = extractSnapshotThinkingSegments(content);
          const snapshotText = stripStreamToolMarkup(
            stripSdkDiagnosticLines(extractSnapshotTextContent(content)),
          );
          const toolUses = extractSnapshotToolUses(content);

          if (!hasRenderableAssistantSnapshot(content) && !buf.messageAppended) break;
          this.ensureMessage(buf);
          const hadOpenThinkingBeforeBoundary = (
            buf.inThinking
            && !!sanitizeBufferedThinkingText(String(buf.thinkingAcc || '')).trim()
          );

          // 某些 provider 在 structured 模式下不会及时发 thinking_end。
          // 当离散 sdk_message 已出现边界（换 messageId / 进入 text / tool_use）时，主动封口当前 thinking。
          if (
            buf.inThinking
            && (
              (sdkMessageKey && sdkMessageKey !== buf.lastSdkAssistantMessageKey)
              || !!snapshotText
              || toolUses.length > 0
              || snapshotThinkingSegments.length === 0
            )
          ) {
            closeOpenThinkingIfNeeded(buf);
          }

          applySdkMessageThinking(buf, snapshotThinkingSegments, sdkMessageKey, {
            preferUpdateLastSealed: hadOpenThinkingBeforeBoundary,
          });

          if (snapshotText) {
            if (buf.textAnchorIndex == null) buf.textAnchorIndex = buf.liveBlocks.length;
            buf.textAcc = mergeSnapshotText(buf.textAcc, snapshotText);
          }

          if (toolUses.length > 0) finalizeBufferedTextSegment(buf);
          for (const toolUse of toolUses) {
            buf.liveBlocks = applyChatStreamLiveEvent(buf.liveBlocks, {
              type: 'tool_start',
              name: toolUse.name,
              toolCallId: toolUse.id,
              args: toolUse.args,
            });
          }
          buf.lastSdkAssistantMessageKey = sdkMessageKey;
        } else if (role === 'user') {
          const toolResults = extractSdkToolResults(content);
          if (toolResults.length === 0 && !buf.messageAppended) break;
          if (toolResults.length > 0) {
            finalizeBufferedTextSegment(buf);
          }
          let nextLiveBlocks = buf.liveBlocks;
          for (const toolResult of toolResults) {
            nextLiveBlocks = applyChatStreamLiveEvent(nextLiveBlocks, {
              type: 'tool_end',
              toolCallId: toolResult.toolCallId,
              success: toolResult.success,
            });
          }
          const applied = nextLiveBlocks !== buf.liveBlocks;
          if (!applied && !buf.messageAppended) break;
          this.ensureMessage(buf);
          buf.liveBlocks = nextLiveBlocks;
        }
        this.scheduleFlush(buf);
        break;
      }

      case 'assistant_snapshot': {
        const content = Array.isArray(msg.content) ? msg.content : [];
        if (!hasRenderableAssistantSnapshot(content) && !buf.messageAppended) break;
        this.ensureMessage(buf);

        applySnapshotThinking(buf, content);

        const snapshotText = stripStreamToolMarkup(
          stripSdkDiagnosticLines(extractSnapshotTextContent(content)),
        );
        if (snapshotText) {
          if (buf.textAnchorIndex == null) buf.textAnchorIndex = buf.liveBlocks.length;
          buf.textAcc = mergeSnapshotText(buf.textAcc, snapshotText);
        }

        const toolUses = extractSnapshotToolUses(content);
        if (toolUses.length > 0) finalizeBufferedTextSegment(buf);
        for (const toolUse of toolUses) {
          buf.liveBlocks = applyChatStreamLiveEvent(buf.liveBlocks, {
            type: 'tool_start',
            name: toolUse.name,
            toolCallId: toolUse.id,
            args: toolUse.args,
          });
        }

        this.scheduleFlush(buf);
        break;
      }

      case 'text_delta':
        closeOpenThinkingIfNeeded(buf);
        this.ensureMessage(buf);
        if (buf.textAnchorIndex == null) buf.textAnchorIndex = buf.liveBlocks.length;
        buf.textAcc = mergeDelta(
          buf.textAcc,
          stripSdkDiagnosticLines(msg.delta || ''),
        );
        this.scheduleFlush(buf);
        break;

      case 'thinking_start':
        finalizeBufferedTextSegment(buf);
        finalizeBufferedThinkingSegment(buf);
        this.ensureMessage(buf);
        buf.sawThinkingStreamEvent = true;
        buf.inThinking = true;
        buf.hadThinking = true;
        buf.thinkingAcc = '';
        this.flush(buf);
        break;

      case 'thinking_delta':
        {
          buf.sawThinkingStreamEvent = true;
          if (!buf.inThinking) {
            finalizeBufferedTextSegment(buf);
            finalizeBufferedThinkingSegment(buf);
            this.ensureMessage(buf);
            buf.inThinking = true;
          }
          const sanitizedDelta = sanitizeBufferedThinkingText(String(msg.delta || ''));
          if (sanitizedDelta) buf.hadThinking = true;
          buf.thinkingAcc = mergeDelta(buf.thinkingAcc, sanitizedDelta);
        }
        this.scheduleFlush(buf);
        break;

      case 'thinking_end':
        buf.sawThinkingStreamEvent = true;
        buf.inThinking = false;
        finalizeBufferedThinkingSegment(buf);
        this.flush(buf);
        break;

      case 'xing_start':
        finalizeBufferedTextSegment(buf);
        this.ensureMessage(buf);
        buf.inXing = true;
        buf.xingAcc = '';
        buf.xingTitle = msg.title || ((window as any).t?.('xing.title') || 'Reflection');
        this.flush(buf);
        break;

      case 'xing_text':
        buf.xingAcc += msg.delta || '';
        break;

      case 'xing_end':
        buf.inXing = false;
        this.flush(buf);
        break;

      case 'tool_start':
        finalizeBufferedTextSegment(buf);
        closeOpenThinkingIfNeeded(buf);
        this.ensureMessage(buf);
        buf.liveBlocks = applyChatStreamLiveEvent(buf.liveBlocks, msg);
        this.flush(buf);
        break;

      case 'tool_end':
        finalizeBufferedTextSegment(buf);
        {
          const nextLiveBlocks = applyChatStreamLiveEvent(buf.liveBlocks, msg);
          const applied = nextLiveBlocks !== buf.liveBlocks;
          if (!applied && !buf.messageAppended) break;
          this.ensureMessage(buf);
          buf.liveBlocks = nextLiveBlocks;
        }
        buf.liveBlocks = maybeApproveCronCard(buf.liveBlocks, msg);
        this.flush(buf);
        break;

      case 'file_output':
        finalizeBufferedTextSegment(buf);
        this.ensureMessage(buf);
        buf.liveBlocks = applyChatStreamLiveEvent(buf.liveBlocks, msg);
        this.flush(buf);
        break;

      case 'artifact':
        finalizeBufferedTextSegment(buf);
        this.ensureMessage(buf);
        buf.liveBlocks = applyChatStreamLiveEvent(buf.liveBlocks, msg);
        this.flush(buf);
        break;

      case 'browser_screenshot':
        finalizeBufferedTextSegment(buf);
        this.ensureMessage(buf);
        buf.liveBlocks = applyChatStreamLiveEvent(buf.liveBlocks, msg);
        this.flush(buf);
        break;

      case 'skill_activated':
        finalizeBufferedTextSegment(buf);
        this.ensureMessage(buf);
        buf.liveBlocks = applyChatStreamLiveEvent(buf.liveBlocks, msg);
        this.flush(buf);
        break;

      case 'cron_confirmation':
        finalizeBufferedTextSegment(buf);
        this.ensureMessage(buf);
        buf.liveBlocks = applyChatStreamLiveEvent(buf.liveBlocks, msg);
        this.flush(buf);
        break;

      case 'settings_confirmation':
        finalizeBufferedTextSegment(buf);
        this.ensureMessage(buf);
        buf.liveBlocks = applyChatStreamLiveEvent(buf.liveBlocks, msg);
        this.flush(buf);
        break;

      case 'ask_user_confirmation':
        finalizeBufferedTextSegment(buf);
        this.ensureMessage(buf);
        buf.liveBlocks = applyChatStreamLiveEvent(buf.liveBlocks, msg);
        this.flush(buf);
        break;

      case 'plan_mode_confirmation':
        finalizeBufferedTextSegment(buf);
        this.ensureMessage(buf);
        buf.liveBlocks = applyChatStreamLiveEvent(buf.liveBlocks, msg);
        this.flush(buf);
        break;

      case 'compaction_start':
        // 分隔项插入前先落盘当前缓冲，避免“最后一项不再是 message”导致本轮内容丢失。
        finalizeBufferedTextSegment(buf);
        closeOpenThinkingIfNeeded(buf);
        if (hasBufferedRenderableState(buf)) this.flush(buf);
        resetBufferTurnState(buf);
        useStore.getState().appendItem(sessionPath, {
          type: 'compaction',
          id: `compaction-${Date.now()}`,
          yuan: useStore.getState().agentYuan || 'hanako',
        });
        break;

      case 'compaction_end':
        // 压缩结束后插入“已压缩上下文”分隔线，后续流应从新 assistant 消息继续渲染。
        finalizeBufferedTextSegment(buf);
        closeOpenThinkingIfNeeded(buf);
        if (hasBufferedRenderableState(buf)) this.flush(buf);
        resetBufferTurnState(buf);
        // 移除 compaction notice
        useStore.getState().clearCompactionNotices(sessionPath);
        if (msg.success !== false) {
          useStore.getState().appendItem(sessionPath, {
            type: 'compaction_done',
            id: `compaction-done-${Date.now()}`,
          });
        }
        break;

      case 'turn_end':
        buf.textAcc = stripStreamToolMarkup(stripSdkDiagnosticLines(buf.textAcc));
        if (hasBufferedRenderableState(buf)) {
          this.flush(buf);
        } else if (buf.messageAppended) {
          this.dropTrailingEmptyAssistantMessage(sessionPath);
        }
        // 清理 buffer
        resetBufferTurnState(buf);
        break;
    }
  }

  /** 清理指定 session 的 buffer */
  clear(sessionPath: string): void {
    const buf = this.buffers.get(sessionPath);
    if (buf?.flushTimer) clearTimeout(buf.flushTimer);
    this.buffers.delete(sessionPath);
  }

  /** 清理所有 */
  clearAll(): void {
    for (const [, buf] of this.buffers) {
      if (buf.flushTimer) clearTimeout(buf.flushTimer);
    }
    this.buffers.clear();
  }
}

/** 全局 singleton */
export const streamBufferManager = new StreamBufferManager();
