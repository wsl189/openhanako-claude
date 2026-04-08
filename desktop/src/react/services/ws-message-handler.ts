/**
 * ws-message-handler.ts — WebSocket 消息分发（从 app-ws-shim.ts 迁移）
 *
 * 纯逻辑模块，不依赖 ctx 注入。通过 Zustand store 访问状态。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { streamBufferManager } from '../hooks/use-stream-buffer';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useStore } from '../stores';
import { loadSessions as loadSessionsAction } from '../stores/session-actions';
import { handleArtifact } from '../stores/artifact-actions';
import { loadDeskFiles } from '../stores/desk-actions';
import { showError } from '../utils/ui-helpers';
import { getWebSocket } from './websocket';
import {
  replayStreamResume,
  isStreamResumeRebuilding,
  isStreamScopedMessage,
  updateSessionStreamMeta,
} from './stream-resume';

declare function t(key: string, vars?: Record<string, string>): any;

// ── 聊天事件集合（走 StreamBufferManager） ──

const REACT_CHAT_EVENTS = new Set([
  'text_delta', 'thinking_start', 'thinking_delta', 'thinking_end',
  'xing_start', 'xing_text', 'xing_end',
  'tool_start', 'tool_end', 'turn_end',
  'file_output', 'skill_activated', 'artifact',
  'browser_screenshot', 'cron_confirmation', 'settings_confirmation',
  'compaction_start', 'compaction_end',
]);

function notifyBrowserSessionsChanged(): void {
  window.dispatchEvent(new Event('hana-browser-sessions-changed'));
}

// ── Session 可见性 + 流状态 ──

function ensureCurrentSessionVisible(): void {
  const state = useStore.getState();
  const sessionPath = state.currentSessionPath;
  if (!sessionPath || state.pendingNewSession) return;
  if (state.sessions.some((s: any) => s.path === sessionPath)) return;

  useStore.setState({
    sessions: [{
      path: sessionPath,
      title: null,
      firstMessage: '',
      modified: new Date().toISOString(),
      messageCount: 0,
      agentId: state.currentAgentId || null,
      agentName: state.agentName || null,
      cwd: null,
      _optimistic: true,
    }, ...state.sessions],
  });
}

function hasOptimisticCurrentSession(): boolean {
  const state = useStore.getState();
  const sessionPath = state.currentSessionPath;
  if (!sessionPath) return false;
  return !!state.sessions.find((s: any) => s.path === sessionPath && s._optimistic);
}

function requestContextUsage(sessionPath?: string | null): void {
  const ws = getWebSocket();
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'context_usage', sessionPath: sessionPath || useStore.getState().currentSessionPath || null }));
}

export function applyStreamingStatus(isStreaming: boolean): void {
  useStore.setState({ isStreaming: !!isStreaming });
  if (isStreaming) {
    ensureCurrentSessionVisible();
  } else {
    // React 模式：消息完成由 StreamBuffer turn_end 处理
    if (hasOptimisticCurrentSession()) {
      loadSessionsAction().catch(() => {});
    }
  }
}

// ── 消息分发（大 switch） ──

export function handleServerMessage(msg: any): void {
  const state = useStore.getState();

  const rebuildingFor = isStreamResumeRebuilding();

  if (rebuildingFor && msg.type === 'status' && state.currentSessionPath === rebuildingFor) {
    return;
  }

  if (
    rebuildingFor &&
    isStreamScopedMessage(msg) &&
    msg.sessionPath === rebuildingFor &&
    !msg.__fromReplay &&
    msg.type !== 'stream_resume'
  ) {
    return;
  }

  if (msg.type !== 'stream_resume' && isStreamScopedMessage(msg)) {
    updateSessionStreamMeta(msg);
  }

  // ── React 聊天渲染路径：聊天相关事件走 StreamBufferManager ──
  if (REACT_CHAT_EVENTS.has(msg.type)) {
    const live = useStore.getState();
    const currentSessionPath = live.currentSessionPath;
    const sameCurrentSession = !!msg.sessionPath && msg.sessionPath === currentSessionPath;

    // 仅在当前 session 的 browser 工具执行期间显示顶部提示，避免跨 session/普通对话闪烁。
    if (msg.type === 'tool_start' && msg.name === 'browser' && sameCurrentSession) {
      useStore.setState({
        browserToolActive: true,
        browserToolSessionPath: msg.sessionPath || currentSessionPath || null,
      });
    }
    if (msg.type === 'tool_end' && msg.name === 'browser') {
      const activeSessionPath = useStore.getState().browserToolSessionPath;
      if (!msg.sessionPath || msg.sessionPath === activeSessionPath || sameCurrentSession) {
        useStore.setState({
          browserToolActive: false,
          browserToolSessionPath: null,
        });
      }
    }
    if (msg.type === 'turn_end' && msg.sessionPath) {
      if (msg.sessionPath === useStore.getState().browserToolSessionPath) {
        useStore.setState({
          browserToolActive: false,
          browserToolSessionPath: null,
        });
      }
    }

    streamBufferManager.handle(msg);
    // turn_end 后仍需执行部分通用逻辑（loadSessions、context_usage）
    if (msg.type === 'turn_end') {
      loadSessionsAction();
      requestContextUsage(msg.sessionPath || useStore.getState().currentSessionPath);
    }
    // tool_end 后更新 todo
    if (msg.type === 'tool_end' && msg.name === 'todo' && msg.details?.todos) {
      useStore.setState({ sessionTodos: msg.details.todos });
    }
    // compaction_end 后更新 token
    if (msg.type === 'compaction_end') {
      const currentSessionPath = useStore.getState().currentSessionPath;
      if (msg.sessionPath && currentSessionPath && msg.sessionPath !== currentSessionPath) {
        return;
      }
      const patch: Record<string, any> = { compacting: false };
      // SDK 在压缩后可能返回 tokens/percent=null（下一次模型回复前未知），
      // 这里也要写入，避免 UI 继续显示压缩前的旧值。
      if ('tokens' in msg) patch.contextTokens = msg.tokens ?? null;
      if ('contextWindow' in msg) patch.contextWindow = msg.contextWindow ?? null;
      if ('percent' in msg) patch.contextPercent = msg.percent ?? null;
      useStore.setState(patch);
      // 压缩结束后多次拉取 context_usage，避免 SDK 统计延迟导致圆环停留在旧值
      const usagePath = msg.sessionPath || currentSessionPath;
      requestContextUsage(usagePath);
      setTimeout(() => requestContextUsage(usagePath), 350);
      setTimeout(() => requestContextUsage(usagePath), 1200);
      setTimeout(() => requestContextUsage(usagePath), 2600);
      setTimeout(() => requestContextUsage(usagePath), 5000);
    }
    if (msg.type === 'compaction_start') {
      const currentSessionPath = useStore.getState().currentSessionPath;
      if (msg.sessionPath && currentSessionPath && msg.sessionPath !== currentSessionPath) {
        return;
      }
      useStore.setState({ compacting: true });
    }
    // artifact 需要通知 artifacts shim 更新预览
    if (msg.type === 'artifact' && state.currentTab === 'chat') {
      handleArtifact(msg);
    }
    return;
  }

  // 非聊天渲染事件走传统 switch
  switch (msg.type) {
    case 'stream_resume':
      replayStreamResume(msg);
      break;

    case 'session_title':
      if (msg.title) {
        useStore.setState({
          sessions: state.sessions.map((s: any) =>
            s.path === msg.path ? { ...s, title: msg.title } : s,
          ),
        });
      }
      break;

    case 'desk_changed':
      loadDeskFiles();
      break;

    case 'skills_changed':
      (window as any).__loadDeskSkills?.();
      break;

    case 'cron_changed':
      (async () => {
        try {
          const res = await hanaFetch('/api/desk/cron?all=1');
          const data = await res.json();
          useStore.setState({ automationCount: (data.jobs || []).length });
        } catch { /* ignore */ }
      })();
      break;

    case 'browser_status':
      // 仅让当前会话的 browser 状态影响顶部提示，
      // 避免后台/其他 session 的事件串到当前页面。
      if (msg.sessionPath && msg.sessionPath !== state.currentSessionPath) {
        break;
      }
      const browserPatch: Record<string, any> = {
        browserRunning: !!msg.running,
        browserSessionPath: msg.running ? (msg.sessionPath || state.currentSessionPath || null) : null,
        browserUrl: msg.url || null,
        browserThumbnail: msg.running ? (msg.thumbnail || state.browserThumbnail) : null,
      };
      if (!msg.running) {
        const activeSessionPath = useStore.getState().browserToolSessionPath;
        if (!msg.sessionPath || !activeSessionPath || msg.sessionPath === activeSessionPath) {
          browserPatch.browserToolActive = false;
          browserPatch.browserToolSessionPath = null;
        }
      }
      useStore.setState(browserPatch);
      // renderBrowserCard — no-op (browser card rendering handled by React)
      if ((window as any).platform?.updateBrowserViewer) {
        (window as any).platform.updateBrowserViewer({
          running: !!msg.running,
          url: msg.url || null,
          thumbnail: msg.running ? (msg.thumbnail || state.browserThumbnail) : null,
        });
      }
      notifyBrowserSessionsChanged();
      break;

    case 'browser_bg_status': {
      // browser_bg_status 来自后台/巡检场景，不绑定具体前台会话。
      // 只在结束时兜底清理，避免跨 session 的瞬时状态污染当前会话提示。
      if (!msg.running) {
        useStore.setState({ browserRunning: false, browserSessionPath: null, browserUrl: null, browserThumbnail: null });
        notifyBrowserSessionsChanged();
      }
      break;
    }

    case 'activity_update':
      if (msg.activity) {
        useStore.setState({ activities: [msg.activity, ...state.activities.slice(0, 49)] });
      }
      break;

    case 'notification': {
      const title = typeof msg.title === 'string' && msg.title.trim() ? msg.title.trim() : '提醒';
      const body = typeof msg.body === 'string' ? msg.body.trim() : '';

      // 提醒类弹窗常驻显示（duration=0），并使用高对比样式增强可见性。
      useStore.getState().addToast(body ? `${title} ${body}` : title, 'reminder', 0);

      const showNotification = (window as any).platform?.showNotification || (window as any).hana?.showNotification;
      if (typeof showNotification === 'function') {
        Promise.resolve(showNotification(title, body))
          .then((ret: any) => {
            if (ret === false || ret?.ok === false) {
              const reason = ret?.reason ? String(ret.reason) : 'not supported';
              useStore.getState().addToast(`系统通知未显示: ${reason}`, 'error', 8_000);
            }
          })
          .catch((err: any) => {
            const reason = err?.message ? String(err.message) : 'unknown error';
            useStore.getState().addToast(`系统通知失败: ${reason}`, 'error', 8_000);
          });
      }
      break;
    }

    case 'bridge_status':
      (window as any).__hanaBridgeLoadStatus?.();
      break;

    case 'bridge_message':
      if (msg.message) {
        (window as any).__hanaBridgeOnMessage?.(msg.message);
      }
      break;

    case 'channel_new_message': {
      const store = useStore.getState();
      if (msg.channelName && store.currentChannel === msg.channelName) {
        store.openChannel(msg.channelName);
      } else if (msg.channelName) {
        store.loadChannels();
      }
      break;
    }

    case 'channel_agent_activity': {
      const channelName = String(msg.channelName || '');
      const agentId = String(msg.agentId || '');
      if (!channelName || !agentId) break;
      useStore.setState((prev: any) => {
        const prevMap = (prev.channelAgentActivity || {}) as Record<string, Record<string, boolean>>;
        const nextChannel = { ...(prevMap[channelName] || {}), [agentId]: !!msg.active };
        return {
          channelAgentActivity: {
            ...prevMap,
            [channelName]: nextChannel,
          },
        };
      });
      break;
    }

    case 'dm_new_message': {
      const dmId = `dm:${msg.from}`;
      const store2 = useStore.getState();
      if (store2.currentChannel === dmId) {
        store2.openChannel(dmId, true);
      } else {
        store2.loadChannels();
      }
      break;
    }

    case 'context_usage':
      // 仅在当前会话明确存在且不匹配时忽略；currentSessionPath 为空时允许更新
      if (msg.sessionPath && state.currentSessionPath && msg.sessionPath !== state.currentSessionPath) {
        break;
      }
      if ('tokens' in msg || 'contextWindow' in msg || 'percent' in msg) {
        const patch: Record<string, any> = {};
        if ('tokens' in msg) patch.contextTokens = msg.tokens ?? null;
        if ('contextWindow' in msg) patch.contextWindow = msg.contextWindow ?? null;
        if ('percent' in msg) patch.contextPercent = msg.percent ?? null;
        useStore.setState(patch);
      }
      break;

    case 'error': {
      showError(msg.message);
      break;
    }

    case 'confirmation_resolved': {
      // 更新所有 session 中匹配 confirmId 的确认卡片状态（不能只改最后一条）
      useStore.setState((prev: any) => {
        const chatSessions = prev.chatSessions || {};
        let changed = false;
        const nextSessions = { ...chatSessions };

        for (const sp of Object.keys(chatSessions)) {
          const session = chatSessions[sp];
          if (!session?.items?.length) continue;

          let sessionChanged = false;
          const nextItems = session.items.map((item: any) => {
            if (item?.type !== 'message' || !item.data?.blocks?.length) return item;

            let msgChanged = false;
            const nextBlocks = item.data.blocks.map((b: any) => {
              if ((b.type !== 'settings_confirm' && b.type !== 'cron_confirm') || b.confirmId !== msg.confirmId) return b;

              msgChanged = true;
              if (b.type === 'settings_confirm') {
                return { ...b, status: msg.action === 'confirmed' ? 'confirmed' : 'rejected' };
              }
              return { ...b, status: msg.action === 'confirmed' ? 'approved' : 'rejected' };
            });

            if (!msgChanged) return item;
            sessionChanged = true;
            return {
              ...item,
              data: { ...item.data, blocks: nextBlocks },
            };
          });

          if (sessionChanged) {
            changed = true;
            nextSessions[sp] = { ...session, items: nextItems };
          }
        }

        return changed ? { chatSessions: nextSessions } : {};
      });
      break;
    }

    case 'apply_frontend_setting': {
      if (msg.key === 'theme') {
        (window as any).applyTheme?.(msg.value);
        // 通知其他窗口（设置窗口等）同步主题
        (window as any).platform?.settingsChanged?.('theme');
      }
      break;
    }

    case 'status': {
      // 元数据层：维护所有 session 的 streaming 状态
      const sp = msg.sessionPath;
      if (sp) {
        const list: string[] = state.streamingSessions || [];
        if (msg.isStreaming) {
          if (!list.includes(sp)) useStore.setState({ streamingSessions: [...list, sp] });
        } else {
          useStore.setState({ streamingSessions: list.filter((p: string) => p !== sp) });
        }
      }
      // 渲染层：只有焦点 session 才影响 UI
      if (!sp || sp === state.currentSessionPath) {
        applyStreamingStatus(msg.isStreaming);
      }

      // 浏览器自动收尾：
      // 仅在当前会话本轮真正结束（status=false）后关闭，避免 tool-use 中间轮次误关。
      if (!msg.isStreaming && sp && sp === state.currentSessionPath) {
        const latest = useStore.getState();
        const shouldAutoCloseBrowser =
          !!latest.browserRunning &&
          latest.browserSessionPath === sp &&
          !latest.browserToolActive;
        if (shouldAutoCloseBrowser) {
          useStore.setState({
            browserRunning: false,
            browserSessionPath: null,
            browserUrl: null,
            browserThumbnail: null,
          });
          hanaFetch('/api/browser/close-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionPath: sp }),
          }).then(() => {
            notifyBrowserSessionsChanged();
          }).catch(() => {});
        }
      }
      break;
    }
  }
}
