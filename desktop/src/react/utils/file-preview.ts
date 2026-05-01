/**
 * file-preview.ts — 文件预览工具函数
 *
 * 从 file-cards-shim.ts 提取，供 React 组件直接 import。
 */

import { useStore } from '../stores';
import type { Artifact } from '../types';
import { openPreview } from '../stores/artifact-actions';
import { normalizePreviewExt } from './preview-path';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── 可在 Artifacts 面板中预览的文件类型 ──

export const PREVIEWABLE_EXTS: Record<string, string> = {
  html: 'html', htm: 'html', xhtml: 'html',
  md: 'markdown', markdown: 'markdown', mkd: 'markdown', mkdn: 'markdown', mdown: 'markdown',
  js: 'code', ts: 'code', jsx: 'code', tsx: 'code',
  py: 'code', css: 'code', json: 'code', yaml: 'code', yml: 'code',
  xml: 'code', sql: 'code', sh: 'code', bash: 'code',
  txt: 'code', svg: 'svg',
  c: 'code', cpp: 'code', h: 'code', java: 'code',
  rs: 'code', go: 'code', rb: 'code', php: 'code',
  csv: 'csv', pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  docx: 'docx', xlsx: 'xlsx', xls: 'xlsx',
};

export const BINARY_PREVIEW_TYPES = new Set(['image', 'pdf']);

export async function readFileForPreview(filePath: string, ext: string): Promise<string | null> {
  const normExt = normalizePreviewExt(ext);
  const previewType = PREVIEWABLE_EXTS[normExt];
  if (!previewType) return null;
  const p = (window as any).platform;
  if (!p) return null;
  if (previewType === 'docx') return p.readFileBase64?.(filePath) ?? p.readDocxHtml?.(filePath) ?? null;
  if (previewType === 'xlsx') return p.readXlsxHtml?.(filePath) ?? null;
  if (BINARY_PREVIEW_TYPES.has(previewType)) return p.readFileBase64?.(filePath) ?? null;
  return p.readFile?.(filePath) ?? null;
}

/**
 * 打开文件预览：读取文件内容 → 创建 Artifact → 打开预览面板
 */
export async function openFilePreview(filePath: string, label: string, ext: string): Promise<void> {
  return openFilePreviewWithOptions(filePath, label, ext, {});
}

export async function openFilePreviewWithOptions(
  filePath: string,
  label: string,
  ext: string,
  opts: { replaceRightSidebar?: boolean } = {},
): Promise<void> {
  const normExt = normalizePreviewExt(ext);
  const fileName = label || filePath.split('/').pop() || filePath;

  if (normExt === 'skill') {
    // .skill 文件可能是纯文本也可能是 zip，先尝试读取内容在预览面板展示
    const name = fileName.replace(/\.skill$/, '');
    const content = await (window as any).platform?.readFile?.(filePath);
    if (content != null) {
      const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
      const artifact: Artifact = {
        id: `skill-${name}`,
        type: 'markdown',
        title: name,
        content: body,
        filePath,
      };
      upsertArtifact(artifact);
      openPreview(artifact, { replaceRightSidebar: opts.replaceRightSidebar === true });
      return;
    }
    // 读取失败（可能是 zip 格式），尝试 skill viewer
    (window as any).platform?.openSkillViewer?.({ skillPath: filePath });
    return;
  }

  if (normExt === 'pdf') {
    // PDF 统一走流式 URL（/api/fs/file），避免 data URL 过长或内置查看器兼容问题导致白屏
    const artifact: Artifact = {
      id: `file-${filePath}`,
      type: 'pdf',
      title: fileName,
      content: '',
      filePath,
      ext: normExt,
    };
    upsertArtifact(artifact);
    openPreview(artifact, {
      replaceRightSidebar: opts.replaceRightSidebar === true,
      preferredWidth: 740,
    });
    return;
  }

  const canPreview = normExt in PREVIEWABLE_EXTS;
  if (canPreview) {
    const content = await readFileForPreview(filePath, normExt);
    if (content != null) {
      const previewType = PREVIEWABLE_EXTS[normExt];
      const artifact: Artifact = {
        id: `file-${filePath}`,
        type: previewType,
        title: fileName,
        content,
        filePath,
        ext: normExt,
        language: previewType === 'code' ? normExt : undefined,
      };
      upsertArtifact(artifact);
      openPreview(artifact, {
        replaceRightSidebar: opts.replaceRightSidebar === true,
        preferredWidth: previewType === 'docx' ? 760 : undefined,
      });
      return;
    }
  }

  // 无法预览的文件类型
  const artifact: Artifact = {
    id: `file-${filePath}`,
    type: 'file-info',
    title: fileName,
    content: '',
    filePath,
    ext: normExt,
  };
  upsertArtifact(artifact);
  openPreview(artifact, { replaceRightSidebar: opts.replaceRightSidebar === true });
}

/**
 * 打开 Skill 预览：读取 skill 文件 → 创建 markdown Artifact → 打开预览面板
 */
export async function openSkillPreview(skillName: string, skillFilePath: string): Promise<void> {
  const content = await (window as any).platform?.readFile?.(skillFilePath);
  if (content != null) {
    const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
    const artifact: Artifact = {
      id: `skill-${skillName}`,
      type: 'markdown',
      title: skillName,
      content: body,
      filePath: skillFilePath,
    };
    upsertArtifact(artifact);
    openPreview(artifact);
  }
}

/** 插入或更新 artifacts store */
function upsertArtifact(artifact: Artifact): void {
  const s = useStore.getState();
  const arts = [...s.artifacts];
  const idx = arts.findIndex(a => a.id === artifact.id);
  if (idx >= 0) arts[idx] = artifact;
  else arts.push(artifact);
  s.setArtifacts(arts);
}
