import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../stores';
import {
  mergeDelta,
  stripSdkDiagnosticLines,
  stripStreamToolMarkup,
  streamBufferManager,
} from './use-stream-buffer';

function initEmptySession(sessionPath: string): void {
  useStore.setState({ chatSessions: {}, currentSessionPath: sessionPath } as any);
  useStore.getState().initSession(sessionPath, [], false);
  streamBufferManager.clear(sessionPath);
}

describe('mergeDelta', () => {
  const sessionPath = '/tmp/stream-buffer-regression.session.json';

  beforeEach(() => {
    initEmptySession(sessionPath);
  });

  it('ignores fully duplicated chunk', () => {
    const acc = '用户说我写的不行。让我再试一次。';
    const next = mergeDelta(acc, '让我再试一次。');
    expect(next).toBe(acc);
  });

  it('handles cumulative delta payloads', () => {
    const acc = '先分析问题';
    const next = mergeDelta(acc, '先分析问题，再给方案');
    expect(next).toBe('先分析问题，再给方案');
  });

  it('merges suffix/prefix overlap', () => {
    const acc = '这是第一段。然后';
    const next = mergeDelta(acc, '然后是第二段。');
    expect(next).toBe('这是第一段。然后是第二段。');
  });

  it('appends normally when no overlap', () => {
    const acc = 'A';
    const next = mergeDelta(acc, 'B');
    expect(next).toBe('AB');
  });

  it('strips SDK diagnostic lines from streamed text', () => {
    const raw = '⚠ [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null\n\n正常正文';
    expect(stripSdkDiagnosticLines(raw)).toBe('正常正文');
  });

  it('hides raw tool markup from streamed text', () => {
    const raw = '先测第一层。<assistant to=Glob>{"pattern":"README*"}</assistant>';
    expect(stripStreamToolMarkup(raw).trim()).toBe('先测第一层。');
  });

  it('hides [TOOL_CALL] markup from streamed text', () => {
    const raw = '先看一下。\n[TOOL_CALL]\n{tool => "Glob", args => {"pattern":"*"}}\n[/TOOL_CALL]\n完成。';
    expect(stripStreamToolMarkup(raw).trim()).toBe('先看一下。\n完成。');
  });

  it('hides minimax XML tool markup from streamed text', () => {
    const raw = '开始。\n<minimax:tool_call><invoke name=“Glob”><parameter name=“pattern”>/Users/tc/Desktop/*</parameter></invoke></minimax:tool_call>\n结束。';
    expect(stripStreamToolMarkup(raw).trim()).toBe('开始。\n结束。');
  });

  it('hides function_calls invoke/parameter markup from streamed text', () => {
    const raw = '开始。\n<function_calls><invoke name="Bash"><parameter name="command">ls -la</parameter></invoke></function_calls>\n结束。';
    expect(stripStreamToolMarkup(raw).trim()).toBe('开始。\n结束。');
  });

  it('keeps trailing plain text when streamed function_calls parameter tag is malformed', () => {
    const raw = '开始。\n<function_calls><invoke name="Bash"><parameter name="command">ls -la\n我继续说明：目录是存在的。';
    expect(stripStreamToolMarkup(raw).trim()).toBe('开始。\nls -la\n我继续说明：目录是存在的。');
  });

  it('does not append empty assistant message when tool_end has no matching tool_start', () => {
    streamBufferManager.handle({
      type: 'tool_end',
      sessionPath,
      name: 'Bash',
      toolCallId: 'missing-tool-call-id',
      success: true,
    });
    streamBufferManager.handle({ type: 'turn_end', sessionPath });

    const items = useStore.getState().chatSessions[sessionPath]?.items || [];
    expect(items).toHaveLength(0);
  });

  it('drops assistant message when streamed text is only tool markup', () => {
    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath,
      delta: '<assistant to=Glob>{"pattern":"README*"}</assistant>',
    });
    streamBufferManager.handle({ type: 'turn_end', sessionPath });

    const items = useStore.getState().chatSessions[sessionPath]?.items || [];
    expect(items).toHaveLength(0);
  });

  it('keeps assistant message when tool_start/tool_end pair is valid', () => {
    streamBufferManager.handle({
      type: 'tool_start',
      sessionPath,
      name: 'Bash',
      toolCallId: 'tool-1',
      args: { cmd: 'ls' },
    });
    streamBufferManager.handle({
      type: 'tool_end',
      sessionPath,
      name: 'Bash',
      toolCallId: 'tool-1',
      success: true,
    });
    streamBufferManager.handle({ type: 'turn_end', sessionPath });

    const items = useStore.getState().chatSessions[sessionPath]?.items || [];
    expect(items).toHaveLength(1);
    const last = items[0];
    expect(last?.type).toBe('message');
    if (last?.type === 'message') {
      expect(last.data.role).toBe('assistant');
      const toolGroup = (last.data.blocks || []).find((b) => b.type === 'tool_group');
      expect(toolGroup).toBeTruthy();
    }
  });

  it('preserves streaming order between text segments and tool chain', () => {
    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath,
      delta: '先给你同步一下进展：',
    });
    streamBufferManager.handle({
      type: 'tool_start',
      sessionPath,
      name: 'WebSearch',
      toolCallId: 'tool-ordered-1',
      args: { query: 'iran latest news' },
    });
    streamBufferManager.handle({
      type: 'tool_end',
      sessionPath,
      name: 'WebSearch',
      toolCallId: 'tool-ordered-1',
      success: true,
    });
    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath,
      delta: '\n继续抓更可靠的来源。',
    });
    streamBufferManager.handle({ type: 'turn_end', sessionPath });

    const items = useStore.getState().chatSessions[sessionPath]?.items || [];
    expect(items).toHaveLength(1);
    const only = items[0];
    expect(only?.type).toBe('message');
    if (only?.type === 'message') {
      const blocks = only.data.blocks || [];
      expect(blocks.map((b) => b.type)).toEqual(['text', 'tool_group', 'text']);
      const firstText = blocks[0];
      const secondText = blocks[2];
      expect(firstText?.type).toBe('text');
      expect(secondText?.type).toBe('text');
      if (firstText?.type === 'text') {
        expect(firstText.html).toContain('先给你同步一下进展');
      }
      if (secondText?.type === 'text') {
        expect(secondText.html).toContain('继续抓更可靠的来源');
      }
    }
  });

  it('does not overwrite previous thinking when multiple thinking segments occur', () => {
    streamBufferManager.handle({ type: 'thinking_start', sessionPath });
    streamBufferManager.handle({ type: 'thinking_delta', sessionPath, delta: '第一段思考' });
    streamBufferManager.handle({ type: 'thinking_end', sessionPath });

    streamBufferManager.handle({ type: 'thinking_start', sessionPath });
    streamBufferManager.handle({ type: 'thinking_delta', sessionPath, delta: '第二段思考' });
    streamBufferManager.handle({ type: 'thinking_end', sessionPath });
    streamBufferManager.handle({ type: 'turn_end', sessionPath });

    const items = useStore.getState().chatSessions[sessionPath]?.items || [];
    expect(items).toHaveLength(1);
    const only = items[0];
    expect(only?.type).toBe('message');
    if (only?.type === 'message') {
      const thinking = (only.data.blocks || []).find((b) => b.type === 'thinking');
      expect(thinking?.type).toBe('thinking');
      if (thinking?.type === 'thinking') {
        expect(thinking.content).toContain('第一段思考');
        expect(thinking.content).toContain('第二段思考');
      }
    }
  });

  it('keeps a single thinking block when snapshot repeats finished thinking', () => {
    streamBufferManager.handle({ type: 'thinking_start', sessionPath });
    streamBufferManager.handle({ type: 'thinking_delta', sessionPath, delta: '先分析问题。' });
    streamBufferManager.handle({ type: 'thinking_end', sessionPath });
    streamBufferManager.handle({
      type: 'assistant_snapshot',
      sessionPath,
      content: [
        { type: 'thinking', thinking: '先分析问题。' },
        { type: 'text', text: '给你结论。' },
      ],
    });
    streamBufferManager.handle({ type: 'turn_end', sessionPath });

    const items = useStore.getState().chatSessions[sessionPath]?.items || [];
    expect(items).toHaveLength(1);
    const only = items[0];
    expect(only?.type).toBe('message');
    if (only?.type === 'message') {
      const blocks = only.data.blocks || [];
      expect(blocks.map((b) => b.type)).toEqual(['thinking', 'text']);
      const thinkingBlocks = blocks.filter((b) => b.type === 'thinking');
      expect(thinkingBlocks).toHaveLength(1);
      const thinking = thinkingBlocks[0];
      if (thinking?.type === 'thinking') {
        expect(thinking.content).toContain('先分析问题');
      }
    }
  });

  it('renders snapshot-only thinking before text', () => {
    streamBufferManager.handle({
      type: 'assistant_snapshot',
      sessionPath,
      content: [
        { type: 'thinking', thinking: '我先搜索再汇总。' },
        { type: 'text', text: '这是最终回答。' },
      ],
    });
    streamBufferManager.handle({ type: 'turn_end', sessionPath });

    const items = useStore.getState().chatSessions[sessionPath]?.items || [];
    expect(items).toHaveLength(1);
    const only = items[0];
    expect(only?.type).toBe('message');
    if (only?.type === 'message') {
      const blocks = only.data.blocks || [];
      expect(blocks.map((b) => b.type)).toEqual(['thinking', 'text']);
    }
  });
});
