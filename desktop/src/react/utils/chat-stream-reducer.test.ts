import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '../stores/chat-types';
import { applyChatStreamLiveEvent } from './chat-stream-reducer';

describe('applyChatStreamLiveEvent', () => {
  it('tracks same-name tools by toolUseId', () => {
    let blocks: ContentBlock[] = [];
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'tool_start',
      name: 'browser',
      toolCallId: 'tool-1',
      args: { action: 'open' },
    });
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'tool_start',
      name: 'browser',
      toolCallId: 'tool-2',
      args: { action: 'click' },
    });
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'tool_end',
      name: 'browser',
      toolCallId: 'tool-1',
      success: true,
    });

    const group = blocks[0] as Extract<ContentBlock, { type: 'tool_group' }>;
    expect(group.tools[0]).toMatchObject({ toolUseId: 'tool-1', done: true, success: true });
    expect(group.tools[1]).toMatchObject({ toolUseId: 'tool-2', done: false, success: false });
  });

  it('merges repeated tool_start updates into one activity', () => {
    let blocks: ContentBlock[] = [];
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'tool_start',
      name: 'Read',
      toolCallId: 'tool-1',
      args: { file_path: 'README.md' },
    });
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'tool_start',
      name: 'Read',
      toolCallId: 'tool-1',
      args: { offset: 20 },
    });

    const group = blocks[0] as Extract<ContentBlock, { type: 'tool_group' }>;
    expect(group.tools).toHaveLength(1);
    expect(group.tools[0]).toMatchObject({
      toolUseId: 'tool-1',
      args: { file_path: 'README.md', offset: 20 },
    });
  });
});
