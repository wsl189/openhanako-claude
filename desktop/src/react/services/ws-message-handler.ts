/**
 * ws-message-handler.ts — WebSocket 消息分发（从 app-ws-shim.ts 迁移）
 *
 * 纯逻辑模块，不依赖 ctx 注入。通过 Zustand store 访问状态。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { streamBufferManager } from '../hooks/use-stream-buffer';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useStore } from '../stores';
import { resolveInputSessionKey } from '../stores/misc-slice';
import { loadSessions as loadSessionsAction } from '../stores/session-actions';
import { handleArtifact } from '../stores/artifact-actions';
import { loadDeskFiles } from '../stores/desk-actions';
import { showError } from '../utils/ui-helpers';
import { getWebSocket } from './websocket';
import {
  replayStreamResume,
  isStreamResumeRebuilding,
  isStreamScopedMessage,
  getSessionStreamMeta,
  updateSessionStreamMeta,
} from './stream-resume';

declare function t(key: string, vars?: Record<string, string>): any;

// ── 聊天事件集合（走 StreamBufferManager） ──

const REACT_CHAT_EVENTS = new Set([
  'sdk_message',
  'assistant_snapshot',
  'text_delta', 'thinking_start', 'thinking_delta', 'thinking_end',
  'xing_start', 'xing_text', 'xing_end',
  'tool_start', 'tool_end', 'turn_end',
  'file_output', 'skill_activated', 'artifact',
  'browser_screenshot', 'cron_confirmation', 'settings_confirmation', 'ask_user_confirmation',
  'plan_mode_confirmation',
  'compaction_start', 'compaction_end',
]);

function resolvePromptSessionKey(sessionPath: string | null | undefined): string {
  const state = useStore.getState();
  return resolveInputSessionKey(
    sessionPath || state.currentSessionPath || null,
    !!state.pendingNewSession,
  );
}

function isTodoToolName(name: unknown): boolean {
  const normalized = String(name || '').trim().toLowerCase();
  return normalized === 'todo' || normalized === 'todowrite';
}

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
  const targetPath = sessionPath || useStore.getState().currentSessionPath;
  if (!targetPath) return;
  ws.send(JSON.stringify({ type: 'context_usage', sessionPath: targetPath }));
}

function normalizeContextUsageForDisplay(
  _sessionPath: string | null,
  tokens: unknown,
  contextWindow: unknown,
  percent: unknown,
): { tokens: number | null; contextWindow: number | null; percent: number | null } {
  const rawTokens = Number.isFinite(tokens as number) ? Number(tokens) : null;
  const rawWindow = Number.isFinite(contextWindow as number) ? Number(contextWindow) : null;
  const rawPercent = Number.isFinite(percent as number) ? Number(percent) : null;
  const displayPercent =
    rawTokens != null && rawWindow != null && rawWindow > 0
      ? Math.max(0, Math.min(100, (rawTokens / rawWindow) * 100))
      : rawPercent;

  return {
    tokens: rawTokens,
    contextWindow: rawWindow,
    percent: displayPercent,
  };
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

function restartStreamingAfterSteer(sessionPath?: string | null): void {
  const sp = sessionPath || useStore.getState().currentSessionPath;
  if (!sp) return;
  const since = Date.now();
  useStore.setState((prev: any) => {
    const list: string[] = Array.isArray(prev.streamingSessions) ? prev.streamingSessions : [];
    return {
      isStreaming: true,
      streamingSessions: list.includes(sp) ? list : [...list, sp],
      streamingSinceByPath: {
        ...(prev.streamingSinceByPath || {}),
        [sp]: since,
      },
    };
  });
  ensureCurrentSessionVisible();
  streamBufferManager.startTurn(sp);
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
    if (msg.type === 'ask_user_confirmation' && msg.confirmId) {
      useStore.getState().enqueuePendingInputPrompt(resolvePromptSessionKey(msg.sessionPath), {
        kind: 'ask_user',
        confirmId: msg.confirmId,
        questions: Array.isArray(msg.questions) ? msg.questions : [],
        createdAt: Date.now(),
      });
    }

    if (msg.type === 'plan_mode_confirmation' && msg.confirmId) {
      useStore.getState().enqueuePendingInputPrompt(resolvePromptSessionKey(msg.sessionPath), {
        kind: 'plan_mode',
        confirmId: msg.confirmId,
        phase: msg.phase === 'exit' ? 'exit' : 'enter',
        prompt: msg.prompt || '',
        allowedPrompts: Array.isArray(msg.allowedPrompts) ? msg.allowedPrompts : [],
        createdAt: Date.now(),
      });
    }

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
    // tool_end 后更新 todo。兼容旧 Hanako custom tool 名 todo 与 Claude builtin TodoWrite。
    if (msg.type === 'tool_end' && isTodoToolName(msg.name) && msg.details?.todos) {
      useStore.setState({ sessionTodos: msg.details.todos });
    }
    // compaction_end 后更新 token
    if (msg.type === 'compaction_end') {
      const currentSessionPath = useStore.getState().currentSessionPath;
      if (!currentSessionPath) {
        return;
      }
      if (msg.sessionPath && msg.sessionPath !== currentSessionPath) {
        return;
      }
      const usagePath = msg.sessionPath || currentSessionPath || null;
      const normalized = normalizeContextUsageForDisplay(
        usagePath,
        msg.tokens,
        msg.contextWindow,
        msg.percent,
      );
      const patch: Record<string, any> = { compacting: false };
      // SDK 在压缩后可能返回 tokens/percent=null（下一次模型回复前未知），
      // 这里也要写入，避免 UI 继续显示压缩前的旧值。
      if ('tokens' in msg) patch.contextTokens = normalized.tokens;
      if ('contextWindow' in msg) patch.contextWindow = normalized.contextWindow;
      if ('percent' in msg) patch.contextPercent = normalized.percent;
      useStore.setState(patch);
      // 压缩结束后多次拉取 context_usage，避免 SDK 统计延迟导致圆环停留在旧值
      requestContextUsage(usagePath);
      setTimeout(() => requestContextUsage(usagePath), 350);
      setTimeout(() => requestContextUsage(usagePath), 1200);
      setTimeout(() => requestContextUsage(usagePath), 2600);
      setTimeout(() => requestContextUsage(usagePath), 5000);
    }
    if (msg.type === 'compaction_start') {
      const currentSessionPath = useStore.getState().currentSessionPath;
      if (!currentSessionPath) {
        return;
      }
      if (msg.sessionPath && msg.sessionPath !== currentSessionPath) {
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

    case 'steered':
      restartStreamingAfterSteer(msg.sessionPath);
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
      {
        const liveState = useStore.getState();
        if (msg.sessionPath && msg.sessionPath !== liveState.currentSessionPath) {
          break;
        }
        const browserPatch: Record<string, any> = {
          browserRunning: !!msg.running,
          browserSessionPath: msg.running ? (msg.sessionPath || liveState.currentSessionPath || null) : null,
          browserUrl: msg.url || null,
          browserThumbnail: msg.running ? (msg.thumbnail || liveState.browserThumbnail) : null,
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
            thumbnail: msg.running ? (msg.thumbnail || liveState.browserThumbnail) : null,
          });
        }
        notifyBrowserSessionsChanged();
        break;
      }

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
      // DM module is hidden in channel view; ignore DM refresh events.
      break;
    }

    case 'context_usage':
      {
        // 没有焦点 session（例如“新建对话”草稿态）时，不接受任何上下文统计，
        // 避免被后台/上一会话数据污染圆环。
        const liveState = useStore.getState();
        const currentSessionPath = liveState.currentSessionPath;
        if (!currentSessionPath) break;
        if (msg.sessionPath && msg.sessionPath !== currentSessionPath) break;
        if ('tokens' in msg || 'contextWindow' in msg || 'percent' in msg) {
          const usagePath = msg.sessionPath || currentSessionPath || null;
          const normalized = normalizeContextUsageForDisplay(
            usagePath,
            msg.tokens,
            msg.contextWindow,
            msg.percent,
          );
          const patch: Record<string, any> = {};
          if ('tokens' in msg) patch.contextTokens = normalized.tokens;
          if ('contextWindow' in msg) patch.contextWindow = normalized.contextWindow;
          if ('percent' in msg) patch.contextPercent = normalized.percent;
          useStore.setState(patch);
        }
        break;
      }

    case 'error': {
      showError(msg.message);
      break;
    }

    case 'confirmation_resolved': {
      if (msg.confirmId) {
        useStore.getState().removePendingInputPrompt(msg.confirmId);
      }
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
              if ((b.type !== 'settings_confirm' && b.type !== 'cron_confirm' && b.type !== 'plan_mode_confirm' && b.type !== 'ask_user_confirm') || b.confirmId !== msg.confirmId) return b;

              msgChanged = true;
              if (b.type === 'settings_confirm') {
                if (msg.action === 'confirmed') return { ...b, status: 'confirmed' };
                if (msg.action === 'timeout') return { ...b, status: 'timeout' };
                return { ...b, status: 'rejected' };
              }
              if (b.type === 'plan_mode_confirm') {
                if (msg.action === 'confirmed') return { ...b, status: 'confirmed' };
                if (msg.action === 'timeout') return { ...b, status: 'timeout' };
                return { ...b, status: 'rejected' };
              }
              if (b.type === 'ask_user_confirm') {
                if (msg.action === 'confirmed') return { ...b, status: 'confirmed' };
                if (msg.action === 'timeout') return { ...b, status: 'timeout' };
                return { ...b, status: 'rejected' };
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
      const statusStreamId = typeof msg.statusStreamId === 'string' ? msg.statusStreamId : null;
      if (sp && statusStreamId && !msg.isStreaming) {
        const currentStreamId = getSessionStreamMeta(sp)?.streamId || null;
        if (currentStreamId && currentStreamId !== statusStreamId) {
          break;
        }
      }
      if (sp) {
        if (statusStreamId && msg.isStreaming) {
          updateSessionStreamMeta({ sessionPath: sp, streamId: statusStreamId });
        }
        useStore.setState((prev: any) => {
          const list: string[] = Array.isArray(prev.streamingSessions) ? prev.streamingSessions : [];
          const sinceMap: Record<string, number> = (prev.streamingSinceByPath || {}) as Record<string, number>;
          if (msg.isStreaming) {
            return {
              streamingSessions: list.includes(sp) ? list : [...list, sp],
              streamingSinceByPath: {
                ...sinceMap,
                [sp]: sinceMap[sp] ?? Date.now(),
              },
            };
          }
          const { [sp]: _removed, ...restSince } = sinceMap;
          return {
            streamingSessions: list.filter((p: string) => p !== sp),
            streamingSinceByPath: restSince,
          };
        });
      }
      // 渲染层：只有焦点 session 才影响 UI
      const liveState = useStore.getState();
      // 无焦点 session（新建对话草稿态）时，禁止把 isStreaming 置 true，
      // 避免后台/异常事件把输入区锁成“停止”态。
      if (!liveState.currentSessionPath) {
        if (!msg.isStreaming) {
          applyStreamingStatus(false);
        }
      } else if (!sp || sp === liveState.currentSessionPath) {
        applyStreamingStatus(msg.isStreaming);
        if (msg.isStreaming && sp) {
          streamBufferManager.startTurn(sp);
        }
      }

      // 浏览器自动收尾：
      // 仅在当前会话本轮真正结束（status=false）后关闭，避免 tool-use 中间轮次误关。
      if (!msg.isStreaming && sp && sp === liveState.currentSessionPath) {
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
