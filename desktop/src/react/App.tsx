/**
 * App.tsx — React 根组件 + 应用初始化
 *
 * React 渲染完整 DOM 树，不再依赖 index.html 的静态 HTML。
 * 所有初始化逻辑从 app.js / bridge.ts 迁移至此。
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from './stores';
import type { ActivePanel } from './types';
import { hanaFetch } from './hooks/use-hana-fetch';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ActivityPanel } from './components/ActivityPanel';
import { AutomationPanel } from './components/AutomationPanel';
import { BridgePanel } from './components/BridgePanel';

import { PreviewPanel } from './components/PreviewPanel';
import { BrowserCard } from './components/BrowserCard';
import { DeskSection } from './components/DeskSection';
import { InputArea } from './components/InputArea';
import { SessionList } from './components/SessionList';
import { WelcomeScreen, refreshAvatarTs as refreshWelcomeAvatarTs } from './components/WelcomeScreen';
import { ChatArea } from './components/chat/ChatArea';
import {
  ChannelsPanel,
  ChannelList,
  ChannelMessages,
  ChannelMembers,
  ChannelMemoryToggle,
  ChannelInput,
  ChannelReadonly,
  ChannelCreate,
  refreshAvatarTs as refreshChannelAvatarTs,
} from './components/ChannelsPanel';
import { SidebarLayout, updateLayout, toggleSidebar } from './components/SidebarLayout';
import { FloatPreviewCard, useFloatCard } from './components/FloatPreviewCard';
import { useSidebarResize } from './hooks/use-sidebar-resize';
import { applyAgentIdentity, loadAgents, loadAvatars } from './stores/agent-actions';
import { createNewSession, loadSessions, switchSession } from './stores/session-actions';
import { connectWebSocket } from './services/websocket';
import { setStatus, loadModels } from './utils/ui-helpers';
import { toSlash, baseName, isHttpUrlPath } from './utils/format';
import { initJian, toggleJianSidebar } from './stores/desk-actions';
import { initEditorEvents } from './stores/artifact-actions';
import { WindowControls } from './components/WindowControls';
import { ToastContainer } from './components/ToastContainer';
import { initTheme, initDragPrevention } from './bootstrap';
import { useI18n } from './hooks/use-i18n';

declare const i18n: {
  locale: string;
  defaultName: string;
  load(locale: string): Promise<void>;
};
declare function t(key: string, vars?: Record<string, string | number>): string;

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── 主题 + drag 阻止 ──
initTheme();
initDragPrevention();

// ── __hanaLog：前端日志上报 ──
window.__hanaLog = function (level: string, module: string, message: string) {
  const { serverPort } = useStore.getState();
  if (!serverPort) return;
  hanaFetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, module, message }),
  }).catch(() => {});
};

// ── 全局错误捕获 ──
window.addEventListener('error', (e) => {
  window.__hanaLog?.('error', 'desktop', `${e.message} at ${e.filename}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  window.__hanaLog?.('error', 'desktop', `unhandledRejection: ${e.reason}`);
});

async function fetchAutomationCount(sessionPath: string | null): Promise<number | null> {
  void sessionPath;
  try {
    const res = await hanaFetch('/api/desk/cron?all=1');
    const data = await res.json();
    return (data.jobs || []).length;
  } catch {
    return null;
  }
}

// ── 初始化流程 ──

async function init(): Promise<void> {
  const platform = window.platform;

  // 1. 获取 server 连接信息并存入 Zustand
  const serverPort = await platform.getServerPort();
  const serverToken = await platform.getServerToken();
  useStore.setState({ serverPort, serverToken });

  if (!serverPort) {
    setStatus('status.serverNotReady', false);
    platform.appReady();
    return;
  }

  // 2. 并行获取 health + config
  try {
    const [healthRes, configRes] = await Promise.all([
      hanaFetch('/api/health'),
      hanaFetch('/api/config'),
    ]);
    const healthData = await healthRes.json();
    const configData = await configRes.json();

    // 3. 加载 i18n
    await i18n.load(configData.locale || 'zh-CN');
    useStore.setState({ locale: i18n.locale });

    // 4. 应用 agent 身份
    await applyAgentIdentity({
      agentName: healthData.agent || 'Hanako',
      userName: healthData.user || t('common.user'),
      ui: { avatars: false, agents: false, welcome: true },
    });

    // 5. 设置 desk 相关状态
    useStore.setState({
      homeFolder: configData.desk?.home_folder || null,
      selectedFolder: configData.desk?.home_folder || null,
    });
    if (Array.isArray(configData.cwd_history)) {
      useStore.setState({ cwdHistory: configData.cwd_history });
    }

    // 6. 加载头像
    loadAvatars(healthData.avatars);
  } catch (err) {
    console.error('[init] i18n/health/config failed:', err);
  }

  // 8. 连接 WebSocket
  connectWebSocket();

  // 9. 加载模型
  await loadModels();

  // 10. 加载 agents + sessions
  useStore.setState({ pendingNewSession: true });
  await loadAgents();
  await loadSessions();
  await loadModels(useStore.getState().currentSessionPath);

  // 11. 初始化书桌
  initJian();

  // 12. 初始化编辑器事件
  initEditorEvents();

  // 13b. 初始 layout 计算
  updateLayout();

  // 14. 任务计划 badge 初始值
  try {
    const count = await fetchAutomationCount(useStore.getState().currentSessionPath);
    if (count !== null) {
      useStore.setState({ automationCount: count });
    }
  } catch { /* ignore */ }

  // 18. 设置快捷键
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      platform.openSettings();
    }
  });

  // 19. 设置变更监听
  platform.onSettingsChanged((type: string, data: any) => {
    switch (type) {
      case 'skills-changed':
        (window as any).__loadDeskSkills?.();
        break;
      case 'locale-changed':
        i18n.load(data.locale).then(() => {
          i18n.defaultName = useStore.getState().agentName;
          useStore.setState({ locale: i18n.locale });
        });
        break;
      case 'models-changed':
        loadModels(useStore.getState().currentSessionPath);
        break;
      case 'agent-created':
      case 'agent-deleted':
        loadAgents();
        break;
      case 'agent-updated': {
        const payload = data || {};
        const { agentId, agentName, yuan, avatarUpdated, hasAvatar, homeFolder } = payload;
        const state = useStore.getState();

        if (avatarUpdated) {
          refreshWelcomeAvatarTs();
          refreshChannelAvatarTs();
          // Keep agent cache (hasAvatar/name/yuan) in sync across panes.
          void loadAgents();
        }

        // Optimistic patch so welcome/session avatars update immediately.
        if (agentId) {
          const agents = state.agents.map((agent) => {
            if (agent.id !== agentId) return agent;
            return {
              ...agent,
              ...(typeof agentName === 'string' ? { name: agentName } : {}),
              ...(typeof yuan === 'string' ? { yuan } : {}),
              ...((avatarUpdated || typeof hasAvatar === 'boolean')
                ? { hasAvatar: typeof hasAvatar === 'boolean' ? hasAvatar : true }
                : {}),
            };
          });

          const patch: Record<string, unknown> = { agents };
          if (state.currentAgentId === agentId) {
            if (typeof agentName === 'string') patch.agentName = agentName;
            if (typeof yuan === 'string') patch.agentYuan = yuan;
            if (typeof homeFolder === 'string') {
              patch.homeFolder = homeFolder || null;
              if (state.pendingNewSession) {
                patch.selectedFolder = homeFolder || null;
              }
            }
          }
          useStore.setState(patch);
        }

        const isCurrent = agentId && agentId === state.currentAgentId;
        applyAgentIdentity({
          agentName: isCurrent ? agentName : undefined,
          yuan: isCurrent ? yuan : undefined,
          ui: { settings: false },
        });
        break;
      }
      case 'theme-changed':
        setTheme(data.theme);
        break;
      case 'user-updated': {
        const nextUserName = typeof data?.userName === 'string' ? data.userName : '';
        if (nextUserName) {
          applyAgentIdentity({
            userName: nextUserName,
            ui: { avatars: false, agents: false },
          });
        }
        break;
      }
      case 'font-changed':
        setSerifFont(data.serif);
        break;
      case 'sessions-changed': {
        const payload = data || {};
        const targetPath = typeof payload.switchPath === 'string' ? payload.switchPath : '';
        if (targetPath) {
          void (async () => {
            await loadSessions();
            await switchSession(targetPath);
          })();
        } else {
          void loadSessions();
        }
        break;
      }
    }
  });

  // 20. 通知 app ready
  platform.appReady();
}

