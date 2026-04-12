/**
 * ChatArea — 聊天消息列表（干净重写版）
 *
 * 原理：每个 session 一个原生滚动 div，visibility:hidden 保持 scrollTop。
 * 不用 Virtuoso，不用 Activity，不用快照，不用任何花活。
 */

import { memo, useRef, useEffect, useState, useMemo } from 'react';
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

function isAssistantMessageItem(item: ChatListItem | undefined): item is Extract<ChatListItem, { type: 'message' }> {
  return !!item && item.type === 'message' && item.data.role === 'assistant';
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
  const isAtBottom = useRef(true);
  const lastAssistantIndex = useMemo(() => {
    for (let idx = items.length - 1; idx >= 0; idx--) {
      if (isAssistantMessageItem(items[idx])) return idx;
    }
    return -1;
  }, [items]);

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

  // scroll 事件维护 isAtBottom 标志
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => checkAtBottom();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // ResizeObserver：内容高度变化 + 在底部 → 自动滚
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (active && isAtBottom.current) {
        scrollToBottom();
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [active]);

  // 首次有内容 → 滚到底
  const scrolledOnce = useRef(false);
  useEffect(() => {
    if (scrolledOnce.current) return;
    if (items.length > 0) {
      scrollToBottom();
      isAtBottom.current = true;
      scrolledOnce.current = true;
    }
  }, [items.length]);

  // 新消息加入 → 强制 sticky（发送消息后自动跟随）
  const prevLen = useRef(items.length);
  useEffect(() => {
    if (items.length > prevLen.current && active) {
      isAtBottom.current = true;
      scrollToBottom();
    }
    prevLen.current = items.length;
  }, [items.length, active]);

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
      style={{
        visibility: active ? 'visible' : 'hidden',
        zIndex: active ? 1 : 0,
        pointerEvents: active ? 'auto' : 'none',
      }}
    >
      <div ref={contentRef} className="chat-session-messages">
        {items.map((item, i) => (
          <ItemView
            key={item.type === 'message' ? item.data.id : `c-${i}`}
            item={item}
            prevItem={i > 0 ? items[i - 1] : undefined}
            isStreamingMessage={isPathStreaming && i === lastAssistantIndex}
            runningMs={isPathStreaming && i === lastAssistantIndex ? runningMs : undefined}
          />
        ))}
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
