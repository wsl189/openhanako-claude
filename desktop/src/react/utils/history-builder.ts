/**
 * history-builder.ts — 将 /api/sessions/messages 的 API 响应转换为 ChatListItem[]
 *
 * 替代 app-messages-shim.ts loadMessages() 中的 DOM 构建循环。
 */

import type { ChatMessage, ChatListItem, ContentBlock } from '../stores/chat-types';
import { parseXingFromContent, parseUserAttachments } from './message-parser';
import { renderMarkdown } from './markdown';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── API 响应类型 ──

export interface HistoryApiResponse {
  messages: Array<{
    id?: string;
    role: string;
    content: string;
    thinking?: string;
    toolCalls?: Array<{
      name: string;
      toolUseId?: string;
      args?: Record<string, unknown>;
      details?: Record<string, unknown>;
      resultText?: string;
    }>;
    toolResults?: Array<{
      name: string;
      toolUseId?: string;
      args?: Record<string, unknown>;
      details?: Record<string, unknown>;
      resultText?: string;
      success?: boolean;
    }>;
    contentBlocks?: Array<
      | { type: 'text'; text: string }
      | { type: 'thinking'; thinking: string }
      | { type: 'tool_use'; id: string; name: string; input?: Record<string, unknown> }
    >;
  }>;
  fileOutputs?: Array<{
    afterIndex: number;
    files: Array<{ filePath: string; label: string; ext: string }>;
  }>;
  artifacts?: Array<{
    afterIndex: number;
    artifactId: string;
    artifactType: string;
    title: string;
    content: string;
    language?: string;
  }>;
  todos?: any[];
  hasMore?: boolean;
}

function isReasoningLikeType(type: unknown): boolean {
  const normalized = String(type || '').toLowerCase();
  if (!normalized || normalized === 'text') return false;
  return /(reason|think|analysis|commentary|summary)/.test(normalized);
}

function buildAssistantBlocksFromStructuredContent(
  contentBlocks: Array<any>,
): {
  thinking: string;
  toolCalls: Array<{
    name: string;
    toolUseId?: string;
    args?: Record<string, unknown>;
    details?: Record<string, unknown>;
    resultText?: string;
  }>;
  text: string;
} {
  let thinking = '';
  let text = '';
  const toolCalls: Array<{
    name: string;
    toolUseId?: string;
    args?: Record<string, unknown>;
    details?: Record<string, unknown>;
    resultText?: string;
  }> = [];

  for (const block of contentBlocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      thinking += block.thinking;
      continue;
    }
    if (block.type === 'tool_use') {
      toolCalls.push({
        name: String(block.name || ''),
        toolUseId: String(block.id || '') || undefined,
        args: (block.input && typeof block.input === 'object') ? block.input : undefined,
      });
      continue;
    }
    const part = typeof block.text === 'string'
      ? block.text
      : (typeof block.thinking === 'string' ? block.thinking : '');
    if (!part) continue;
    if (isReasoningLikeType(block.type)) thinking += part;
    else text += part;
  }

  return { thinking, toolCalls, text };
}

function findToolResultMatch(
  toolResults: Array<{
    name: string;
    toolUseId?: string;
    args?: Record<string, unknown>;
    details?: Record<string, unknown>;
    resultText?: string;
    success?: boolean;
  }>,
  used: Set<number>,
  call: {
    name: string;
    toolUseId?: string;
    args?: Record<string, unknown>;
    details?: Record<string, unknown>;
    resultText?: string;
  },
): number {
  if (call.toolUseId) {
    const byId = toolResults.findIndex((result, idx) => (
      !used.has(idx) && result.toolUseId === call.toolUseId
    ));
    if (byId >= 0) return byId;
  }
  return toolResults.findIndex((result, idx) => (
    !used.has(idx) && result.name === call.name
  ));
}

function appendAssistantTextBlocks(blocks: ContentBlock[], text: string): void {
  if (!text) return;
  const { xingBlocks, text: mainText } = parseXingFromContent(text);
  if (mainText) {
    blocks.push({ type: 'text', html: renderMarkdown(mainText), raw: mainText });
  }
  for (const xb of xingBlocks) {
    blocks.push({ type: 'xing', title: xb.title, content: xb.content, sealed: true });
  }
}

