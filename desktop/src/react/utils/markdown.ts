/**
 * Markdown 渲染器
 *
 * 通过 npm import 使用 markdown-it，不依赖全局 window.markdownit。
 */

import markdownit from 'markdown-it';
import mk from '@traptitech/markdown-it-katex';
import 'katex/dist/katex.min.css';

type MarkdownIt = ReturnType<typeof markdownit>;

let _md: MarkdownIt | null = null;
let _mdPreview: MarkdownIt | null = null;

const CJK_CHAR_CLASS = '\u3400-\u9FFF\uF900-\uFAFF';
const HAIR_SPACE = '\u200A';
const INVISIBLE_MARKER_CHARS = '\u200B\u200C\u200D\u2060\uFEFF';
const SPACE_LIKE_RE = /^[\s\u00A0\u3000]+|[\s\u00A0\u3000]+$/g;
const ASTERISK_ENTITY_RE = /(?:&#42;|&#x2a;|&ast;)/gi;
const UNDERSCORE_ENTITY_RE = /(?:&#95;|&#x5f;|&lowbar;)/gi;
const BACKSLASH_ENTITY_RE = /(?:&#92;|&#x5c;|&bsol;)/gi;
const ESCAPED_STRONG_ASTERISK_RE = /\\\*\\\*([^\n]*?)\\\*\\\*/g;
const ESCAPED_STRONG_UNDERSCORE_RE = /\\_\\_([^\n]*?)\\_\\_/g;
const LOOSE_STRONG_ASTERISK_RE = /\*\*([^\n]*?)\*\*/g;
const LOOSE_STRONG_UNDERSCORE_RE = /__([^\n]*?)__/g;
const STRONG_ASTERISK_RE = new RegExp(`\\*\\*([^*\\n]+?)\\*\\*(?=[${CJK_CHAR_CLASS}])`, 'g');
const STRONG_UNDERSCORE_RE = new RegExp(`__([^_\\n]+?)__(?=[${CJK_CHAR_CLASS}])`, 'g');
const EMPHASIS_ASTERISK_RE = new RegExp(`(^|[^*])\\*([^*\\n]+?)\\*(?=[${CJK_CHAR_CLASS}])`, 'g');
const EMPHASIS_UNDERSCORE_RE = new RegExp(`(^|[^_])_([^_\\n]+?)_(?=[${CJK_CHAR_CLASS}])`, 'g');
const CODE_SPAN_RE = /(`+[^`]*`+)/g;
const FENCE_RE = /^[ \t]*(```|~~~)/;
const CJK_EMPHASIS_SPACER_RE = new RegExp(`(<\\/(?:strong|em)>)${HAIR_SPACE}(?=[${CJK_CHAR_CLASS}])`, 'g');
const MARKDOWN_MARKER_INVISIBLE_RE = new RegExp(`([*_])[${INVISIBLE_MARKER_CHARS}]+(?=\\1)`, 'g');
const MATH_FENCE_OPEN_RE = /^[ \t]*(```|~~~)\s*(math|latex|tex|katex)\s*$/i;
const DISPLAY_MATH_OPEN_RE = /^[ \t]*\\\[[ \t]*$/;
const DISPLAY_MATH_CLOSE_RE = /^[ \t]*\\\][ \t]*$/;
const INDENTED_BLOCK_RE = /^(?: {4}|\t)/;
const STRIP_INDENT_RE = /^(?: {4}|\t)/;
const MATH_SIGNAL_RE = /(?:\\[A-Za-z]+|[=^_]|[α-ωΑ-Ωπθλεσμ]|(?:\b(?:min|max|argmin|argmax|clip|sum|prod|exp|log)\b))/i;
const CODE_SIGNAL_RE = /(?:\b(?:const|let|var|function|class|import|export|return|if|for|while|switch|try|catch|console|def)\b|[{};]|=>)/;
const TASK_MARKER_RE = /^\[([ xX])\]\s+/;

/**
 * markdown-it 在部分 CJK 场景下会漏掉强调解析，例如：
 * 用**重要性采样（Importance Sampling）**把...
 * 这里先注入极细空格触发解析，再在 HTML 阶段移除。
 */
function normalizeMarkdownForCjkEmphasis(src: string): string {
  const lines = String(src || '').replace(MARKDOWN_MARKER_INVISIBLE_RE, '$1').split(/(\r?\n)/);
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line === '\n' || line === '\r\n') continue;

    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const chunks = line.split(CODE_SPAN_RE);
    for (let j = 0; j < chunks.length; j++) {
      const chunk = chunks[j];
      if (/^`+[^`]*`+$/.test(chunk)) continue;
      chunks[j] = chunk
        // 有些历史/桥接消息会把 markdown 标记 HTML 实体化，浏览器会显示成 **，
        // 但 markdown-it 解析时不会把实体当作强调标记。这里只恢复标记字符本身。
        .replace(ASTERISK_ENTITY_RE, '*')
        .replace(UNDERSCORE_ENTITY_RE, '_')
        .replace(BACKSLASH_ENTITY_RE, '\\')
        // 容错：模型偶发输出 **text ** / ** text** / __text __，会导致 markdown 失效。
        .replace(LOOSE_STRONG_ASTERISK_RE, (m, text: string) => {
          const trimmed = String(text || '').replace(SPACE_LIKE_RE, '');
          if (!trimmed || trimmed === text || trimmed.includes('**')) return m;
          return `**${trimmed}**`;
        })
        .replace(LOOSE_STRONG_UNDERSCORE_RE, (m, text: string) => {
          const trimmed = String(text || '').replace(SPACE_LIKE_RE, '');
          if (!trimmed || trimmed === text || trimmed.includes('__')) return m;
          return `__${trimmed}__`;
        })
        // 某些模型会输出转义后的强调（\*\*text\*\*），这里在非代码区恢复。
        .replace(ESCAPED_STRONG_ASTERISK_RE, (_m, text: string) => {
          const normalized = String(text || '').replace(SPACE_LIKE_RE, '');
          return normalized ? `**${normalized}**` : _m;
        })
        .replace(ESCAPED_STRONG_UNDERSCORE_RE, (_m, text: string) => {
          const normalized = String(text || '').replace(SPACE_LIKE_RE, '');
          return normalized ? `__${normalized}__` : _m;
        })
        .replace(STRONG_ASTERISK_RE, `**$1**${HAIR_SPACE}`)
        .replace(STRONG_UNDERSCORE_RE, `__$1__${HAIR_SPACE}`)
        .replace(EMPHASIS_ASTERISK_RE, (_m, prefix: string, text: string) => `${prefix}*${text}*${HAIR_SPACE}`)
        .replace(EMPHASIS_UNDERSCORE_RE, (_m, prefix: string, text: string) => `${prefix}_${text}_${HAIR_SPACE}`);
    }
    lines[i] = chunks.join('');
  }

  return lines.join('');
}

