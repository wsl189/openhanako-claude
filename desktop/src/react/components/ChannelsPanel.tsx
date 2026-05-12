/**
 * ChannelsPanel — 频道系统 React 组件
 *
 * Phase 3 迁移：替代 channels-shim.ts (1159 行)。
 * 通过 portal 渲染到 index.html 中已有的 DOM 容器。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../stores';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { usePushToTalk } from '../hooks/use-push-to-talk';
import { renderMarkdown } from '../utils/markdown';
import { isHttpUrlPath } from '../utils/format';
import { parseUserAttachments } from '../utils/message-parser';
import { openFilePreviewWithOptions } from '../utils/file-preview';
import { toggleSidebar } from './SidebarLayout';
import { toggleJianSidebar } from '../stores/desk-actions';
import { ContextMenu } from './ContextMenu';
import type { ContextMenuItem } from './ContextMenu';
import type { Channel, Agent } from '../types';
import { yuanFallbackAvatar } from '../utils/agent-helpers';
import { SVG_ICONS } from '../utils/icons';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CHANNEL_MESSAGE_ANCHOR_RATIO = 0.65;
const CHANNEL_MENTION_MAX_MEMBERS = 8;
const CHANNEL_EDIT_MESSAGE_EVENT = 'hana:channel-edit-message';

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
  icon: string;
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
  const displayTime = parts[1].replace(/\.\d{1,3}$/, '');

  const today = new Date();
  const [y, mo, d] = parts[0].split('-').map(Number);
  const t = (window as any).t;

  if (y === today.getFullYear() && mo === today.getMonth() + 1 && d === today.getDate()) {
    return displayTime;
  }
  if (y === today.getFullYear() && mo === today.getMonth() + 1 && d === today.getDate() - 1) {
    return t('time.yesterday');
  }
  return `${mo}/${d}`;
}

const CHANNEL_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

type ChannelAttachmentItem = { path: string; name: string; isDirectory: boolean };

function channelAttachmentMime(att: ChannelAttachmentItem): string {
  const ext = (att.name.split('.').pop() || '').toLowerCase();
  return CHANNEL_MIME_BY_EXT[ext] || 'image/png';
}

const ChannelAttachmentFileCard = ({
  att,
  onOpenFile,
}: {
  att: ChannelAttachmentItem;
  onOpenFile?: (att: ChannelAttachmentItem) => void;
}) => {
  const ext = att.name.split('.').pop() || '';
  const canOpen = !!onOpenFile && !att.isDirectory && !!att.path && !isHttpUrlPath(att.path);
  const card = (
    <>
      <span className="attach-file-icon">
        {att.isDirectory ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        )}
      </span>
      <span className="attach-file-name">{att.name}</span>
      {ext && <span className="attach-file-ext">{ext}</span>}
    </>
  );

  if (canOpen) {
    return (
      <button type="button" className="attach-file attach-file-btn" onClick={() => onOpenFile(att)} title={att.path}>
        {card}
      </button>
    );
  }

  return (
    <div className="attach-file">
      {card}
    </div>
  );
};

const ChannelAttachmentImage = ({
  att,
  onPreviewImage,
  onOpenFile,
}: {
  att: ChannelAttachmentItem;
  onPreviewImage: (src: string, name: string) => void;
  onOpenFile: (att: ChannelAttachmentItem) => void;
}) => {
  const [src, setSrc] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setErrored(false);
    if (!att.path || isHttpUrlPath(att.path)) {
      setSrc(null);
      return;
    }
    const platform = (window as any).platform;
    if (!platform?.readFileBase64) {
      setSrc(null);
      return;
    }
    let cancelled = false;
    platform.readFileBase64(att.path)
      .then((base64: string | null) => {
        if (cancelled) return;
        if (!base64) {
          setSrc(null);
          return;
        }
        setSrc(`data:${channelAttachmentMime(att)};base64,${base64}`);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => { cancelled = true; };
  }, [att.path, att.name]);

  if (src && !errored) {
    return (
      <button
        type="button"
        className="attach-image attach-image-btn"
        onClick={() => onPreviewImage(src, att.name)}
        title={att.name}
      >
        <img
          src={src}
          alt={att.name}
          loading="lazy"
          onError={() => setErrored(true)}
        />
      </button>
    );
  }
  return <ChannelAttachmentFileCard att={att} onOpenFile={onOpenFile} />;
};

const ChannelAttachmentsView = ({
  attachments,
  onPreviewImage,
}: {
  attachments: ChannelAttachmentItem[];
  onPreviewImage: (src: string, name: string) => void;
}) => {
  const isImage = useCallback((att: ChannelAttachmentItem) => {
    return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(att.name);
  }, []);
  const openAttachmentFile = useCallback((att: ChannelAttachmentItem) => {
    if (!att.path || att.isDirectory || isHttpUrlPath(att.path)) return;
    const ext = (att.name.split('.').pop() || '').toLowerCase();
    void openFilePreviewWithOptions(att.path, att.name, ext, { replaceRightSidebar: true });
  }, []);

  if (!attachments.length) return null;
  return (
    <div className="user-attachments channel-msg-attachments">
      {attachments.map((att, i) => {
        if (isImage(att) && !att.isDirectory) {
          return <ChannelAttachmentImage key={`${att.path}-${i}`} att={att} onPreviewImage={onPreviewImage} onOpenFile={openAttachmentFile} />;
        }
        return <ChannelAttachmentFileCard key={`${att.path}-${i}`} att={att} onOpenFile={openAttachmentFile} />;
      })}
    </div>
  );
};

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

  const groups = channels.filter((ch) => !ch.isDM);
  if (groups.length === 0) {
    return <div className="session-empty">{t('channel.empty')}</div>;
  }

  return (
    <>
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
  const [selectedLeaders, setSelectedLeaders] = useState<string[]>([]);
  const [membersError, setMembersError] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!channel) return;
    setSelectedMembers(Array.isArray(channel.members) ? channel.members : []);
    setSelectedLeaders(Array.isArray(channel.leaders) ? channel.leaders : []);
    setMembersError(false);

    let cancelled = false;
    (async () => {
      try {
        const res = await hanaFetch(`/api/channels/${encodeURIComponent(channel.id)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const latestMembers = Array.isArray(data.members) ? data.members : [];
        const latestLeaders = Array.isArray(data.leaders) ? data.leaders : [];
        setSelectedMembers(latestMembers);
        setSelectedLeaders(latestLeaders.filter((id: string) => latestMembers.includes(id)));
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
    setSelectedLeaders((prev) => prev.filter((id) => id !== agentId));
    setMembersError(false);
  }, []);

  const toggleLeader = useCallback((agentId: string) => {
    if (!selectedMembers.includes(agentId)) return;
    setSelectedLeaders((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId],
    );
  }, [selectedMembers]);

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
    const leaders = channel.mode === 'discussion'
      ? []
      : [...new Set(
          selectedLeaders
            .map((id) => String(id || '').trim())
            .filter((id) => id && members.includes(id)),
        )];

    setSaving(true);
    try {
      const res = await hanaFetch(`/api/channels/${encodeURIComponent(channel.id)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ members, leaders }),
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
  }, [addToast, channel, currentChannel, loadChannels, onClose, openChannel, saving, selectedLeaders, selectedMembers, t]);

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

        {channel.mode !== 'discussion' && (
          <div className="settings-field">
            <label className="settings-field-label">{t('channel.createLeaders')}</label>
            <div className="channel-create-members channel-manage-members-list">
              {agents.filter((agent) => selectedMembers.includes(agent.id)).map((agent) => {
                const isLeader = selectedLeaders.includes(agent.id);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    className={`channel-create-member-chip${isLeader ? ' selected' : ''}`}
                    onClick={() => toggleLeader(agent.id)}
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
            <div className="channel-manage-members-hint">{t('channel.createLeadersHint')}</div>
          </div>
        )}

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
  const sendChannelMessage = useStore((s) => s.sendChannelMessage);
  const contentRef = useRef<HTMLDivElement>(null);
  const anchoredUserKeyRef = useRef<string | null>(null);
  const followReplyRef = useRef(false);
  const channelSwitchPendingRef = useRef(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copiedMsgKey, setCopiedMsgKey] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; name: string } | null>(null);
  const [previewZoom, setPreviewZoom] = useState(0.9);
  const ch = channels.find((c) => c.id === currentChannel);
  const isDM = ch?.isDM ?? false;
  const channelMemberKeys = useMemo(
    () => new Set((channelMembers || []).map((m) => String(m || '').trim().toLowerCase()).filter(Boolean)),
    [channelMembers],
  );

  useEffect(() => () => {
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!previewImage) return undefined;
    setPreviewZoom(0.9);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewImage(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [previewImage]);

  const copyMessage = useCallback((msgKey: string, text: string) => {
    const payload = String(text || '').trim();
    if (!payload) return;
    navigator.clipboard.writeText(payload).then(() => {
      setCopiedMsgKey(msgKey);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopiedMsgKey((prev) => (prev === msgKey ? null : prev));
      }, 1500);
    }).catch(() => {});
  }, []);

  const editMessage = useCallback((text: string) => {
    window.dispatchEvent(new CustomEvent(CHANNEL_EDIT_MESSAGE_EVENT, {
      detail: { text: String(text || '') },
    }));
  }, []);

  const resendMessage = useCallback((text: string) => {
    const payload = String(text || '').trim();
    if (!payload) return;
    void sendChannelMessage(payload);
  }, [sendChannelMessage]);

  const clampZoom = useCallback((value: number) => {
    return Math.max(0.45, Math.min(2.4, value));
  }, []);

  const handlePreviewWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const zoomFactor = Math.exp(-e.deltaY * 0.0018);
    setPreviewZoom((prev) => clampZoom(prev * zoomFactor));
  }, [clampZoom]);

  const getMessageKey = useCallback((msg: (typeof messages)[number], idx: number) => `${msg.timestamp}-${idx}`, []);

  const isSelfChannelMessage = useCallback((msg: (typeof messages)[number]) => {
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
    return senderInfo.isUser || isUserSenderAlias || isGroupUserFallback || (isDM && msg.sender === (currentAgentId || ''));
  }, [agents, channelMemberKeys, currentAgentId, isDM, userAvatarUrl, userName]);

  const findMessageElement = useCallback((el: HTMLElement, msgKey: string) => {
    const nodes = el.querySelectorAll<HTMLElement>('.channel-msg');
    for (const node of nodes) {
      if (node.dataset.channelMsgKey === msgKey) return node;
    }
    return null;
  }, []);

  const showChannelBottomImmediately = useCallback(() => {
    const el = document.getElementById('channelMessages');
    if (!el) return;
    const spacer = el.querySelector('.channel-context-tail-spacer') as HTMLElement | null;
    if (spacer) spacer.style.height = '0px';
    anchoredUserKeyRef.current = null;
    followReplyRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, []);

  const anchorMessageAtRatio = useCallback((el: HTMLElement, spacer: HTMLElement, msgEl: HTMLElement) => {
    spacer.style.height = '0px';

    requestAnimationFrame(() => {
      const desiredY = Math.floor(el.clientHeight * CHANNEL_MESSAGE_ANCHOR_RATIO);
      const containerRect = el.getBoundingClientRect();
      const msgRect = msgEl.getBoundingClientRect();
      const currentY = msgRect.top - containerRect.top;
      const rawTargetTop = Math.max(0, el.scrollTop + currentY - desiredY);
      const maxScrollable = el.scrollHeight - el.clientHeight;
      const neededSpace = Math.max(0, rawTargetTop - maxScrollable + 12);
      spacer.style.height = `${neededSpace}px`;

      requestAnimationFrame(() => {
        const maxScrollableAfterSpacer = el.scrollHeight - el.clientHeight;
        const targetTop = Math.min(rawTargetTop, maxScrollableAfterSpacer);
        el.scrollTo({ top: targetTop, behavior: 'smooth' });
      });
    });
  }, []);

  const syncChannelScrollAnchor = useCallback(() => {
    const el = document.getElementById('channelMessages');
    if (!el) return;
    const spacer = el.querySelector('.channel-context-tail-spacer') as HTMLElement | null;
    if (!spacer) return;

    const lastIdx = messages.length - 1;
    const lastMsg = messages[lastIdx];
    if (!lastMsg || lastMsg.isContextReset) {
      anchoredUserKeyRef.current = null;
      followReplyRef.current = false;
      showChannelBottomImmediately();
      return;
    }

    const lastMsgKey = getMessageKey(lastMsg, lastIdx);
    const lastMsgEl = findMessageElement(el, lastMsgKey);
    if (!lastMsgEl) return;

    if (channelSwitchPendingRef.current) {
      channelSwitchPendingRef.current = false;
      anchoredUserKeyRef.current = null;
      followReplyRef.current = true;
      if (spacer) spacer.style.height = '0px';
      showChannelBottomImmediately();
      return;
    }

    if (isSelfChannelMessage(lastMsg)) {
      if (anchoredUserKeyRef.current === lastMsgKey && !followReplyRef.current) return;
      anchoredUserKeyRef.current = lastMsgKey;
      followReplyRef.current = false;
      anchorMessageAtRatio(el, spacer, lastMsgEl);
      return;
    }

    if (!anchoredUserKeyRef.current) {
      showChannelBottomImmediately();
      return;
    }

    const containerRect = el.getBoundingClientRect();
    const msgRect = lastMsgEl.getBoundingClientRect();
    const replyReachedInput = msgRect.bottom - containerRect.top >= el.clientHeight - 12;
    if (!followReplyRef.current && !replyReachedInput) return;

    followReplyRef.current = true;
    if (spacer) spacer.style.height = '0px';
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [anchorMessageAtRatio, findMessageElement, getMessageKey, isSelfChannelMessage, messages, showChannelBottomImmediately]);

  useEffect(() => {
    anchoredUserKeyRef.current = null;
    followReplyRef.current = false;
    channelSwitchPendingRef.current = !!currentChannel;
  }, [currentChannel]);

  useEffect(() => {
    syncChannelScrollAnchor();
  }, [syncChannelScrollAnchor]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      syncChannelScrollAnchor();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [syncChannelScrollAnchor]);

  if (!currentChannel) {
    return <ChannelWelcomeGroups />;
  }

  if (messages.length === 0) {
    return <div className="channel-welcome">{t('channel.noMessages')}</div>;
  }

  let lastSender: string | null = null;

  return (
    <div ref={contentRef} className="channel-messages-content">
      {messages.map((msg, idx) => {
        const msgKey = `${msg.timestamp}-${idx}`;
        if (msg.isContextReset) {
          lastSender = null;
          return (
            <div key={msgKey} className="channel-context-divider">
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
        const parsed = parseUserAttachments(msg.body || '');
        const messageText = parsed.text;
        const attachments = parsed.files;
        const canCopy = senderNorm !== 'system' && String(msg.body || '').trim().length > 0;
        const canOperateSelfMessage = isSelf && !isDM && canCopy;
        const copied = copiedMsgKey === msgKey;
        const el = (
          <div
            key={msgKey}
            data-channel-msg-key={msgKey}
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
              <div className="channel-msg-text-wrap">
                <ChannelAttachmentsView
                  attachments={attachments}
                  onPreviewImage={(src, name) => setPreviewImage({ src, name })}
                />
                {messageText && (
                  <div
                    className="channel-msg-text md-content"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(messageText) }}
                  />
                )}
                {canCopy && !canOperateSelfMessage && (
                  <button
                    className={`channel-msg-action-btn channel-msg-copy-btn${copied ? ' copied' : ''}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      copyMessage(msgKey, msg.body || '');
                    }}
                    title={copied ? t('common.copied') : t('common.copyText')}
                    aria-label={copied ? t('common.copied') : t('common.copyText')}
                    type="button"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      {copied
                        ? <polyline points="20 6 9 17 4 12" />
                        : (
                          <>
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </>
                        )}
                    </svg>
                  </button>
                )}
                {canOperateSelfMessage && (
                  <div className="channel-msg-self-actions">
                    <button
                      className={`channel-msg-action-btn channel-msg-copy-btn${copied ? ' copied' : ''}`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        copyMessage(msgKey, msg.body || '');
                      }}
                      title={copied ? t('common.copied') : t('common.copyText')}
                      aria-label={copied ? t('common.copied') : t('common.copyText')}
                      type="button"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        {copied
                          ? <polyline points="20 6 9 17 4 12" />
                          : (
                            <>
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </>
                          )}
                      </svg>
                    </button>
                    <button
                      className="channel-msg-action-btn channel-msg-edit-btn"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        editMessage(msg.body || '');
                      }}
                      title={t('common.edit')}
                      aria-label={t('common.edit')}
                      type="button"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                      </svg>
                    </button>
                    <button
                      className="channel-msg-action-btn channel-msg-resend-btn"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        resendMessage(msg.body || '');
                      }}
                      title={t('channel.resend')}
                      aria-label={t('channel.resend')}
                      type="button"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M23 4v6h-6" />
                        <path d="M1 20v-6h6" />
                        <path d="M3.5 9a9 9 0 0 1 14.1-3.4L23 10" />
                        <path d="M20.5 15a9 9 0 0 1-14.1 3.4L1 14" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
        lastSender = msg.sender;
        return el;
      })}
      <div className="channel-context-tail-spacer" />
      {previewImage && (
        <div
          className="attach-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={previewImage.name}
          onClick={() => setPreviewImage(null)}
        >
          <div
            className="attach-image-lightbox-frame"
            onClick={(e) => e.stopPropagation()}
            onWheel={handlePreviewWheel}
            style={{ transform: `scale(${previewZoom})` }}
          >
            <img
              className="attach-image-lightbox-img"
              src={previewImage.src}
              alt={previewImage.name}
              draggable={false}
            />
          </div>
        </div>
      )}
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
  const { t, locale } = useI18n();
  const currentTab = useStore((s) => s.currentTab);
  const currentChannel = useStore((s) => s.currentChannel);
  const isDM = useStore((s) => s.channelIsDM);
  const channelMembers = useStore((s) => s.channelMembers);
  const agents = useStore((s) => s.agents);
  const userName = useStore((s) => s.userName);
  const userAvatarUrl = useStore((s) => s.userAvatarUrl);
  const currentAgentId = useStore((s) => s.currentAgentId);
  const channelAgentActivity = useStore((s) => s.channelAgentActivity);
  const sendChannelMessage = useStore((s) => s.sendChannelMessage);
  const resetChannelContext = useStore((s) => s.resetChannelContext);
  const clearChannelMessages = useStore((s) => s.clearChannelMessages);
  const stopChannelReplies = useStore((s) => s.stopChannelReplies);
  const attachedFiles = useStore((s) => s.channelAttachedFiles);
  const addAttachedFile = useStore((s) => s.addChannelAttachedFile);
  const removeAttachedFile = useStore((s) => s.removeChannelAttachedFile);
  const clearAttachedFiles = useStore((s) => s.clearChannelAttachedFiles);
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
  const attachFileInputRef = useRef<HTMLInputElement>(null);
  const voiceAnchorRef = useRef<{ prefix: string; suffix: string; interim: string } | null>(null);
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

  useEffect(() => {
    const handleEditMessage = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string }>).detail;
      const nextValue = String(detail?.text || '');
      setInputValue(nextValue);
      setMentionActive(false);
      setCommandActive(false);
      clearAttachedFiles();
      requestAnimationFrame(() => {
        if (!inputRef.current) return;
        inputRef.current.focus();
        const cursor = nextValue.length;
        inputRef.current.setSelectionRange(cursor, cursor);
      });
    };

    window.addEventListener(CHANNEL_EDIT_MESSAGE_EVENT, handleEditMessage as EventListener);
    return () => {
      window.removeEventListener(CHANNEL_EDIT_MESSAGE_EVENT, handleEditMessage as EventListener);
    };
  }, [clearAttachedFiles]);

  // 输入框自适应高度：最多展示 5 行，超出后内部滚动
  useEffect(() => {
    resizeTextarea();
  }, [inputValue, currentChannel, resizeTextarea]);

  const buildVoiceAnchoredText = useCallback((anchor: { prefix: string; suffix: string }, rawText: string) => {
    const text = String(rawText || '').trim();
    const needsLeadingSpace = !!text && anchor.prefix.length > 0 && !/\s$/.test(anchor.prefix);
    const needsTrailingSpace = !!text && anchor.suffix.length > 0 && !/^\s/.test(anchor.suffix);
    const leading = needsLeadingSpace ? ' ' : '';
    const trailing = needsTrailingSpace ? ' ' : '';
    const nextValue = `${anchor.prefix}${leading}${text}${trailing}${anchor.suffix}`;
    const cursor = `${anchor.prefix}${leading}${text}`.length;
    return { text, leading, nextValue, cursor };
  }, []);

  const prepareVoiceAnchor = useCallback(() => {
    const node = inputRef.current;
    const value = node?.value ?? inputValue;
    const start = node?.selectionStart ?? value.length;
    const end = node?.selectionEnd ?? start;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const strippedBefore = before.replace(/[ \u3000]$/, '');
    const nextValue = strippedBefore + after;
    const cursor = strippedBefore.length;

    voiceAnchorRef.current = { prefix: strippedBefore, suffix: after, interim: '' };
    setInputValue(nextValue);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  }, [inputValue]);

  const applyVoiceInterimTranscript = useCallback((rawText: string) => {
    const anchor = voiceAnchorRef.current;
    if (!anchor) return;
    const next = buildVoiceAnchoredText(anchor, rawText);
    setInputValue(next.nextValue);
    voiceAnchorRef.current = { ...anchor, interim: next.text };
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.cursor, next.cursor);
    });
  }, [buildVoiceAnchoredText]);

  const applyVoiceTranscript = useCallback((rawText: string) => {
    const text = String(rawText || '').trim();
    if (!text) return;
    const anchor = voiceAnchorRef.current;
    if (!anchor) {
      setInputValue((prev) => {
        const prefix = prev && !/\s$/.test(prev) ? `${prev} ` : prev;
        return `${prefix}${text}`;
      });
      return;
    }
    const next = buildVoiceAnchoredText(anchor, text);
    setInputValue(next.nextValue);
    voiceAnchorRef.current = {
      prefix: `${anchor.prefix}${next.leading}${next.text}`,
      suffix: anchor.suffix,
      interim: '',
    };
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.cursor, next.cursor);
    });
  }, [buildVoiceAnchoredText]);

  const voiceLanguage = useMemo(
    () => String(locale || (window as any).i18n?.locale || navigator.language || ''),
    [locale],
  );
  const {
    supported: voiceSupported,
    state: voiceState,
    error: voiceErrorRaw,
    volumeLevel: voiceVolumeLevel,
    clearError: clearVoiceError,
  } = usePushToTalk({
    enabled: currentTab === 'channels' && !isDM && !!currentChannel,
    language: voiceLanguage,
    onActivate: prepareVoiceAnchor,
    onInterimTranscript: applyVoiceInterimTranscript,
    onTranscript: applyVoiceTranscript,
  });

  const voiceError = useMemo(() => {
    if (!voiceErrorRaw) return '';
    if (voiceErrorRaw === 'NO_SPEECH') return t('input.voiceNoSpeech');
    if (voiceErrorRaw === 'MIC_PERMISSION_DENIED') return t('input.voiceMicDenied');
    if (voiceErrorRaw === 'VOICE_RECORDER_ERROR') return t('input.voiceRecorderError');
    const message = String(voiceErrorRaw || '').trim();
    if (!message) return '';
    const detail = message.split(' - ').pop()?.trim();
    return detail || message;
  }, [voiceErrorRaw, t]);

  useEffect(() => {
    if (!voiceErrorRaw) return;
    const timer = setTimeout(() => clearVoiceError(), 4000);
    return () => clearTimeout(timer);
  }, [voiceErrorRaw, clearVoiceError]);

  useEffect(() => {
    if (voiceState === 'idle') voiceAnchorRef.current = null;
  }, [voiceState]);

  const voiceStatusText = useMemo(() => {
    if (!voiceSupported) return '';
    if (voiceState === 'warming') return t('input.voiceWarming');
    if (voiceState === 'recording') return t('input.voiceRecording');
    if (voiceState === 'processing') return t('input.voiceProcessing');
    return t('input.voiceHoldHint');
  }, [voiceSupported, voiceState, t]);

  const hasContent = inputValue.trim().length > 0 || attachedFiles.length > 0;
  const isChannelResponding = !!(
    currentChannel
    && Object.values(channelAgentActivity?.[currentChannel] || {}).some(Boolean)
  );
  const isStopMode = isChannelResponding && !hasContent;

  const stopReplies = useCallback(async (clearInputAfter = false) => {
    if (sending) return;
    setSending(true);
    try {
      await stopChannelReplies();
      if (clearInputAfter) {
        setInputValue('');
        setMentionActive(false);
        setCommandActive(false);
        clearAttachedFiles();
      }
    } catch (err) {
      console.error('[channels] stop failed:', err);
      addToast(t('channel.stopFailed'), 'error', 3000);
    } finally {
      setSending(false);
    }
  }, [sending, stopChannelReplies, clearAttachedFiles, addToast, t]);

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
      await stopReplies(true);
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
  }, [sending, inputValue, attachedFiles, sendChannelMessage, clearAttachedFiles, resetChannelContext, clearChannelMessages, stopReplies, addToast, t]);

  const handlePrimaryAction = useCallback(() => {
    if (isStopMode) {
      void stopReplies(false);
      return;
    }
    void handleSend();
  }, [isStopMode, stopReplies, handleSend]);

  const checkMention = useCallback(() => {
    if (!inputRef.current) return;
    const val = inputRef.current.value;
    const cursorPos = inputRef.current.selectionStart ?? 0;
    const textBeforeCursor = val.slice(0, cursorPos);

    const atIdx = textBeforeCursor.lastIndexOf('@');
    if (atIdx < 0) {
      setMentionActive(false);
      return;
    }

    const keywordRaw = textBeforeCursor.slice(atIdx + 1);
    if (/\s/.test(keywordRaw)) {
      setMentionActive(false);
      return;
    }

    const keyword = keywordRaw.toLowerCase();
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

    const hasMentionAll = filtered.some((m) => m.id === '__all_members__');
    const memberItems = filtered.filter((m) => m.id !== '__all_members__');
    const limitedMembers = memberItems.slice(0, CHANNEL_MENTION_MAX_MEMBERS);
    const limitedItems = hasMentionAll
      ? [mentionItemsAll[0], ...limitedMembers]
      : limitedMembers;

    if (limitedItems.length === 0) {
      setMentionActive(false);
      return;
    }

    setMentionItems(limitedItems);
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
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
      },
      {
        id: 'clear',
        label: '/clear',
        desc: t('channel.commandClearDesc'),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
      },
      {
        id: 'stop',
        label: '/stop',
        desc: t('channel.commandStopDesc'),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2" ry="2"/></svg>',
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
      handlePrimaryAction();
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
  }, [mentionActive, mentionItems, mentionSelectedIdx, insertMention, commandActive, commandItems, commandSelectedIdx, insertCommand, handlePrimaryAction]);

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

  const appendPickedFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;

    const maxAttachments = 9;
    let count = attachedFiles.length;
    const seenPathSet = new Set(attachedFiles.map((file) => file.path));

    for (const file of Array.from(files)) {
      if (count >= maxAttachments) break;
      const absolutePath = window.platform?.getFilePath?.(file);
      if (!absolutePath || isHttpUrlPath(absolutePath) || seenPathSet.has(absolutePath)) continue;

      addAttachedFile({
        path: absolutePath,
        name: file.name || absolutePath.split('/').pop() || absolutePath,
        isDirectory: false,
      });
      seenPathSet.add(absolutePath);
      count += 1;
    }
  }, [addAttachedFile, attachedFiles]);

  const handleAttachPickerChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    appendPickedFiles(e.target.files);
    e.currentTarget.value = '';
  }, [appendPickedFiles]);

  const handlePickAttachments = useCallback(() => {
    attachFileInputRef.current?.click();
  }, []);

  if (isDM || !currentChannel) return null;

  return (
    <>
      {voiceError && (
        <div className="slash-busy-bar slash-result-error">
          <span>{voiceError}</span>
        </div>
      )}
      {attachedFiles.length > 0 && (
        <AttachedFilesBar
          files={attachedFiles}
          onRemove={removeAttachedFile}
          className="channel-attached-files"
        />
      )}
      <div className="input-wrapper channel-composer">
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
          <div className="channel-mention-dropdown channel-command-dropdown slash-menu">
            {commandItems.map((cmd, idx) => (
              <button
                key={cmd.id}
                type="button"
                className={`slash-menu-item${idx === commandSelectedIdx ? ' selected' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertCommand(cmd.label);
                }}
              >
                <span className="slash-menu-icon" dangerouslySetInnerHTML={{ __html: cmd.icon }} />
                <span className="slash-menu-label">{cmd.label}</span>
                <span className="slash-menu-desc">{cmd.desc}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          id="channelInputBox"
          className="input-box"
          placeholder={(window as any).t?.('channel.inputPlaceholder') || 'Send a message...'}
          rows={1}
          spellCheck={false}
          value={inputValue}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
        <div className="input-bottom-bar">
          <div className="input-actions">
            <div className="attach-menu-wrap">
              <button
                type="button"
                className="attach-menu-trigger"
                title={t('input.addAttachment')}
                aria-label={t('input.addAttachment')}
                onClick={handlePickAttachments}
              >
                <span className="attach-menu-plus">+</span>
              </button>
              <input
                ref={attachFileInputRef}
                className="attach-menu-file-input"
                type="file"
                multiple
                onChange={handleAttachPickerChange}
              />
            </div>
          </div>
          <div className="input-controls">
            {voiceSupported && (
              <span
                className={`voice-mic-indicator state-${voiceState}${voiceState !== 'idle' ? ' active' : ''}`}
                title={voiceStatusText}
                aria-label={voiceStatusText}
                style={{ '--voice-level': voiceVolumeLevel.toFixed(3) } as any}
              >
                <span className="voice-mic-glyph" aria-hidden="true">
                  <span
                    className="voice-mic-outline"
                    dangerouslySetInnerHTML={{ __html: SVG_ICONS.mic }}
                  />
                  <span
                    className="voice-mic-fill"
                    dangerouslySetInnerHTML={{ __html: SVG_ICONS.micFill }}
                  />
                </span>
              </span>
            )}
            <button
              type="button"
              className={`send-btn${isStopMode ? ' is-streaming' : ''}`}
              disabled={sending || (!isStopMode && !hasContent)}
              onMouseDown={(e) => { e.preventDefault(); }}
              onClick={handlePrimaryAction}
              title={isStopMode ? t('chat.stop') : t('chat.send')}
            >
              <span className="send-label">
                {isStopMode ? (
                  <svg className="stop-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                ) : (
                  <svg className="send-enter-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 10 4 15 9 20" />
                    <path d="M20 4v7a4 4 0 01-4 4H4" />
                  </svg>
                )}
                <span className="send-label-text">{isStopMode ? t('chat.stop') : t('chat.send')}</span>
              </span>
            </button>
          </div>
        </div>
      </div>
    </>
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
  const [channelMode, setChannelMode] = useState<'command' | 'discussion'>('discussion');
  const [discussionMaxRounds, setDiscussionMaxRounds] = useState(3);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [selectedLeaders, setSelectedLeaders] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [nameError, setNameError] = useState(false);
  const [membersError, setMembersError] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // When modal becomes visible, reset form and keep members unselected by default
  useEffect(() => {
    const overlay = document.getElementById('channelCreateOverlay');
    if (!overlay) return;

    const observer = new MutationObserver(() => {
      if (overlay.classList.contains('visible')) {
        setName('');
        setIntro('');
        setChannelMode('discussion');
        setDiscussionMaxRounds(3);
        setSelectedMembers([]);
        setSelectedLeaders([]);
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
    setSelectedLeaders((prev) => prev.filter((id) => id !== agentId));
    setMembersError(false);
  }, []);

  const toggleLeader = useCallback((agentId: string) => {
    if (!selectedMembers.includes(agentId)) return;
    setSelectedLeaders((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId],
    );
  }, [selectedMembers]);

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
      const leaders = channelMode === 'command'
        ? selectedLeaders.filter((id) => selectedMembers.includes(id))
        : [];
      await createChannel(name.trim(), selectedMembers, intro.trim() || undefined, leaders, channelMode, discussionMaxRounds);
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
  }, [channelMode, creating, name, discussionMaxRounds, selectedLeaders, selectedMembers, intro, createChannel]);

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
        <label className="settings-field-label">{t('channel.createMode')}</label>
        <div className="channel-create-members">
          <button
            type="button"
            className={`channel-create-member-chip${channelMode === 'discussion' ? ' selected' : ''}`}
            onClick={() => setChannelMode('discussion')}
          >
            <span>{t('channel.modeDiscussion')}</span>
          </button>
          <button
            type="button"
            className={`channel-create-member-chip${channelMode === 'command' ? ' selected' : ''}`}
            onClick={() => setChannelMode('command')}
          >
            <span>{t('channel.modeCommand')}</span>
          </button>
        </div>
        <div className="channel-manage-members-hint">
          {channelMode === 'discussion' ? t('channel.modeDiscussionHint') : t('channel.modeCommandHint')}
        </div>
      </div>
      {channelMode === 'discussion' && (
        <div className="settings-field">
          <label className="settings-field-label">{t('channel.discussionMaxRounds')}</label>
          <input
            className="settings-input"
            type="number"
            min={1}
            max={8}
            value={discussionMaxRounds}
            onChange={(e) => {
              const next = Math.max(1, Math.min(8, Number(e.target.value) || 3));
              setDiscussionMaxRounds(next);
            }}
          />
          <div className="channel-manage-members-hint">{t('channel.discussionMaxRoundsHint')}</div>
        </div>
      )}
      {channelMode === 'command' && (
        <div className="settings-field">
          <label className="settings-field-label">{t('channel.createLeaders')}</label>
          <div className="channel-create-members">
            {agents.filter((agent) => selectedMembers.includes(agent.id)).map((agent) => {
              const isLeader = selectedLeaders.includes(agent.id);
              return (
                <button
                  key={agent.id}
                  type="button"
                  className={`channel-create-member-chip${isLeader ? ' selected' : ''}`}
                  onClick={() => toggleLeader(agent.id)}
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
          <div className="channel-manage-members-hint">{t('channel.createLeadersHint')}</div>
        </div>
      )}
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
