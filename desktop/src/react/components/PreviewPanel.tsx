/**
 * PreviewPanel — Artifact 预览/编辑面板
 *
 * 从 Zustand store 读取 artifacts / currentArtifactId / previewOpen 状态。
 * 可编辑类型（有 filePath 的 markdown/code/csv）使用 CodeMirror 编辑器。
 *
 * 架构原则：
 * - 文件系统是 source of truth，编辑器直接对接文件
 * - 文件型 artifact 的 content 不回写 store（避免双源）
 * - ArtifactEditor 不依赖 PreviewPanel，可脱离到独立窗口
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores';
import { hanaUrl } from '../hooks/use-hana-fetch';
import { renderMarkdownForPreview } from '../utils/markdown';
import { parseCSV, injectCopyButtons } from '../utils/format';
import { fileIconSvg } from '../utils/icons';
import {
  enhanceHtmlForPreview,
  isImageLikeHref,
  toPreviewAssetUrl,
} from '../utils/preview-path';
import { closePreview as closePreviewAction } from '../stores/artifact-actions';
import { ArtifactEditor } from './ArtifactEditor';
import type { Artifact } from '../types';

const INLINE_EDITABLE_TYPES = new Set(['code', 'csv']);
const DETACHABLE_EDIT_TYPES = new Set(['markdown', 'code', 'csv']);
type DiffLineTone = 'add' | 'remove' | 'context';
type DiffLine = { tone: DiffLineTone; text: string };

function isEditable(artifact: Artifact | null): boolean {
  if (!artifact) return false;
  return !!artifact.filePath && INLINE_EDITABLE_TYPES.has(artifact.type);
}

function canDetachEditor(artifact: Artifact | null): boolean {
  if (!artifact) return false;
  return !!artifact.filePath && DETACHABLE_EDIT_TYPES.has(artifact.type);
}

function getEditorMode(artifact: Artifact): 'markdown' | 'code' | 'text' {
  if (artifact.type === 'markdown') return 'markdown';
  return 'code';
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const normalized = String(base64 || '').replace(/\s+/g, '');
  const bin = atob(normalized);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function parseDiffLines(artifact: Artifact): DiffLine[] {
  const rawMetaLines = (artifact.meta as { diffLines?: unknown } | undefined)?.diffLines;
  if (Array.isArray(rawMetaLines)) {
    const lines: DiffLine[] = [];
    for (const item of rawMetaLines) {
      if (!item || typeof item !== 'object') continue;
      const toneRaw = String((item as { tone?: unknown }).tone || '').toLowerCase();
      const text = String((item as { text?: unknown }).text ?? '');
      const tone: DiffLineTone = toneRaw === 'add'
        ? 'add'
        : (toneRaw === 'remove' ? 'remove' : 'context');
      lines.push({ tone, text });
    }
    if (lines.length > 0) return lines;
  }

  const lines = String(artifact.content || '').split('\n');
  return lines.map((line) => {
    if (line.startsWith('+') && !line.startsWith('+++')) return { tone: 'add', text: line.slice(1) };
    if (line.startsWith('-') && !line.startsWith('---')) return { tone: 'remove', text: line.slice(1) };
    if (line.startsWith(' ')) return { tone: 'context', text: line.slice(1) };
    return { tone: 'context', text: line };
  });
}

function enhanceMarkdownImages(container: HTMLElement, baseFilePath?: string): void {
  for (const img of Array.from(container.querySelectorAll('img[src]'))) {
    const rawSrc = img.getAttribute('src') || '';
    const previewSrc = toPreviewAssetUrl(rawSrc, baseFilePath);
    if (previewSrc) img.setAttribute('src', previewSrc);
    img.classList.add('preview-markdown-image');
    img.setAttribute('loading', 'lazy');
  }

  for (const link of Array.from(container.querySelectorAll('a[href]'))) {
    if (link.querySelector('img')) continue;
    const href = link.getAttribute('href') || '';
    if (!isImageLikeHref(href)) continue;

    const previewSrc = toPreviewAssetUrl(href, baseFilePath);
    if (!previewSrc) continue;

    const holder = document.createElement('div');
    holder.className = 'preview-markdown-image-link';

    const img = document.createElement('img');
    img.className = 'preview-markdown-image';
    img.src = previewSrc;
    img.alt = (link.textContent || '').trim() || 'image';
    img.loading = 'lazy';
    holder.appendChild(img);

    const linkText = (link.textContent || '').trim();
    if (!linkText || linkText === href.trim()) {
      link.replaceWith(holder);
    } else {
      link.insertAdjacentElement('afterend', holder);
    }
  }
}

async function renderDocxPreview(container: HTMLDivElement, artifact: Artifact): Promise<void> {
  const content = String(artifact.content || '').trim();
  if (!content) {
    container.textContent = '';
    return;
  }

  // 兼容优先：先尝试 LibreOffice 转 PDF，解决 MathType / OLE 公式缺失问题。
  if (artifact.filePath && window.platform?.readDocxPdfBase64) {
    container.innerHTML = '<div class="preview-docx-loading">Rendering document...</div>';
    const pdfBase64 = await window.platform.readDocxPdfBase64(artifact.filePath);
    if (!container.isConnected) return;
    if (pdfBase64) {
      container.classList.add('preview-docx-pdf');
      const iframe = document.createElement('iframe');
      iframe.className = 'preview-pdf';
      iframe.src = `data:application/pdf;base64,${pdfBase64}`;
      container.innerHTML = '';
      container.appendChild(iframe);
      return;
    }
  }

  // 兼容旧数据：若已是 HTML（mammoth 输出），直接渲染。
  if (content.startsWith('<')) {
    container.classList.add('preview-docx-html');
    container.innerHTML = content;
    return;
  }

  container.innerHTML = '<div class="preview-docx-loading">Loading...</div>';

  try {
    const docx = await import('docx-preview');
    if (!container.isConnected) return;

    const host = document.createElement('div');
    host.className = 'preview-docx-host';
    container.innerHTML = '';
    container.appendChild(host);

    const arrayBuffer = base64ToArrayBuffer(content);
    await docx.renderAsync(arrayBuffer, host, undefined, {
      className: 'docx',
      inWrapper: true,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      renderChanges: true,
      renderComments: true,
      useBase64URL: true,
    });
  } catch {
    // 动态渲染失败时回退到 mammoth HTML，保证可读性。
    if (!artifact.filePath) {
      container.innerHTML = '<div class="preview-docx-loading">Unable to render this document.</div>';
      return;
    }
    const fallback = await window.platform?.readDocxHtml?.(artifact.filePath);
    if (!container.isConnected) return;
    if (fallback) {
      container.classList.add('preview-docx-html');
      container.innerHTML = fallback;
    } else {
      container.innerHTML = '<div class="preview-docx-loading">Unable to render this document.</div>';
    }
  }
}

async function renderPptPreview(container: HTMLDivElement, artifact: Artifact): Promise<void> {
  container.innerHTML = '<div class="preview-docx-loading">Rendering slides...</div>';
  if (!artifact.filePath || !window.platform?.readPptPdfBase64) {
    container.innerHTML = '<div class="preview-docx-loading">Unable to render this presentation.</div>';
    return;
  }
  const pdfBase64 = await window.platform.readPptPdfBase64(artifact.filePath);
  if (!container.isConnected) return;
  if (!pdfBase64) {
    container.innerHTML = '<div class="preview-docx-loading">Unable to render this presentation.</div>';
    return;
  }
  let blobUrl = '';
  try {
    const bytes = Uint8Array.from(atob(pdfBase64), (ch) => ch.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'application/pdf' });
    blobUrl = URL.createObjectURL(blob);
  } catch {
    container.innerHTML = '<div class="preview-docx-loading">Unable to render this presentation.</div>';
    return;
  }
  const iframe = document.createElement('iframe');
  iframe.className = 'preview-pdf';
  iframe.src = blobUrl;
  container.innerHTML = '';
  container.appendChild(iframe);
}

export function PreviewPanel() {
  const previewOpen = useStore(s => s.previewOpen);
  const currentArtifactId = useStore(s => s.currentArtifactId);
  const artifacts = useStore(s => s.artifacts);
  const editorDetached = useStore(s => s.editorDetached);
  const setEditorDetached = useStore(s => s.setEditorDetached);

  const bodyRef = useRef<HTMLDivElement>(null);
  const artifact = artifacts.find(a => a.id === currentArtifactId) ?? null;
  const editable = isEditable(artifact);
  const detachable = canDetachEditor(artifact);

  const closePreview = useCallback(() => {
    closePreviewAction();
  }, []);

  // 拆分到独立窗口
  const handleDetach = useCallback(() => {
    if (!artifact?.filePath) return;
    setEditorDetached(true);
    closePreviewAction();
    // 通过 IPC 打开编辑器窗口
    window.platform?.openEditorWindow?.({
      filePath: artifact.filePath,
      title: artifact.title,
      type: artifact.type,
      language: artifact.language,
    });
  }, [artifact, setEditorDetached]);

  // 非编辑模式：渲染 artifact 内容到 body（命令式 DOM）
  // 注意：editable 时也要清理上一次命令式插入的残留 DOM（iframe 等），
  // 但不能用 innerHTML='' 因为会破坏 React 管理的 ArtifactEditor。
  // 所以只移除非 React 的子节点。
  useEffect(() => {
    if (!previewOpen || !artifact || !bodyRef.current) return;
    const body = bodyRef.current;
    // 清理命令式插入的节点（保留 React 管理的 .artifact-editor）
    Array.from(body.children).forEach(child => {
      if (!child.classList.contains('artifact-editor')) {
        if (child instanceof HTMLIFrameElement && child.src.startsWith('blob:')) {
          try { URL.revokeObjectURL(child.src); } catch {}
        }
        child.remove();
      }
    });
    if (editable) return;

    switch (artifact.type) {
      case 'html': {
        const iframe = document.createElement('iframe');
        iframe.sandbox.add('allow-scripts');
        iframe.sandbox.add('allow-same-origin');
        iframe.srcdoc = enhanceHtmlForPreview(artifact.content, artifact.filePath);
        body.appendChild(iframe);
        break;
      }
      case 'markdown': {
        const div = document.createElement('div');
        div.className = 'preview-markdown md-content';
        div.innerHTML = renderMarkdownForPreview(artifact.content);
        enhanceMarkdownImages(div, artifact.filePath);
        injectCopyButtons(div);
        body.appendChild(div);
        break;
      }
      case 'code': {
        const pre = document.createElement('pre');
        pre.className = 'preview-code';
        const code = document.createElement('code');
        code.textContent = artifact.content;
        if (artifact.language) code.className = `language-${artifact.language}`;
        pre.appendChild(code);
        body.appendChild(pre);
        break;
      }
      case 'docx': {
        const div = document.createElement('div');
        div.className = 'preview-docx';
        body.appendChild(div);
        void renderDocxPreview(div, artifact);
        break;
      }
      case 'xlsx': {
        const div = document.createElement('div');
        div.className = 'preview-csv';
        div.innerHTML = artifact.content;
        body.appendChild(div);
        break;
      }
      case 'svg': {
        const img = document.createElement('img');
        img.className = 'preview-image';
        img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(artifact.content)))}`;
        img.alt = artifact.title;
        body.appendChild(img);
        break;
      }
      case 'image': {
        const img = document.createElement('img');
        img.className = 'preview-image';
        const ext = artifact.ext === 'jpg' ? 'jpeg' : (artifact.ext || 'png');
        img.src = `data:image/${ext};base64,${artifact.content}`;
        img.alt = artifact.title;
        body.appendChild(img);
        break;
      }
      case 'pdf': {
        const iframe = document.createElement('iframe');
        iframe.className = 'preview-pdf';
        if (artifact.filePath) {
          iframe.src = hanaUrl(`/api/fs/file?path=${encodeURIComponent(artifact.filePath)}`);
        } else if (artifact.content) {
          iframe.src = `data:application/pdf;base64,${artifact.content}`;
        }
        body.appendChild(iframe);
        break;
      }
      case 'ppt': {
        const div = document.createElement('div');
        div.className = 'preview-ppt';
        body.appendChild(div);
        void renderPptPreview(div, artifact);
        break;
      }
      case 'csv': {
        const wrap = document.createElement('div');
        wrap.className = 'preview-csv';
        const table = document.createElement('table');
        const rows = parseCSV(artifact.content);
        if (rows.length > 0) {
          const thead = document.createElement('thead');
          const headerRow = document.createElement('tr');
          for (const cell of rows[0]) {
            const th = document.createElement('th');
            th.textContent = cell;
            headerRow.appendChild(th);
          }
          thead.appendChild(headerRow);
          table.appendChild(thead);
          const tbody = document.createElement('tbody');
          for (let i = 1; i < rows.length; i++) {
            const tr = document.createElement('tr');
            for (const cell of rows[i]) {
              const td = document.createElement('td');
              td.textContent = cell;
              tr.appendChild(td);
            }
            tbody.appendChild(tr);
          }
          table.appendChild(tbody);
        }
        wrap.appendChild(table);
        body.appendChild(wrap);
        break;
      }
      case 'diff': {
        const wrap = document.createElement('div');
        wrap.className = 'preview-diff';
        for (const line of parseDiffLines(artifact)) {
          const row = document.createElement('div');
          row.className = `preview-diff-line ${line.tone}`;
          const prefix = document.createElement('span');
          prefix.className = 'preview-diff-prefix';
          prefix.textContent = line.tone === 'add' ? '+' : (line.tone === 'remove' ? '-' : ' ');
          const text = document.createElement('span');
          text.className = 'preview-diff-text';
          text.textContent = line.text || '\u200B';
          row.appendChild(prefix);
          row.appendChild(text);
          wrap.appendChild(row);
        }
        body.appendChild(wrap);
        break;
      }
      case 'file-info': {
        const wrap = document.createElement('div');
        wrap.className = 'preview-file-info';
        const iconEl = document.createElement('div');
        iconEl.className = 'preview-file-icon';
        iconEl.innerHTML = fileIconSvg(artifact.ext || '');
        const nameEl = document.createElement('div');
        nameEl.className = 'preview-file-name';
        nameEl.textContent = artifact.title;
        const extLabel = document.createElement('div');
        extLabel.className = 'preview-file-ext';
        const _t = window.t ?? ((p: string) => p);
        extLabel.textContent = (artifact.ext || '').toUpperCase() + ' ' + _t('desk.fileLabel');
        const openBtn = document.createElement('button');
        openBtn.className = 'preview-file-open-btn';
        openBtn.textContent = _t('desk.openWithDefault');
        openBtn.addEventListener('click', () => {
          if (artifact.filePath) window.platform?.openFile?.(artifact.filePath);
        });
        wrap.appendChild(iconEl);
        wrap.appendChild(nameEl);
        wrap.appendChild(extLabel);
        wrap.appendChild(openBtn);
        body.appendChild(wrap);
        break;
      }
      default: {
        const pre = document.createElement('pre');
        pre.className = 'preview-code';
        pre.textContent = artifact.content;
        body.appendChild(pre);
      }
    }
  }, [previewOpen, artifact, editable]);

  const [copyLabel, setCopyLabel] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);
  const handleCopy = useCallback(() => {
    if (!artifact) return;
    navigator.clipboard.writeText(artifact.content).then(() => {
      const _t = window.t ?? ((p: string) => p);
      setCopyLabel(_t('attach.copied'));
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopyLabel(null), 1500);
    });
  }, [artifact]);

  return (
    <div className={`preview-panel${previewOpen ? '' : ' collapsed'}`} id="previewPanel">
      <div className="resize-handle resize-handle-left" id="previewResizeHandle"></div>
      <div className="preview-panel-inner">
        <div className="preview-panel-header">
          <span className="preview-panel-title" id="previewTitle">
            {artifact?.title ?? ''}
          </span>
          <div className="preview-panel-actions">
            <button className="preview-panel-action-btn preview-panel-copy-btn" onClick={handleCopy}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span>{copyLabel ?? (window.t ?? ((p: string) => p))('attach.copy')}</span>
            </button>
            {detachable && (
              <button className="preview-panel-action-btn" title="Open in window" onClick={handleDetach}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3"></line>
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                </svg>
              </button>
            )}
            <button className="preview-panel-action-btn" title="Close" onClick={closePreview}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
        <div className="preview-panel-body" id="previewBody" ref={bodyRef}>
          {previewOpen && artifact && editable && (
            <ArtifactEditor
              content={artifact.content}
              filePath={artifact.filePath}
              mode={getEditorMode(artifact)}
              language={artifact.language}
            />
          )}
        </div>
      </div>
    </div>
  );
}
