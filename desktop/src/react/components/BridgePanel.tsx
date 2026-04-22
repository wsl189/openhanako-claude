import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { formatSessionDate } from '../utils/format';
import { renderMarkdown } from '../utils/markdown';
import { MarkdownContent } from './chat/MarkdownContent';

interface BridgeSession {
  sessionKey: string;
  platform: string;
  chatId: string;
  displayName?: string;
  avatarUrl?: string;
  lastActive?: number;
  lastMessage?: string | null;
  agentId?: string;
  agentName?: string;
}

interface BridgeMessage {
  role: string;
  content: string;
  timestamp?: number | null;
}

interface BridgeHistorySession extends BridgeSession {
  messages: BridgeMessage[];
}

interface BoundAgent {
  id: string;
  name: string;
}

interface BridgeAgentItem {
  agentId: string;
  agentName: string;
  avatarUrl?: string;
  lastActive?: number;
  lastMessage?: string;
}

interface StatusData {
  telegram?: { status: string; configured?: boolean };
  feishu?: { status: string; configured?: boolean };
  qq?: { status: string; configured?: boolean };
  wechat?: { status: string; configured?: boolean };
  [key: string]: { status: string; configured?: boolean } | undefined;
}

type BridgePlatform = 'feishu' | 'telegram' | 'qq' | 'wechat';

function normalizeBridgeTab(raw: string | null): BridgePlatform {
  if (raw === 'telegram' || raw === 'qq' || raw === 'feishu' || raw === 'wechat') return raw;
  return 'feishu';
}

function isGenericUserLabel(v?: string | null, platform?: string): boolean {
  const s = (v || '').trim();
  if (!s) return true;
  if (/^(user|用户)$/iu.test(s)) return true;
  // 技术型平台用户标识（按平台精确匹配，避免误伤正常昵称）
  if (platform === 'feishu' && /^ou_[a-z0-9]{8,}$/i.test(s)) return true; // 飞书 open_id
  if (platform === 'wechat') {
    if (/@im\.wechat$/i.test(s)) return true; // 微信 userId
    if (/^o[a-z0-9]{16,}$/i.test(s)) return true; // 微信 openid 常见格式
  }
  return false;
}

function shortUserHint(v?: string | null): string {
  const s = (v || '').trim();
  if (!s) return '';
  const core = s.replace(/@im\.wechat$/i, '');
  return core.length > 4 ? core.slice(-4) : core;
}

function buildAgentItems(sessions: BridgeSession[], boundAgents: BoundAgent[]): BridgeAgentItem[] {
  const map = new Map<string, BridgeAgentItem>();

  for (const agent of boundAgents || []) {
    if (!agent?.id) continue;
    map.set(agent.id, {
      agentId: agent.id,
      agentName: agent.name || agent.id,
      lastActive: 0,
      lastMessage: "",
    });
  }

  for (const s of sessions || []) {
    if (!s.agentId) continue;
    const prev = map.get(s.agentId);
    const nextLast = s.lastActive || 0;
    if (!prev) {
      map.set(s.agentId, {
        agentId: s.agentId,
        agentName: s.agentName || s.agentId,
        avatarUrl: s.avatarUrl,
        lastActive: nextLast,
        lastMessage: (s.lastMessage || "").trim(),
      });
      continue;
    }
    if (nextLast > (prev.lastActive || 0)) {
      prev.lastActive = nextLast;
      if (s.avatarUrl) prev.avatarUrl = s.avatarUrl;
      prev.lastMessage = (s.lastMessage || "").trim();
    }
    if (!prev.lastMessage && s.lastMessage) prev.lastMessage = String(s.lastMessage).trim();
    if (!prev.agentName && s.agentName) prev.agentName = s.agentName;
  }

  return [...map.values()].sort((a, b) => {
    const at = a.lastActive || 0;
    const bt = b.lastActive || 0;
    if (at !== bt) return bt - at;
    return a.agentName.localeCompare(b.agentName, 'zh-Hans-CN');
  });
}

function reorderMessagesByTurn(messages: BridgeMessage[]): BridgeMessage[] {
  if (!Array.isArray(messages) || messages.length <= 1) return messages || [];

  const turns: BridgeMessage[][] = [];
  let currentTurn: BridgeMessage[] = [];
  let hasUser = false;

  for (const msg of messages) {
    if (msg?.role === 'user') {
      hasUser = true;
      if (currentTurn.length) turns.push(currentTurn);
      currentTurn = [msg];
      continue;
    }
    if (!currentTurn.length) {
      currentTurn = [msg];
    } else {
      currentTurn.push(msg);
    }
  }
  if (currentTurn.length) turns.push(currentTurn);

  // 没有 user 锚点时退化为简单倒序（最新在上）
  if (!hasUser) return [...messages].reverse();

  const out: BridgeMessage[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    out.push(...turns[i]);
  }
  return out;
}

