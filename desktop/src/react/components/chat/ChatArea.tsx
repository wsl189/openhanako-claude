/**
 * ChatArea — 聊天消息列表（干净重写版）
 *
 * 原理：每个 session 一个原生滚动 div，使用 opacity 切换可见性以保持 scrollTop。
 * 不用 Virtuoso，不用 Activity，不用快照，不用任何花活。
 */

import { memo, useCallback, useRef, useEffect, useState, useMemo } from 'react';
import { useStore } from '../../stores';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { CompactionNotice, CompactionDoneDivider } from './CompactionNotice';
import type { ChatListItem, ChatMessage, ContentBlock } from '../../stores/chat-types';

const MAX_ALIVE = 5;

// ── 入口 ──

export function ChatArea() {
  return (
    <>
      <PanelHost />
      <ScrollToBottomBtn />
    </>
  );
}

// ── PanelHost：管理 alive 列表 ──

function PanelHost() {
  const currentPath = useStore(s => s.currentSessionPath);
  const chatSessions = useStore(s => s.chatSessions);
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const [alive, setAlive] = useState<string[]>([]);

  // 加入 alive 列表（不重排已有位置，避免 React 移动 DOM 节点导致 scrollTop 丢失）
  useEffect(() => {
    if (!currentPath) return;
    if (!chatSessions[currentPath] || chatSessions[currentPath].items.length === 0) return;
    setAlive(prev => {
      if (prev.includes(currentPath)) return prev; // 已存在，不动
      if (prev.length >= MAX_ALIVE) {
        // 淘汰第一个非当前的
        const evictIdx = prev.findIndex(p => p !== currentPath);
        const next = [...prev];
        next.splice(evictIdx, 1);
        next.push(currentPath);
        return next;
      }
      return [...prev, currentPath];
    });
  }, [currentPath, chatSessions]);

  if (welcomeVisible || !currentPath) return null;

  return (
    <>
      {alive.map(path => (
        <Panel key={path} path={path} active={path === currentPath} />
      ))}
    </>
  );
}

// ── Panel：一个 session 的原生滚动容器 ──

const SCROLL_THRESHOLD = 300;
const INPUT_GAP = 12;
const USER_MESSAGE_ANCHOR_RATIO = 0.70;
const ASSISTANT_REPLY_MIN_TOP_RATIO = 0.70;

function isAssistantMessageItem(item: ChatListItem | undefined): item is Extract<ChatListItem, { type: 'message' }> {
  return !!item && item.type === 'message' && item.data.role === 'assistant';
}

function isUserMessageItem(item: ChatListItem | undefined): item is Extract<ChatListItem, { type: 'message' }> {
  return !!item && item.type === 'message' && item.data.role === 'user';
}

function mergeAssistantMessages(prev: ChatMessage, next: ChatMessage): ChatMessage {
  const prevBlocks: ContentBlock[] = Array.isArray(prev.blocks) ? prev.blocks : [];
  const nextBlocks: ContentBlock[] = Array.isArray(next.blocks) ? next.blocks : [];
  return {
    ...prev,
    blocks: [...prevBlocks, ...nextBlocks],
    // 保留更晚的时间戳，头像行上“Agent Running”计时和时序更贴近当前状态
    timestamp: typeof next.timestamp === 'number' ? next.timestamp : prev.timestamp,
  };
}

function coalesceAssistantItems(items: ChatListItem[]): ChatListItem[] {
  const merged: ChatListItem[] = [];
  for (const item of items) {
    if (!item || item.type !== 'message' || item.data.role !== 'assistant') {
      merged.push(item);
      continue;
    }
    const last = merged[merged.length - 1];
    if (last && last.type === 'message' && last.data.role === 'assistant') {
      merged[merged.length - 1] = {
        type: 'message',
        data: mergeAssistantMessages(last.data, item.data),
      };
      continue;
    }
    merged.push(item);
  }
  return merged;
}