// ── 拖拽附件 drop handler（从 bridge.ts appInput shim 迁移） ──

async function handleDrop(e: React.DragEvent): Promise<void> {
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  let srcPaths: string[] = [];
  const fileMetaMap = new Map<string, { name: string; isDirectoryGuess: boolean }>();
  for (const file of Array.from(files)) {
    const filePath = window.platform?.getFilePath?.(file);
    if (filePath && !isHttpUrlPath(filePath)) {
      srcPaths.push(filePath);
      fileMetaMap.set(filePath, {
        name: file.name,
        // Browser File 无法可靠区分目录；这里仅做弱推断，书桌路径会被后面的 deskFileMap 覆盖为准确信息。
        isDirectoryGuess: file.type === '' && file.size === 0,
      });
    }
  }
  if (srcPaths.length === 0) return;

  const store = useStore.getState();

  // 频道页：DM 只读，禁止挂附件
  if (store.currentTab === 'channels') {
    if (!store.currentChannel) return;
    if (store.channelIsDM) {
      store.addToast(t('channel.readOnly'), 'info', 3000);
      return;
    }
  }

  if (store.attachedFiles.length >= 9) return;

  // 统一保留原始路径（不走 /api/upload，不复制到 .hanako-uploads）
  const s = useStore.getState();
  const deskBase = toSlash(s.deskBasePath ?? '').replace(/\/+$/, '');
  const prefix = deskBase ? (deskBase + '/') : '';
  const deskFileMap = new Map(s.deskFiles.map((f: any) => [f.name, f]));
  for (const p of srcPaths) {
    if (useStore.getState().attachedFiles.length >= 9) break;
    const name = baseName(p);
    const isDeskPath = prefix ? toSlash(p).startsWith(prefix) : false;
    const knownFile = isDeskPath ? deskFileMap.get(name) : null;
    const meta = fileMetaMap.get(p);
    useStore.getState().addAttachedFile({
      path: p,
      name: meta?.name || name || p.split('/').pop() || p,
      isDirectory: knownFile?.isDir ?? meta?.isDirectoryGuess ?? false,
    });
  }
}

