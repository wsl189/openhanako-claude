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

export async function loadModels(): Promise<void> {
  try {
    const favRes = await hanaFetch('/api/models/favorites');
    const favData = await favRes.json();
    useStore.setState({
      models: favData.models || [],
      currentModel: favData.current,
    });
  } catch { /* silent */ }
}