function repairStrongMarkersInTextSegment(text: string): string {
  if (!text || (!text.includes('**') && !text.includes('__'))) return text;
  return text
    .replace(/(^|[^*])\*\*([^\n]*?)\*\*/g, (m, prefix: string, inner: string) => {
      const trimmed = String(inner || '').replace(SPACE_LIKE_RE, '');
      if (!trimmed || trimmed.includes('**')) return m;
      return `${prefix}<strong>${trimmed}</strong>`;
    })
    .replace(/(^|[^_])__([^\n]*?)__/g, (m, prefix: string, inner: string) => {
      const trimmed = String(inner || '').replace(SPACE_LIKE_RE, '');
      if (!trimmed || trimmed.includes('__')) return m;
      return `${prefix}<strong>${trimmed}</strong>`;
    });
}

export function repairMarkdownHtml(html: string): string {
  const raw = String(html || '');
  if (!raw || (!raw.includes('**') && !raw.includes('__'))) return raw;

  const parts = raw.split(/(<[^>]+>)/g);
  const skipStack: string[] = [];
  return parts.map((part) => {
    if (!part) return part;
    if (part.startsWith('<') && part.endsWith('>')) {
      const close = part.match(/^<\/\s*([a-zA-Z0-9-]+)/);
      if (close) {
        const tag = close[1].toLowerCase();
        const idx = skipStack.lastIndexOf(tag);
        if (idx >= 0) skipStack.splice(idx, 1);
        return part;
      }

      const open = part.match(/^<\s*([a-zA-Z0-9-]+)/);
      if (open && !/\/\s*>$/.test(part)) {
        const tag = open[1].toLowerCase();
        if (['code', 'pre', 'script', 'style', 'textarea'].includes(tag)) {
          skipStack.push(tag);
        }
      }
      return part;
    }
    if (skipStack.length > 0) return part;
    return repairStrongMarkersInTextSegment(part);
  }).join('');
}

