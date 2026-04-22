import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown CJK emphasis compatibility', () => {
  it('renders strong markdown when closing marker is followed by CJK text', () => {
    const html = renderMarkdown('思路： 用**重要性采样（Importance Sampling）**把On-policy变成Off-policy。');
    expect(html).toContain('<strong>重要性采样（Importance Sampling）</strong>把');
  });

  it('renders emphasis markdown when closing marker is followed by CJK text', () => {
    const html = renderMarkdown('这是*斜体（Italic）*测试。');
    expect(html).toContain('<em>斜体（Italic）</em>测试');
  });

  it('recovers escaped strong markdown emitted by some models', () => {
    const html = renderMarkdown('状态：\\*\\*不可用\\*\\*。');
    expect(html).toContain('<strong>不可用</strong>');
  });

  it('recovers strong markdown with accidental inner-edge spaces', () => {
    const html = renderMarkdown('结论：**第一仓位存疑。 **\n以及：** 第一仓位存疑。**');
    expect(html).toContain('<strong>第一仓位存疑。</strong>');
  });

  it('recovers escaped strong markdown inside table cells', () => {
    const html = renderMarkdown('| 状态 | 说明 |\n| --- | --- |\n| \\*\\*不可用\\*\\* | API 未配置 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<strong>不可用</strong>');
  });

  it('does not alter markdown inside code spans or fenced code blocks', () => {
    const inlineCode = renderMarkdown('`**literal（code）**把`');
    expect(inlineCode).toContain('<code>**literal（code）**把</code>');

    const fenceCode = renderMarkdown('```\\n**literal（code）**把\\n```');
    expect(fenceCode).toContain('**literal（code）**把');
    expect(fenceCode).not.toContain('<strong>literal（code）</strong>');
  });

  it('renders latex fenced block as math instead of code block', () => {
    const html = renderMarkdown('```latex\nx_t = y + 1\n```');
    expect(html).toContain('katex');
    expect(html).not.toContain('<pre><code>');
  });

  it('renders indented equation block as math when it is not code', () => {
    const html = renderMarkdown('目标函数：\n\n    L^CLIP(θ) = E[min(r_t(θ) * A_t, clip(r_t(θ), 1-ε, 1+ε) * A_t)]');
    expect(html).toContain('katex');
    expect(html).not.toContain('<pre><code>');
  });

  it('keeps real indented code blocks unchanged', () => {
    const html = renderMarkdown('示例：\n\n    const x = y + 1;\n    console.log(x);');
    expect(html).toContain('<pre><code>const x = y + 1;');
    expect(html).toContain('console.log(x);');
  });
});
