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
});
