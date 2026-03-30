import { hanaUrl } from '../hooks/use-hana-fetch';

const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/]/;
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']);
const UNIX_ABS_ROOT_RE = /^\/(?:Users|home|opt|var|tmp|private|Volumes|etc|usr)\//;
const MD_INLINE_TOKEN_RE = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)/g;

export function normalizePreviewExt(ext: string): string {
  return String(ext || '').trim().toLowerCase().replace(/^\./, '');
}

function stripQueryAndHash(input: string): string {
  const s = String(input || '');
  const q = s.indexOf('?');
  const h = s.indexOf('#');
  const cut = [q, h].filter(i => i >= 0).sort((a, b) => a - b)[0];
  return cut == null ? s : s.slice(0, cut);
}

function isWebUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

function isDataLike(input: string): boolean {
  return /^(data:|blob:)/i.test(input);
}

function isUnsafeProtocol(input: string): boolean {
  return /^(javascript:|vbscript:)/i.test(input);
}

function fileUrlToPath(input: string): string | null {
  try {
    const u = new URL(input);
    if (u.protocol !== 'file:') return null;
    let p = decodeURIComponent(u.pathname || '');
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    return p || null;
  } catch {
    return null;
  }
}

function splitPath(input: string): { prefix: string; segments: string[] } {
  const normalized = String(input || '').replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    return {
      prefix: '/',
      segments: normalized.split('/').filter(Boolean),
    };
  }
  const driveMatch = normalized.match(/^([A-Za-z]:)(?:\/(.*))?$/);
  if (driveMatch) {
    return {
      prefix: driveMatch[1],
      segments: String(driveMatch[2] || '').split('/').filter(Boolean),
    };
  }
  return {
    prefix: '',
    segments: normalized.split('/').filter(Boolean),
  };
}

function joinPath(prefix: string, segments: string[]): string {
  if (prefix === '/') return `/${segments.join('/')}`;
  if (/^[A-Za-z]:$/.test(prefix)) return `${prefix}/${segments.join('/')}`;
  return segments.join('/');
}

function dirname(filePath: string): string {
  const { prefix, segments } = splitPath(filePath);
  if (segments.length <= 1) return prefix || '';
  return joinPath(prefix, segments.slice(0, -1));
}

function resolveRelativePath(baseFilePath: string, relativePath: string): string {
  const baseDir = dirname(baseFilePath);
  const { prefix, segments } = splitPath(baseDir);
  const rel = String(relativePath || '').replace(/\\/g, '/');

  for (const part of rel.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(part);
  }
  return joinPath(prefix, segments);
}

export function resolveAssetPath(raw: string, baseFilePath?: string): string | null {
  const href = String(raw || '').trim();
  if (!href) return null;
  if (href.startsWith('#')) return href;
  if (href.startsWith('//')) return `https:${href}`;
  if (isUnsafeProtocol(href)) return null;
  if (isWebUrl(href) || isDataLike(href)) return href;

  const filePath = fileUrlToPath(href);
  if (filePath) return filePath;

  if (WINDOWS_ABS_RE.test(href)) return href;
  if (href.startsWith('/')) {
    if (UNIX_ABS_ROOT_RE.test(href)) return href;
    if (baseFilePath) return resolveRelativePath(baseFilePath, `.${href}`);
    return href;
  }
  if (!baseFilePath) return null;

  if (href.startsWith('./') || href.startsWith('../') || !/^[A-Za-z][A-Za-z\d+.-]*:/.test(href)) {
    return resolveRelativePath(baseFilePath, href);
  }

  return href;
}

export function toPreviewAssetUrl(raw: string, baseFilePath?: string): string | null {
  const original = String(raw || '').trim();
  const resolved = resolveAssetPath(raw, baseFilePath);
  if (!resolved) return null;
  if (resolved.startsWith('#')) return resolved;
  if (isWebUrl(resolved) || isDataLike(resolved)) return resolved;
  if (!baseFilePath && original.startsWith('/') && !WINDOWS_ABS_RE.test(original)) {
    return original;
  }
  return hanaUrl(`/api/fs/file?path=${encodeURIComponent(resolved)}`);
}

export function isImageLikeHref(raw: string): boolean {
  const value = stripQueryAndHash(String(raw || '').trim());
  const pathLike = isWebUrl(value)
    ? (() => {
        try {
          return stripQueryAndHash(new URL(value).pathname || '');
        } catch {
          return value;
        }
      })()
    : value;

  const m = pathLike.match(/\.([A-Za-z0-9]+)$/);
  if (!m) return false;
  return IMAGE_EXTS.has(m[1].toLowerCase());
}

