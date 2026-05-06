import type { ChatListItem, ChatMessage, ContentBlock } from '../stores/chat-types';

type MessageItem = Extract<ChatListItem, { type: 'message' }>;

function getLastTextBlockIndex(blocks: ContentBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i]?.type === 'text') return i;
  }
  return -1;
}

function collectLiveChainBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const finalTextIndex = getLastTextBlockIndex(blocks);
  return blocks.filter((block, index) => {
    if (block.type === 'thinking' || block.type === 'tool_group') return true;
    if (block.type === 'text') return finalTextIndex >= 0 && index !== finalTextIndex;
    return false;
  });
}

function collectCanonicalReplyBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const finalTextIndex = getLastTextBlockIndex(blocks);
  return blocks.filter((block, index) => {
    if (block.type === 'thinking' || block.type === 'tool_group') return false;
    if (block.type === 'text') return finalTextIndex < 0 || index === finalTextIndex;
    return true;
  });
}

function countThinkingBlocks(blocks: ContentBlock[]): number {
  return blocks.reduce((count, block) => (block.type === 'thinking' ? count + 1 : count), 0);
}

export function mergeCanonicalAssistantBlocks(
  liveBlocks: ContentBlock[],
  canonicalBlocks: ContentBlock[],
): ContentBlock[] {
  const safeLiveBlocks = Array.isArray(liveBlocks) ? liveBlocks : [];
  const safeCanonicalBlocks = Array.isArray(canonicalBlocks) ? canonicalBlocks : [];
  if (safeCanonicalBlocks.length === 0) return safeLiveBlocks;

  const liveChainBlocks = collectLiveChainBlocks(safeLiveBlocks);
  if (liveChainBlocks.length === 0) return safeCanonicalBlocks;

  const liveThinkingCount = countThinkingBlocks(safeLiveBlocks);
  const canonicalThinkingCount = countThinkingBlocks(safeCanonicalBlocks);
  if (canonicalThinkingCount >= liveThinkingCount && canonicalThinkingCount > 0) {
    return safeCanonicalBlocks;
  }

  const canonicalReplyBlocks = collectCanonicalReplyBlocks(safeCanonicalBlocks);
  if (canonicalReplyBlocks.length === 0) return safeLiveBlocks;

  return [...liveChainBlocks, ...canonicalReplyBlocks];
}

function isMessageItem(item: ChatListItem | undefined): item is MessageItem {
  return !!item && item.type === 'message';
}

function isAssistantMessageItem(item: ChatListItem | undefined): item is MessageItem {
  return isMessageItem(item) && item.data.role === 'assistant';
}

function isUserMessageItem(item: ChatListItem | undefined): item is MessageItem {
  return isMessageItem(item) && item.data.role === 'user';
}

function findLastMessageIndexByRole(
  items: ChatListItem[] | undefined,
  role: ChatMessage['role'],
): number {
  const list = Array.isArray(items) ? items : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (item?.type === 'message' && item.data.role === role) {
      return i;
    }
  }
  return -1;
}

function flattenAssistantBlocks(items: ChatListItem[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const item of items) {
    if (!isAssistantMessageItem(item)) continue;
    const messageBlocks = Array.isArray(item.data.blocks) ? item.data.blocks : [];
    blocks.push(...messageBlocks);
  }
  return blocks;
}

function buildMergedAssistantMessage(
  liveItems: ChatListItem[],
  canonicalItems: ChatListItem[],
): MessageItem | null {
  const liveAssistant = findLastAssistantMessageItem(liveItems);
  const canonicalAssistant = findLastAssistantMessageItem(canonicalItems);
  const baseMessage = canonicalAssistant?.data || liveAssistant?.data;
  if (!baseMessage) return null;

  const mergedBlocks = mergeCanonicalAssistantBlocks(
    flattenAssistantBlocks(liveItems),
    flattenAssistantBlocks(canonicalItems),
  );

  return {
    type: 'message',
    data: {
      ...baseMessage,
      blocks: mergedBlocks,
    },
  };
}

export function mergeCanonicalTurnItems(
  liveItems: ChatListItem[] | undefined,
  canonicalItems: ChatListItem[] | undefined,
): ChatListItem[] | null {
  const liveList = Array.isArray(liveItems) ? liveItems : [];
  const canonicalList = Array.isArray(canonicalItems) ? canonicalItems : [];
  if (canonicalList.length === 0) return liveList.length ? liveList : null;

  const liveLastUserIndex = findLastMessageIndexByRole(liveList, 'user');
  const canonicalLastUserIndex = findLastMessageIndexByRole(canonicalList, 'user');
  if (liveLastUserIndex < 0 || canonicalLastUserIndex < 0) {
    const mergedAssistant = buildMergedAssistantMessage(liveList, canonicalList);
    if (!mergedAssistant) return canonicalList;
    return [...canonicalList.filter((item) => !isAssistantMessageItem(item)), mergedAssistant];
  }

  const liveLastUser = liveList[liveLastUserIndex];
  const canonicalLastUser = canonicalList[canonicalLastUserIndex];
  if (!isUserMessageItem(liveLastUser) || !isUserMessageItem(canonicalLastUser)) {
    return canonicalList;
  }

  const liveUserText = String(liveLastUser.data.text || '').trim();
  const canonicalUserText = String(canonicalLastUser.data.text || '').trim();
  if (liveUserText && canonicalUserText && liveUserText !== canonicalUserText) {
    return canonicalList;
  }

  const liveTurnItems = liveList.slice(liveLastUserIndex + 1);
  const canonicalTurnItems = canonicalList.slice(canonicalLastUserIndex + 1);
  const liveAssistantTail = liveTurnItems.filter(isAssistantMessageItem);
  const canonicalAssistantTail = canonicalTurnItems.filter(isAssistantMessageItem);

  if (liveAssistantTail.length === 0 && canonicalAssistantTail.length === 0) {
    return canonicalList;
  }

  const mergedAssistant = buildMergedAssistantMessage(liveAssistantTail, canonicalAssistantTail);
  if (!mergedAssistant) return canonicalList;

  const canonicalTailExtras = canonicalTurnItems.filter((item) => !isAssistantMessageItem(item));
  return [
    ...canonicalList.slice(0, canonicalLastUserIndex + 1),
    ...canonicalTailExtras,
    mergedAssistant,
  ];
}

export function findLastAssistantMessageItem(
  items: ChatListItem[] | undefined,
): Extract<ChatListItem, { type: 'message' }> | null {
  const list = Array.isArray(items) ? items : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (item?.type === 'message' && item.data.role === 'assistant') {
      return item;
    }
  }
  return null;
}