function isFenceCloseLine(line: string, marker: string): boolean {
  return new RegExp(`^[ \\t]*${marker}\\s*$`).test(line);
}

function looksLikeMathBlock(text: string): boolean {
  const s = String(text || '').trim();
  if (!s) return false;
  if (s.length > 500) return false;
  if (!MATH_SIGNAL_RE.test(s)) return false;
  if (CODE_SIGNAL_RE.test(s)) return false;
  return true;
}

/**
 * 公式渲染纠偏：
 * 1) ```latex / ```math / ```tex / ```katex 代码块 -> $$...$$
 * 2) 4 空格缩进且看起来是公式的块 -> $$...$$
 * 避免模型把公式塞进“可复制代码框”。
 */
function normalizeMarkdownMathBlocks(src: string): string {
  const lines = String(src || '').split(/\r?\n/);
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const mathFenceMatch = line.match(MATH_FENCE_OPEN_RE);
    if (mathFenceMatch) {
      const marker = mathFenceMatch[1];
      i += 1;
      const content: string[] = [];
      while (i < lines.length && !isFenceCloseLine(lines[i], marker)) {
        content.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // skip closing fence
      const body = content.join('\n').trim();
      out.push('$$');
      if (body) out.push(body);
      out.push('$$');
      continue;
    }

    const genericFenceMatch = line.match(FENCE_RE);
    if (genericFenceMatch) {
      const marker = genericFenceMatch[1];
      out.push(line);
      i += 1;
      while (i < lines.length) {
        const cur = lines[i];
        out.push(cur);
        i += 1;
        if (isFenceCloseLine(cur, marker)) break;
      }
      continue;
    }

    if (INDENTED_BLOCK_RE.test(line)) {
      const rawBlock: string[] = [];
      const stripped: string[] = [];
      while (i < lines.length && INDENTED_BLOCK_RE.test(lines[i])) {
        rawBlock.push(lines[i]);
        stripped.push(lines[i].replace(STRIP_INDENT_RE, ''));
        i += 1;
      }
      const body = stripped.join('\n').trim();
      if (looksLikeMathBlock(body)) {
        out.push('$$');
        if (body) out.push(body);
        out.push('$$');
      } else {
        out.push(...rawBlock);
      }
      continue;
    }

    out.push(line);
    i += 1;
  }

  return out.join('\n');
}

