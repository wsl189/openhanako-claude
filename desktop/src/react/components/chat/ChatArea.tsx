/**
 * ChatArea — 聊天消息列表（干净重写版）
 *
 * 原理：每个 session 一个原生滚动 div，使用 opacity 切换可见性以保持 scrollTop。
 * 不用 Virtuoso，不用 Activity，不用快照，不用任何花活。
 */

import { memo, useRef, useEffect, useState, useMemo, useCallback } from 'react';
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
const LATEST_TURN_ANCHOR_RATIO = 0.70;
const INPUT_SAFE_GAP = 12;
const LATEST_TURN_ANCHOR_GUARD_MS = 500;

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
  const headSpacerRef = useRef<HTMLDivElement>(null);
  const tailSpacerRef = useRef<HTMLDivElement>(null);
  const isAtBottom = useRef(true);
  const suppressAutoScrollUntil = useRef(0);
  const anchoredUserIdRef = useRef<string | null>(null);
  const followReplyRef = useRef(false);
  const latestTurnAnchorGuardUntil = useRef(0);
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
  const lastUserId = useMemo(() => {
    const item = lastUserIndex >= 0 ? items[lastUserIndex] : undefined;
    return isUserMessageItem(item) ? item.data.id : null;
  }, [items, lastUserIndex]);

  // 判断是否在底部
  const checkAtBottom = () => {
    const el = ref.current;
    if (!el) return;
    isAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
  };

  // 滚到底
  const scrollToBottom = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const clearTurnSpacers = useCallback(() => {
    if (headSpacerRef.current) headSpacerRef.current.style.height = '0px';
    if (tailSpacerRef.current) tailSpacerRef.current.style.height = '0px';
  }, []);

  const scrollToBottomAfterSpacerReset = useCallback(() => {
    clearTurnSpacers();
    requestAnimationFrame(() => {
      scrollToBottom();
      isAtBottom.current = true;
    });
  }, [clearTurnSpacers]);

  const findItemElement = useCallback((index: number) => {
    const el = ref.current;
    if (!el || index < 0) return null;
    return el.querySelector<HTMLElement>(`.chat-session-item[data-chat-item-index="${index}"]`);
  }, []);

  const getSafeBottomY = useCallback((el: HTMLElement) => {
    const panelRect = el.getBoundingClientRect();
    const inputEl = document.querySelector('.input-area:not(.hidden)') as HTMLElement | null;
    if (!inputEl) return el.clientHeight - INPUT_SAFE_GAP;
    const inputRect = inputEl.getBoundingClientRect();
    return Math.max(0, Math.min(el.clientHeight, inputRect.top - panelRect.top - INPUT_SAFE_GAP));
  }, []);

  const anchorMessageAtRatio = useCallback((msgEl: HTMLElement) => {
    const el = ref.current;
    const headSpacer = headSpacerRef.current;
    const tailSpacer = tailSpacerRef.current;
    if (!el || !headSpacer || !tailSpacer) return;

    headSpacer.style.height = '0px';
    tailSpacer.style.height = '0px';

    requestAnimationFrame(() => {
      if (!msgEl.isConnected) return;
      const desiredY = Math.floor(el.clientHeight * LATEST_TURN_ANCHOR_RATIO);
      const containerRect = el.getBoundingClientRect();
      const msgRect = msgEl.getBoundingClientRect();
      const currentY = msgRect.top - containerRect.top;

      if (el.scrollTop <= 1 && currentY < desiredY) {
        headSpacer.style.height = `${Math.ceil(desiredY - currentY)}px`;
      }

      requestAnimationFrame(() => {
        if (!msgEl.isConnected) return;
        const nextContainerRect = el.getBoundingClientRect();
        const nextMsgRect = msgEl.getBoundingClientRect();
        const nextY = nextMsgRect.top - nextContainerRect.top;
        const rawTargetTop = Math.max(0, el.scrollTop + nextY - desiredY);
        const maxScrollable = Math.max(0, el.scrollHeight - el.clientHeight);
        const neededTailSpace = Math.max(0, rawTargetTop - maxScrollable + INPUT_SAFE_GAP);
        tailSpacer.style.height = `${neededTailSpace}px`;

        requestAnimationFrame(() => {
          const maxScrollableAfterSpacer = Math.max(0, el.scrollHeight - el.clientHeight);
          const targetTop = Math.min(rawTargetTop, maxScrollableAfterSpacer);
          el.scrollTo({ top: targetTop, behavior: 'smooth' });
          isAtBottom.current = false;
        });
      });
    });
  }, []);

  const restoredTurnWouldOverflowInput = useCallback((userEl: HTMLElement) => {
    const el = ref.current;
    if (!el) return false;
    const lastItemEl = findItemElement(items.length - 1);
    if (!lastItemEl) return false;

    const userRect = userEl.getBoundingClientRect();
    const lastRect = lastItemEl.getBoundingClientRect();
    const latestTurnHeight = Math.max(0, lastRect.bottom - userRect.top);
    const desiredY = Math.floor(el.clientHeight * LATEST_TURN_ANCHOR_RATIO);
    const safeBottomY = getSafeBottomY(el);
    return desiredY + latestTurnHeight >= safeBottomY;
  }, [findItemElement, getSafeBottomY, items.length]);

  const syncLatestTurnScroll = useCallback(() => {
    if (!active) return;
    const el = ref.current;
    const headSpacer = headSpacerRef.current;
    const tailSpacer = tailSpacerRef.current;
    if (!el || !headSpacer || !tailSpacer || items.length === 0) return;

    if (lastUserIndex >= 0 && lastUserId && anchoredUserIdRef.current !== lastUserId) {
      const userEl = findItemElement(lastUserIndex);
      if (!userEl) return;
      anchoredUserIdRef.current = lastUserId;
      followReplyRef.current = false;
      latestTurnAnchorGuardUntil.current = Date.now() + LATEST_TURN_ANCHOR_GUARD_MS;
      if (!isPathStreaming && restoredTurnWouldOverflowInput(userEl)) {
        followReplyRef.current = true;
        latestTurnAnchorGuardUntil.current = 0;
        scrollToBottomAfterSpacerReset();
        return;
      }
      anchorMessageAtRatio(userEl);
      return;
    }

    if (!anchoredUserIdRef.current) {
      if (items.length > 0) scrollToBottom();
      return;
    }

    if (!isPathStreaming && !followReplyRef.current) return;

    const lastItemEl = findItemElement(items.length - 1);
    if (!lastItemEl) return;
    const containerRect = el.getBoundingClientRect();
    const lastRect = lastItemEl.getBoundingClientRect();
    const lastBottomY = lastRect.bottom - containerRect.top;
    const safeBottomY = getSafeBottomY(el);
    const reachedInput = lastBottomY >= safeBottomY;

    if (!followReplyRef.current && Date.now() < latestTurnAnchorGuardUntil.current) return;

    if (!followReplyRef.current && !reachedInput) return;

    followReplyRef.current = true;
    latestTurnAnchorGuardUntil.current = 0;
    scrollToBottomAfterSpacerReset();
  }, [
    active,
    anchorMessageAtRatio,
    findItemElement,
    getSafeBottomY,
    isPathStreaming,
    items.length,
    lastUserId,
    lastUserIndex,
    restoredTurnWouldOverflowInput,
    scrollToBottomAfterSpacerReset,
  ]);

  // scroll 事件维护 isAtBottom 标志
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => checkAtBottom();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // ResizeObserver：内容高度变化时同步最新一轮的 70% 锚点与后续上顶
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (Date.now() < suppressAutoScrollUntil.current) return;
      syncLatestTurnScroll();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [syncLatestTurnScroll]);

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

  // 首次/切回当前 session/消息结构变化时，同步最新一轮位置
  useEffect(() => {
    syncLatestTurnScroll();
  }, [syncLatestTurnScroll]);

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
        <div ref={headSpacerRef} className="chat-session-head-spacer" />
        {items.map((item, i) => {
          const role = item.type === 'message' ? item.data.role : item.type;
          return (
            <div
              key={item.type === 'message' ? item.data.id : `c-${i}`}
              className="chat-session-item"
              data-chat-item-index={i}
              data-chat-role={role}
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
        <div ref={tailSpacerRef} className="chat-session-tail-spacer" />
        <div className="chat-session-footer" />
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
