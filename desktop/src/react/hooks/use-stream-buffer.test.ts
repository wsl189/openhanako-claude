import { describe, expect, it } from 'vitest';
import { mergeDelta } from './use-stream-buffer';

describe('mergeDelta', () => {
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
});