function normalizeMathDelimitersInInlineText(text: string): string {
  if (!text || (!text.includes('\\(') && !text.includes('\\['))) return text;
  const chunks = text.split(CODE_SPAN_RE);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (/^`+[^`]*`+$/.test(chunk)) continue;
    chunks[i] = chunk
      .replace(/\\\[([^\n]+?)\\\]/g, (_m, body: string) => `$$${body}$$`)
      .replace(/\\\((.+?)\\\)/g, (_m, body: string) => `$${body}$`);
  }
  return chunks.join('');
}

/**
 * KaTeX 插件只识别 $...$ / $$...$$。这里兼容常见 LaTeX 分隔符：
 * \[...\] / \(...\)，并避开代码块与行内代码。
 */
function normalizeMarkdownMathDelimiters(src: string): string {
  const lines = String(src || '').split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (DISPLAY_MATH_OPEN_RE.test(line) || DISPLAY_MATH_CLOSE_RE.test(line)) {
      out.push('$$');
      continue;
    }
    out.push(normalizeMathDelimitersInInlineText(line));
  }

  return out.join('\n');
}

function taskListsPlugin(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'hanako_task_lists', (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type !== 'inline') continue;
      if (tokens[i - 1]?.type !== 'paragraph_open') continue;
      if (tokens[i - 2]?.type !== 'list_item_open') continue;

      const children = token.children;
      const first = children?.[0];
      if (!first || first.type !== 'text') continue;

      const match = first.content.match(TASK_MARKER_RE);
      if (!match) continue;

      const checked = match[1].toLowerCase() === 'x';
      first.content = first.content.slice(match[0].length);

      const checkbox = new state.Token('html_inline', '', 0);
      checkbox.content = `<input class="task-list-item-checkbox" type="checkbox" disabled${checked ? ' checked' : ''}> `;
      children.unshift(checkbox);

      tokens[i - 2].attrJoin('class', 'task-list-item');
      for (let j = i - 3; j >= 0; j--) {
        if (tokens[j].type === 'bullet_list_open' || tokens[j].type === 'ordered_list_open') {
          tokens[j].attrJoin('class', 'contains-task-list');
          break;
        }
        if (tokens[j].type === 'bullet_list_close' || tokens[j].type === 'ordered_list_close') break;
      }
    }
  });
}

function useMarkdownExtensions(md: MarkdownIt): MarkdownIt {
  md.use(mk);
  md.use(taskListsPlugin);
  return md;
}

/** 获取默认 md 实例（html: false, katex 插件） */
export function getMd(): MarkdownIt {
  if (_md) return _md;
  _md = markdownit({
    html: false,
    breaks: true,
    linkify: true,
    typographer: true,
  });
  return useMarkdownExtensions(_md);
}

/** 预览用 markdown 实例：允许内联 HTML（用于本地文件预览） */
function getMdPreview(): MarkdownIt {
  if (_mdPreview) return _mdPreview;
  _mdPreview = markdownit({
    html: true,
    breaks: true,
    linkify: true,
    typographer: true,
  });
  return useMarkdownExtensions(_mdPreview);
}

function sanitizePreviewHtml(html: string): string {
  if (!html || typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blockedTags = ['script', 'iframe', 'object', 'embed', 'meta[http-equiv="refresh"]'];
  for (const selector of blockedTags) {
    for (const node of Array.from(doc.querySelectorAll(selector))) node.remove();
  }

  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const val = String(attr.value || '').trim().toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if ((name === 'href' || name === 'src') && /^javascript:/.test(val)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.body?.innerHTML || html;
}

const _cache = new Map<string, MarkdownIt>();

/** 获取自定义选项的 md 实例（缓存复用） */
export function getMdWithOpts(opts: Parameters<typeof markdownit>[0]): MarkdownIt {
  const key = JSON.stringify(opts);
  let inst = _cache.get(key);
  if (!inst) {
    inst = markdownit(opts);
    _cache.set(key, inst);
  }
  return inst;
}

export function renderMarkdown(src: string): string {
  const normalizedMath = normalizeMarkdownMathDelimiters(normalizeMarkdownMathBlocks(src));
  const normalized = normalizeMarkdownForCjkEmphasis(normalizedMath);
  const html = getMd().render(normalized);
  return repairMarkdownHtml(html.replace(CJK_EMPHASIS_SPACER_RE, '$1'));
}

export function renderMarkdownForPreview(src: string): string {
  const normalizedMath = normalizeMarkdownMathDelimiters(normalizeMarkdownMathBlocks(src));
  const normalized = normalizeMarkdownForCjkEmphasis(normalizedMath);
  const html = getMdPreview().render(normalized);
  return repairMarkdownHtml(sanitizePreviewHtml(html).replace(CJK_EMPHASIS_SPACER_RE, '$1'));
}
