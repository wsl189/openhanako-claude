/**
 * useSidebarResize — 侧边栏宽度拖拽调整
 *
 * 从 sidebar-shim.ts 的 initSidebarResize 迁移。
 * 在 useEffect 中绑定 pointer 事件，管理三个 resize handle。
 */

import { useEffect } from 'react';

export function useSidebarResize(): void {
  useEffect(() => {
    const root = document.documentElement;
    const sidebarEl = document.getElementById('sidebar');
    const jianSidebarEl = document.getElementById('jianSidebar');
    const leftHandle = document.getElementById('sidebarResizeHandle');
    const rightHandle = document.getElementById('jianResizeHandle');
    const previewPanel = document.getElementById('previewPanel');

    const LEFT_MIN = 180, LEFT_MAX = 400;
    const RIGHT_MIN = 180, RIGHT_MAX = 600;
    const PREVIEW_MIN = 320, PREVIEW_MAX = 800;

    const leftInner = sidebarEl?.querySelector('.sidebar-inner') as HTMLElement | null;
    const rightInner = jianSidebarEl?.querySelector('.jian-sidebar-inner') as HTMLElement | null;
    const previewInner = previewPanel?.querySelector('.preview-panel-inner') as HTMLElement | null;

    function applySidebarWidth(w: number): void {
      const px = w + 'px';
      root.style.setProperty('--sidebar-width', px);
      if (leftInner) { leftInner.style.width = px; leftInner.style.minWidth = px; }
    }

    function updateJianColumns(w: number): void {
      const cols = w > 520 ? 3 : w > 350 ? 2 : 1;
      root.style.setProperty('--jian-columns', String(cols));
    }

    function applyJianWidth(w: number): void {
      const px = w + 'px';
      root.style.setProperty('--jian-sidebar-width', px);
      if (rightInner) { rightInner.style.width = px; rightInner.style.minWidth = px; }
      updateJianColumns(w);
    }

    function applyPreviewWidth(w: number): void {
      const px = w + 'px';
      root.style.setProperty('--preview-panel-width', px);
      if (previewInner) { previewInner.style.width = px; previewInner.style.minWidth = px; }
    }

    // 恢复保存的宽度
    const savedLeft = localStorage.getItem('hana-sidebar-width');
    const savedRight = localStorage.getItem('hana-jian-width');
    const savedPreview = localStorage.getItem('hana-preview-width');
    if (savedLeft) applySidebarWidth(Number(savedLeft));
    if (savedRight) applyJianWidth(Number(savedRight));
    if (savedPreview) applyPreviewWidth(Number(savedPreview));

    function setupHandle(
      handle: HTMLElement | null,
      getSidebar: () => HTMLElement | null,
      getWidth: () => number,
      setWidth: (w: number) => void,
      min: number,
      max: number,
      storageKey: string,
      isRight: boolean,
    ): void {
      if (!handle) return;
      let dragging = false;
      let activePointerId: number | null = null;
      let startX = 0;
      let startW = 0;

      const setHandleY = (clientY: number) => {
        const rect = handle.getBoundingClientRect();
        handle.style.setProperty('--handle-y', `${clientY - rect.top}px`);
      };

      const clearHandleY = () => {
        handle.style.setProperty('--handle-y', '-999px');
      };

      const onHandlePointerMove = (e: PointerEvent) => setHandleY(e.clientY);
      const onHandlePointerLeave = () => {
        if (!dragging) clearHandleY();
      };

      const onHandlePointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const sidebarTarget = getSidebar();
        if (!sidebarTarget || sidebarTarget.classList.contains('collapsed')) return;

        startX = e.clientX;
        startW = getWidth();
        activePointerId = e.pointerId;
        dragging = true;
        handle.classList.add('active');
        document.body.classList.add('resizing');
        setHandleY(e.clientY);
        try { handle.setPointerCapture(e.pointerId); } catch {}
      };

      const stopDrag = (pointerId?: number): void => {
        if (!dragging) return;
        if (pointerId !== undefined && activePointerId !== null && pointerId !== activePointerId) return;

        const pid = activePointerId;
        dragging = false;
        activePointerId = null;
        handle.classList.remove('active');
        document.body.classList.remove('resizing');
        clearHandleY();
        localStorage.setItem(storageKey, String(getWidth()));
        if (pid !== null) {
          try { handle.releasePointerCapture(pid); } catch {}
        }
      };

      const onWindowPointerMove = (e: PointerEvent): void => {
        if (!dragging) return;
        if (activePointerId !== null && e.pointerId !== activePointerId) return;

        const delta = isRight ? startX - e.clientX : e.clientX - startX;
        const w = Math.max(min, Math.min(max, startW + delta));
        setWidth(w);
        setHandleY(e.clientY);
      };

      const onWindowPointerUp = (e: PointerEvent): void => stopDrag(e.pointerId);
      const onWindowPointerCancel = (e: PointerEvent): void => stopDrag(e.pointerId);
      const onWindowBlur = (): void => stopDrag();
      const onHandleLostPointerCapture = (): void => stopDrag();

      handle.addEventListener('pointermove', onHandlePointerMove);
      handle.addEventListener('pointerleave', onHandlePointerLeave);
      handle.addEventListener('pointerdown', onHandlePointerDown);
      handle.addEventListener('lostpointercapture', onHandleLostPointerCapture);
      window.addEventListener('pointermove', onWindowPointerMove);
      window.addEventListener('pointerup', onWindowPointerUp);
      window.addEventListener('pointercancel', onWindowPointerCancel);
      window.addEventListener('blur', onWindowBlur);

      cleanups.push(() => {
        stopDrag();
        handle.removeEventListener('pointermove', onHandlePointerMove);
        handle.removeEventListener('pointerleave', onHandlePointerLeave);
        handle.removeEventListener('pointerdown', onHandlePointerDown);
        handle.removeEventListener('lostpointercapture', onHandleLostPointerCapture);
        window.removeEventListener('pointermove', onWindowPointerMove);
        window.removeEventListener('pointerup', onWindowPointerUp);
        window.removeEventListener('pointercancel', onWindowPointerCancel);
        window.removeEventListener('blur', onWindowBlur);
      });
    }
    const cleanups: Array<() => void> = [];

    setupHandle(
      leftHandle,
      () => sidebarEl,
      () => sidebarEl?.offsetWidth || 240,
      (w) => applySidebarWidth(w),
      LEFT_MIN, LEFT_MAX, 'hana-sidebar-width', false,
    );

    setupHandle(
      rightHandle,
      () => jianSidebarEl,
      () => jianSidebarEl?.offsetWidth || 240,
      (w) => applyJianWidth(w),
      RIGHT_MIN, RIGHT_MAX, 'hana-jian-width', true,
    );

    const previewHandle = document.getElementById('previewResizeHandle');
    setupHandle(
      previewHandle,
      () => previewPanel,
      () => previewPanel?.offsetWidth || 580,
      (w) => applyPreviewWidth(w),
      PREVIEW_MIN, PREVIEW_MAX, 'hana-preview-width', true,
    );

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, []);
}