// ── React 组件 ──

function togglePanel(panel: ActivePanel) {
  const s = useStore.getState();
  s.setActivePanel(s.activePanel === panel ? null : panel);
}

function App() {
  useSidebarResize();
  // 订阅 locale 变化，驱动整棵树重渲染
  useStore(s => s.locale);
  const { t } = useI18n();
  const serverPort = useStore(s => s.serverPort);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const sidebarOpen = useStore(s => s.sidebarOpen);
  const jianOpen = useStore(s => s.jianOpen);
  const currentTab = useStore(s => s.currentTab);
  const currentChannel = useStore(s => s.currentChannel);
  const channelIsDM = useStore(s => s.channelIsDM);
  const channelAnnouncement = useStore(s => s.channelAnnouncement);
  const saveChannelAnnouncement = useStore(s => s.saveChannelAnnouncement);
  const addToast = useStore(s => s.addToast);
  const { floatCard, show: showFloat, scheduleHide: scheduleFloatHide, cancelHide: cancelFloatHide, hide: hideFloat } = useFloatCard();
  const automationCountReqRef = useRef(0);
  const [announcementModalOpen, setAnnouncementModalOpen] = useState(false);
  const [announcementDraft, setAnnouncementDraft] = useState('');
  const [announcementSaving, setAnnouncementSaving] = useState(false);

  const openAnnouncementModal = useCallback(() => {
    if (!currentChannel || channelIsDM) return;
    setAnnouncementDraft(channelAnnouncement || '');
    setAnnouncementModalOpen(true);
  }, [channelAnnouncement, channelIsDM, currentChannel]);

  const closeAnnouncementModal = useCallback(async () => {
    if (announcementSaving) return;
    setAnnouncementModalOpen(false);
    if (!currentChannel || channelIsDM) return;
    if (announcementDraft === channelAnnouncement) return;

    setAnnouncementSaving(true);
    const ok = await saveChannelAnnouncement(announcementDraft);
    setAnnouncementSaving(false);

    if (!ok) {
      addToast(t('channel.announcementSaveFailed'), 'error', 3000);
    }
  }, [
    addToast,
    announcementDraft,
    announcementSaving,
    channelAnnouncement,
    channelIsDM,
    currentChannel,
    saveChannelAnnouncement,
    t,
  ]);

  useEffect(() => {
    if (!announcementModalOpen) return;
    if (!currentChannel || channelIsDM) {
      setAnnouncementModalOpen(false);
    }
  }, [announcementModalOpen, channelIsDM, currentChannel]);

  useEffect(() => {
    init().catch((err: unknown) => {
      console.error('[init] 初始化异常:', err);
      window.platform?.appReady?.();
    });
  }, []);

  // 切换 session 后，侧边栏任务计划数量应立即同步刷新
  useEffect(() => {
    if (!serverPort) return;
    const reqId = ++automationCountReqRef.current;
    fetchAutomationCount(currentSessionPath).then((count) => {
      if (count === null) return;
      if (reqId !== automationCountReqRef.current) return;
      useStore.setState({ automationCount: count });
    });
  }, [currentSessionPath, serverPort]);

  return (
    <ErrorBoundary>
      {/* Headless behavior components */}
      <SidebarLayout />
      <ChannelsPanel />

      {/* ── Titlebar ── */}
      <div className="titlebar">
        <button
          className={`tb-toggle tb-toggle-left${sidebarOpen ? ' active' : ''}`}
          id="tbToggleLeft"
          title={t('sidebar.toggle')}
          onClick={() => { hideFloat(); toggleSidebar(); }}
          onMouseEnter={(e) => showFloat('left', e.currentTarget)}
          onMouseLeave={scheduleFloatHide}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="9" y1="3" x2="9" y2="21"></line>
          </svg>
        </button>
        <div className="tb-tabs" id="tbTabs">
          <div className="tb-tabs-slider" id="tbSlider"></div>
          <button className="tb-tab active" data-tab="chat">{t('channel.chatTab')}</button>
          <button className="tb-tab" data-tab="channels">
            {t('channel.tab')}
            <span className="tb-tab-badge hidden" id="channelTabBadge"></span>
          </button>
        </div>
        <button
          className={`tb-toggle tb-toggle-right${jianOpen ? ' active' : ''}`}
          id="tbToggleRight"
          title={currentTab === 'channels' ? t('channel.info') : t('sidebar.jian')}
          onClick={() => { hideFloat(); toggleJianSidebar(); }}
          onMouseEnter={(e) => showFloat('right', e.currentTarget)}
          onMouseLeave={scheduleFloatHide}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="15" y1="3" x2="15" y2="21"></line>
          </svg>
        </button>
        <WindowControls />
      </div>

      {/* ── App body ── */}
      <div className="app">
        {/* Left sidebar */}
        <aside className={`sidebar${sidebarOpen ? '' : ' collapsed'}`} id="sidebar">
          <div className="sidebar-inner">
            <div className="sidebar-chat-content" id="sidebarChatContent">
              <div className="sidebar-header">
                <span className="sidebar-title">{t('sidebar.title')}</span>
                <div className="sidebar-header-actions">
                  <button className="sidebar-action-btn" id="newSessionBtn" title={t('sidebar.newChat')} onClick={createNewSession}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19"></line>
                      <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                  </button>
                  <button className="sidebar-action-btn" id="settingsBtn" title={t('settings.title')} onClick={() => window.platform.openSettings()}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3"></circle>
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                    </svg>
                  </button>
                </div>
              </div>
              <button className="sidebar-activity-bar" id="bridgeBar" onClick={() => togglePanel('bridge')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                </svg>
                <span>{t('sidebar.platformChat')}</span>
                <BridgeDot />
              </button>
              <button className="sidebar-activity-bar" id="activityBar" onClick={() => togglePanel('activity')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
                </svg>
                <span>{t('sidebar.activity')}</span>
              </button>
              <button className="sidebar-activity-bar" id="automationBar" onClick={() => togglePanel('automation')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                <span>{t('automation.title')}</span>
                <AutomationBadge />
              </button>
              <div className="session-list" id="sessionList">
                <SessionList />
              </div>
            </div>

            {/* 频道 tab 内容 */}
            <div className="sidebar-channel-content hidden" id="sidebarChannelContent">
              <div className="sidebar-header">
                <span className="sidebar-title">{t('channel.tab')}</span>
                <div className="sidebar-header-actions">
                  <button className="sidebar-action-btn" id="channelCreateBtn" title={t('channel.createTitle')}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19"></line>
                      <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                  </button>
                  <button className="sidebar-action-btn" id="channelSettingsBtn" title={t('settings.title')} onClick={() => window.platform.openSettings()}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3"></circle>
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                    </svg>
                  </button>
                </div>
              </div>
              <div className="channel-list-wrap" id="channelListWrap">
                <div className="channel-list" id="channelList">
                  <ChannelList />
                </div>
              </div>
            </div>
          </div>
          <div className="resize-handle resize-handle-right" id="sidebarResizeHandle"></div>
        </aside>

        {/* Main content */}
        <MainContentDrag>

          <div className="chat-area" id="chatArea">
            <WelcomeContainer />
            <ChatArea />
          </div>

          <div className="input-area">
            <InputArea />
          </div>

          <div className="channel-view" id="channelView">
            <div className={`channel-header${currentChannel ? '' : ' hidden'}`} id="channelHeader">
              <div className="channel-header-main">
                <div className="channel-header-info">
                  <span className="channel-header-name" id="channelHeaderName"></span>
                  <span className="channel-header-members" id="channelHeaderMembers"></span>
                </div>
                <ChannelMemoryToggle />
              </div>
            </div>
            <div className="channel-messages" id="channelMessages">
              <ChannelMessages />
            </div>
            <div className="channel-input-area hidden" id="channelInputArea">
              <ChannelInput />
            </div>
            <div className="channel-readonly-notice hidden" id="channelReadonlyNotice">
              <ChannelReadonly />
            </div>
          </div>

          {/* Floating panels render into main-content */}
          <ActivityPanel />
          <AutomationPanel />
          <BridgePanel />
        </MainContentDrag>

        <PreviewPanel />

        {/* Right sidebar (Jian) */}
        <aside className={`jian-sidebar${jianOpen ? '' : ' collapsed'}`} id="jianSidebar">
          <div className="resize-handle resize-handle-left" id="jianResizeHandle"></div>
          <div className="jian-sidebar-inner">
            <div className="jian-chat-content" id="jianChatContent">
              <DeskSection />
            </div>

            <div className="jian-channel-content hidden" id="jianChannelContent">
              {currentChannel && (
                <div className="jian-card">
                <div className="channel-info-section">
                  <div className="channel-info-label-row">
                    <div className="channel-info-label">{t('channel.info')}</div>
                    {!channelIsDM && (
                      <button
                          className="channel-announcement-open-btn"
                          type="button"
                          onClick={openAnnouncementModal}
                        >
                          {t('channel.announcementBtn')}
                        </button>
                      )}
                    </div>
                    <div className="channel-info-name" id="channelInfoName"></div>
                  </div>
                  <div className="channel-info-section">
                    <div className="channel-info-label">{t('channel.members')}</div>
                    <div className="channel-members-list" id="channelMembersList">
                      <ChannelMembers />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>

      {/* Connection status */}
      <ConnectionStatus />

      {/* Channel create overlay */}
      <div className="agent-create-overlay" id="channelCreateOverlay">
        <ChannelCreate />
      </div>

      <div
        className={`channel-announcement-overlay${announcementModalOpen ? ' visible' : ''}`}
        onClick={(e) => { if (e.target === e.currentTarget) void closeAnnouncementModal(); }}
      >
        <div className="channel-announcement-card">
          <button
            className="channel-announcement-close-btn"
            type="button"
            onClick={() => void closeAnnouncementModal()}
            aria-label={t('channel.announcementClose')}
            title={t('channel.announcementClose')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
          <h3 className="channel-announcement-title">{t('channel.announcementTitle')}</h3>
          <textarea
            className="settings-input channel-announcement-input"
            value={announcementDraft}
            onChange={(e) => setAnnouncementDraft(e.target.value)}
            placeholder={t('channel.announcementPlaceholder')}
          />
          <div className="channel-announcement-hint">{t('channel.announcementHint')}</div>
        </div>
      </div>

      {/* Float preview card */}
      {floatCard && (
        <FloatPreviewCard
          state={floatCard}
          onMouseEnter={cancelFloatHide}
          onMouseLeave={scheduleFloatHide}
          onAction={hideFloat}
        />
      )}

      {/* Toast notifications */}
      <ToastContainer />
    </ErrorBoundary>
  );
}

function MainContentDrag({ children }: { children: React.ReactNode }) {
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (dragCounter.current === 1) setDragActive(true);
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragActive(false);
  }, []);
  const onDragOver = useCallback((e: React.DragEvent) => e.preventDefault(), []);
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragActive(false);
    handleDrop(e);
  }, []);

  return (
    <div
      className="main-content"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <BrowserCard />
      <div className={`drop-overlay${dragActive ? ' visible' : ''}`}>
        <div className="drop-overlay-inner">
          <span className="drop-icon">📎</span>
          <DropText />
        </div>
      </div>
      {children}
    </div>
  );
}

function WelcomeContainer() {
  const visible = useStore(s => s.welcomeVisible);
  return (
    <div className={`welcome${visible ? '' : ' hidden'}`} id="welcome">
      <WelcomeScreen />
    </div>
  );
}

function AutomationBadge() {
  const count = useStore(s => s.automationCount);
  return <span className="automation-count-badge">{count > 0 ? String(count) : ''}</span>;
}

function BridgeDot() {
  const connected = useStore(s => s.bridgeDotConnected);
  return <span className={`sidebar-bridge-dot${connected ? ' connected' : ''}`}></span>;
}

function DropText() {
  const computeDropTarget = (s: any) => {
    const findAgentName = (agentId: string | null | undefined): string | null => {
      if (!agentId) return null;
      return s.agents.find((a: any) => a.id === agentId)?.name || null;
    };

    if (s.currentTab === 'channels') {
      const current = s.currentChannel ? s.channels.find((c: any) => c.id === s.currentChannel) : null;
      if (current) {
        if (current.isDM) {
          return { targetName: current.peerName || current.name || current.peerId || s.channelInfoName || t('channel.tab'), isGroupChannel: false };
        }
        return { targetName: current.name || s.channelInfoName || current.id, isGroupChannel: true };
      }
      if (s.channelInfoName) {
        return { targetName: s.channelInfoName, isGroupChannel: !s.channelIsDM };
      }
      return { targetName: t('channel.tab'), isGroupChannel: false };
    }

    const selectedAgentName = findAgentName(s.selectedAgentId);
    if (selectedAgentName) return { targetName: selectedAgentName, isGroupChannel: false };

    if (s.sessionAgent?.name) return { targetName: s.sessionAgent.name, isGroupChannel: false };

    const currentSession = s.currentSessionPath
      ? s.sessions.find((it: any) => it.path === s.currentSessionPath)
      : null;
    if (currentSession?.agentName) return { targetName: currentSession.agentName, isGroupChannel: false };

    const currentSessionAgentName = findAgentName(currentSession?.agentId || null);
    if (currentSessionAgentName) return { targetName: currentSessionAgentName, isGroupChannel: false };

    const currentAgentName = findAgentName(s.currentAgentId);
    if (currentAgentName) return { targetName: currentAgentName, isGroupChannel: false };

    return { targetName: s.agentName || 'Hanako', isGroupChannel: false };
  };
  const targetName = useStore((s) => computeDropTarget(s).targetName);
  const isGroupChannel = useStore((s) => computeDropTarget(s).isGroupChannel);

  return (
    <span className="drop-text">
      {isGroupChannel ? t('drop.hintGroup', { name: targetName }) : t('drop.hint', { name: targetName })}
    </span>
  );
}

function ConnectionStatus() {
  const connected = useStore(s => s.connected);
  const statusKey = useStore(s => s.statusKey);
  const statusVars = useStore(s => s.statusVars);
  return (
    <div className={`connection-status${connected ? ' connected' : ''}`}>
      <span className="status-dot"></span>
      <span className="status-text">{statusKey ? t(statusKey, statusVars) : ''}</span>
    </div>
  );
}

export default App;
