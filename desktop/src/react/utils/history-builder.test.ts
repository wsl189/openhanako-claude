import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '../stores/chat-types';
import { buildItemsFromHistory } from './history-builder';

function getFirstAssistantBlocks(data: Parameters<typeof buildItemsFromHistory>[0]): ContentBlock[] {
  const items = buildItemsFromHistory(data);
  const first = items.find((item) => item.type === 'message' && item.data.role === 'assistant');
  if (!first || first.type !== 'message') return [];
  return first.data.blocks || [];
}

describe('buildItemsFromHistory', () => {
  it('applies real tool result success state by toolUseId', () => {
    const blocks = getFirstAssistantBlocks({
      messages: [{
        id: 'a-1',
        role: 'assistant',
        content: 'done',
        toolCalls: [
          { name: 'browser', toolUseId: 'tool-1', args: { action: 'open' } },
          { name: 'bash', toolUseId: 'tool-2', args: { command: 'npm test' } },
        ],
        toolResults: [
          { name: 'browser', toolUseId: 'tool-1', success: true },
          { name: 'bash', toolUseId: 'tool-2', success: false },
        ],
      }],
    });

    const group = blocks.find((block) => block.type === 'tool_group') as Extract<ContentBlock, { type: 'tool_group' }>;
    expect(group.tools).toHaveLength(2);
    expect(group.tools[0]).toMatchObject({ name: 'browser', toolUseId: 'tool-1', done: true, success: true });
    expect(group.tools[1]).toMatchObject({ name: 'bash', toolUseId: 'tool-2', done: true, success: false });
  });

  it('rebuilds tool group from tool results when assistant tool_use is missing', () => {
    const blocks = getFirstAssistantBlocks({
      messages: [{
        id: 'a-2',
        role: 'assistant',
        content: 'all set',
        toolResults: [
          { name: 'search_query', toolUseId: 'tool-3', args: { q: 'hanako' }, success: true },
        ],
      }],
    });

    const group = blocks.find((block) => block.type === 'tool_group') as Extract<ContentBlock, { type: 'tool_group' }>;
    expect(group.tools).toHaveLength(1);
    expect(group.tools[0]).toMatchObject({
      name: 'search_query',
      toolUseId: 'tool-3',
      args: { q: 'hanako' },
      done: true,
      success: true,
    });
  });

  it('keeps tool result text and details from history payload', () => {
    const blocks = getFirstAssistantBlocks({
      messages: [{
        id: 'a-3',
        role: 'assistant',
        content: 'ok',
        toolResults: [
          {
            name: 'bash',
            toolUseId: 'tool-4',
            args: { command: 'ls' },
            resultText: 'a.txt\nb.txt',
            details: { summary: 'listed files' },
            success: true,
          },
        ],
      }],
    });

    const group = blocks.find((block) => block.type === 'tool_group') as Extract<ContentBlock, { type: 'tool_group' }>;
    expect(group.tools[0]).toMatchObject({
      name: 'bash',
      toolUseId: 'tool-4',
      resultText: 'a.txt\nb.txt',
      details: { summary: 'listed files' },
      done: true,
      success: true,
    });
  });

  it('places trailing tool results before text when structured blocks miss tool_use', () => {
    const blocks = getFirstAssistantBlocks({
      messages: [{
        id: 'a-4',
        role: 'assistant',
        content: '最终回答',
        contentBlocks: [
          { type: 'text', text: '最终回答' },
        ],
        toolResults: [
          { name: 'web_fetch', toolUseId: 'tool-x', resultText: 'ok', success: true },
        ],
      }],
    });

    expect(blocks.map((b) => b.type)).toEqual(['tool_group', 'text']);
  });

  it('preserves multiple adjacent thinking blocks from structured history', () => {
    const blocks = getFirstAssistantBlocks({
      messages: [{
        id: 'a-5',
        role: 'assistant',
        content: '最终回答',
        contentBlocks: [
          { type: 'thinking', thinking: '第一段思考。' },
          { type: 'thinking', thinking: '第二段思考。' },
          { type: 'text', text: '最终回答' },
        ],
      }],
    });

    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'thinking', 'text']);
    const first = blocks[0];
    const second = blocks[1];
    expect(first?.type).toBe('thinking');
    expect(second?.type).toBe('thinking');
    if (first?.type === 'thinking') {
      expect(first.content).toContain('第一段思考');
      expect(first.content).not.toContain('第二段思考');
    }
    if (second?.type === 'thinking') {
      expect(second.content).toContain('第二段思考');
      expect(second.content).not.toContain('第一段思考');
    }
  });
});
