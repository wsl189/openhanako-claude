/**
 * session-actions.ts — Session 生命周期操作（纯逻辑 + API）
 *
 * 从 sidebar-shim.ts 迁移。所有函数直接操作 Zustand store，
 * 不依赖 ctx 注入，不持有闭包状态（除 _switchVersion 防竞争）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useStore } from './index';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { buildItemsFromHistory } from '../utils/history-builder';
import { loadAvatars as loadAvatarsAction, clearChat as clearChatAction } from './agent-actions';
import { loadDeskFiles } from './desk-actions';

// ── 防竞争计数器 ──

let _switchVersion = 0;

// ══════════════════════════════════════════════════════
// 消息加载（从 app-messages-shim 迁移）
// ══════════════════════════════════════════════════════

export async function loadMessages(forPath?: string): Promise<void> {
  const targetPath = forPath || useStore.getState().currentSessionPath;
  if (!targetPath) return;
  try {
    const res = await hanaFetch(`/api/sessions/messages?path=${encodeURIComponent(targetPath)}`);
    const data = await res.json();
    // 总是更新 todos（包括清空），避免残留上一个 session 的 todo
    useStore.setState({ sessionTodos: data.todos || [] });
    const items = buildItemsFromHistory(data);
    if (items.length > 0) {
      useStore.getState().initSession(targetPath, items, data.hasMore ?? false);
      if (targetPath === useStore.getState().currentSessionPath) {
        useStore.setState({ welcomeVisible: false });
      }
    } else {
      useStore.getState().initSession(targetPath, [], false);
    }
  } catch (err) { console.error('[loadMessages] error:', err); }
}

// ══════════════════════════════════════════════════════
// Session 列表
// ══════════════════════════════════════════════════════

export async function loadSessions(): Promise<void> {
  try {
    const res = await hanaFetch('/api/sessions');
    const data = await res.json();
    const sessions = data || [];

    const s = useStore.getState();
    useStore.setState({ sessions });

    if (sessions.length > 0 && !s.currentSessionPath && !s.pendingNewSession) {
      // 首次加载：走完整的 switchSession 确保后端同步 + 消息加载
      await switchSession(sessions[0].path);
    }
  } catch { /* ignore */ }
}

// ══════════════════════════════════════════════════════
// Session 切换
// ══════════════════════════════════════════════════════