export function rewriteHtmlAssetUrls(html: string, baseFilePath?: string): string {
  if (!html) return html;

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const attrs: Array<[string, string]> = [
    ['img', 'src'],
    ['source', 'src'],
    ['source', 'srcset'],
    ['script', 'src'],
    ['link', 'href'],
    ['video', 'src'],
    ['video', 'poster'],
    ['audio', 'src'],
  ];

  for (const [tag, attr] of attrs) {
    const selector = `${tag}[${attr}]`;
    for (const node of Array.from(doc.querySelectorAll(selector))) {
      const oldVal = node.getAttribute(attr);
      if (!oldVal) continue;
      const newVal = attr === 'srcset'
        ? oldVal.includes('data:')
          ? oldVal
          : oldVal
          .split(',')
          .map((entry) => {
            const trimmed = entry.trim();
            if (!trimmed) return trimmed;
            const parts = trimmed.split(/\s+/);
            const rewrittenUrl = toPreviewAssetUrl(parts[0], baseFilePath);
            if (!rewrittenUrl) return trimmed;
            return [rewrittenUrl, ...parts.slice(1)].join(' ').trim();
          })
          .filter(Boolean)
          .join(', ')
        : toPreviewAssetUrl(oldVal, baseFilePath);
      if (!newVal || newVal === oldVal) continue;
      node.setAttribute(attr, newVal);
    }
  }

  return doc.documentElement.outerHTML || html;
}

function transformMarkdownTokensInTextNode(node: Text, baseFilePath?: string): void {
  const text = node.nodeValue || '';
  MD_INLINE_TOKEN_RE.lastIndex = 0;
  if (!MD_INLINE_TOKEN_RE.test(text)) return;
  MD_INLINE_TOKEN_RE.lastIndex = 0;

  const doc = node.ownerDocument;
  if (!doc) return;
  const frag = doc.createDocumentFragment();
  let cursor = 0;
  let m: RegExpExecArray | null;

  while ((m = MD_INLINE_TOKEN_RE.exec(text)) != null) {
    if (m.index > cursor) {
      frag.appendChild(doc.createTextNode(text.slice(cursor, m.index)));
    }
    if (m[1] != null) {
      const alt = m[1] || '';
      const rawSrc = (m[2] || '').trim();
      const src = toPreviewAssetUrl(rawSrc, baseFilePath);
      if (src) {
        const img = doc.createElement('img');
        img.setAttribute('src', src);
        img.setAttribute('alt', alt);
        frag.appendChild(img);
      } else {
        frag.appendChild(doc.createTextNode(m[0]));
      }
    } else {
      const label = m[3] || '';
      const rawHref = (m[4] || '').trim();
      const href = toPreviewAssetUrl(rawHref, baseFilePath);
      if (href) {
        const a = doc.createElement('a');
        a.setAttribute('href', href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        a.textContent = label;
        frag.appendChild(a);
      } else {
        frag.appendChild(doc.createTextNode(m[0]));
      }
    }
    cursor = MD_INLINE_TOKEN_RE.lastIndex;
  }

  if (cursor < text.length) {
    frag.appendChild(doc.createTextNode(text.slice(cursor)));
  }
  node.replaceWith(frag);
}

function rewriteHtmlMarkdownTokens(doc: Document, baseFilePath?: string): void {
  const root = doc.body || doc.documentElement;
  if (!root) return;
  const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'PRE', 'CODE', 'TEXTAREA', 'A']);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let cur: Node | null = walker.nextNode();
  while (cur) {
    const text = cur as Text;
    const parentTag = text.parentElement?.tagName || '';
    if (!skipTags.has(parentTag) && MD_INLINE_TOKEN_RE.test(text.nodeValue || '')) {
      nodes.push(text);
    }
    MD_INLINE_TOKEN_RE.lastIndex = 0;
    cur = walker.nextNode();
  }
  for (const n of nodes) transformMarkdownTokensInTextNode(n, baseFilePath);
}

function ensurePreviewStyle(doc: Document): void {
  const head = doc.head || doc.documentElement;
  if (!head) return;
  if (doc.getElementById('hana-html-preview-style')) return;
  const style = doc.createElement('style');
  style.id = 'hana-html-preview-style';
  style.textContent = `
    html, body { max-width: 100%; }
    body { overflow-wrap: anywhere; word-break: break-word; }
    img, video { max-width: 100%; height: auto; }
    table { border-collapse: collapse; max-width: 100%; display: block; overflow: auto; }
    th, td { border: 1px solid #d9d9d9; padding: 6px 10px; }
    pre, code { white-space: pre-wrap; word-break: break-word; }
  `;
  head.appendChild(style);
}

export function enhanceHtmlForPreview(html: string, baseFilePath?: string): string {
  if (!html) return html;
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  rewriteHtmlMarkdownTokens(doc, baseFilePath);
  ensurePreviewStyle(doc);
  return rewriteHtmlAssetUrls(doc.documentElement.outerHTML || html, baseFilePath);
}
