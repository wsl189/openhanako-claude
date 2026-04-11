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
import type { ChatListItem, ContentBlock, ChatMessage } from '../../stores/chat-types';

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

type ChainGroupMeta = {
  key: string;
  isOwner: boolean;
  hideTextWhenCollapsed: boolean;
  totalThinking: number;
  totalTools: number;
  allCompleted: boolean;
  allSuccessful: boolean;
  isSettled: boolean;
};

function isChainBlock(block: ContentBlock): boolean {
  return block.type === 'thinking' || block.type === 'tool_group';
}

function isAssistantMessageItem(item: ChatListItem | undefined): item is Extract<ChatListItem, { type: 'message' }> {
  return !!item && item.type === 'message' && item.data.role === 'assistant';
}

function hasTextBlock(msg: ChatMessage): boolean {
  return (msg.blocks || []).some((block) => block.type === 'text');
}

function getMessageChainStats(msg: ChatMessage): {
  hasChain: boolean;
  thinkingCount: number;
  toolCount: number;
  allCompleted: boolean;
  allSuccessful: boolean;
  onlyChainBlocks: boolean;
} {
  const blocks = msg.blocks || [];
  let hasChain = false;
  let thinkingCount = 0;
  let toolCount = 0;
  let allCompleted = true;
  let allSuccessful = true;
  let nonChainCount = 0;

  for (const block of blocks) {
    if (!isChainBlock(block)) {
      nonChainCount += 1;
      continue;
    }
    hasChain = true;
    if (block.type === 'thinking') {
      thinkingCount += 1;
      if (!block.sealed) {
        allCompleted = false;
        allSuccessful = false;
      }
    } else if (block.type === 'tool_group') {
      toolCount += block.tools.length;
      const doneAll = block.tools.every(t => t.done);
      const successAll = block.tools.every(t => t.done && t.success);
      if (!doneAll) allCompleted = false;
      if (!successAll) allSuccessful = false;
    }
  }

  return {
    hasChain,
    thinkingCount,
    toolCount,
    allCompleted,
    allSuccessful,
    onlyChainBlocks: hasChain && nonChainCount === 0,
  };
}

function buildChainGroupMeta(path: string, items: ChatListItem[], isStreaming: boolean): Record<number, ChainGroupMeta> {
  const map: Record<number, ChainGroupMeta> = {};
  let lastAssistantIndex = -1;
  for (let idx = items.length - 1; idx >= 0; idx--) {
    if (isAssistantMessageItem(items[idx])) {
      lastAssistantIndex = idx;
      break;
    }
  }
  let i = 0;

  while (i < items.length) {
    const item = items[i];
    if (!isAssistantMessageItem(item)) {
      i += 1;
      continue;
    }

    const runStart = i;
    let runEnd = i;
    while (runEnd + 1 < items.length && isAssistantMessageItem(items[runEnd + 1])) {
      runEnd += 1;
    }

    const memberIndices: number[] = [];
    let totalThinking = 0;
    let totalTools = 0;
    let allCompleted = true;
    let allSuccessful = true;
    let finalTextIndex = -1;

    for (let j = runStart; j <= runEnd; j++) {
      const runItem = items[j];
      if (!isAssistantMessageItem(runItem)) continue;
      if (hasTextBlock(runItem.data)) finalTextIndex = j;
      const stats = getMessageChainStats(runItem.data);
      if (!stats.hasChain) continue;
      memberIndices.push(j);
      totalThinking += stats.thinkingCount;
      totalTools += stats.toolCount;
      if (!stats.allCompleted) allCompleted = false;
      if (!stats.allSuccessful) allSuccessful = false;
    }

    if (memberIndices.length > 0) {
      const ownerIndex = memberIndices[0];
      const ownerMessageId = isAssistantMessageItem(items[ownerIndex])
        ? items[ownerIndex].data.id
        : `${runStart}`;
      const key = `${path}:${ownerMessageId}`;
      const isSettled = !(isStreaming && runEnd === lastAssistantIndex);
      for (const idx of memberIndices) {
        map[idx] = {
          key,
          isOwner: idx === ownerIndex,
          hideTextWhenCollapsed: finalTextIndex >= 0 && idx !== finalTextIndex,
          totalThinking,
          totalTools,
          allCompleted,
          allSuccessful,
          isSettled,
        };
      }
    }

    i = runEnd + 1;
  }

  return map;
}

const Panel = memo(function Panel({ path, active }: { path: string; active: boolean }) {
  const items = useStore(s => s.chatSessions[path]?.items || []);
  const streamingSessions = useStore(s => s.streamingSessions);
  const isPathStreaming = streamingSessions.includes(path);
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isAtBottom = useRef(true);
  const chainMetaByIndex = useMemo(
    () => buildChainGroupMeta(path, items, isPathStreaming),
    [path, items, isPathStreaming],
  );
  const lastAssistantIndex = useMemo(() => {
    for (let idx = items.length - 1; idx >= 0; idx--) {
      if (isAssistantMessageItem(items[idx])) return idx;
    }
    return -1;
  }, [items]);
  const [chainCollapsedByKey, setChainCollapsedByKey] = useState<Record<string, boolean>>({});
  const chainEligibleByKeyRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    const unique = new Map<string, ChainGroupMeta>();
    for (const meta of Object.values(chainMetaByIndex)) {
      if (!unique.has(meta.key)) unique.set(meta.key, meta);
    }

    setChainCollapsedByKey(prev => {
      const next: Record<string, boolean> = {};
      const nextEligible: Record<string, boolean> = {};
      for (const [key, meta] of unique) {
        // 折叠稳定性：执行链完成（thinking 封口 + tools done）即可折叠，
        // 不再要求“全部成功”，避免失败分支永不自动折叠。
        // 对于仍在流式进行中的尾部 run，延迟显示摘要，避免中途闪烁。
        const eligible = meta.allCompleted && meta.isSettled;
        const wasEligible = !!chainEligibleByKeyRef.current[key];
        nextEligible[key] = eligible;

        if (Object.prototype.hasOwnProperty.call(prev, key)) {
          // 在“回复完成”这个状态跃迁点，自动折叠一次。
          next[key] = (!wasEligible && eligible) ? true : prev[key];
        } else {
          next[key] = eligible;
        }
      }
      chainEligibleByKeyRef.current = nextEligible;
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (prevKeys.length !== nextKeys.length) return next;
      for (const k of nextKeys) {
        if (!Object.prototype.hasOwnProperty.call(prev, k)) return next;
        if (prev[k] !== next[k]) return next;
      }
      return prev;
    });
  }, [chainMetaByIndex]);

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

  if (items.length === 0) return null;

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
}: {
  item: ChatListItem;
  prevItem?: ChatListItem;
  isStreamingMessage?: boolean;
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
    />
  );
});
