import { describe, expect, it } from 'vitest';
import type { ChatListItem, ContentBlock, ToolCall } from '../stores/chat-types';
import {
  mergeCanonicalAssistantBlocks,
  mergeCanonicalTurnItems,
} from './ollama-turn-canonicalize';

function makeTool(name: string, toolUseId: string): ToolCall {
  return {
    name,
    toolUseId,
    done: true,
    success: true,
  };
}

function makeAssistantMessage(id: string, blocks: ContentBlock[]): ChatListItem {
  return {
    type: 'message',
    data: {
      id,
      role: 'assistant',
      blocks,
    },
  };
}

function makeUserMessage(id: string, text: string): ChatListItem {
  return {
    type: 'message',
    data: {
      id,
      role: 'user',
      text,
    },
  };
}

describe('mergeCanonicalAssistantBlocks', () => {
  it('keeps the live chain when canonical history has no final reply yet', () => {
    const liveBlocks: ContentBlock[] = [
      { type: 'thinking', content: '先分析一下。', sealed: true },
      { type: 'tool_group', tools: [makeTool('Bash', 'tool-1')], collapsed: false },
    ];
    const canonicalBlocks: ContentBlock[] = [
      { type: 'tool_group', tools: [makeTool('Bash', 'tool-1')], collapsed: false },
    ];

    expect(mergeCanonicalAssistantBlocks(liveBlocks, canonicalBlocks)).toEqual(liveBlocks);
  });
});

describe('mergeCanonicalTurnItems', () => {
  it('preserves live thinking/tool ordering while replacing the final reply with canonical markdown', () => {
    const liveItems: ChatListItem[] = [
      makeUserMessage('user-1', '帮我搜一下俄乌局势'),
      makeAssistantMessage('live-1', [
        { type: 'thinking', content: '先换几个信源试试。', sealed: true },
        { type: 'tool_group', tools: [makeTool('WebFetch', 'tool-a'), makeTool('Bash', 'tool-b')], collapsed: false },
        { type: 'text', html: '<p>正在整理结果</p>', raw: '正在整理结果' },
      ]),
    ];
    const canonicalItems: ChatListItem[] = [
      makeUserMessage('user-1', '帮我搜一下俄乌局势'),
      makeAssistantMessage('hist-1', [
        { type: 'tool_group', tools: [makeTool('WebFetch', 'tool-a')], collapsed: false },
      ]),
      makeAssistantMessage('hist-2', [
        { type: 'text', html: '<table><tr><td>最新进展</td></tr></table>', raw: '| 标题 |\n| --- |\n| 最新进展 |' },
      ]),
    ];

    const merged = mergeCanonicalTurnItems(liveItems, canonicalItems);
    expect(merged).not.toBeNull();
    expect(merged).toHaveLength(2);

    const mergedAssistant = merged?.[1];
    expect(mergedAssistant?.type).toBe('message');
    if (mergedAssistant?.type === 'message') {
      expect(mergedAssistant.data.blocks?.map((block) => block.type)).toEqual([
        'thinking',
        'tool_group',
        'text',
      ]);
      const finalText = mergedAssistant.data.blocks?.[2];
      expect(finalText?.type).toBe('text');
      if (finalText?.type === 'text') {
        expect(finalText.html).toContain('<table>');
      }
    }
  });

  it('keeps the live assistant turn when canonical history has not caught up yet', () => {
    const liveItems: ChatListItem[] = [
      makeUserMessage('user-1', '你好'),
      makeAssistantMessage('live-1', [
        { type: 'thinking', content: '先打个招呼。', sealed: true },
        { type: 'text', html: '<p>你好，WSL。</p>', raw: '你好，WSL。' },
      ]),
    ];
    const canonicalItems: ChatListItem[] = [
      makeUserMessage('user-1', '你好'),
    ];

    const merged = mergeCanonicalTurnItems(liveItems, canonicalItems);
    expect(merged).not.toBeNull();
    expect(merged).toHaveLength(2);
    const mergedAssistant = merged?.[1];
    expect(mergedAssistant?.type).toBe('message');
    if (mergedAssistant?.type === 'message') {
      expect(mergedAssistant.data.blocks?.map((block) => block.type)).toEqual(['thinking', 'text']);
    }
  });

  it('does not merge across a different last user turn', () => {
    const liveItems: ChatListItem[] = [
      makeUserMessage('user-1', '你好'),
      makeAssistantMessage('live-1', [
        { type: 'text', html: '<p>你好</p>', raw: '你好' },
      ]),
    ];
    const canonicalItems: ChatListItem[] = [
      makeUserMessage('user-2', '帮我搜一下俄乌局势'),
      makeAssistantMessage('hist-1', [
        { type: 'text', html: '<p>好的</p>', raw: '好的' },
      ]),
    ];

    expect(mergeCanonicalTurnItems(liveItems, canonicalItems)).toEqual(canonicalItems);
  });
});