const Panel = memo(function Panel({ path, active }: { path: string; active: boolean }) {
  const rawItems = useStore(s => s.chatSessions[path]?.items || []);
  const items = useMemo(() => coalesceAssistantItems(rawItems), [rawItems]);
  const streamingSessions = useStore(s => s.streamingSessions);
  const streamingSinceByPath = useStore(s => s.streamingSinceByPath);
  const isPathStreaming = streamingSessions.includes(path);
  const [streamingNow, setStreamingNow] = useState<number>(Date.now());
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const isAtBottom = useRef(true);
  const anchoredUserIdRef = useRef<string | null>(null);
  const anchoredAssistantIdRef = useRef<string | null>(null);
  const followReplyRef = useRef(false);
  const suppressAutoScrollUntil = useRef(0);
  const lastUserIndex = useMemo(() => {
    for (let idx = items.length - 1; idx >= 0; idx--) {
      if (isUserMessageItem(items[idx])) return idx;
    }
    return -1;
  }, [items]);
  const streamingAssistantIndex = useMemo(() => {
    if (!isPathStreaming) return -1;
    // 仅把“最后一条用户消息之后”的 assistant 视作当前轮，避免 stop 时空占位被清理后错误回落到上一轮 assistant。
    for (let idx = items.length - 1; idx > lastUserIndex; idx--) {
      if (isAssistantMessageItem(items[idx])) return idx;
    }
    return -1;
  }, [items, isPathStreaming, lastUserIndex]);

  // 判断是否在底部
  const checkAtBottom = () => {
    const el = ref.current;
    if (!el) return;
    isAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
  };

  const getInputTop = useCallback(() => {
    const el = ref.current;
    if (!el) return 0;
    const input = document.querySelector('.input-area:not(.hidden)') as HTMLElement | null;
    if (!input) return el.clientHeight;
    const panelRect = el.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    const inputTop = inputRect.top - panelRect.top;
    if (!Number.isFinite(inputTop)) return el.clientHeight;
    return Math.max(0, Math.min(el.clientHeight, inputTop));
  }, []);

  const setFooterHeight = useCallback((height: number) => {
    const footer = footerRef.current;
    if (!footer) return;
    const next = `${Math.max(0, Math.ceil(height))}px`;
    if (footer.style.height !== next) footer.style.height = next;
  }, []);

  const getFooterHeight = useCallback(() => {
    const footer = footerRef.current;
    if (!footer) return 0;
    return footer.getBoundingClientRect().height;
  }, []);

  const getFollowFooterHeight = useCallback(() => {
    const el = ref.current;
    if (!el) return 0;
    return Math.max(0, el.clientHeight - getInputTop() + INPUT_GAP);
  }, [getInputTop]);

  const getFooterHeightForTargetTop = useCallback((targetTop: number, minHeight: number) => {
    const el = ref.current;
    if (!el) return minHeight;
    const maxScrollable = Math.max(0, el.scrollHeight - el.clientHeight);
    const maxScrollableWithoutFooter = Math.max(0, maxScrollable - getFooterHeight());
    return Math.max(minHeight, targetTop - maxScrollableWithoutFooter + INPUT_GAP);
  }, [getFooterHeight]);

  // 滚到底
  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const showBottomImmediately = useCallback(() => {
    anchoredUserIdRef.current = null;
    anchoredAssistantIdRef.current = null;
    followReplyRef.current = true;
    setFooterHeight(getFollowFooterHeight());
    scrollToBottom();
    isAtBottom.current = true;
  }, [getFollowFooterHeight, scrollToBottom, setFooterHeight]);

  const findMessageElement = useCallback((messageId: string) => {
    const el = ref.current;
    if (!el) return null;
    return el.querySelector<HTMLElement>(`.chat-session-item[data-chat-message-id="${CSS.escape(messageId)}"]`);
  }, []);

  const findAssistantFollowElement = useCallback((messageId: string) => {
    const msgEl = findMessageElement(messageId);
    if (!msgEl) return null;
    const primaryReplyEl = msgEl.querySelector<HTMLElement>([
      '.assistant-final-reply',
      '.file-output-card',
      '.artifact-card',
      '.browser-screenshot',
      '.skill-card',
      '.cron-confirm-card',
      '.settings-confirm-card',
    ].join(', '));
    if (primaryReplyEl) return primaryReplyEl;

    // 在最终文本出现前，纯思考/执行链也需要作为当前回复被输入框顶起。
    return msgEl.querySelector<HTMLElement>('.message.assistant');
  }, [findMessageElement]);

  const anchorElementAtInputRatio = useCallback((targetEl: HTMLElement, ratio: number) => {
    const el = ref.current;
    if (!el || !targetEl.isConnected) return;

    setFooterHeight(0);
    requestAnimationFrame(() => {
      if (!targetEl.isConnected) return;
      const visibleBottom = getInputTop();
      const desiredY = Math.floor(visibleBottom * ratio);
      const containerRect = el.getBoundingClientRect();
      const msgRect = targetEl.getBoundingClientRect();
      const currentY = msgRect.top - containerRect.top;
      const rawTargetTop = Math.max(0, el.scrollTop + currentY - desiredY);
      const maxScrollable = el.scrollHeight - el.clientHeight;
      const neededSpace = Math.max(getFollowFooterHeight(), rawTargetTop - maxScrollable + INPUT_GAP);
      setFooterHeight(neededSpace);

      requestAnimationFrame(() => {
        const maxScrollableAfterSpacer = el.scrollHeight - el.clientHeight;
        const targetTop = Math.min(rawTargetTop, maxScrollableAfterSpacer);
        el.scrollTo({ top: targetTop, behavior: 'smooth' });
        isAtBottom.current = false;
      });
    });
  }, [getFollowFooterHeight, getInputTop, setFooterHeight]);

  const anchorUserAtInputRatio = useCallback((messageId: string) => {
    const msgEl = findMessageElement(messageId);
    if (!msgEl) return;
    anchorElementAtInputRatio(msgEl, USER_MESSAGE_ANCHOR_RATIO);
  }, [anchorElementAtInputRatio, findMessageElement]);

  const followAssistantReplyWithMinAnchor = useCallback((replyEl: HTMLElement) => {
    const el = ref.current;
    if (!el || !replyEl.isConnected) return;

    const visibleBottom = getInputTop();
    const minTopY = Math.floor(visibleBottom * ASSISTANT_REPLY_MIN_TOP_RATIO);
    const availableBelowAnchor = Math.max(0, visibleBottom - minTopY - INPUT_GAP);
    const panelRect = el.getBoundingClientRect();
    const replyRect = replyEl.getBoundingClientRect();
    const currentTopY = replyRect.top - panelRect.top;
    const currentBottomY = replyRect.bottom - panelRect.top;
    const targetTop = replyRect.height <= availableBelowAnchor
      ? el.scrollTop + currentTopY - minTopY
      : el.scrollTop + currentBottomY - (visibleBottom - INPUT_GAP);
    const rawTargetTop = Math.max(0, targetTop);
    const neededSpace = getFooterHeightForTargetTop(rawTargetTop, getFollowFooterHeight());
    setFooterHeight(neededSpace);

    requestAnimationFrame(() => {
      const maxScrollableAfterSpacer = Math.max(0, el.scrollHeight - el.clientHeight);
      const nextTop = Math.min(rawTargetTop, maxScrollableAfterSpacer);
      el.scrollTo({ top: nextTop, behavior: 'smooth' });
      isAtBottom.current = nextTop >= maxScrollableAfterSpacer - SCROLL_THRESHOLD;
    });
  }, [getFollowFooterHeight, getInputTop, setFooterHeight]);

  const syncChatScrollAnchor = useCallback(() => {
    if (!active || items.length === 0) return;
    const el = ref.current;
    if (!el) return;

    let latestUser: ChatMessage | null = null;
    let latestUserIndex = -1;
    for (let idx = items.length - 1; idx >= 0; idx -= 1) {
      const item = items[idx];
      if (item.type === 'message' && item.data.role === 'user') {
        latestUser = item.data;
        latestUserIndex = idx;
        break;
      }
    }

    const latestMessageItem = [...items].reverse().find((item) => item.type === 'message');
    if (!latestMessageItem || latestMessageItem.type !== 'message') {
      anchoredUserIdRef.current = null;
      anchoredAssistantIdRef.current = null;
      followReplyRef.current = false;
      showBottomImmediately();
      return;
    }

    if (!latestUser) {
      showBottomImmediately();
      return;
    }

    const latestAssistantAfterUser = items
      .slice(latestUserIndex + 1)
      .find((item): item is Extract<ChatListItem, { type: 'message' }> => (
        item.type === 'message' && item.data.role === 'assistant'
      ));

    if (anchoredUserIdRef.current !== latestUser.id) {
      anchoredUserIdRef.current = latestUser.id;
      anchoredAssistantIdRef.current = null;
      followReplyRef.current = false;
      anchorUserAtInputRatio(latestUser.id);
      return;
    }

    if (!latestAssistantAfterUser) {
      if (!followReplyRef.current) return;
      anchoredAssistantIdRef.current = null;
      followReplyRef.current = false;
      anchorUserAtInputRatio(latestUser.id);
      return;
    }

    const msgEl = findAssistantFollowElement(latestAssistantAfterUser.data.id);
    if (!msgEl) return;
    if (anchoredAssistantIdRef.current !== latestAssistantAfterUser.data.id) {
      anchoredAssistantIdRef.current = latestAssistantAfterUser.data.id;
      followReplyRef.current = false;
      anchorElementAtInputRatio(msgEl, ASSISTANT_REPLY_MIN_TOP_RATIO);
      return;
    }

    const panelRect = el.getBoundingClientRect();
    const msgRect = msgEl.getBoundingClientRect();
    const replyReachedInput = msgRect.bottom - panelRect.top >= getInputTop() - INPUT_GAP;
    if (!followReplyRef.current && !replyReachedInput) return;

    followReplyRef.current = true;
    followAssistantReplyWithMinAnchor(msgEl);
  }, [
    active,
    anchorElementAtInputRatio,
    anchorUserAtInputRatio,
    findAssistantFollowElement,
    followAssistantReplyWithMinAnchor,
    getInputTop,
    items,
    showBottomImmediately,
  ]);

  // scroll 事件维护 isAtBottom 标志
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => checkAtBottom();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // ResizeObserver：内容高度变化时，按“用户锚点 → 回复触顶后贴底”的策略调整滚动。
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (Date.now() < suppressAutoScrollUntil.current) return;
      syncChatScrollAnchor();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [syncChatScrollAnchor]);

  // 点击执行链/思考链的展开收起时，锁定点击锚点位置并临时禁用自动吸底
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const toggleAnchorSelector = '.tool-indicator.expandable, .chain-summary';

    const preserveToggleAnchor = (anchor: HTMLElement) => {
      const beforeTop = anchor.getBoundingClientRect().top;
      suppressAutoScrollUntil.current = Date.now() + 700;
      // 等待 React 更新 + CSS 动画首帧后再补偿，保持点击位置稳定
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!anchor.isConnected) return;
          const afterTop = anchor.getBoundingClientRect().top;
          const delta = afterTop - beforeTop;
          if (Math.abs(delta) < 0.5) return;
          el.scrollTop += delta;
        });
      });
    };

    const onClickCapture = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const anchor = target.closest(toggleAnchorSelector) as HTMLElement | null;
      if (!anchor) return;
      preserveToggleAnchor(anchor);
    };
    el.addEventListener('click', onClickCapture, true);
    return () => el.removeEventListener('click', onClickCapture, true);
  }, []);

  // 首次有内容 → 应用当前消息锚点，避免会话切换后回到底部。
  const scrolledOnce = useRef(false);
  useEffect(() => {
    if (scrolledOnce.current) return;
    if (items.length > 0) {
      requestAnimationFrame(syncChatScrollAnchor);
      scrolledOnce.current = true;
    }
  }, [items.length, syncChatScrollAnchor]);

  useEffect(() => {
    if (!active || items.length === 0) return;
    requestAnimationFrame(syncChatScrollAnchor);
  }, [active, items.length, syncChatScrollAnchor]);

  // 新消息加入 → 用户消息先锚在 65%，回复触到输入框上方后再自动贴底。
  useEffect(() => {
    syncChatScrollAnchor();
  }, [syncChatScrollAnchor]);

  useEffect(() => {
    if (!isPathStreaming) return undefined;
    const timer = window.setInterval(() => {
      setStreamingNow(Date.now());
    }, 100);
    return () => window.clearInterval(timer);
  }, [isPathStreaming]);

  if (items.length === 0) return null;

  const runningMs = isPathStreaming
    ? Math.max(0, streamingNow - (streamingSinceByPath[path] ?? streamingNow))
    : 0;

  return (
    <div
      ref={ref}
      className="chat-session-panel"
      aria-hidden={!active}
      style={{
        opacity: active ? 1 : 0,
        zIndex: active ? 1 : 0,
        pointerEvents: active ? 'auto' : 'none',
      }}
    >
      <div ref={contentRef} className="chat-session-messages">
        {items.map((item, i) => {
          const itemKey = item.type === 'message' ? item.data.id : `c-${i}`;
          return (
            <div
              key={itemKey}
              className="chat-session-item"
              data-chat-message-id={item.type === 'message' ? item.data.id : undefined}
            >
              <ItemView
                item={item}
                prevItem={i > 0 ? items[i - 1] : undefined}
                isStreamingMessage={i === streamingAssistantIndex}
                runningMs={i === streamingAssistantIndex ? runningMs : undefined}
              />
            </div>
          );
        })}
        <div ref={footerRef} className="chat-session-footer" />
      </div>
    </div>
  );
});