export function BridgePanel() {
  const activePanel = useStore(s => s.activePanel);
  const setActivePanel = useStore(s => s.setActivePanel);

  const [platform, setPlatform] = useState<BridgePlatform>(() => normalizeBridgeTab(localStorage.getItem('hana_bridge_tab')));
  const [agentItems, setAgentItems] = useState<BridgeAgentItem[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [historySessions, setHistorySessions] = useState<BridgeHistorySession[]>([]);
  const [showOverlay, setShowOverlay] = useState(false);
  const [statusData, setStatusData] = useState<StatusData>({});

  const messagesRef = useRef<HTMLDivElement>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const platformRef = useRef(platform);
  platformRef.current = platform;
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;

  const selectedAgent = useMemo(
    () => agentItems.find((a) => a.agentId === selectedAgentId) || null,
    [agentItems, selectedAgentId],
  );

  const loadAgentHistory = useCallback(async (plat: BridgePlatform, agentId: string) => {
    try {
      const res = await hanaFetch(`/api/bridge/agents/${encodeURIComponent(agentId)}/history?platform=${plat}`);
      const data = await res.json();
      setHistorySessions((data.sessions || []) as BridgeHistorySession[]);
      setTimeout(() => {
        if (messagesRef.current) {
          messagesRef.current.scrollTop = 0;
        }
      }, 0);
    } catch (err) {
      console.error('[bridge] load agent history failed:', err);
      setHistorySessions([]);
    }
  }, []);

  // 加载状态
  const loadStatus = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/bridge/status');
      const data = await res.json();
      setStatusData(data);
      updateSidebarDot(data);
    } catch {}
  }, []);

  // 加载平台数据 + 自动定位当前选中 agent
  const loadPlatformData = useCallback(async (plat: BridgePlatform) => {
    try {
      const [statusRes, sessionsRes] = await Promise.all([
        hanaFetch('/api/bridge/status'),
        hanaFetch(`/api/bridge/sessions?platform=${plat}`),
      ]);
      const sData = await statusRes.json();
      const sessData = await sessionsRes.json();

      const nextSessions = (sessData.sessions || []) as BridgeSession[];
      const nextBoundAgents = (sessData.boundAgents || []) as BoundAgent[];
      const nextAgentItems = buildAgentItems(nextSessions, nextBoundAgents);

      setStatusData(sData);
      updateSidebarDot(sData);
      setShowOverlay(!sData[plat]?.configured);
      setAgentItems(nextAgentItems);

      const prevSelected = selectedAgentIdRef.current;
      const nextSelected = (prevSelected && nextAgentItems.some((a) => a.agentId === prevSelected))
        ? prevSelected
        : (nextAgentItems[0]?.agentId || null);

      selectedAgentIdRef.current = nextSelected;
      setSelectedAgentId(nextSelected);

      if (nextSelected) {
        await loadAgentHistory(plat, nextSelected);
      } else {
        setHistorySessions([]);
      }
    } catch (err) {
      console.error('[bridge] load platform data failed:', err);
    }
  }, [loadAgentHistory]);

  // 面板打开时加载数据
  useEffect(() => {
    if (activePanel === 'bridge') {
      void loadPlatformData(platform);
    }
  }, [activePanel, platform, loadPlatformData]);

  // 注册 WS 回调
  useEffect(() => {
    window.__hanaBridgeLoadStatus = loadStatus;
    window.__hanaBridgeOnMessage = () => {
      if (activePanel !== 'bridge') return;
      if (!refreshTimerRef.current) {
        refreshTimerRef.current = setTimeout(() => {
          refreshTimerRef.current = null;
          void loadPlatformData(platformRef.current);
        }, 500);
      }
    };
    return () => {
      delete window.__hanaBridgeLoadStatus;
      delete window.__hanaBridgeOnMessage;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [activePanel, loadStatus, loadPlatformData]);

  const switchTab = useCallback((plat: BridgePlatform) => {
    setPlatform(plat);
    selectedAgentIdRef.current = null;
    setSelectedAgentId(null);
    setHistorySessions([]);
    localStorage.setItem('hana_bridge_tab', plat);
    void loadPlatformData(plat);
  }, [loadPlatformData]);

  const openAgentHistory = useCallback((agentId: string) => {
    selectedAgentIdRef.current = agentId;
    setSelectedAgentId(agentId);
    void loadAgentHistory(platformRef.current, agentId);
  }, [loadAgentHistory]);

  const close = useCallback(() => setActivePanel(null), [setActivePanel]);

  if (activePanel !== 'bridge') return null;

  const t = window.t ?? ((p: string) => p);
  const tgStatus = statusData.telegram?.status;
  const fsStatus = statusData.feishu?.status;
  const qqStatus = statusData.qq?.status;
  const wechatStatus = statusData.wechat?.status;
  const currentPlatformName = platform === 'telegram'
    ? 'Telegram'
    : platform === 'qq'
      ? 'QQ'
      : platform === 'wechat'
        ? t('settings.bridge.wechat')
        : t('settings.bridge.feishu');
  const genericSessionName = (plat?: string) => {
    if (plat === 'wechat') return `${t('settings.bridge.wechat')}用户`;
    if (plat === 'feishu') return `${t('settings.bridge.feishu')}用户`;
    if (plat === 'telegram') return 'Telegram用户';
    if (plat === 'qq') return 'QQ用户';
    return '用户';
  };
  const sessionDisplayName = (session: BridgeHistorySession) => {
    const rawName = (session.displayName || '').trim();
    if (!isGenericUserLabel(rawName, session.platform)) {
      return rawName || session.chatId || genericSessionName(session.platform);
    }
    const base = genericSessionName(session.platform);
    const hint = shortUserHint(session.chatId || rawName);
    return hint ? `${base} · ${hint}` : base;
  };

  return (
    <div className="floating-panel bridge-panel-wide" id="bridgePanel">
      <div className="floating-panel-inner">
        <div className="floating-panel-header">
          <div className="bridge-tabs" id="bridgeTabs">
            <button
              className={'bridge-tab' + (platform === 'feishu' ? ' active' : '')}
              onClick={() => switchTab('feishu')}
            >
              <span className={'bridge-tab-dot' + dotClass(fsStatus)} />
              <span>{t('settings.bridge.feishu')}</span>
            </button>
            <button
              className={'bridge-tab' + (platform === 'telegram' ? ' active' : '')}
              onClick={() => switchTab('telegram')}
            >
              <span className={'bridge-tab-dot' + dotClass(tgStatus)} />
              Telegram
            </button>
            <button
              className={'bridge-tab' + (platform === 'qq' ? ' active' : '')}
              onClick={() => switchTab('qq')}
            >
              <span className={'bridge-tab-dot' + dotClass(qqStatus)} />
              QQ
            </button>
            <button
              className={'bridge-tab' + (platform === 'wechat' ? ' active' : '')}
              onClick={() => switchTab('wechat')}
            >
              <span className={'bridge-tab-dot' + dotClass(wechatStatus)} />
              <span>{t('settings.bridge.wechat')}</span>
            </button>
          </div>
          <button className="floating-panel-close" onClick={close}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="bridge-body">
          {showOverlay && (
            <div className="bridge-overlay" id="bridgeOverlay">
              <div className="bridge-overlay-content">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <div className="bridge-overlay-text">
                  {t('bridge.notConfigured', { platform: currentPlatformName })}
                </div>
                <button className="bridge-overlay-btn" onClick={() => window.platform.openSettings('bridge')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  <span>{t('bridge.goToSettings')}</span>
                </button>
              </div>
            </div>
          )}

          <div className="bridge-sidebar" id="bridgeSidebar">
            <div className="bridge-contact-list" id="bridgeContactList">
              {agentItems.length === 0 ? (
                <div className="bridge-contact-empty">{t('bridge.noAgents')}</div>
              ) : (
                agentItems.map((a) => (
                  <div
                    key={a.agentId}
                    className={'bridge-contact-item' + (a.agentId === selectedAgentId ? ' active' : '')}
                    onClick={() => openAgentHistory(a.agentId)}
                  >
                    <ContactAvatar name={a.agentName} avatarUrl={a.avatarUrl} />
                    <div className="bridge-contact-info">
                      <div className="bridge-contact-name">{a.agentName}</div>
                      <div className="bridge-contact-preview" title={a.lastMessage || ''}>
                        {a.lastMessage || t('bridge.noMessages')}
                      </div>
                      {a.lastActive && (
                        <div className="bridge-contact-time">
                          {formatSessionDate(new Date(a.lastActive).toISOString())}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="bridge-chat" id="bridgeChat">
            {selectedAgent ? (
              <>
                <div className="bridge-chat-header" id="bridgeChatHeader">
                  <span className="bridge-chat-header-name">{selectedAgent.agentName}</span>
                </div>
                <div className="bridge-chat-messages" ref={messagesRef} id="bridgeChatMessages">
                  {historySessions.length === 0 ? (
                    <div className="bridge-chat-no-msg">{t('bridge.noMessages')}</div>
                  ) : (
                    historySessions.map((session) => (
                      <div className="bridge-history-session" key={session.sessionKey}>
                        <div className="bridge-history-session-head">
                          <span className="bridge-history-session-name">
                            {sessionDisplayName(session)}
                          </span>
                          {session.lastActive && (
                            <span className="bridge-history-session-time">{formatSessionDate(new Date(session.lastActive).toISOString())}</span>
                          )}
                        </div>
                        {session.messages.length === 0 ? (
                          <div className="bridge-chat-no-msg">{t('bridge.noMessages')}</div>
                        ) : (
                          reorderMessagesByTurn(session.messages).map((m, i) => (
                            <ChatBubble key={`${session.sessionKey}:${i}`} message={m} />
                          ))
                        )}
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : (
              <div className="bridge-chat-empty" id="bridgeChatEmpty">
                <span>{t('bridge.selectAgent')}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function dotClass(status?: string): string {
  if (status === 'connected') return ' bridge-dot-ok';
  if (status === 'error') return ' bridge-dot-err';
  return ' bridge-dot-off';
}

function updateSidebarDot(data: Record<string, { status: string } | undefined>) {
  const anyConnected = data.telegram?.status === 'connected'
    || data.feishu?.status === 'connected'
    || data.qq?.status === 'connected'
    || data.wechat?.status === 'connected';
  useStore.setState({ bridgeDotConnected: anyConnected });
}

function ContactAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
  const [showImg, setShowImg] = useState(!!avatarUrl);
  return (
    <div className="bridge-contact-avatar">
      {showImg && avatarUrl ? (
        <img
          className="bridge-contact-avatar-img"
          src={avatarUrl}
          alt={name}
          onError={() => setShowImg(false)}
        />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </div>
  );
}

function ChatBubble({ message: m }: { message: BridgeMessage }) {
  if (m.role === 'assistant') {
    let base = String(m.content || '');
    const finalMatches = [...base.matchAll(/<final>\s*([\s\S]*?)\s*<\/final>/gi)];
    if (finalMatches.length) {
      base = finalMatches[finalMatches.length - 1][1];
    } else {
      const replyingMatches = [...base.matchAll(/<replying>\s*([\s\S]*?)\s*<\/replying>/gi)];
      if (replyingMatches.length) base = replyingMatches[replyingMatches.length - 1][1];
    }
    const cleaned = base
      .replace(/```(?:think|analysis|commentary|summary)[\s\S]*?```\n*/gi, '')
      .replace(/<(?:think|analysis|commentary|summary)>[\s\S]*?<\/(?:think|analysis|commentary|summary)>\s*/gi, '')
      .replace(/<xing\s+title=["\u201C\u201D][^"\u201C\u201D]*["\u201C\u201D]>[\s\S]*?<\/xing>\s*/gi, '')
      .replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/gi, '')
      .replace(/<\/?(?:final|replying)\s*>/gi, '')
      .trim();
    if (!cleaned) return null;
    return (
      <div className="bridge-bubble-row bridge-bubble-in">
        <MarkdownContent
          className="bridge-bubble bridge-bubble-markdown md-content"
          html={renderMarkdown(cleaned)}
        />
      </div>
    );
  }
  // user: 保留时间标签，仅去掉 User/用户 前缀
  let displayText = m.content;
  // [来自 User] xxx -> xxx（允许重复）
  displayText = displayText.replace(
    /^(?:[\[\(【]\s*来自\s*(?:user|用户)\s*[\]\)】]\s*)+/iu,
    '',
  );
  // [03-23 21:57] User: xxx -> [03-23 21:57] xxx
  displayText = displayText.replace(
    /^([\[\(【][^\]\)】]{1,48}[\]\)】]\s*)(?:user|用户)\s*[:：]\s*/iu,
    '$1',
  );
  // [03-23 21:57] o9cq800d...: xxx -> [03-23 21:57] xxx（微信/平台用户ID前缀）
  displayText = displayText.replace(
    /^([\[\(【][^\]\)】]{1,48}[\]\)】]\s*)(?=[A-Za-z0-9._@-]{6,}\s*[:：])(?=[^:：]*(?:\d|@))[A-Za-z0-9._@-]+\s*[:：]\s*/u,
    '$1',
  );
  // 兼容残留片段：57] User: xxx -> xxx
  displayText = displayText.replace(/^\d{1,2}\]\s*(?:user|用户)\s*[:：]\s*/iu, '');
  // User: xxx -> xxx
  displayText = displayText.replace(/^(?:user|用户)\s*[:：]\s*/iu, '');
  // o9cq800d...: xxx -> xxx（无时间标签的用户ID前缀）
  displayText = displayText.replace(
    /^(?=[A-Za-z0-9._@-]{6,}\s*[:：])(?=[^:：]*(?:\d|@))[A-Za-z0-9._@-]+\s*[:：]\s*/u,
    '',
  );
  return (
    <div className="bridge-bubble-row bridge-bubble-out">
      <div className="bridge-bubble">{displayText}</div>
    </div>
  );
}