function insertToolEntriesBeforeText(
  blocks: ContentBlock[],
  toolEntries: Array<{
    name: string;
    toolUseId?: string;
    args?: Record<string, unknown>;
    details?: Record<string, unknown>;
    resultText?: string;
    done: boolean;
    success: boolean;
  }>,
): void {
  if (!toolEntries.length) return;
  const firstTextLikeIdx = blocks.findIndex((block) => block.type === 'text' || block.type === 'xing');
  if (firstTextLikeIdx < 0) {
    const prev = blocks[blocks.length - 1];
    if (prev?.type === 'tool_group') {
      prev.tools = [...prev.tools, ...toolEntries];
      prev.collapsed = false;
    } else {
      blocks.push({ type: 'tool_group', tools: toolEntries, collapsed: false });
    }
    return;
  }

  const prev = blocks[firstTextLikeIdx - 1];
  if (prev?.type === 'tool_group') {
    prev.tools = [...prev.tools, ...toolEntries];
    prev.collapsed = false;
    return;
  }

  blocks.splice(firstTextLikeIdx, 0, {
    type: 'tool_group',
    tools: toolEntries,
    collapsed: false,
  });
}

// ── 构建 ──

export function buildItemsFromHistory(data: HistoryApiResponse): ChatListItem[] {
  const items: ChatListItem[] = [];

  // 按 afterIndex 分组 fileOutputs 和 artifacts
  const fileMap: Record<number, Array<{ filePath: string; label: string; ext: string }>> = {};
  const artMap: Record<number, Array<{ artifactId: string; artifactType: string; title: string; content: string; language?: string }>> = {};

  for (const fo of (data.fileOutputs || [])) {
    (fileMap[fo.afterIndex] ??= []).push(...fo.files);
  }
  for (const ar of (data.artifacts || [])) {
    (artMap[ar.afterIndex] ??= []).push(ar);
  }

  for (let i = 0; i < data.messages.length; i++) {
    const m = data.messages[i];
    const id = m.id || `hist-${i}`;

    if (m.role === 'user') {
      // strip steer 前缀（内部标记，不应展示给用户）
      const rawContent = (m.content || '').replace(/^（插话(?:，无需 MOOD)?）\n?/, '');
      const { text, files, deskContext } = parseUserAttachments(rawContent);
      const msg: ChatMessage = {
        id,
        role: 'user',
        text,
        textHtml: text ? renderMarkdown(text) : undefined,
        attachments: files.length ? files.map(f => ({
          path: f.path,
          name: f.name,
          isDir: f.isDirectory,
        })) : undefined,
        deskContext: deskContext || undefined,
      };
      items.push({ type: 'message', data: msg });
    } else if (m.role === 'assistant') {
      const blocks: ContentBlock[] = [];
      const structured = Array.isArray(m.contentBlocks)
        ? buildAssistantBlocksFromStructuredContent(m.contentBlocks)
        : { thinking: '', toolCalls: [], text: '' };
      const mergedThinking = structured.thinking || m.thinking || '';
      const mergedToolCalls = structured.toolCalls.length ? structured.toolCalls : (m.toolCalls || []);
      const toolResults = Array.isArray(m.toolResults) ? m.toolResults : [];
      const assistantContent = structured.text || String(m.content || '');
      const structuredBlocks = Array.isArray(m.contentBlocks) ? m.contentBlocks : [];

      if (structuredBlocks.length > 0) {
        let hasThinkingBlock = false;
        const usedToolResults = new Set<number>();
        let hasTextLikeBlock = false;
        const trailingToolEntries: Array<{
          name: string;
          toolUseId?: string;
          args?: Record<string, unknown>;
          details?: Record<string, unknown>;
          resultText?: string;
          done: boolean;
          success: boolean;
        }> = [];

        for (const sb of structuredBlocks) {
          if (!sb || typeof sb !== 'object') continue;
          if (sb.type === 'thinking' && typeof sb.thinking === 'string') {
            hasThinkingBlock = true;
            blocks.push({ type: 'thinking', content: sb.thinking, sealed: true });
            continue;
          }

          if (sb.type === 'tool_use') {
            const call = {
              name: String(sb.name || ''),
              toolUseId: String(sb.id || '') || undefined,
              args: (sb.input && typeof sb.input === 'object') ? sb.input : undefined,
            };
            const matchedIdx = findToolResultMatch(toolResults, usedToolResults, call);
            const matched = matchedIdx >= 0 ? toolResults[matchedIdx] : null;
            if (matchedIdx >= 0) usedToolResults.add(matchedIdx);
            const toolEntry = {
              name: call.name,
              toolUseId: call.toolUseId || matched?.toolUseId,
              args: call.args || matched?.args,
              details: (matched?.details && typeof matched.details === 'object') ? matched.details : undefined,
              resultText: typeof matched?.resultText === 'string' ? matched.resultText : undefined,
              done: true,
              success: matched ? matched.success !== false : true,
            };
            const prev = blocks[blocks.length - 1];
            if (prev?.type === 'tool_group') {
              prev.tools = [...prev.tools, toolEntry];
              prev.collapsed = false;
            } else {
              blocks.push({
                type: 'tool_group',
                tools: [toolEntry],
                collapsed: false,
              });
            }
            continue;
          }

          if (sb.type === 'text' && typeof sb.text === 'string' && sb.text) {
            hasTextLikeBlock = true;
            appendAssistantTextBlocks(blocks, sb.text);
          }
        }

        for (let idx = 0; idx < toolResults.length; idx += 1) {
          if (usedToolResults.has(idx)) continue;
          const result = toolResults[idx];
          if (!result?.name) continue;
          trailingToolEntries.push({
            name: result.name,
            toolUseId: result.toolUseId,
            args: (result.args && typeof result.args === 'object') ? result.args : undefined,
            details: (result.details && typeof result.details === 'object') ? result.details : undefined,
            resultText: typeof result.resultText === 'string' ? result.resultText : undefined,
            done: true,
            success: result.success !== false,
          });
        }

        insertToolEntriesBeforeText(blocks, trailingToolEntries);

        if (!hasThinkingBlock && mergedThinking) {
          blocks.unshift({ type: 'thinking', content: mergedThinking, sealed: true });
        }
        if (!hasTextLikeBlock && assistantContent) {
          appendAssistantTextBlocks(blocks, assistantContent);
        }
      } else {
        // 1. Thinking
        if (mergedThinking) {
          blocks.push({ type: 'thinking', content: mergedThinking, sealed: true });
        }

        // 2. Tool calls
        if (mergedToolCalls?.length || toolResults.length) {
          const callsForRender = mergedToolCalls.length
            ? mergedToolCalls
            : toolResults.map((result) => ({
              name: String(result.name || ''),
              toolUseId: String(result.toolUseId || '') || undefined,
              args: (result.args && typeof result.args === 'object') ? result.args : undefined,
            }));
          const usedToolResults = new Set<number>();
          // 分离确认类工具和普通工具
          const normalTools = [];
          for (const tc of callsForRender) {
            const matchedIdx = findToolResultMatch(toolResults, usedToolResults, tc);
            const matched = matchedIdx >= 0 ? toolResults[matchedIdx] : null;
            if (matchedIdx >= 0) usedToolResults.add(matchedIdx);
            const mergedArgs = tc.args || matched?.args;
            const toolEntry = {
              name: tc.name,
              toolUseId: tc.toolUseId || matched?.toolUseId,
              args: mergedArgs,
              details: (matched?.details && typeof matched.details === 'object') ? matched.details : undefined,
              resultText: typeof matched?.resultText === 'string' ? matched.resultText : undefined,
              done: true,
              success: matched ? matched.success !== false : true,
            };
            if (tc.name === 'cron' && tc.args && (tc.args as any).action === 'add') {
              // 重建 cron 确认卡片（已完成状态）
              const a = tc.args as Record<string, any>;
              blocks.push({
                type: 'cron_confirm',
                jobData: { type: a.type, schedule: a.schedule, prompt: a.prompt, label: a.label },
                status: 'approved',
              } as any);
            } else {
              normalTools.push(toolEntry);
            }
          }
          for (let idx = 0; idx < toolResults.length; idx += 1) {
            if (usedToolResults.has(idx)) continue;
            const result = toolResults[idx];
            if (!result?.name) continue;
            normalTools.push({
              name: result.name,
              toolUseId: result.toolUseId,
              args: (result.args && typeof result.args === 'object') ? result.args : undefined,
              details: (result.details && typeof result.details === 'object') ? result.details : undefined,
              resultText: typeof result.resultText === 'string' ? result.resultText : undefined,
              done: true,
              success: result.success !== false,
            });
            usedToolResults.add(idx);
          }
          if (normalTools.length) {
            blocks.push({
              type: 'tool_group',
              tools: normalTools,
              collapsed: normalTools.length > 1 && normalTools.every((tool) => tool.done),
            });
          }
        }

        // 3. 主文本（去掉 xing 后的内容）
        appendAssistantTextBlocks(blocks, assistantContent);
      }

      // 5. 跟在这条消息后面的 file outputs
      const files = fileMap[i];
      if (files) {
        for (const f of files) {
          blocks.push({ type: 'file_output', filePath: f.filePath, label: f.label, ext: f.ext });
        }
      }

      // 6. 跟在这条消息后面的 artifacts
      const arts = artMap[i];
      if (arts) {
        for (const a of arts) {
          blocks.push({
            type: 'artifact',
            artifactId: a.artifactId,
            artifactType: a.artifactType,
            title: a.title,
            content: a.content,
            language: a.language,
          });
        }
      }

      const msg: ChatMessage = { id, role: 'assistant', blocks };
      items.push({ type: 'message', data: msg });
    }
  }

  return items;
}
