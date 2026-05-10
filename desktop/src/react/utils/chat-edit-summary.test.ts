import { describe, expect, it } from 'vitest';
import type { ChatListItem } from '../stores/chat-types';
import { buildDiffContent, extractLatestEditSummary } from './chat-edit-summary';

function assistantItem(id: string, tools: Array<Record<string, unknown>>): ChatListItem {
  return {
    type: 'message',
    data: {
      id,
      role: 'assistant',
      blocks: [
        {
          type: 'tool_group',
          collapsed: false,
          tools: tools as any,
        },
      ],
    },
  };
}

describe('chat edit summary extraction', () => {
  it('counts add/remove lines from structured patch and fallback old/new text', () => {
    const items: ChatListItem[] = [
      assistantItem('msg-1', [
        {
          name: 'Edit',
          done: true,
          success: true,
          args: { file_path: '/tmp/a.txt' },
          details: {
            structuredPatch: [
              {
                lines: [
                  '--- a.txt',
                  '+++ a.txt',
                  '@@ -1,2 +1,2 @@',
                  '-old line',
                  ' keep line',
                  '+new line',
                ],
              },
            ],
          },
        },
        {
          name: 'Edit',
          done: true,
          success: true,
          args: {
            filePath: '/tmp/b.txt',
            oldString: 'before',
            newString: 'after 1\nafter 2',
          },
        },
      ]),
    ];

    const summary = extractLatestEditSummary(items);
    expect(summary).not.toBeNull();
    expect(summary?.files).toHaveLength(2);
    expect(summary?.totalPlus).toBe(3);
    expect(summary?.totalMinus).toBe(2);

    const fileA = summary?.files.find((f) => f.filePath === '/tmp/a.txt');
    expect(fileA).toBeDefined();
    expect(fileA?.plus).toBe(1);
    expect(fileA?.minus).toBe(1);
    expect(fileA?.diffLines.some((line) => line.tone === 'remove' && line.text === 'old line')).toBe(true);
    expect(fileA?.diffLines.some((line) => line.tone === 'add' && line.text === 'new line')).toBe(true);

    const fileB = summary?.files.find((f) => f.filePath === '/tmp/b.txt');
    expect(fileB).toBeDefined();
    expect(fileB?.plus).toBe(2);
    expect(fileB?.minus).toBe(1);

    const preview = buildDiffContent(fileA?.diffLines || []);
    expect(preview).toContain('-old line');
    expect(preview).toContain('+new line');
  });

  it('returns null when latest message is not assistant', () => {
    const items: ChatListItem[] = [
      assistantItem('msg-1', []),
      {
        type: 'message',
        data: { id: 'user-1', role: 'user', text: 'hello' },
      },
    ];
    expect(extractLatestEditSummary(items)).toBeNull();
  });

  it('ignores non editable file extensions', () => {
    const items: ChatListItem[] = [
      assistantItem('msg-1', [
        {
          name: 'Edit',
          done: true,
          success: true,
          args: {
            file_path: '/tmp/image.png',
            old_string: 'a',
            new_string: 'b',
          },
        },
      ]),
    ];

    expect(extractLatestEditSummary(items)).toBeNull();
  });
});