export async function switchSession(path: string): Promise<void> {
  const s = useStore.getState();
  if (path === s.currentSessionPath) return;

  // 关闭浮动面板
  const activePanel = useStore.getState().activePanel;
  if (activePanel === 'activity' || activePanel === 'automation') {
    useStore.getState().setActivePanel(null);
  }

  const myVersion = ++_switchVersion;

  try {
    const res = await hanaFetch('/api/sessions/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (myVersion !== _switchVersion) return;
    if (data.error) {
      console.error('[session] switch failed:', data.error);
      return;
    }

    const state = useStore.getState();

    // 同步 streamingSessions：切入的 session 可能正在 streaming
    let streamingSessions = state.streamingSessions;
    if (data.isStreaming && path) {
      if (!streamingSessions.includes(path)) {
        streamingSessions = [...streamingSessions, path];
      }
    }

    // 计算 sessionAgent
    let sessionAgent = null;
    if (data.agentId && data.agentId !== state.currentAgentId) {
      const ag = state.agents.find((a: any) => a.id === data.agentId);
      sessionAgent = {
        name: data.agentName || ag?.name || data.agentId,
        yuan: ag?.yuan || 'hanako',
        avatarUrl: ag?.hasAvatar ? hanaUrl(`/api/agents/${data.agentId}/avatar?t=${Date.now()}`) : null,
      };
    }

    // 批量更新 store
    useStore.setState({
      currentSessionPath: path,
      pendingNewSession: false,
      selectedFolder: null,
      selectedAgentId: null,
      memoryEnabled: data.memoryEnabled !== false,
      isStreaming: !!data.isStreaming,
      streamingSessions,
      sessionAgent,
      browserRunning: !!data.browserRunning,
      browserSessionPath: data.browserRunning ? path : null,
      browserToolActive: false,
      browserToolSessionPath: null,
      browserUrl: data.browserUrl || null,
      browserThumbnail: data.browserRunning ? state.browserThumbnail : null,
    });

    // renderBrowserCard — no-op (browser card rendering handled by React)

    // updateFolderButton — no-op (React-driven)

    // 如果 store 中没有该 session 的消息数据，加载之
    const hasData = !!useStore.getState().chatSessions?.[path];
    if (!hasData) {
      await loadMessages(path);
    }

    // 加载 desk files
    loadDeskFiles('');

    // 切换会话后刷新 context ring
    useStore.setState({ contextTokens: null, contextWindow: null, contextPercent: null });
    const { getWebSocket } = await import('../services/websocket');
    const wsConn = getWebSocket();
    if (wsConn?.readyState === WebSocket.OPEN) {
      wsConn.send(JSON.stringify({ type: 'context_usage' }));
    }
  } catch (err) {
    console.error('[session] switch failed:', err);
  }
}

// ══════════════════════════════════════════════════════
// 新建 Session
// ══════════════════════════════════════════════════════

export async function createNewSession(): Promise<void> {
  // 关闭浮动面板
  if (useStore.getState().activePanel === 'activity') {
    useStore.getState().setActivePanel(null);
  }

  const s = useStore.getState();

  useStore.setState({
    isStreaming: false,
    welcomeVisible: true,
    currentSessionPath: null,
    selectedFolder: s.homeFolder || null,
    selectedAgentId: null,
    sessionAgent: null,
    pendingNewSession: true,
    browserRunning: false,
    browserSessionPath: null,
    browserToolActive: false,
    browserToolSessionPath: null,
    browserUrl: null,
    browserThumbnail: null,
  });

  // 重置 context ring
  useStore.setState({ contextTokens: null, contextWindow: null, contextPercent: null });

  // renderBrowserCard — no-op (browser card rendering handled by React)

  // updateFolderButton — no-op (React-driven)

  const currentState = useStore.getState();
  loadDeskFiles('', currentState.selectedFolder || currentState.homeFolder || undefined);

  useStore.getState().requestInputFocus();
}

// ══════════════════════════════════════════════════════
// 确保 Session 存在（首次发消息时调用）
// ══════════════════════════════════════════════════════

export async function ensureSession(): Promise<boolean> {
  const s = useStore.getState();
  if (!s.pendingNewSession) return true;

  try {
    const body: Record<string, any> = { memoryEnabled: s.memoryEnabled };
    if (s.selectedFolder) {
      body.cwd = s.selectedFolder;
    }
    if (s.selectedAgentId && s.selectedAgentId !== s.currentAgentId) {
      body.agentId = s.selectedAgentId;
    }

    const res = await hanaFetch('/api/sessions/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[session] create failed:', data.error);
      return false;
    }

    const justSelected = s.selectedFolder;

    // 基础状态更新
    const patch: Record<string, any> = {
      pendingNewSession: false,
      selectedFolder: null,
      selectedAgentId: null,
      browserToolActive: false,
      browserToolSessionPath: null,
    };

    if (data.agentId) {
      const switched = data.agentId !== s.currentAgentId;
      patch.currentAgentId = data.agentId;
      if (data.agentName) patch.agentName = data.agentName;
      if (switched) {
        const ag = s.agents.find((a: any) => a.id === data.agentId);
        if (ag?.yuan) patch.agentYuan = ag.yuan;
        patch.agentAvatarUrl = null;
        (window as any).i18n.defaultName = data.agentName || s.agentName;
        // 异步刷新头像
        hanaFetch('/api/health').then((r: Response) => r.json()).then((d: any) => {
          loadAvatarsAction(d.avatars);
        }).catch(() => {
          loadAvatarsAction();
        });
      }
    }

    if (data.path) {
      patch.currentSessionPath = data.path;
      // 初始化空 session，ChatArea 自动渲染
      useStore.getState().initSession(data.path, [], false);
    }

    useStore.setState(patch);

    await loadSessions();

    // updateFolderButton — no-op (React-driven)

    // 更新 cwdHistory
    if (justSelected) {
      const currentState = useStore.getState();
      let cwdHistory = currentState.cwdHistory.filter((p: string) => p !== justSelected);
      cwdHistory = [justSelected, ...cwdHistory];
      if (cwdHistory.length > 10) cwdHistory = cwdHistory.slice(0, 10);
      useStore.setState({ cwdHistory });
    }

    loadDeskFiles('');

    return true;
  } catch (err) {
    console.error('[session] create failed:', err);
    return false;
  }
}

// ══════════════════════════════════════════════════════
// 归档 Session
// ══════════════════════════════════════════════════════

export async function archiveSession(path: string): Promise<void> {
  try {
    const res = await hanaFetch('/api/sessions/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[session] archive failed:', data.error);
      showSidebarToast((window as any).t('session.archiveFailed'));
      return;
    }

    const s = useStore.getState();
    if (path === s.currentSessionPath) {
      useStore.setState({
        currentSessionPath: null,
        browserToolActive: false,
        browserToolSessionPath: null,
        browserSessionPath: null,
      });
      clearChatAction();
    }

    await loadSessions();

    const updated = useStore.getState();
    if (updated.sessions.length === 0) {
      await createNewSession();
    } else if (!updated.currentSessionPath) {
      await switchSession(updated.sessions[0].path);
    }
  } catch (err) {
    console.error('[session] archive failed:', err);
    showSidebarToast((window as any).t('session.archiveFailed'));
  }
}

// ══════════════════════════════════════════════════════
// Toast
// ══════════════════════════════════════════════════════

export function showSidebarToast(text: string, duration = 3000): void {
  useStore.getState().addToast(text, 'info', duration);
}
