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
const MATH_FENCE_OPEN_RE = /^[ \t]*(```|~~~)\s*(math|latex|tex|katex)\s*$/i;
const INDENTED_BLOCK_RE = /^(?: {4}|\t)/;
const STRIP_INDENT_RE = /^(?: {4}|\t)/;
const MATH_SIGNAL_RE = /(?:\\[A-Za-z]+|[=^_]|[α-ωΑ-Ωπθλεσμ]|(?:\b(?:min|max|argmin|argmax|clip|sum|prod|exp|log)\b))/i;
const CODE_SIGNAL_RE = /(?:\b(?:const|let|var|function|class|import|export|return|if|for|while|switch|try|catch|console|def)\b|[{};]|=>)/;

/**
 * markdown-it 在部分 CJK 场景下会漏掉强调解析，例如：
 * 用**重要性采样（Importance Sampling）**把...
 * 这里先注入极细空格触发解析，再在 HTML 阶段移除。
 */
function normalizeMarkdownForCjkEmphasis(src: string): string {
  const lines = String(src || '').split(/(\r?\n)/);
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

/** 获取默认 md 实例（html: false, katex 插件） */
export function getMd(): MarkdownIt {
  if (_md) return _md;
  _md = markdownit({
    html: false,
    breaks: true,
    linkify: true,
    typographer: true,
  });
  _md.use(mk);
  return _md;
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
  _mdPreview.use(mk);
  return _mdPreview;
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
  const normalizedMath = normalizeMarkdownMathBlocks(src);
  const normalized = normalizeMarkdownForCjkEmphasis(normalizedMath);
  const html = getMd().render(normalized);
  return html.replace(CJK_EMPHASIS_SPACER_RE, '$1');
}

export function renderMarkdownForPreview(src: string): string {
  const normalizedMath = normalizeMarkdownMathBlocks(src);
  const normalized = normalizeMarkdownForCjkEmphasis(normalizedMath);
  const html = getMdPreview().render(normalized);
  return sanitizePreviewHtml(html).replace(CJK_EMPHASIS_SPACER_RE, '$1');
}
