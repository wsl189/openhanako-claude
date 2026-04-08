/**
 * ChannelsPanel — 频道系统 React 组件
 *
 * Phase 3 迁移：替代 channels-shim.ts (1159 行)。
 * 通过 portal 渲染到 index.html 中已有的 DOM 容器。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { renderMarkdown } from '../utils/markdown';
import { isHttpUrlPath } from '../utils/format';
import { toggleSidebar } from './SidebarLayout';
import { toggleJianSidebar } from '../stores/desk-actions';
import { ContextMenu } from './ContextMenu';
import type { ContextMenuItem } from './ContextMenu';
import type { Channel, Agent } from '../types';
import { yuanFallbackAvatar } from '../utils/agent-helpers';
import { SVG_ICONS } from '../utils/icons';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── 稳定头像时间戳（避免每次渲染生成新 URL） ──
let _avatarTs = Date.now();
export function refreshAvatarTs() { _avatarTs = Date.now(); }

// ── 辅助类型 ──

interface MemberInfo {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  fallbackAvatar: string | null;
  yuan?: string;
  isUser: boolean;
}

interface MentionItem {
  id: string;
  displayName: string;
  mentionText: string;
  avatar: MemberInfo | null;
  searchTokens: string[];
}

interface CommandItem {
  id: string;
  label: string;
  desc: string;
}

// ── 辅助函数 ──

function resolveChannelMember(
  memberId: string,
  userName: string,
  userAvatarUrl: string | null,
  agents: Agent[],
  currentAgentId: string | null,
): MemberInfo {
  const normalizedMemberId = String(memberId || '').trim().toLowerCase();
  const normalizedUserName = String(userName || '').trim().toLowerCase();
  const isUserAlias =
    normalizedMemberId === 'user'
    || normalizedMemberId === '用户'
    || (!!normalizedUserName && normalizedMemberId === normalizedUserName);

  if (isUserAlias) {
    return {
      id: memberId,
      displayName: userName || memberId || 'user',
      avatarUrl: userAvatarUrl,
      fallbackAvatar: null,
      isUser: true,
    };
  }
  const agent = agents.find((a) => a.id === memberId || a.name === memberId);
  if (agent) {
    const hasAvatar = !!agent.hasAvatar;
    return {
      id: memberId,
      displayName: agent.name || agent.id,
      avatarUrl: hasAvatar ? hanaUrl(`/api/agents/${agent.id}/avatar?t=${_avatarTs}`) : null,
      fallbackAvatar: yuanFallbackAvatar(agent.yuan),
      yuan: agent.yuan,
      isUser: false,
    };
  }
  return {
    id: memberId,
    displayName: memberId,
    avatarUrl: null,
    fallbackAvatar: null,
    isUser: false,
  };
}

function formatChannelTime(timestamp: string): string {
  if (!timestamp) return '';
  const parts = timestamp.split(' ');
  if (parts.length < 2) return timestamp;

  const today = new Date();
  const [y, mo, d] = parts[0].split('-').map(Number);
  const t = (window as any).t;

  if (y === today.getFullYear() && mo === today.getMonth() + 1 && d === today.getDate()) {
    return parts[1];
  }
  if (y === today.getFullYear() && mo === today.getMonth() + 1 && d === today.getDate() - 1) {
    return t('time.yesterday');
  }
  return `${mo}/${d}`;
}

// ══════════════════════════════════════════════════════
// MemberAvatar — 复用头像渲染
// ══════════════════════════════════════════════════════

function MemberAvatar({ info, className }: { info: MemberInfo; className?: string }) {
  const [imgError, setImgError] = useState(false);
  useEffect(() => {
    setImgError(false);
  }, [info.avatarUrl, info.fallbackAvatar]);

  if (info.avatarUrl && !imgError) {
    return (
      <img
        className={className}
        src={info.avatarUrl}
        onError={() => setImgError(true)}
      />
    );
  }
  if (info.fallbackAvatar) {
    return <img className={className} src={info.fallbackAvatar} />;
  }
  return <>{(info.displayName || '?').charAt(0).toUpperCase()}</>;
}

// ══════════════════════════════════════════════════════
// ChannelsPanel — 入口组件
// ══════════════════════════════════════════════════════

export function ChannelsPanel() {
  const currentTab = useStore((s) => s.currentTab);
  const channels = useStore((s) => s.channels);
  const loadChannels = useStore((s) => s.loadChannels);
  const serverPort = useStore((s) => s.serverPort);

  // 初始化：进入频道 tab 时加载数据
  useEffect(() => {
    if (currentTab === 'channels' && channels.length === 0 && serverPort) {
      loadChannels();
    }
  }, [currentTab, channels.length, serverPort, loadChannels]);

  // 启动时加载频道数据
  useEffect(() => {
    if (serverPort) {
      loadChannels();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverPort]);

  // Tab 初始化：恢复保存的 tab
  useEffect(() => {
    const savedTab = localStorage.getItem('hana-tab');
    if (savedTab === 'channels') {
      useStore.getState().setCurrentTab('channels');
    }
  }, []);

  // Tab 切换的 DOM 副作用（操纵非 React 管理的 DOM 元素）
  useEffect(() => {
    const sidebarChatContent = document.getElementById('sidebarChatContent');
    const sidebarChannelContent = document.getElementById('sidebarChannelContent');
    const chatArea = document.getElementById('chatArea');
    const inputArea = document.querySelector('.input-area') as HTMLElement | null;
    const channelView = document.getElementById('channelView');
    const jianChatContent = document.getElementById('jianChatContent');
    const jianChannelContent = document.getElementById('jianChannelContent');
    const activityPanel = document.getElementById('activityPanel');
    const automationPanel = document.getElementById('automationPanel');

    if (currentTab === 'chat') {
      sidebarChatContent?.classList.remove('hidden');
      sidebarChannelContent?.classList.add('hidden');
      chatArea?.classList.remove('hidden');
      inputArea?.classList.remove('hidden');
      channelView?.classList.remove('active');
      jianChatContent?.classList.remove('hidden');
      jianChannelContent?.classList.add('hidden');
    } else {
      sidebarChatContent?.classList.add('hidden');
      sidebarChannelContent?.classList.remove('hidden');
      chatArea?.classList.add('hidden');
      inputArea?.classList.add('hidden');
      channelView?.classList.add('active');
      jianChatContent?.classList.add('hidden');
      jianChannelContent?.classList.remove('hidden');
      activityPanel?.classList.add('hidden');
      automationPanel?.classList.add('hidden');
    }
  }, [currentTab]);

  // Tab 切换时同步 sidebar/jian 的 open 状态
  useEffect(() => {
    const savedLeft = localStorage.getItem(`hana-sidebar-${currentTab}`);
    const wantLeftOpen = savedLeft !== 'closed';
    const s = useStore.getState();
    if (s.sidebarOpen !== wantLeftOpen) {
      toggleSidebar(wantLeftOpen);
    }
    const savedRight = localStorage.getItem(`hana-jian-${currentTab}`);
    const wantRightOpen = savedRight !== 'closed';
    if (s.jianOpen !== wantRightOpen) {
      toggleJianSidebar(wantRightOpen);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTab]);

  // Tab slider + badge 的 DOM 操纵（titlebar tabs 现在由 React 渲染但仍用 DOM 操纵 slider）
  useTabSlider(currentTab);
  useTabBadge();
  useTabClickHandler();

  // 渲染 headless 控制组件（不产出 DOM，只管理副作用）
  return (
    <>
      <ChannelHeaderSync />
      <ChannelToggleController />
    </>
  );
}


// ══════════════════════════════════════════════════════
// Hooks for titlebar tab management
// ══════════════════════════════════════════════════════

function useTabSlider(currentTab: string) {
  const locale = useStore(s => s.locale);

  useEffect(() => {
    moveSlider(currentTab, true);
  }, [currentTab]);

  // Re-position slider when locale changes (tab text width changes)
  useEffect(() => {
    moveSlider(useStore.getState().currentTab || 'chat', false);
  }, [locale]);

  // Initial slider position (no animation)
  useEffect(() => {
    moveSlider(useStore.getState().currentTab || 'chat', false);
  }, []);
}

function moveSlider(tab: string, animate: boolean) {
  const tbTabs = document.getElementById('tbTabs');
  const slider = document.getElementById('tbSlider');
  const target = tbTabs?.querySelector(`.tb-tab[data-tab="${tab}"]`) as HTMLElement | null;
  if (!slider || !target || !tbTabs) return;
  const parentRect = tbTabs.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const offsetX = targetRect.left - parentRect.left;
  if (!animate) slider.style.transition = 'none';
  slider.style.width = targetRect.width + 'px';
  slider.style.transform = `translateX(${offsetX - 2}px)`;
  if (!animate) requestAnimationFrame(() => { slider.style.transition = ''; });
}

function useTabBadge() {
  const channelTotalUnread = useStore((s) => s.channelTotalUnread);

  useEffect(() => {
    const badge = document.getElementById('channelTabBadge');
    if (!badge) return;
    if (channelTotalUnread > 0) {
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }, [channelTotalUnread]);
}

function useTabClickHandler() {
  useEffect(() => {
    const tbTabs = document.getElementById('tbTabs');
    if (!tbTabs) return;

    const handler = (e: Event) => {
      const tabBtn = (e.target as HTMLElement).closest('.tb-tab') as HTMLElement | null;
      if (!tabBtn) return;
      const tab = tabBtn.dataset.tab || 'chat';
      const s = useStore.getState();
      if (tab === s.currentTab) return;

      s.setCurrentTab(tab as any);
      localStorage.setItem('hana-tab', tab);

      // Update active class on tab buttons
      tbTabs.querySelectorAll('.tb-tab').forEach((btn) => {
        (btn as HTMLElement).classList.toggle('active', (btn as HTMLElement).dataset.tab === tab);
      });

    };

    tbTabs.addEventListener('click', handler);
    return () => tbTabs.removeEventListener('click', handler);
  }, []);
}

// ══════════════════════════════════════════════════════
// ChannelToggleController — 频道默认开启，保留空组件做兼容
// ══════════════════════════════════════════════════════

function ChannelToggleController() {
  return null;
}

function confirmDeleteChannel(channelId: string) {
  const s = useStore.getState();
  const ch = s.channels.find((c) => c.id === channelId);
  const displayName = ch?.name || channelId;
  const msg = ((window as any).t('channel.deleteConfirm', { name: displayName }) || '');
  if (!confirm(msg)) return;
  s.deleteChannel(channelId);
}

// ══════════════════════════════════════════════════════
// ChannelHeaderSync — 同步频道头部信息到静态 DOM
// ══════════════════════════════════════════════════════

function ChannelHeaderSync() {
  const headerName = useStore((s) => s.channelHeaderName);
  const headerMembers = useStore((s) => s.channelHeaderMembersText);
  const channelInfoName = useStore((s) => s.channelInfoName);

  useEffect(() => {
    const el = document.getElementById('channelHeaderName');
    if (el) el.textContent = headerName;
  }, [headerName]);

  useEffect(() => {
    const el = document.getElementById('channelHeaderMembers');
    if (el) el.textContent = headerMembers;
  }, [headerMembers]);

  useEffect(() => {
    const el = document.getElementById('channelInfoName');
    if (el) el.textContent = channelInfoName;
  }, [channelInfoName]);

  return null;
}

export function ChannelMemoryToggle() {
  const { t } = useI18n();
  const currentChannel = useStore((s) => s.currentChannel);
  const channelIsDM = useStore((s) => s.channelIsDM);
  const channelMemoryEnabled = useStore((s) => s.channelMemoryEnabled);
  const channelMemoryLoading = useStore((s) => s.channelMemoryLoading);
  const toggleCurrentChannelMemory = useStore((s) => s.toggleCurrentChannelMemory);

  if (!currentChannel || channelIsDM) return null;

  return (
    <button
      className={'memory-toggle-btn channel-memory-toggle' + (channelMemoryEnabled ? ' active' : '')}
      onClick={() => { void toggleCurrentChannelMemory(); }}
      disabled={channelMemoryLoading}
      aria-pressed={channelMemoryEnabled}
      title={t(channelMemoryEnabled ? 'channel.memoryOn' : 'channel.memoryOff')}
    >
      <svg className="memory-toggle-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8a4 4 0 1 0 0 8" />
        <path d="M12 2v2M12 20v2" />
      </svg>
      <span>{t(channelMemoryEnabled ? 'channel.memoryOn' : 'channel.memoryOff')}</span>
    </button>
  );
}

// ══════════════════════════════════════════════════════
// ChannelList — 频道列表
// ══════════════════════════════════════════════════════

export function ChannelList() {
  const { t } = useI18n();
  const channels = useStore((s) => s.channels);
  const currentChannel = useStore((s) => s.currentChannel);
  const agents = useStore((s) => s.agents);
  const userName = useStore((s) => s.userName);
  const userAvatarUrl = useStore((s) => s.userAvatarUrl);
  const currentAgentId = useStore((s) => s.currentAgentId);
  const openChannel = useStore((s) => s.openChannel);
  const [manageMembersChannel, setManageMembersChannel] = useState<Channel | null>(null);
  const openManageMembersModal = useCallback((channel: Channel) => {
    setManageMembersChannel(channel);
  }, []);
  const closeManageMembersModal = useCallback(() => {
    setManageMembersChannel(null);
  }, []);

  if (channels.length === 0) {
    return <div className="session-empty">{t('channel.empty')}</div>;
  }

  const dms = channels.filter((ch) => ch.isDM === true);
  const groups = channels.filter((ch) => !ch.isDM);

  return (
    <>
      {dms.length > 0 && (
        <>
          <div className="channel-section-label">
            <span>{t('channel.dmLabel')}</span>
            <span className="channel-section-hint">{t('channel.dmHint')}</span>
          </div>
          {dms.map((ch) => (
            <ChannelItem
              key={ch.id}
              channel={ch}
              isDM
              isActive={ch.id === currentChannel}
              agents={agents}
              userName={userName}
              userAvatarUrl={userAvatarUrl}
              currentAgentId={currentAgentId}
              onOpen={openChannel}
              onManageMembers={openManageMembersModal}
            />
          ))}
        </>
      )}
      {groups.length > 0 && (
        <>
          <div className="channel-section-label">{t('channel.groupLabel')}</div>
          {groups.map((ch) => (
            <ChannelItem
              key={ch.id}
              channel={ch}
              isDM={false}
              isActive={ch.id === currentChannel}
              agents={agents}
              userName={userName}
              userAvatarUrl={userAvatarUrl}
              currentAgentId={currentAgentId}
              onOpen={openChannel}
              onManageMembers={openManageMembersModal}
            />
          ))}
        </>
      )}
      <ChannelManageMembersModal
        channel={manageMembersChannel}
        onClose={closeManageMembersModal}
      />
    </>
  );
}

// ── ChannelItem ──

interface ChannelItemProps {
  channel: Channel;
  isDM: boolean;
  isActive: boolean;
  agents: Agent[];
  userName: string;
  userAvatarUrl: string | null;
  currentAgentId: string | null;
  onOpen: (id: string, isDM?: boolean) => void;
  onManageMembers: (channel: Channel) => void;
}

function ChannelItem({
  channel,
  isDM,
  isActive,
  agents,
  userName,
  userAvatarUrl,
  currentAgentId,
  onOpen,
  onManageMembers,
}: ChannelItemProps) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [avatarError, setAvatarError] = useState(false);
  const addToast = useStore((s) => s.addToast);
  const loadChannels = useStore((s) => s.loadChannels);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const t = window.t ?? ((k: string) => k);

  const handleClick = useCallback(() => {
    onOpen(channel.id, channel.isDM);
  }, [onOpen, channel.id, channel.isDM]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (isDM) return;
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, [isDM]);

  const handleCloseCtxMenu = useCallback(() => {
    setCtxMenu(null);
  }, []);

  const uploadGroupAvatar = useCallback(async (file: File) => {
    if (!file) return;
    const type = String(file.type || "").toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp"].includes(type)) {
      addToast(t('error.unsupportedImageFormat', { mime: type || 'unknown' }), 'error', 2500);
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('read file failed'));
      reader.readAsDataURL(file);
    });

    const res = await hanaFetch(`/api/channels/${encodeURIComponent(channel.id)}/avatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: dataUrl }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    setAvatarError(false);
    refreshAvatarTs();
    await loadChannels();
    addToast(t('settings.saved'), 'success', 1800);
  }, [addToast, channel.id, loadChannels, t]);

  const onGroupIconClick = useCallback((e: React.MouseEvent) => {
    if (isDM) return;
    e.stopPropagation();
    fileInputRef.current?.click();
  }, [isDM]);

  const onGroupIconFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    try {
      await uploadGroupAvatar(file);
    } catch (err: any) {
      addToast(err?.message || t('settings.saveFailed'), 'error', 2500);
    }
  }, [addToast, t, uploadGroupAvatar]);

  const selfInfo = resolveChannelMember(currentAgentId || '', userName, userAvatarUrl, agents, currentAgentId);
  const groupAvatarUrl = !isDM ? hanaUrl(`/api/channels/${encodeURIComponent(channel.id)}/avatar?t=${_avatarTs}`) : null;

  const ctxMenuItems: ContextMenuItem[] = ctxMenu ? [
    {
      label: (window as any).t('channel.manageMembers'),
      action: () => onManageMembers(channel),
    },
    { divider: true },
    {
      label: (window as any).t('channel.deleteChannel'),
      danger: true,
      action: () => confirmDeleteChannel(channel.id),
    },
  ] : [];

  return (
    <div
      className={`channel-item${isActive ? ' active' : ''}`}
      data-channel={channel.id}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {isDM ? (
        <DmIcon channel={channel} selfInfo={selfInfo} agents={agents} userName={userName} userAvatarUrl={userAvatarUrl} currentAgentId={currentAgentId} />
      ) : (
        <>
          <button className="channel-item-icon channel-item-icon-btn" onClick={onGroupIconClick} title={t('settings.me.changeAvatar')}>
            {groupAvatarUrl && !avatarError ? (
              <img
                className="channel-item-icon-img"
                src={groupAvatarUrl}
                alt={channel.name || channel.id}
                onError={() => setAvatarError(true)}
              />
            ) : (
              <span>{(channel.name || channel.id || '?').charAt(0).toUpperCase()}</span>
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            style={{ display: 'none' }}
            onChange={onGroupIconFileChange}
          />
        </>
      )}
      <div className="channel-item-body">
        <div className="channel-item-name">
          {isDM
            ? `${selfInfo.displayName} \u00B7 ${channel.peerName || channel.name}`
            : (channel.name || channel.id)
          }
        </div>
        <div className="channel-item-preview">
          {channel.lastMessage && (() => {
            const senderNorm = String(channel.lastSender || '').trim().toLowerCase();
            const memberKeys = new Set((channel.members || []).map((m) => String(m || '').trim().toLowerCase()).filter(Boolean));
            const isGroupUserFallback = !isDM && senderNorm !== 'system' && !memberKeys.has(senderNorm);
            const senderInfo = isGroupUserFallback
              ? resolveChannelMember(userName || 'user', userName, userAvatarUrl, agents, currentAgentId)
              : resolveChannelMember(channel.lastSender, userName, userAvatarUrl, agents, currentAgentId);
            return `${senderInfo.displayName}: ${channel.lastMessage}`;
          })()}
        </div>
      </div>
      <div className="channel-item-meta">
        {channel.lastTimestamp && (
          <div className="channel-item-time">{formatChannelTime(channel.lastTimestamp)}</div>
        )}
        {(channel.newMessageCount || 0) > 0 && (
          <div className="channel-unread-badge">
            {channel.newMessageCount > 99 ? '99+' : String(channel.newMessageCount)}
          </div>
        )}
      </div>
      {ctxMenu && (
        <ContextMenu items={ctxMenuItems} position={ctxMenu} onClose={handleCloseCtxMenu} />
      )}
    </div>
  );
}

// ── DM Icon (dual avatar) ──

function DmIcon({ channel, selfInfo, agents, userName, userAvatarUrl, currentAgentId }: {
  channel: Channel;
  selfInfo: MemberInfo;
  agents: Agent[];
  userName: string;
  userAvatarUrl: string | null;
  currentAgentId: string | null;
}) {
  const peerId = channel.peerId || channel.members?.[0] || '';
  const peerInfo = resolveChannelMember(peerId, userName, userAvatarUrl, agents, currentAgentId);

  return (
    <div className="channel-dm-icon">
      <div className="channel-dm-avatar">
        <MemberAvatar info={selfInfo} />
      </div>
      <div className="channel-dm-link">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      </div>
      <div className="channel-dm-avatar">
        <MemberAvatar info={peerInfo} />
      </div>
    </div>
  );
}

function ChannelManageMembersModal({ channel, onClose }: {
  channel: Channel | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const agents = useStore((s) => s.agents);
  const loadChannels = useStore((s) => s.loadChannels);
  const openChannel = useStore((s) => s.openChannel);
  const currentChannel = useStore((s) => s.currentChannel);
  const addToast = useStore((s) => s.addToast);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [membersError, setMembersError] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!channel) return;
    setSelectedMembers(Array.isArray(channel.members) ? channel.members : []);
    setMembersError(false);

    let cancelled = false;
    (async () => {
      try {
        const res = await hanaFetch(`/api/channels/${encodeURIComponent(channel.id)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const latestMembers = Array.isArray(data.members) ? data.members : [];
        setSelectedMembers(latestMembers);
      } catch {}
    })();

    return () => { cancelled = true; };
  }, [channel]);

  useEffect(() => {
    if (!channel) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [channel, onClose, saving]);

  const toggleMember = useCallback((agentId: string) => {
    setSelectedMembers((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId],
    );
    setMembersError(false);
  }, []);

  const handleSave = useCallback(async () => {
    if (!channel || saving) return;
    const members = [...new Set(
      selectedMembers
        .map((id) => String(id || '').trim())
        .filter(Boolean),
    )];
    if (members.length < 1) {
      setMembersError(true);
      setTimeout(() => setMembersError(false), 1200);
      return;
    }

    setSaving(true);
    try {
      const res = await hanaFetch(`/api/channels/${encodeURIComponent(channel.id)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ members }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      await loadChannels();
      if (currentChannel === channel.id) {
        await openChannel(channel.id, false);
      }
      onClose();
      addToast(t('settings.saved'), 'success', 1800);
    } catch (err: any) {
      addToast(`${t('settings.saveFailed')}: ${err?.message || String(err || '')}`, 'error', 2500);
    } finally {
      setSaving(false);
    }
  }, [addToast, channel, currentChannel, loadChannels, onClose, openChannel, saving, selectedMembers, t]);

  if (!channel) return null;

  return (
    <div
      className="agent-create-overlay visible"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="agent-create-card channel-manage-members-card">
        <h3 className="agent-create-title">{t('channel.manageMembersTitle')}</h3>
        <div className="channel-manage-members-meta">
          <span className="channel-manage-members-name">{channel.name || channel.id}</span>
          <span className="channel-manage-members-count">{`${selectedMembers.length}${t('channel.membersCount')}`}</span>
        </div>

        <div className="settings-field">
          <label className="settings-field-label">{t('channel.createMembers')}</label>
          <div
            className="channel-create-members channel-manage-members-list"
            style={membersError ? { outline: '1.5px solid var(--danger, #c44)' } : undefined}
          >
            {agents.map((agent) => {
              const isSelected = selectedMembers.includes(agent.id);
              return (
                <button
                  key={agent.id}
                  type="button"
                  className={`channel-create-member-chip${isSelected ? ' selected' : ''}`}
                  onClick={() => toggleMember(agent.id)}
                  disabled={saving}
                >
                  <AgentChipAvatar
                    agentId={agent.id}
                    agentName={agent.name}
                    agentYuan={agent.yuan}
                    hasAvatar={agent.hasAvatar}
                  />
                  <span>{agent.name || agent.id}</span>
                </button>
              );
            })}
          </div>
          <div className="channel-manage-members-hint">
            {membersError ? t('channel.manageMembersMinOne') : t('channel.manageMembersHint')}
          </div>
        </div>

        <div className="agent-create-actions">
          <button className="agent-create-cancel" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </button>
          <button className="agent-create-confirm" onClick={() => { void handleSave(); }} disabled={saving}>
            {saving ? '...' : t('settings.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChannelWelcomeChip({
  channel,
  isSelected,
  onOpen,
}: {
  channel: Channel;
  isSelected: boolean;
  onOpen: (channel: Channel) => void;
}) {
  const [avatarError, setAvatarError] = useState(false);

  useEffect(() => {
    setAvatarError(false);
  }, [channel.id]);

  const avatarUrl = hanaUrl(`/api/channels/${encodeURIComponent(channel.id)}/avatar?t=${_avatarTs}`);
  const displayName = channel.name || channel.id || '?';

  return (
    <button
      className={'welcome-agent-chip' + (isSelected ? ' selected' : '')}
      onClick={() => onOpen(channel)}
      title={displayName}
    >
      {!avatarError ? (
        <img
          className="welcome-agent-chip-avatar"
          src={avatarUrl}
          alt={displayName}
          draggable={false}
          onError={() => setAvatarError(true)}
        />
      ) : (
        <span className="channel-welcome-chip-avatar-fallback">
          {displayName.charAt(0).toUpperCase()}
        </span>
      )}
      <span>{displayName}</span>
    </button>
  );
}

function ChannelWelcomeGroups() {
  const { t } = useI18n();
  const channels = useStore((s) => s.channels);
  const selectedGroupId = useStore((s) => s.channelWelcomeSelectedId);
  const setChannelWelcomeSelectedId = useStore((s) => s.setChannelWelcomeSelectedId);
  const loadChannelPreview = useStore((s) => s.loadChannelPreview);
  const openChannel = useStore((s) => s.openChannel);
  const [heroAvatarError, setHeroAvatarError] = useState(false);

  const groups = channels.filter((ch) => !ch.isDM);

  useEffect(() => {
    if (groups.length === 0) {
      if (selectedGroupId !== null) setChannelWelcomeSelectedId(null);
      return;
    }
    const exists = selectedGroupId && groups.some((ch) => ch.id === selectedGroupId);
    if (!exists) setChannelWelcomeSelectedId(groups[0].id);
  }, [groups, selectedGroupId, setChannelWelcomeSelectedId]);

  const selectedGroup = groups.find((ch) => ch.id === selectedGroupId) || groups[0] || null;
  const selectedGroupKey = selectedGroup?.id || '';

  useEffect(() => {
    setHeroAvatarError(false);
  }, [selectedGroupKey]);

  useEffect(() => {
    if (!selectedGroupKey) return;
    void loadChannelPreview(selectedGroupKey);
  }, [loadChannelPreview, selectedGroupKey]);

  const handleOpenGroup = useCallback((channel: Channel) => {
    setChannelWelcomeSelectedId(channel.id);
    void openChannel(channel.id, false);
  }, [openChannel, setChannelWelcomeSelectedId]);

  if (!selectedGroup) {
    return <div className="channel-welcome">{t('channel.empty')}</div>;
  }

  const selectedDisplayName = selectedGroup.name || selectedGroup.id || '?';
  const heroAvatarUrl = hanaUrl(`/api/channels/${encodeURIComponent(selectedGroup.id)}/avatar?t=${_avatarTs}`);

  return (
    <div className="welcome channel-welcome-home">
      {!heroAvatarError ? (
        <img
          className="welcome-avatar"
          src={heroAvatarUrl}
          alt={selectedDisplayName}
          draggable={false}
          onError={() => setHeroAvatarError(true)}
        />
      ) : (
        <div className="channel-welcome-hero-avatar-fallback">
          {selectedDisplayName.charAt(0).toUpperCase()}
        </div>
      )}
      <p className="welcome-text channel-welcome-home-text">{t('channel.welcomeTitle')}</p>
      <div className="welcome-agent-selector channel-welcome-chip-list">
        {groups.map((ch) => (
          <ChannelWelcomeChip
            key={ch.id}
            channel={ch}
            isSelected={ch.id === selectedGroup.id}
            onOpen={handleOpenGroup}
          />
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// ChannelMessages — 消息列表
// ══════════════════════════════════════════════════════

export function ChannelMessages() {
  const { t } = useI18n();
  const messages = useStore((s) => s.channelMessages);
  const currentChannel = useStore((s) => s.currentChannel);
  const channels = useStore((s) => s.channels);
  const channelMembers = useStore((s) => s.channelMembers);
  const agents = useStore((s) => s.agents);
  const userName = useStore((s) => s.userName);
  const userAvatarUrl = useStore((s) => s.userAvatarUrl);
  const currentAgentId = useStore((s) => s.currentAgentId);
  const contentRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMessagesLenRef = useRef(0);
  const forceStickRef = useRef(false);

  const checkAtBottom = useCallback(() => {
    const el = document.getElementById('channelMessages');
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = document.getElementById('channelMessages');
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // 监听用户滚动，维护“是否贴底”状态
  useEffect(() => {
    const el = document.getElementById('channelMessages');
    if (!el) return;
    const onScroll = () => checkAtBottom();
    el.addEventListener('scroll', onScroll, { passive: true });
    checkAtBottom();
    return () => el.removeEventListener('scroll', onScroll);
  }, [checkAtBottom]);

  // 切换频道时，下一次渲染强制贴底
  useEffect(() => {
    if (!currentChannel) return;
    forceStickRef.current = true;
    isAtBottomRef.current = true;
    prevMessagesLenRef.current = 0;
  }, [currentChannel]);

  // 新消息到达时：仅在用户原本贴底时继续自动跟随
  useEffect(() => {
    const messageAppended = messages.length > prevMessagesLenRef.current;
    if (forceStickRef.current || (messageAppended && isAtBottomRef.current)) {
      requestAnimationFrame(() => {
        scrollToBottom();
        requestAnimationFrame(scrollToBottom);
      });
      forceStickRef.current = false;
    }
    prevMessagesLenRef.current = messages.length;
  }, [currentChannel, messages.length, scrollToBottom]);

  // 内容高度持续变化（长消息渲染、图片加载）时保持贴底
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (!isAtBottomRef.current) return;
      scrollToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  if (!currentChannel) {
    return <ChannelWelcomeGroups />;
  }

  if (messages.length === 0) {
    return <div className="channel-welcome">{t('channel.noMessages')}</div>;
  }

  const ch = channels.find((c) => c.id === currentChannel);
  const isDM = ch?.isDM ?? false;
  const channelMemberKeys = new Set((channelMembers || []).map((m) => String(m || '').trim().toLowerCase()).filter(Boolean));
  let lastSender: string | null = null;

  return (
    <div ref={contentRef} className="channel-messages-content">
      {messages.map((msg, idx) => {
        if (msg.isContextReset) {
          lastSender = null;
          return (
            <div key={`${msg.timestamp}-${idx}`} className="channel-context-divider">
              <span>{t('channel.newConversationDivider')}</span>
            </div>
          );
        }

        const isContinuation = msg.sender === lastSender;
        const senderNorm = String(msg.sender || '').trim().toLowerCase();
        const userNameNorm = String(userName || '').trim().toLowerCase();
        const isMemberSender = !isDM && channelMemberKeys.has(senderNorm);
        const isGroupUserFallback = !isDM && senderNorm !== 'system' && !isMemberSender;
        const senderInfo = isGroupUserFallback
          ? resolveChannelMember(userName || 'user', userName, userAvatarUrl, agents, currentAgentId)
          : resolveChannelMember(msg.sender, userName, userAvatarUrl, agents, currentAgentId);
        const isUserSenderAlias =
          senderNorm === 'user'
          || senderNorm === '用户'
          || (!!userNameNorm && senderNorm === userNameNorm);
        const isSelf = senderInfo.isUser || isUserSenderAlias || isGroupUserFallback || (isDM && msg.sender === (currentAgentId || ''));
        const el = (
          <div
            key={`${msg.timestamp}-${idx}`}
            className={
              'channel-msg'
              + (isContinuation ? ' channel-msg-continuation' : '')
              + (isSelf ? ' channel-msg-self' : '')
            }
          >
            <div className="channel-msg-avatar">
              <MemberAvatar info={senderInfo} className="channel-msg-avatar-img" />
            </div>
            <div className="channel-msg-body">
              {!isContinuation && (
                <div className="channel-msg-header">
                  <span className="channel-msg-sender">{senderInfo.displayName}</span>
                  <span className="channel-msg-time">{formatChannelTime(msg.timestamp)}</span>
                </div>
              )}
              <div
                className="channel-msg-text md-content"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.body || '') }}
              />
            </div>
          </div>
        );
        lastSender = msg.sender;
        return el;
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════
// ChannelMembers — 右侧面板成员列表
// ══════════════════════════════════════════════════════

export function ChannelMembers() {
  const currentChannel = useStore((s) => s.currentChannel);
  const previewChannelId = useStore((s) => s.channelWelcomeSelectedId);
  const previewMembers = useStore((s) => s.channelPreviewMembers);
  const channelMembers = useStore((s) => s.channelMembers);
  const channelAgentActivity = useStore((s) => s.channelAgentActivity);
  const isDM = useStore((s) => s.channelIsDM);
  const agents = useStore((s) => s.agents);
  const userName = useStore((s) => s.userName);
  const userAvatarUrl = useStore((s) => s.userAvatarUrl);
  const currentAgentId = useStore((s) => s.currentAgentId);

  const effectiveChannelId = currentChannel || previewChannelId;
  if (!effectiveChannelId) return null;

  if (currentChannel && isDM) {
    // DM: show peer and self info cards
    const peerId = channelMembers[0] || '';
    const peerInfo = resolveChannelMember(peerId, userName, userAvatarUrl, agents, currentAgentId);
    const selfInfo = resolveChannelMember(currentAgentId || '', userName, userAvatarUrl, agents, currentAgentId);

    return (
      <>
        {[peerInfo, selfInfo].map((info) => (
          <div key={info.id} className="channel-member-item">
            {(info.avatarUrl || info.fallbackAvatar) ? (
              <MemberAvatar info={info} className="channel-member-avatar-img" />
            ) : (
              <div className="channel-member-avatar">
                {(info.displayName || '?').charAt(0).toUpperCase()}
              </div>
            )}
            <div className="channel-member-name">{info.displayName}</div>
            {!info.isUser && (
              <span className={`channel-member-status-dot${channelAgentActivity?.[effectiveChannelId]?.[info.id] ? ' active' : ''}`} />
            )}
          </div>
        ))}
      </>
    );
  }

  // Group channel: show all members (user + agents)
  const groupMembers = currentChannel ? channelMembers : previewMembers;
  const displayMembers = [userName || 'user', ...groupMembers];
  return (
    <>
      {displayMembers.map((m) => {
        const info = resolveChannelMember(m, userName, userAvatarUrl, agents, currentAgentId);
        return (
          <div key={info.id + m} className="channel-member-item">
            {(info.avatarUrl || info.fallbackAvatar) ? (
              <MemberAvatar info={info} className="channel-member-avatar-img" />
            ) : (
              <div className="channel-member-avatar">
                {(info.displayName || '?').charAt(0).toUpperCase()}
              </div>
            )}
            <div className="channel-member-name">{info.displayName}</div>
            {currentChannel && !info.isUser && (
              <span className={`channel-member-status-dot${channelAgentActivity?.[effectiveChannelId]?.[info.id] ? ' active' : ''}`} />
            )}
          </div>
        );
      })}
    </>
  );
}

// ══════════════════════════════════════════════════════
// ChannelInput — 输入区域 + @mention
// ══════════════════════════════════════════════════════

export function ChannelInput() {
  const { t } = useI18n();
  const currentChannel = useStore((s) => s.currentChannel);
  const isDM = useStore((s) => s.channelIsDM);
  const channelMembers = useStore((s) => s.channelMembers);
  const agents = useStore((s) => s.agents);
  const userName = useStore((s) => s.userName);
  const userAvatarUrl = useStore((s) => s.userAvatarUrl);
  const currentAgentId = useStore((s) => s.currentAgentId);
  const sendChannelMessage = useStore((s) => s.sendChannelMessage);
  const resetChannelContext = useStore((s) => s.resetChannelContext);
  const clearChannelMessages = useStore((s) => s.clearChannelMessages);
  const stopChannelReplies = useStore((s) => s.stopChannelReplies);
  const attachedFiles = useStore((s) => s.attachedFiles);
  const removeAttachedFile = useStore((s) => s.removeAttachedFile);
  const clearAttachedFiles = useStore((s) => s.clearAttachedFiles);
  const addToast = useStore((s) => s.addToast);

  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const [mentionActive, setMentionActive] = useState(false);
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState(-1);
  const [commandActive, setCommandActive] = useState(false);
  const [commandItems, setCommandItems] = useState<CommandItem[]>([]);
  const [commandSelectedIdx, setCommandSelectedIdx] = useState(0);
  const [commandStartPos, setCommandStartPos] = useState(-1);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resizeTextarea = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;

    const cs = window.getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 20;
    const paddingTop = parseFloat(cs.paddingTop) || 0;
    const paddingBottom = parseFloat(cs.paddingBottom) || 0;
    const borderTop = parseFloat(cs.borderTopWidth) || 0;
    const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
    const chrome = paddingTop + paddingBottom + borderTop + borderBottom;
    const minHeight = Math.ceil(lineHeight + chrome);
    const maxHeight = Math.ceil(lineHeight * 5 + chrome);

    el.style.height = 'auto';
    const nextHeight = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  // Show/hide the input area based on DM state
  useEffect(() => {
    const inputArea = document.getElementById('channelInputArea');
    const readonlyNotice = document.getElementById('channelReadonlyNotice');
    if (!currentChannel) {
      inputArea?.classList.add('hidden');
      readonlyNotice?.classList.add('hidden');
      return;
    }
    if (isDM) {
      inputArea?.classList.add('hidden');
      readonlyNotice?.classList.remove('hidden');
    } else {
      inputArea?.classList.remove('hidden');
      readonlyNotice?.classList.add('hidden');
    }
  }, [currentChannel, isDM]);

  // 切换频道时重置输入态
  useEffect(() => {
    setInputValue('');
    setMentionActive(false);
    setCommandActive(false);
    clearAttachedFiles();
  }, [currentChannel, clearAttachedFiles]);

  // 输入框自适应高度：最多展示 5 行，超出后内部滚动
  useEffect(() => {
    resizeTextarea();
  }, [inputValue, currentChannel, resizeTextarea]);

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    const safeAttachedFiles = attachedFiles.filter((f) => !isHttpUrlPath(f.path));
    const hasFiles = safeAttachedFiles.length > 0;
    if (sending || (!text && !hasFiles)) return;

    const cmd = text.split(/\s+/)[0]?.toLowerCase();
    if (cmd === '/new') {
      setSending(true);
      try {
        await resetChannelContext();
        setInputValue('');
        setMentionActive(false);
        setCommandActive(false);
        clearAttachedFiles();
      } catch (err) {
        console.error('[channels] /new failed:', err);
        addToast(t('channel.resetContextFailed'), 'error', 3000);
      } finally {
        setSending(false);
      }
      return;
    }

    if (cmd === '/clear') {
      setSending(true);
      try {
        await clearChannelMessages();
        setInputValue('');
        setMentionActive(false);
        setCommandActive(false);
        clearAttachedFiles();
      } catch (err) {
        console.error('[channels] /clear failed:', err);
        addToast(t('channel.resetFailed'), 'error', 3000);
      } finally {
        setSending(false);
      }
      return;
    }

    if (cmd === '/stop') {
      setSending(true);
      try {
        await stopChannelReplies();
        setInputValue('');
        setMentionActive(false);
        setCommandActive(false);
        clearAttachedFiles();
      } catch (err) {
        console.error('[channels] /stop failed:', err);
        addToast(t('channel.stopFailed'), 'error', 3000);
      } finally {
        setSending(false);
      }
      return;
    }

    let finalText = text;
    if (hasFiles) {
      const fileBlock = safeAttachedFiles
        .map((f) => f.isDirectory ? `[目录] ${f.path}` : `[附件] ${f.path}`)
        .join('\n');
      finalText = text ? `${text}\n\n${fileBlock}` : fileBlock;
    }

    setSending(true);
    try {
      await sendChannelMessage(finalText);
      setInputValue('');
      clearAttachedFiles();
      setMentionActive(false);
      setCommandActive(false);
    } finally {
      setSending(false);
    }
  }, [sending, inputValue, attachedFiles, sendChannelMessage, clearAttachedFiles, resetChannelContext, clearChannelMessages, stopChannelReplies, addToast, t]);

  const checkMention = useCallback(() => {
    if (!inputRef.current) return;
    const val = inputRef.current.value;
    const cursorPos = inputRef.current.selectionStart ?? 0;
    const textBeforeCursor = val.slice(0, cursorPos);

    const atIdx = textBeforeCursor.lastIndexOf('@');
    if (atIdx < 0 || (atIdx > 0 && /\S/.test(textBeforeCursor[atIdx - 1]))) {
      setMentionActive(false);
      return;
    }

    const keyword = textBeforeCursor.slice(atIdx + 1).toLowerCase();
    setMentionStartPos(atIdx);

    const members = (channelMembers || [])
      .map((id) => resolveChannelMember(id, userName, userAvatarUrl, agents, currentAgentId))
      .filter((m) => !m.isUser);

    const mentionAllLabel = (window as any).t?.('channel.mentionAll') || '全体成员';
    const mentionItemsAll: MentionItem[] = [
      {
        id: '__all_members__',
        displayName: mentionAllLabel,
        mentionText: mentionAllLabel,
        avatar: null,
        searchTokens: [mentionAllLabel, '全体成员', '所有人', 'all', 'all members', 'everyone'],
      },
      ...members.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        mentionText: m.displayName,
        avatar: m,
        searchTokens: [m.displayName, m.id, m.yuan || ''],
      })),
    ];

    const filtered = keyword
      ? mentionItemsAll.filter((m) =>
          m.searchTokens.some((token) => String(token || '').toLowerCase().includes(keyword)),
        )
      : mentionItemsAll;

    if (filtered.length === 0) {
      setMentionActive(false);
      return;
    }

    setMentionItems(filtered);
    setMentionSelectedIdx(0);
    setMentionActive(true);
    setCommandActive(false);
  }, [channelMembers, agents, userName, userAvatarUrl, currentAgentId]);

  const checkCommand = useCallback(() => {
    if (!inputRef.current) return;
    const val = inputRef.current.value;
    const cursorPos = inputRef.current.selectionStart ?? 0;
    const textBeforeCursor = val.slice(0, cursorPos);

    const slashIdx = textBeforeCursor.lastIndexOf('/');
    if (slashIdx < 0 || (slashIdx > 0 && /\S/.test(textBeforeCursor[slashIdx - 1]))) {
      setCommandActive(false);
      return;
    }

    const keywordRaw = textBeforeCursor.slice(slashIdx + 1);
    if (/\s/.test(keywordRaw)) {
      setCommandActive(false);
      return;
    }

    setCommandStartPos(slashIdx);
    const keyword = keywordRaw.toLowerCase();
    const allCommands: CommandItem[] = [
      {
        id: 'new',
        label: '/new',
        desc: t('channel.commandNewDesc'),
      },
      {
        id: 'clear',
        label: '/clear',
        desc: t('channel.commandClearDesc'),
      },
      {
        id: 'stop',
        label: '/stop',
        desc: t('channel.commandStopDesc'),
      },
    ];
    const filtered = keyword
      ? allCommands.filter((c) => c.label.slice(1).toLowerCase().includes(keyword))
      : allCommands;

    if (filtered.length === 0) {
      setCommandActive(false);
      return;
    }

    setCommandItems(filtered);
    setCommandSelectedIdx(0);
    setCommandActive(true);
    setMentionActive(false);
  }, [t]);

  const insertMention = useCallback((mentionText: string) => {
    if (!inputRef.current || mentionStartPos < 0) return;
    const val = inputRef.current.value;
    const cursorPos = inputRef.current.selectionStart ?? 0;
    const before = val.slice(0, mentionStartPos);
    const after = val.slice(cursorPos);
    const inserted = `@${mentionText} `;
    const newVal = before + inserted + after;
    setInputValue(newVal);
    setMentionActive(false);

    requestAnimationFrame(() => {
      if (inputRef.current) {
        const newCursor = before.length + inserted.length;
        inputRef.current.setSelectionRange(newCursor, newCursor);
        inputRef.current.focus();
      }
    });
  }, [mentionStartPos]);

  const insertCommand = useCallback((label: string) => {
    if (!inputRef.current || commandStartPos < 0) return;
    const val = inputRef.current.value;
    const cursorPos = inputRef.current.selectionStart ?? 0;
    const before = val.slice(0, commandStartPos);
    const after = val.slice(cursorPos);
    const inserted = `${label} `;
    const newVal = before + inserted + after;
    setInputValue(newVal);
    setCommandActive(false);

    requestAnimationFrame(() => {
      if (inputRef.current) {
        const newCursor = before.length + inserted.length;
        inputRef.current.setSelectionRange(newCursor, newCursor);
        inputRef.current.focus();
      }
    });
  }, [commandStartPos]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
      if (mentionActive) {
        e.preventDefault();
        const selected = mentionItems[mentionSelectedIdx];
        if (selected) insertMention(selected.mentionText);
        return;
      }
      if (commandActive) {
        e.preventDefault();
        const selected = commandItems[commandSelectedIdx];
        if (selected) insertCommand(selected.label);
        return;
      }
      e.preventDefault();
      handleSend();
      return;
    }
    if (mentionActive) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionSelectedIdx((i) => (i + 1) % mentionItems.length); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionSelectedIdx((i) => (i - 1 + mentionItems.length) % mentionItems.length); }
      if (e.key === 'Escape') { e.preventDefault(); setMentionActive(false); }
    }
    if (commandActive) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCommandSelectedIdx((i) => (i + 1) % commandItems.length); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCommandSelectedIdx((i) => (i - 1 + commandItems.length) % commandItems.length); }
      if (e.key === 'Escape') { e.preventDefault(); setCommandActive(false); }
    }
  }, [mentionActive, mentionItems, mentionSelectedIdx, insertMention, commandActive, commandItems, commandSelectedIdx, insertCommand, handleSend]);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
    // Defer checks to after state update
    requestAnimationFrame(() => {
      checkMention();
      checkCommand();
    });
  }, [checkMention, checkCommand]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const plainText = e.clipboardData?.getData('text/plain') ?? '';
    if (!plainText) return;

    // Copying from channel message markdown blocks may carry extra trailing blank lines.
    const htmlText = e.clipboardData?.getData('text/html') ?? '';
    const fromChannelMessage = htmlText.includes('channel-msg-text');
    if (!fromChannelMessage) return;

    const normalized = plainText
      .replace(/\r\n?/g, '\n')
      .replace(/\n{2,}$/g, '');

    if (normalized === plainText) return;

    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    const next = inputValue.slice(0, start) + normalized + inputValue.slice(end);
    setInputValue(next);

    requestAnimationFrame(() => {
      const cursor = start + normalized.length;
      el.setSelectionRange(cursor, cursor);
      checkMention();
      checkCommand();
    });
  }, [inputValue, checkMention, checkCommand]);

  if (isDM || !currentChannel) return null;

  return (
    <div className="channel-input-wrapper">
      {mentionActive && mentionItems.length > 0 && (
        <div className="channel-mention-dropdown">
          {mentionItems.map((m, idx) => (
            <div
              key={m.id}
              className={`channel-mention-item${idx === mentionSelectedIdx ? ' active' : ''}`}
              data-name={m.displayName}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(m.mentionText);
              }}
            >
              <div className="channel-mention-avatar">
                {m.avatar ? <MemberAvatar info={m.avatar} /> : <span>@</span>}
              </div>
              <span>{m.displayName}</span>
            </div>
          ))}
        </div>
      )}
      {commandActive && commandItems.length > 0 && (
        <div className="channel-mention-dropdown channel-command-dropdown">
          {commandItems.map((cmd, idx) => (
            <div
              key={cmd.id}
              className={`channel-mention-item${idx === commandSelectedIdx ? ' active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertCommand(cmd.label);
              }}
            >
              <span className="channel-command-item-main">{cmd.label}</span>
              <span className="channel-command-item-desc">{cmd.desc}</span>
            </div>
          ))}
        </div>
      )}
      {attachedFiles.length > 0 && (
        <AttachedFilesBar
          files={attachedFiles}
          onRemove={removeAttachedFile}
          className="channel-attached-files"
        />
      )}
      <textarea
        ref={inputRef}
        className="channel-input-box"
        placeholder={(window as any).t?.('channel.inputPlaceholder') || 'Send a message...'}
        rows={1}
        spellCheck={false}
        value={inputValue}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      />
      <button
        className="channel-send-btn"
        disabled={(!inputValue.trim() && attachedFiles.length === 0) || sending}
        onClick={handleSend}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      </button>
    </div>
  );
}

function AttachedFilesBar({ files, onRemove, className }: {
  files: Array<{ path: string; name: string; isDirectory?: boolean }>;
  onRemove: (index: number) => void;
  className?: string;
}) {
  return (
    <div className={className ? `attached-files ${className}` : 'attached-files'}>
      {files.map((f, i) => (
        <span key={`${f.path}-${i}`} className="file-tag">
          <span className="file-tag-name">
            <span
              className="file-tag-icon"
              dangerouslySetInnerHTML={{ __html: f.isDirectory ? SVG_ICONS?.folder : SVG_ICONS?.clip }}
            />
            {f.name}
          </span>
          <button className="file-tag-remove" onClick={() => onRemove(i)}>✕</button>
        </span>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════
// ChannelReadonly
// ══════════════════════════════════════════════════════

export function ChannelReadonly() {
  const isDM = useStore((s) => s.channelIsDM);
  const currentChannel = useStore((s) => s.currentChannel);

  if (!isDM || !currentChannel) return null;

  return (
    <span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle', marginRight: 4 }}>
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
      {(window as any).t?.('channel.readOnly') || '这是 Agent 之间的私信，仅可查看'}
    </span>
  );
}

// ══════════════════════════════════════════════════════
// ChannelCreate — 新建频道弹窗
// ══════════════════════════════════════════════════════

export function ChannelCreate() {
  const { t } = useI18n();
  const agents = useStore((s) => s.agents);
  const createChannel = useStore((s) => s.createChannel);

  const [name, setName] = useState('');
  const [intro, setIntro] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [nameError, setNameError] = useState(false);
  const [membersError, setMembersError] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // When modal becomes visible, reset form and select all agents
  useEffect(() => {
    const overlay = document.getElementById('channelCreateOverlay');
    if (!overlay) return;

    const observer = new MutationObserver(() => {
      if (overlay.classList.contains('visible')) {
        setName('');
        setIntro('');
        setSelectedMembers(agents.map((a) => a.id));
        setNameError(false);
        setMembersError(false);
        requestAnimationFrame(() => nameRef.current?.focus());
      }
    });

    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [agents]);

  // Show/hide overlay via channelCreateBtn
  useEffect(() => {
    const createBtn = document.getElementById('channelCreateBtn');
    const overlay = document.getElementById('channelCreateOverlay');

    const handleCreate = () => {
      overlay?.classList.add('visible');
    };
    const handleOverlayClick = (e: Event) => {
      if (e.target === e.currentTarget) overlay?.classList.remove('visible');
    };

    createBtn?.addEventListener('click', handleCreate);
    overlay?.addEventListener('click', handleOverlayClick);

    return () => {
      createBtn?.removeEventListener('click', handleCreate);
      overlay?.removeEventListener('click', handleOverlayClick);
    };
  }, []);

  const toggleMember = useCallback((agentId: string) => {
    setSelectedMembers((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId],
    );
    setMembersError(false);
  }, []);

  const handleCancel = useCallback(() => {
    document.getElementById('channelCreateOverlay')?.classList.remove('visible');
  }, []);

  const handleSubmit = useCallback(async () => {
    if (creating) return;
    if (!name.trim()) {
      nameRef.current?.focus();
      return;
    }
    if (selectedMembers.length < 2) {
      setMembersError(true);
      setTimeout(() => setMembersError(false), 1500);
      return;
    }

    setCreating(true);
    try {
      await createChannel(name.trim(), selectedMembers, intro.trim() || undefined);
      document.getElementById('channelCreateOverlay')?.classList.remove('visible');
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (msg.includes('已存在') || msg.includes('409')) {
        setNameError(true);
        nameRef.current?.focus();
        setTimeout(() => setNameError(false), 2000);
      }
    } finally {
      setCreating(false);
    }
  }, [creating, name, selectedMembers, intro, createChannel]);

  const handleNameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') handleCancel();
  }, [handleCancel]);

  return (
    <div className="agent-create-card">
      <h3 className="agent-create-title">{t('channel.createTitle')}</h3>
      <div className="settings-field">
        <label className="settings-field-label">{t('channel.createName')}</label>
        <input
          ref={nameRef}
          className="settings-input"
          type="text"
          placeholder={nameError ? t('channel.nameExists') : t('channel.createNamePlaceholder')}
          autoComplete="off"
          value={name}
          onChange={(e) => { setName(e.target.value); setNameError(false); }}
          onKeyDown={handleNameKeyDown}
          style={nameError ? { outline: '1.5px solid var(--danger, #c44)' } : undefined}
        />
      </div>
      <div className="settings-field">
        <label className="settings-field-label">{t('channel.createMembers')}</label>
        <div
          className="channel-create-members"
          style={membersError ? { outline: '1.5px solid var(--danger, #c44)' } : undefined}
        >
          {agents.map((agent) => {
            const isSelected = selectedMembers.includes(agent.id);
            return (
              <button
                key={agent.id}
                type="button"
                className={`channel-create-member-chip${isSelected ? ' selected' : ''}`}
                onClick={() => toggleMember(agent.id)}
              >
                <AgentChipAvatar
                  agentId={agent.id}
                  agentName={agent.name}
                  agentYuan={agent.yuan}
                  hasAvatar={agent.hasAvatar}
                />
                <span>{agent.name || agent.id}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="settings-field">
        <label className="settings-field-label">
          {t('channel.createIntro')}{' '}
          <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>
            {t('channel.createIntroOptional')}
          </span>
        </label>
        <textarea
          className="settings-input channel-create-intro"
          rows={2}
          placeholder={t('channel.createIntroPlaceholder')}
          style={{ resize: 'vertical', minHeight: '2.4rem' }}
          value={intro}
          onChange={(e) => setIntro(e.target.value)}
        />
      </div>
      <div className="agent-create-actions">
        <button className="agent-create-cancel" onClick={handleCancel}>
          {t('channel.createCancel')}
        </button>
        <button className="agent-create-confirm" onClick={handleSubmit} disabled={creating}>
          {t('channel.createConfirm')}
        </button>
      </div>
    </div>
  );
}

function AgentChipAvatar({ agentId, agentName, agentYuan, hasAvatar }: {
  agentId: string;
  agentName: string;
  agentYuan?: string;
  hasAvatar?: boolean;
}) {
  const [apiError, setApiError] = useState(false);
  const [fallbackError, setFallbackError] = useState(false);

  useEffect(() => {
    setApiError(false);
    setFallbackError(false);
  }, [agentId, hasAvatar, agentYuan]);

  const apiSrc = hasAvatar !== false ? hanaUrl(`/api/agents/${agentId}/avatar?t=${_avatarTs}`) : null;
  const fallbackSrc = yuanFallbackAvatar(agentYuan);

  return (
    <span className="chip-avatar">
      {apiSrc && !apiError ? (
        <img
          src={apiSrc}
          className="chip-avatar-img"
          onError={() => setApiError(true)}
        />
      ) : (fallbackSrc && !fallbackError) ? (
        <img
          src={fallbackSrc}
          className="chip-avatar-img"
          onError={() => setFallbackError(true)}
        />
      ) : (
        <>{(agentName || agentId).charAt(0).toUpperCase()}</>
      )}
    </span>
  );
}
