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

  it('does not let an id-less same-name tool_start overwrite a pending tool', () => {
    let blocks: ContentBlock[] = [];
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'tool_start',
      name: 'Bash',
      toolCallId: 'tool-1',
      args: { command: 'search first query' },
    });
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'tool_start',
      name: 'Bash',
      args: { command: 'search second query' },
    });
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'tool_start',
      name: 'Bash',
      toolCallId: 'tool-2',
      args: { command: 'search second query' },
    });

    const group = blocks[0] as Extract<ContentBlock, { type: 'tool_group' }>;
    expect(group.tools).toHaveLength(2);
    expect(group.tools[0]).toMatchObject({
      toolUseId: 'tool-1',
      args: { command: 'search first query' },
      done: false,
    });
    expect(group.tools[1]).toMatchObject({
      toolUseId: 'tool-2',
      args: { command: 'search second query' },
      done: false,
    });
  });

  it('does not complete a same-name pending tool without toolCallId', () => {
    let blocks: ContentBlock[] = [];
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'tool_start',
      name: 'Bash',
      toolCallId: 'tool-1',
      args: { command: 'search first query' },
    });
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'tool_start',
      name: 'Bash',
      toolCallId: 'tool-2',
      args: { command: 'search second query' },
    });
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'tool_end',
      name: 'Bash',
      success: true,
    });

    const group = blocks[0] as Extract<ContentBlock, { type: 'tool_group' }>;
    expect(group.tools).toHaveLength(2);
    expect(group.tools[0]).toMatchObject({ toolUseId: 'tool-1', done: false });
    expect(group.tools[1]).toMatchObject({ toolUseId: 'tool-2', done: false });
  });

  it('stores tool result text and details on tool_end', () => {
    let blocks: ContentBlock[] = [];
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'tool_start',
      name: 'bash',
      toolCallId: 'tool-9',
      args: { command: 'ls' },
    });
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'tool_end',
      name: 'bash',
      toolCallId: 'tool-9',
      success: true,
      resultText: 'a.txt\nb.txt',
      details: { summary: 'listed 2 files' },
    });

    const group = blocks[0] as Extract<ContentBlock, { type: 'tool_group' }>;
    expect(group.tools[0]).toMatchObject({
      toolUseId: 'tool-9',
      done: true,
      success: true,
      resultText: 'a.txt\nb.txt',
      details: { summary: 'listed 2 files' },
    });
  });

  it('merges late tool_end output into already-done tool entry', () => {
    let blocks: ContentBlock[] = [];
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'tool_start',
      name: 'bash',
      toolCallId: 'tool-late-1',
      args: { command: 'ls -la' },
    });
    // 模拟 sdk_message(user tool_result) 先到：仅有 success，没有 resultText。
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'tool_end',
      name: 'bash',
      toolCallId: 'tool-late-1',
      success: true,
    });
    // 模拟随后的 tool_end 事件补齐可展示输出。
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'tool_end',
      name: 'bash',
      toolCallId: 'tool-late-1',
      success: true,
      resultText: 'total 2\n-rw-r--r-- a.txt',
      details: { summary: 'listed files' },
    });

    const group = blocks[0] as Extract<ContentBlock, { type: 'tool_group' }>;
    expect(group.tools[0]).toMatchObject({
      toolUseId: 'tool-late-1',
      done: true,
      success: true,
      resultText: 'total 2\n-rw-r--r-- a.txt',
      details: { summary: 'listed files' },
    });
  });

  it('stores plan mode confirmation cards', () => {
    let blocks: ContentBlock[] = [];
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'plan_mode_confirmation',
      confirmId: 'plan-confirm-1',
      phase: 'exit',
      prompt: 'Ready to run the planned changes',
      allowedPrompts: [{ tool: 'Bash', prompt: 'npm test' }],
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'plan_mode_confirm',
      confirmId: 'plan-confirm-1',
      phase: 'exit',
      prompt: 'Ready to run the planned changes',
      status: 'pending',
    });
  });

  it('stores ask user confirmation cards', () => {
    let blocks: ContentBlock[] = [];
    blocks = applyChatStreamLiveEvent(blocks, {
      type: 'ask_user_confirmation',
      confirmId: 'ask-user-1',
      questions: [
        { id: 'goal', question: 'What is your goal?' },
      ],
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'ask_user_confirm',
      confirmId: 'ask-user-1',
      status: 'pending',
    });
  });
});