// ── ScrollToBottom 按钮 ──

let _scrollBtn = { el: null as HTMLElement | null, visible: false, listeners: [] as (() => void)[] };

function ScrollToBottomBtn() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const update = () => setVisible(_scrollBtn.visible);
    _scrollBtn.listeners.push(update);
    return () => { _scrollBtn.listeners = _scrollBtn.listeners.filter(f => f !== update); };
  }, []);

  if (!visible) return null;
  return (
    <button className="scroll-to-bottom-fab" onClick={() => {
      _scrollBtn.el?.scrollTo({ top: _scrollBtn.el.scrollHeight, behavior: 'smooth' });
    }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
}

// ── ItemView ──

const ItemView = memo(function ItemView({
  item,
  prevItem,
  isStreamingMessage,
  runningMs,
}: {
  item: ChatListItem;
  prevItem?: ChatListItem;
  isStreamingMessage?: boolean;
  runningMs?: number;
}) {
  if (item.type === 'compaction') {
    return <CompactionNotice yuan={item.yuan} />;
  }
  if (item.type === 'compaction_done') {
    return <CompactionDoneDivider />;
  }
  const msg = item.data;
  const prevRole = prevItem?.type === 'message' ? prevItem.data.role : null;
  const showAvatar = msg.role !== prevRole;
  if (msg.role === 'user') {
    return <UserMessage message={msg} showAvatar={showAvatar} />;
  }
  return (
    <AssistantMessage
      message={msg}
      showAvatar={showAvatar}
      isStreaming={!!isStreamingMessage}
      runningMs={runningMs}
    />
  );
});
