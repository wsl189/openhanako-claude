/**
 * ui-helpers.ts — 连接状态 / 错误提示 / 模型加载
 *
 * 纯 store 操作，无 DOM 依赖。
 */

import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';

// ── 连接状态 ──

export function setStatus(key: string, connected: boolean, vars: Record<string, string | number> = {}): void {
  useStore.setState({ connected, statusKey: key, statusVars: vars });
}

// ── 错误显示 ──

export function showError(message: string): void {
  console.error('[hana]', message);
  useStore.getState().addToast(`\u26A0 ${message}`, 'error');
}

// ── 模型加载 ──

export async function loadModels(sessionPath?: string | null): Promise<void> {
  try {
    const state = useStore.getState();
    const effectiveSessionPath =
      sessionPath !== undefined
        ? sessionPath
        : (state.pendingNewSession ? null : state.currentSessionPath);
    const query = effectiveSessionPath ? `?sessionPath=${encodeURIComponent(effectiveSessionPath)}` : '';
    const favRes = await hanaFetch(`/api/models/favorites${query}`);
    const favData = await favRes.json();
    const isDraftSession = !sessionPath && state.pendingNewSession && !state.currentSessionPath;
    const pendingModelId = String(state.pendingSessionModel || '').trim();
    let models = Array.isArray(favData.models) ? favData.models : [];
    let current = favData.current || null;

    if (!current && models.length > 0) {
      const localCurrent = String(state.currentModel || '').trim();
      const localCurrentExists = !!localCurrent && models.some((m: any) => m.id === localCurrent);
      const fallbackCurrent = (isDraftSession && pendingModelId && models.some((m: any) => m.id === pendingModelId))
        ? pendingModelId
        : (localCurrentExists ? localCurrent : null);
      if (fallbackCurrent) {
        current = fallbackCurrent;
        models = models.map((m: any) => ({ ...m, isCurrent: m.id === fallbackCurrent }));
      }
    }

    if (isDraftSession && pendingModelId) {
      models = models.map((m: any) => ({ ...m, isCurrent: m.id === pendingModelId }));
      current = pendingModelId;
    }

    useStore.setState({
      models,
      currentModel: current,
    });
  } catch { /* silent */ }
}
