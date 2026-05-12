/**
 * artifact-actions.ts — Artifact 预览管理
 *
 * 从 artifacts-shim.ts 迁移。纯 Zustand store 操作 + updateLayout。
 */

import { useStore } from './index';
import { updateLayout } from '../components/SidebarLayout';
import type { Artifact } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

let _artifactCounter = 0;
let _replaceRightSidebarActive = false;
let _jianSnapshotBeforeReplace: { open: boolean; autoCollapsed: boolean } | null = null;

function ensurePreviewWidth(preferredWidth?: number): void {
  if (!preferredWidth || typeof document === "undefined") return;
  const min = 320, max = 800;
  const target = Math.max(min, Math.min(max, Math.round(preferredWidth)));
  const root = document.documentElement;
  const currentCss = parseInt(getComputedStyle(root).getPropertyValue('--preview-panel-width')) || 0;
  const saved = Number(localStorage.getItem('hana-preview-width') || 0);
  const current = Math.max(currentCss, saved);
  if (current >= target) return;

  const px = `${target}px`;
  root.style.setProperty('--preview-panel-width', px);
  const previewPanel = document.getElementById('previewPanel');
  const previewInner = previewPanel?.querySelector('.preview-panel-inner') as HTMLElement | null;
  if (previewInner) {
    previewInner.style.width = px;
    previewInner.style.minWidth = px;
  }
  localStorage.setItem('hana-preview-width', String(target));
}

export function openPreview(
  artifact: Artifact,
  opts?: { replaceRightSidebar?: boolean; preferredWidth?: number },
): void {
  const s = useStore.getState();
  const replaceRightSidebar = opts?.replaceRightSidebar === true;
  const arts = [...s.artifacts];
  const idx = arts.findIndex(a => a.id === artifact.id);
  if (idx >= 0) arts[idx] = artifact;
  else arts.push(artifact);
  s.setArtifacts(arts);
  s.setCurrentArtifactId(artifact.id);
  if (replaceRightSidebar) {
    // Only capture once per replace session so repeated openPreview calls
    // while preview is open won't overwrite the original sidebar state.
    if (!_replaceRightSidebarActive) {
      _jianSnapshotBeforeReplace = {
        open: s.jianOpen,
        autoCollapsed: s.jianAutoCollapsed,
      };
      _replaceRightSidebarActive = true;
    }
    s.setJianOpen(false);
    s.setJianAutoCollapsed(false);
  }
  s.setPreviewOpen(true);
  ensurePreviewWidth(opts?.preferredWidth);
  updateLayout();
}

export function closePreview(): void {
  const s = useStore.getState();
  const snapshot = _replaceRightSidebarActive ? _jianSnapshotBeforeReplace : null;
  _replaceRightSidebarActive = false;
  _jianSnapshotBeforeReplace = null;
  s.setPreviewOpen(false);
  s.setCurrentArtifactId(null);
  if (snapshot) {
    s.setJianOpen(snapshot.open);
    s.setJianAutoCollapsed(snapshot.autoCollapsed);
  }
  updateLayout();
  if (snapshot) {
    const next = useStore.getState();
    if (next.jianOpen !== snapshot.open || next.jianAutoCollapsed !== snapshot.autoCollapsed) {
      useStore.setState({
        jianOpen: snapshot.open,
        jianAutoCollapsed: snapshot.autoCollapsed,
      });
    }
  }
}

/** 注册 artifact 到全局 store（流式事件 + 点击卡片都走这里） */
export function handleArtifact(data: Record<string, unknown>): void {
  const id = (data.artifactId as string) || `artifact-${++_artifactCounter}`;
  const artifact: Artifact = {
    id,
    type: data.artifactType as string,
    title: data.title as string,
    content: data.content as string,
    language: data.language as string | undefined,
  };
  const s = useStore.getState();
  const arts = [...s.artifacts];
  const idx = arts.findIndex(a => a.id === id);
  if (idx >= 0) arts[idx] = artifact;
  else arts.push(artifact);
  s.setArtifacts(arts);
}

/**
 * 注册编辑器 dock/detach 事件监听
 * 在 App mount 时调用一次
 */
export function initEditorEvents(): void {
  window.platform?.onEditorDockFile?.((data: any) => {
    const s = useStore.getState();
    const existing = s.artifacts.find(a => a.filePath === data.filePath);
    if (existing) {
      openPreview(existing);
    } else {
      window.platform?.readFile(data.filePath).then((content: string | null) => {
        if (content == null) return;
        const artifact: Artifact = {
          id: `file-${data.filePath}`,
          type: data.type,
          title: data.title,
          content,
          filePath: data.filePath,
          language: data.language,
        };
        openPreview(artifact);
      });
    }
    useStore.getState().setEditorDetached(false);
  });

  window.platform?.onEditorDetached?.((detached: boolean) => {
    useStore.getState().setEditorDetached(detached);
  });
}
