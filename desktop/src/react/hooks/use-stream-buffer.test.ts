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

  it('hides singular function_call markup from streamed text', () => {
    const raw = '开始。\n<function_call>{"tool":"Glob","input":{"pattern":"*"}}</function_call>\n结束。';
    expect(stripStreamToolMarkup(raw).trim()).toBe('开始。\n结束。');
  });

  it('hides malformed singular function_call block without opening tag from streamed text', () => {
    const raw = '开始。\nfunction_call\n{"tool":"Glob","input":{"AbsolutePathPattern":"/Users/tc/Desktop/*"}}\n</function_call>\n结束。';
    expect(stripStreamToolMarkup(raw).trim()).toBe('开始。\n结束。');
  });

  it('hides plain text tool_call trace lines from streamed text', () => {
    const raw = '开始。\ntool_call: - id: "glob_1" depth: "1" dir: "/Users/tc/Desktop" Glob: null\ntool_call_end: glob_1\n结束。';
    expect(stripStreamToolMarkup(raw).trim()).toBe('开始。\n\n结束。');
  });

  it('hides named XML tool tag markup from streamed text', () => {
    const raw = '开始。\n<Glob><path>/Users/tc/Desktop/*</path></Glob>\n结束。';
    expect(stripStreamToolMarkup(raw).trim()).toBe('开始。\n结束。');
  });

  it('hides lone closing named tool tags from streamed text', () => {
    const raw = '好，先建目录。\n</bash>\n继续。';
    expect(stripStreamToolMarkup(raw).trim()).toBe('好，先建目录。\n\n继续。');
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

  it('creates assistant placeholder immediately on startTurn and drops it on empty turn_end', () => {
    streamBufferManager.startTurn(sessionPath);
    let items = useStore.getState().chatSessions[sessionPath]?.items || [];
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe('message');
    if (items[0]?.type === 'message') {
      expect(items[0].data.role).toBe('assistant');
      expect(items[0].data.blocks || []).toEqual([]);
    }

    streamBufferManager.handle({ type: 'turn_end', sessionPath });
    items = useStore.getState().chatSessions[sessionPath]?.items || [];
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

  it('folds pre-tool narration into thinking while keeping post-tool text visible', () => {
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
      expect(blocks.map((b) => b.type)).toEqual(['thinking', 'tool_group', 'text']);
      const firstThinking = blocks[0];
      const secondText = blocks[2];
      expect(firstThinking?.type).toBe('thinking');
      expect(secondText?.type).toBe('text');
      if (firstThinking?.type === 'thinking') {
        expect(firstThinking.content).toContain('先给你同步一下进展');
      }
      if (secondText?.type === 'text') {
        expect(secondText.html).toContain('继续抓更可靠的来源');
      }
    }
  });

  it('folds inter-tool narration into thinking when another tool starts', () => {
    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath,
      delta: '我先尝试调用图片工具。',
    });
    streamBufferManager.handle({
      type: 'tool_start',
      sessionPath,
      name: 'generate_images',
      toolCallId: 'tool-a',
      args: { prompt: 'cute puppy' },
    });
    streamBufferManager.handle({
      type: 'tool_end',
      sessionPath,
      name: 'generate_images',
      toolCallId: 'tool-a',
      success: false,
      details: { error: 'No such tool available' },
    });
    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath,
      delta: '图片工具不可用，我换个方式继续找图。',
    });
    streamBufferManager.handle({
      type: 'tool_start',
      sessionPath,
      name: 'WebSearch',
      toolCallId: 'tool-b',
      args: { q: 'cute puppy photo' },
    });
    streamBufferManager.handle({
      type: 'tool_end',
      sessionPath,
      name: 'WebSearch',
      toolCallId: 'tool-b',
      success: true,
    });
    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath,
      delta: '找到一张图片，给你链接。',
    });
    streamBufferManager.handle({ type: 'turn_end', sessionPath });

    const items = useStore.getState().chatSessions[sessionPath]?.items || [];
    expect(items).toHaveLength(1);
    const only = items[0];
    expect(only?.type).toBe('message');
    if (only?.type === 'message') {
      const blocks = only.data.blocks || [];
      expect(blocks.map((b) => b.type)).toEqual([
        'thinking',
        'tool_group',
        'thinking',
        'tool_group',
        'text',
      ]);

      const thinking = blocks[0];
      expect(thinking?.type).toBe('thinking');
      if (thinking?.type === 'thinking') {
        expect(thinking.content).toContain('我先尝试调用图片工具');
      }

      const midThinking = blocks[2];
      expect(midThinking?.type).toBe('thinking');
      if (midThinking?.type === 'thinking') {
        expect(midThinking.content).toContain('图片工具不可用');
      }

      const toolGroupA = blocks[1];
      const toolGroupB = blocks[3];
      expect(toolGroupA?.type).toBe('tool_group');
      expect(toolGroupB?.type).toBe('tool_group');
      if (toolGroupA?.type === 'tool_group') {
        expect(toolGroupA.tools).toHaveLength(1);
      }
      if (toolGroupB?.type === 'tool_group') {
        expect(toolGroupB.tools).toHaveLength(1);
      }

      const finalText = blocks[4];
      expect(finalText?.type).toBe('text');
      if (finalText?.type === 'text') {
        expect(finalText.html).toContain('找到一张图片');
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

  it('does not render tool_call trace text in thinking block', () => {
    streamBufferManager.handle({ type: 'thinking_start', sessionPath });
    streamBufferManager.handle({
      type: 'thinking_delta',
      sessionPath,
      delta: 'tool_call: - id: "glob_1" depth: "1" dir: "/Users/tc/Desktop" Glob: null\ntool_call_end: glob_1',
    });
    streamBufferManager.handle({ type: 'thinking_end', sessionPath });
    streamBufferManager.handle({ type: 'turn_end', sessionPath });

    const items = useStore.getState().chatSessions[sessionPath]?.items || [];
    expect(items).toHaveLength(0);
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
