import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderMarkdownForPreview, repairMarkdownHtml } from './markdown';

describe('renderMarkdown CJK emphasis compatibility', () => {
  it('renders strong markdown when closing marker is followed by CJK text', () => {
    const html = renderMarkdown('思路： 用**重要性采样（Importance Sampling）**把On-policy变成Off-policy。');
    expect(html).toContain('<strong>重要性采样（Importance Sampling）</strong>把');
  });

  it('renders strong markdown in the agent reply pattern shown in chat', () => {
    const html = renderMarkdown('核心创新是**双 MoE 结构**——在 Actor');
    expect(html).toContain('核心创新是<strong>双 MoE 结构</strong>——在 Actor');
  });

  it('recovers strong markers split by invisible characters', () => {
    const html = renderMarkdown('核心创新是*\u200B*双 MoE 结构*\u200B*——在 Actor');
    expect(html).toContain('核心创新是<strong>双 MoE 结构</strong>——在 Actor');
  });

  it('renders emphasis markdown when closing marker is followed by CJK text', () => {
    const html = renderMarkdown('这是*斜体（Italic）*测试。');
    expect(html).toContain('<em>斜体（Italic）</em>测试');
  });

  it('recovers escaped strong markdown emitted by some models', () => {
    const html = renderMarkdown('状态：\\*\\*不可用\\*\\*。');
    expect(html).toContain('<strong>不可用</strong>');
  });

  it('recovers entity-escaped strong markdown markers', () => {
    const html = renderMarkdown('高级官员称伊朗&#42;&#42;已准备好与美国和以色列打持久战&#42;&#42;，不寻求快速结束冲突');
    expect(html).toContain('<strong>已准备好与美国和以色列打持久战</strong>，');
  });

  it('recovers entity-escaped markdown markers outside code spans only', () => {
    const html = renderMarkdown('状态：&ast;&ast;不可用&ast;&ast;，代码 `&#42;&#42;literal&#42;&#42;`。');
    expect(html).toContain('<strong>不可用</strong>');
    expect(html).toContain('<code>&amp;#42;&amp;#42;literal&amp;#42;&amp;#42;</code>');
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

  it('repairs cached html that still contains literal strong markers', () => {
    const html = repairMarkdownHtml('<p>核心创新是**双 MoE 结构**——在 Actor</p><pre><code>**literal**</code></pre>');
    expect(html).toContain('<p>核心创新是<strong>双 MoE 结构</strong>——在 Actor</p>');
    expect(html).toContain('<pre><code>**literal**</code></pre>');
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

  it('renders LaTeX bracket delimiters as math', () => {
    const display = renderMarkdown('\\[\nL(\\theta)=x+1\n\\]');
    expect(display).toContain('katex');
    expect(display).not.toContain('\\[');

    const inline = renderMarkdown('inline \\(x_t + 1\\) text');
    expect(inline).toContain('katex');
    expect(inline).not.toContain('\\(');
  });

  it('renders GitHub-style task lists', () => {
    const html = renderMarkdown('- [x] done\n- [ ] todo');
    expect(html).toContain('task-list-item');
    expect(html).toContain('type="checkbox" disabled checked');
    expect(html).toContain('type="checkbox" disabled');
  });

  it('uses the full markdown renderer for local file preview', () => {
    const html = renderMarkdownForPreview('# Title\n\n| A | B |\n| - | - |\n| $x$ | <b>ok</b> |');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<table>');
    expect(html).toContain('katex');
    expect(html).toContain('<b>ok</b>');
  });
});
