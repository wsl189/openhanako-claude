/**
 * AssistantMessage — 助手消息，遍历 ContentBlock 按类型渲染
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { MoodBlock } from './MoodBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolGroupBlock } from './ToolGroupBlock';
import { XingCard } from './XingCard';
import { SettingsConfirmCard } from './SettingsConfirmCard';
import type { ChatMessage, ContentBlock } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useSmoothStream } from '../../hooks/use-smooth-stream';
import { useI18n } from '../../hooks/use-i18n';
import { openFilePreview, openSkillPreview, readFileForPreview } from '../../utils/file-preview';
import { openPreview } from '../../stores/artifact-actions';
import { normalizeAgentDisplayName } from '../../utils/agent-helpers';
import { cronToHuman } from '../../utils/format';
import { renderMarkdown } from '../../utils/markdown';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
  message: ChatMessage;
  showAvatar: boolean;
  isStreaming?: boolean;
  runningMs?: number;
}

function normalizeToolName(name: string): string {
  return String(name || '').trim().toLowerCase();
}

function removeRedundantOutputToolLines(blocks: ContentBlock[]): ContentBlock[] {
  if (!Array.isArray(blocks) || blocks.length === 0) return blocks;

  const hasCronCard = blocks.some((block) => block.type === 'cron_confirm');
  const hasAskUserCard = blocks.some((block) => block.type === 'ask_user_confirm');
  const hasFileCard = blocks.some((block) => block.type === 'file_output');
  const hasArtifactCard = blocks.some((block) => block.type === 'artifact');
  const hasImageCard = blocks.some((block) => block.type === 'browser_screenshot');
  const hasPlanModeCard = blocks.some((block) => block.type === 'plan_mode_confirm');

  const shouldHideToolLine = (toolName: string): boolean => {
    const name = normalizeToolName(toolName);
    if (name === 'cron') return hasCronCard;
    if (name === 'askuserquestion') return hasAskUserCard;
    if (name === 'present_files') return hasFileCard;
    if (name === 'create_artifact') return hasArtifactCard;
    if (name === 'generate_images') return hasImageCard;
    if (name === 'enterplanmode' || name === 'exitplanmode') return hasPlanModeCard;
    return false;
  };

  const next: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type !== 'tool_group') {
      next.push(block);
      continue;
    }
    const tools = block.tools.filter((tool) => !shouldHideToolLine(tool.name));
    if (tools.length === 0) continue;
    next.push({ ...block, tools });
  }
  return next;
}

function isCoreChainBlock(block: ContentBlock): boolean {
  return block.type === 'thinking' || block.type === 'tool_group';
}

function formatChainDuration(ms: number): string {
  const sec = Math.max(0, ms) / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const minutes = Math.floor(sec / 60);
  const seconds = sec - minutes * 60;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

const CHAIN_AUTO_COLLAPSE_DELAY_MS = 1200;
const BLOCK_REVEAL_BASE_DELAY_MS = 180;
const BLOCK_REVEAL_MAX_DELAY_MS = 1_200;
const THINKING_BLOCK_REVEAL_MIN_DELAY_MS = 420;
const TOOL_BLOCK_REVEAL_MIN_DELAY_MS = 520;
const THINK_TO_TOOL_REVEAL_PAUSE_MS = 980;
const THINK_TO_INTERMEDIATE_TEXT_REVEAL_PAUSE_MS = 560;
const TOOL_TO_INTERMEDIATE_TEXT_REVEAL_PAUSE_MS = 460;
const THINK_TO_FINAL_REPLY_REVEAL_PAUSE_MS = 820;
const TOOL_TO_FINAL_REPLY_REVEAL_PAUSE_MS = 680;
const FRESH_CHAIN_REVEAL_WINDOW_MS = 20_000;
const FINAL_TEXT_SETTLE_MIN_MS = 420;
const FINAL_TEXT_SETTLE_MAX_MS = 2200;

function getBlockRevealDelayMs(params: {
  prevBlock?: ContentBlock;
  nextBlock?: ContentBlock;
  remaining: number;
}): number {
  const { prevBlock, nextBlock, remaining } = params;
  // 运行中的 thinking 块优先尽快出现，先给用户“思考中”状态反馈。
  if (nextBlock?.type === 'thinking' && nextBlock.sealed === false) {
    return 24;
  }

  let delay = BLOCK_REVEAL_BASE_DELAY_MS + Math.min(4, Math.max(0, remaining)) * 24;

  if (nextBlock?.type === 'thinking') {
    delay = Math.max(delay, THINKING_BLOCK_REVEAL_MIN_DELAY_MS);
  } else if (nextBlock?.type === 'tool_group') {
    delay = Math.max(delay, TOOL_BLOCK_REVEAL_MIN_DELAY_MS);
  }

  if (prevBlock?.type === 'thinking' && nextBlock?.type === 'tool_group') {
    delay = Math.max(delay, THINK_TO_TOOL_REVEAL_PAUSE_MS);
  }
  // 给“最后一次思考/工具 -> 最终回复”留出更平滑的过渡间隔。
  if (nextBlock?.type === 'text' && remaining <= 1) {
    if (prevBlock?.type === 'thinking') {
      delay = Math.max(delay, THINK_TO_FINAL_REPLY_REVEAL_PAUSE_MS);
    } else if (prevBlock?.type === 'tool_group') {
      delay = Math.max(delay, TOOL_TO_FINAL_REPLY_REVEAL_PAUSE_MS);
    }
  }
  if (nextBlock?.type === 'text' && remaining > 1) {
    if (prevBlock?.type === 'thinking') {
      delay = Math.max(delay, THINK_TO_INTERMEDIATE_TEXT_REVEAL_PAUSE_MS);
    } else if (prevBlock?.type === 'tool_group') {
      delay = Math.max(delay, TOOL_TO_INTERMEDIATE_TEXT_REVEAL_PAUSE_MS);
    }
  }

  return Math.min(BLOCK_REVEAL_MAX_DELAY_MS, delay);
}

export const AssistantMessage = memo(function AssistantMessage({ message, showAvatar, isStreaming = false, runningMs }: Props) {
  const agentName = useStore(s => s.agentName) || 'Hanako';
  const agentYuan = useStore(s => s.agentYuan) || 'hanako';
  const agentAvatarUrl = useStore(s => s.agentAvatarUrl);
  const sessionAgent = useStore(s => s.sessionAgent);
  const agents = useStore(s => s.agents);
  const [avatarFailed, setAvatarFailed] = useState(false);

  // 非主 agent session 用 sessionAgent 信息
  const rawDisplayName = sessionAgent?.name || agentName;
  const knownAgentNames = useMemo(() => {
    const names: string[] = [];
    for (const a of agents || []) {
      if (a?.id) names.push(String(a.id));
      if (a?.name) names.push(String(a.name));
    }
    if (agentName) names.push(agentName);
    if (sessionAgent?.name) names.push(sessionAgent.name);
    return names;
  }, [agents, agentName, sessionAgent?.name]);
  const displayName = useMemo(
    () => normalizeAgentDisplayName(rawDisplayName, knownAgentNames),
    [rawDisplayName, knownAgentNames],
  );
  const displayYuan = sessionAgent?.yuan || agentYuan;
  const fallbackAvatar = useMemo(() => {
    const types = (window as any).t?.('yuan.types') || {};
    const entry = types[displayYuan] || types.hanako;
    return `assets/${entry?.avatar || 'Hanako.png'}`;
  }, [displayYuan]);
  const avatarSrc = sessionAgent
    ? (sessionAgent.avatarUrl || fallbackAvatar)
    : (agentAvatarUrl || fallbackAvatar);

  useEffect(() => {
    setAvatarFailed(false);
  }, [sessionAgent?.avatarUrl, agentAvatarUrl, fallbackAvatar]);

  const blocks = message.blocks || [];
  const isLiveStreamMessage = isStreaming || String(message.id || '').startsWith('stream-');
  const displayBlocks = useMemo(() => removeRedundantOutputToolLines(blocks), [blocks]);
  // 运行中但尚未收到 thinking 文本时，不渲染空壳 thinking 块，避免“先出 THINKING 再出内容”。
  const renderBlocks = useMemo(
    () => displayBlocks.filter((block) => !(
      block.type === 'thinking'
      && block.sealed === false
      && !String(block.content || '').trim()
    )),
    [displayBlocks],
  );
  const hasChainLikeBlocks = useMemo(
    () => renderBlocks.length > 1 && renderBlocks.some((block) => block.type === 'thinking' || block.type === 'tool_group'),
    [renderBlocks],
  );
  const messageHasTimestamp = typeof message.timestamp === 'number';
  const isRecentAssistantMessage = useMemo(() => {
    if (!messageHasTimestamp) return false;
    return Date.now() - (message.timestamp as number) < FRESH_CHAIN_REVEAL_WINDOW_MS;
  }, [message.id, message.timestamp, messageHasTimestamp]);
  // 仅在“可确认是最近消息”时才做历史链路渐进回放。
  // 历史消息缺少 timestamp 时，不应触发展开/收起动画，否则重启后会出现逐条展开再收起。
  const shouldTreatAsFreshChain = hasChainLikeBlocks && messageHasTimestamp && isRecentAssistantMessage;
  const shouldProgressiveReveal = isLiveStreamMessage || shouldTreatAsFreshChain;
  const [revealedBlockCount, setRevealedBlockCount] = useState(() => (
    shouldProgressiveReveal ? Math.min(1, renderBlocks.length) : renderBlocks.length
  ));
  const prevRevealMessageIdRef = useRef(message.id);

  useEffect(() => {
    if (prevRevealMessageIdRef.current === message.id) return;
    prevRevealMessageIdRef.current = message.id;
    setRevealedBlockCount(shouldProgressiveReveal ? Math.min(1, renderBlocks.length) : renderBlocks.length);
  }, [message.id, shouldProgressiveReveal, renderBlocks.length]);

  useEffect(() => {
    if (revealedBlockCount > renderBlocks.length) {
      setRevealedBlockCount(renderBlocks.length);
      return;
    }
    if (revealedBlockCount >= renderBlocks.length) return;

    const remaining = renderBlocks.length - revealedBlockCount;
    const prevBlock = revealedBlockCount > 0 ? renderBlocks[revealedBlockCount - 1] : undefined;
    const nextBlock = renderBlocks[revealedBlockCount];
    const delay = getBlockRevealDelayMs({ prevBlock, nextBlock, remaining });
    const timer = window.setTimeout(() => {
      setRevealedBlockCount((count) => Math.min(renderBlocks.length, count + 1));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [isLiveStreamMessage, renderBlocks.length, revealedBlockCount]);

  const visibleBlocks = useMemo(
    () => renderBlocks.slice(0, Math.max(0, revealedBlockCount)),
    [renderBlocks, revealedBlockCount],
  );
  const showStreamingIntro = isStreaming && visibleBlocks.length === 0;

  const finalTextIndex = useMemo(() => {
    for (let i = visibleBlocks.length - 1; i >= 0; i--) {
      if (visibleBlocks[i].type === 'text') return i;
    }
    return -1;
  }, [visibleBlocks]);
  const hasPrimaryText = finalTextIndex >= 0;
  const isAutoCollapsibleChainBlock = useCallback((block: ContentBlock, index: number) => {
    if (isCoreChainBlock(block)) return true;
    if (!hasPrimaryText) return false;
    return block.type === 'text' && index !== finalTextIndex;
  }, [hasPrimaryText, finalTextIndex]);
  const chainBlocks = useMemo(
    () => visibleBlocks.filter((block, index) => isAutoCollapsibleChainBlock(block, index)),
    [visibleBlocks, isAutoCollapsibleChainBlock],
  );
  const displayFinalTextIndex = useMemo(() => {
    for (let i = renderBlocks.length - 1; i >= 0; i--) {
      if (renderBlocks[i].type === 'text') return i;
    }
    return -1;
  }, [renderBlocks]);
  const summaryCountingBlocks = useMemo(() => {
    return renderBlocks.filter((block, index) => {
      if (isCoreChainBlock(block)) return true;
      if (block.type !== 'text') return false;
      if (displayFinalTextIndex < 0) return true;
      return index !== displayFinalTextIndex;
    });
  }, [renderBlocks, displayFinalTextIndex]);
  const hasCollapsibleChain = hasPrimaryText && chainBlocks.length > 0;
  const [chainSummaryPinned, setChainSummaryPinned] = useState(
    () => isStreaming || hasCollapsibleChain || chainBlocks.length > 0,
  );
  const showChainSummary = chainSummaryPinned || isStreaming || hasCollapsibleChain || chainBlocks.length > 0;
  const [chainExpanded, setChainExpanded] = useState(() => isStreaming);
  const chainCollapseTimerRef = useRef<number | null>(null);
  const prevMessageIdRef = useRef(message.id);
  const autoCollapseArmedRef = useRef(isStreaming);
  const didAutoCollapseRef = useRef(false);
  const [chainElapsedMsFrozen, setChainElapsedMsFrozen] = useState<number | null>(
    typeof runningMs === 'number' && runningMs >= 0 ? runningMs : null,
  );

  const clearChainCollapseTimer = useCallback(() => {
    if (chainCollapseTimerRef.current == null) return;
    window.clearTimeout(chainCollapseTimerRef.current);
    chainCollapseTimerRef.current = null;
  }, []);

  useEffect(() => () => {
    clearChainCollapseTimer();
  }, [clearChainCollapseTimer]);

  useEffect(() => {
    if (prevMessageIdRef.current === message.id) return;
    prevMessageIdRef.current = message.id;
    clearChainCollapseTimer();
    autoCollapseArmedRef.current = isStreaming;
    didAutoCollapseRef.current = false;
    setChainSummaryPinned(isStreaming || hasCollapsibleChain || chainBlocks.length > 0);
    setChainExpanded(showChainSummary ? isStreaming : false);
    setChainElapsedMsFrozen(typeof runningMs === 'number' && runningMs >= 0 ? runningMs : null);
  }, [
    message.id,
    showChainSummary,
    isStreaming,
    runningMs,
    hasCollapsibleChain,
    chainBlocks.length,
    clearChainCollapseTimer,
  ]);

  useEffect(() => {
    if (!chainSummaryPinned && (isStreaming || hasCollapsibleChain || chainBlocks.length > 0)) {
      setChainSummaryPinned(true);
    }
  }, [chainSummaryPinned, isStreaming, hasCollapsibleChain, chainBlocks.length]);

  useEffect(() => {
    if (typeof runningMs === 'number' && runningMs >= 0) {
      setChainElapsedMsFrozen(runningMs);
    }
  }, [runningMs]);

  useEffect(() => {
    clearChainCollapseTimer();

    if (!showChainSummary) {
      setChainExpanded(false);
      return;
    }

    if (isStreaming) {
      setChainExpanded(true);
      autoCollapseArmedRef.current = true;
      didAutoCollapseRef.current = false;
      return;
    }

    if (!autoCollapseArmedRef.current || didAutoCollapseRef.current) return;
    if (!hasCollapsibleChain || !hasPrimaryText) return;

    chainCollapseTimerRef.current = window.setTimeout(() => {
      setChainExpanded(false);
      didAutoCollapseRef.current = true;
      chainCollapseTimerRef.current = null;
    }, CHAIN_AUTO_COLLAPSE_DELAY_MS);
  }, [showChainSummary, hasCollapsibleChain, hasPrimaryText, isStreaming, clearChainCollapseTimer]);

  const chainThinkingCount = useMemo(
    () => summaryCountingBlocks.filter((block) => block.type === 'thinking').length,
    [summaryCountingBlocks],
  );
  const chainToolCount = useMemo(
    () => summaryCountingBlocks.reduce((sum, block) => (
      block.type === 'tool_group' ? sum + block.tools.length : sum
    ), 0),
    [summaryCountingBlocks],
  );
  const chainElapsedMs = (typeof runningMs === 'number' && runningMs >= 0)
    ? runningMs
    : chainElapsedMsFrozen;
  const chainSummaryText = useMemo(() => {
    return `思考和执行链（${chainThinkingCount}次思考 · ${chainToolCount}次工具执行）`;
  }, [chainThinkingCount, chainToolCount]);
  const finalTextBlock = finalTextIndex >= 0 && visibleBlocks[finalTextIndex].type === 'text'
    ? visibleBlocks[finalTextIndex]
    : null;
  const finalTextHtml = finalTextBlock?.html || '';
  const finalTextRaw = finalTextBlock?.raw || '';
  const [replayFinalText, setReplayFinalText] = useState(
    () => isLiveStreamMessage && !isStreaming && !!finalTextRaw,
  );
  const prevFinalRawRef = useRef(finalTextRaw);

  useEffect(() => {
    const prev = prevFinalRawRef.current;
    prevFinalRawRef.current = finalTextRaw;
    if (!isLiveStreamMessage || !finalTextRaw) {
      setReplayFinalText(false);
      return;
    }
    if (isStreaming) {
      setReplayFinalText(false);
      return;
    }
    if (finalTextRaw !== prev) {
      setReplayFinalText(true);
    }
  }, [finalTextRaw, isLiveStreamMessage, isStreaming]);

  useEffect(() => {
    if (!replayFinalText) return;
    const duration = Math.min(
      FINAL_TEXT_SETTLE_MAX_MS,
      Math.max(FINAL_TEXT_SETTLE_MIN_MS, Math.ceil(finalTextRaw.length * 12)),
    );
    const timer = window.setTimeout(() => setReplayFinalText(false), duration);
    return () => window.clearTimeout(timer);
  }, [replayFinalText, finalTextRaw.length]);

  const canSmoothFinalText = finalTextRaw.length > 0 && finalTextRaw.length <= 8_000;
  const smoothFinalTextStreaming = canSmoothFinalText && (isStreaming || replayFinalText);
  const { displayedContent: smoothedFinalTextRaw } = useSmoothStream({
    content: finalTextRaw,
    isStreaming: smoothFinalTextStreaming,
    minDelay: 24,
    startFromEmptyWhenStreaming: smoothFinalTextStreaming,
  });
  const finalDisplayHtml = useMemo(() => {
    if (!finalTextRaw || !canSmoothFinalText) return finalTextHtml;
    if (!smoothFinalTextStreaming) return finalTextHtml;
    return renderMarkdown(smoothedFinalTextRaw);
  }, [finalTextRaw, finalTextHtml, canSmoothFinalText, smoothFinalTextStreaming, smoothedFinalTextRaw]);

  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!finalDisplayHtml) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = finalDisplayHtml;
    const text = tmp.innerText.trim();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [finalDisplayHtml]);

  if (visibleBlocks.length === 0 && !showChainSummary) return null;

  return (
    <div className="message-group assistant">
      {showAvatar && (
        <div className={`avatar-row assistant${showStreamingIntro ? ' streaming-intro' : ''}`}>
          {!avatarFailed ? (
            <img
              className="avatar hana-avatar"
              src={avatarSrc}
              alt={displayName}
              draggable={false}
              onError={(e) => {
                const img = e.target as HTMLImageElement;
                if (img.src.endsWith(fallbackAvatar)) {
                  img.onerror = null;
                  setAvatarFailed(true);
                  return;
                }
                img.onerror = null;
                img.src = fallbackAvatar;
              }}
            />
          ) : (
            <span className="avatar user-avatar">🌸</span>
          )}
          <span className="avatar-name">{displayName}</span>
        </div>
      )}
      <div className="message assistant">
        {showChainSummary && (
          <button
            type="button"
            className="chain-summary"
            onClick={() => {
              clearChainCollapseTimer();
              setChainExpanded((prev) => !prev);
            }}
            aria-expanded={chainExpanded}
          >
            <span className="chain-summary-arrow">{chainExpanded ? '▾' : '▸'}</span>
            <span className="chain-summary-text">{chainSummaryText}</span>
            {typeof chainElapsedMs === 'number' && chainElapsedMs >= 0 && (
              <span className="chain-summary-elapsed">{formatChainDuration(chainElapsedMs)}</span>
            )}
            <span className="chain-summary-status">{chainExpanded ? '已展开' : '已折叠'}</span>
          </button>
        )}
        {visibleBlocks.map((block, i) => {
          if (isAutoCollapsibleChainBlock(block, i)) {
            const chainVisible = !showChainSummary || chainExpanded;
            return (
              <div
                key={i}
                className={`chain-collapsible${chainVisible ? ' expanded' : ' collapsed'}`}
                aria-hidden={showChainSummary ? !chainExpanded : undefined}
              >
                <div className="chain-collapsible-inner">
                  <ContentBlockView
                    block={block}
                    agentName={displayName}
                    yuan={displayYuan}
                    dimmed={hasPrimaryText && block.type !== 'text'}
                    animate={isLiveStreamMessage}
                    runningMs={runningMs}
                  />
                </div>
              </div>
            );
          }

          const isFinalTextBlock = block.type === 'text' && i === finalTextIndex;
          if (isFinalTextBlock) {
            return (
              <div key={i} className={`assistant-final-reply${(isStreaming || replayFinalText) ? ' streaming' : ''}`}>
                <MarkdownContent
                  html={finalDisplayHtml || block.html}
                  className={(isStreaming || replayFinalText) ? 'md-content stream-live' : 'md-content'}
                />
                <button
                  className={`msg-copy-btn${copied ? ' copied' : ''}`}
                  onClick={handleCopy}
                  title={t('common.copyText')}
                  aria-label={t('common.copyText')}
                  type="button"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    {copied
                      ? <polyline points="20 6 9 17 4 12" />
                      : <>
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </>
                    }
                  </svg>
                </button>
              </div>
            );
          }
          return (
            <ContentBlockView
              key={i}
              block={block}
              agentName={displayName}
              yuan={displayYuan}
              dimmed={hasPrimaryText && block.type !== 'text'}
              animate={isLiveStreamMessage}
              runningMs={runningMs}
            />
          );
        })}
      </div>
    </div>
  );
});

// ── ContentBlock 分发 ──

const ContentBlockView = memo(function ContentBlockView({ block, agentName, yuan, dimmed, animate, runningMs }: {
  block: ContentBlock;
  agentName: string;
  yuan: string;
  dimmed?: boolean;
  animate?: boolean;
  runningMs?: number;
}) {
  switch (block.type) {
    case 'thinking':
      return <ThinkingBlock content={block.content} sealed={block.sealed} dimmed={!!dimmed} streamLike={!!animate} runningMs={runningMs} />;
    case 'mood':
      return <MoodBlock yuan={block.yuan} text={block.text} />;
    case 'tool_group':
      return <ToolGroupBlock tools={block.tools} agentName={agentName} dimmed={!!dimmed} animate={!!animate} />;
    case 'text':
      return <MarkdownContent html={block.html} />;
    case 'xing':
      return <XingCard title={block.title} content={block.content} sealed={block.sealed} agentName={agentName} />;
    case 'file_output':
      return <FileOutputCard filePath={block.filePath} label={block.label} ext={block.ext} />;
    case 'artifact':
      return <ArtifactCard title={block.title} artifactType={block.artifactType} artifactId={block.artifactId} content={block.content} language={block.language} />;
    case 'browser_screenshot':
      return <BrowserScreenshot base64={block.base64} mimeType={block.mimeType} />;
    case 'skill':
      return <SkillCard skillName={block.skillName} skillFilePath={block.skillFilePath} />;
    case 'cron_confirm':
      return <CronConfirmCard confirmId={(block as any).confirmId} jobData={block.jobData} status={block.status} />;
    case 'ask_user_confirm':
      return null;
    case 'plan_mode_confirm':
      return null;
    case 'settings_confirm':
      return <SettingsConfirmCard {...block} />;
    default:
      return null;
  }
});

// ── 简单子块组件 ──

const EXT_LABELS: Record<string, string> = {
  pdf: 'PDF', doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel',
  ppt: 'Presentation', pptx: 'Presentation', md: 'Markdown', txt: 'Text',
  html: 'HTML', htm: 'HTML', css: 'Stylesheet', json: 'JSON', yaml: 'YAML', yml: 'YAML',
  js: 'JavaScript', ts: 'TypeScript', jsx: 'React', tsx: 'React',
  py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', rb: 'Ruby', php: 'PHP',
  c: 'C', cpp: 'C++', h: 'Header', sh: 'Shell', sql: 'SQL', xml: 'XML',
  csv: 'CSV', svg: 'SVG', skill: 'Skill',
  png: 'Image', jpg: 'Image', jpeg: 'Image', gif: 'Image', webp: 'Image',
};

const LIGHTBOX_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const LIGHTBOX_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

function resolveLightboxMime(ext: string): string {
  return LIGHTBOX_MIME_BY_EXT[ext] || 'image/png';
}

const LIGHTBOX_MIN_SCALE = 0.25;
const LIGHTBOX_MAX_SCALE = 6;
const LIGHTBOX_WHEEL_SPEED = 0.0025;
const LIGHTBOX_PINCH_WHEEL_SPEED = 0.004;

function clampLightboxScale(value: number): number {
  return Math.min(LIGHTBOX_MAX_SCALE, Math.max(LIGHTBOX_MIN_SCALE, value));
}

const FileOutputCard = memo(function FileOutputCard({ filePath, label, ext }: { filePath: string; label: string; ext: string }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState('');
  const [loadingLightbox, setLoadingLightbox] = useState(false);
  const normalizedExt = String(ext || '').toLowerCase();
  const isImageFile = LIGHTBOX_IMAGE_EXTS.has(normalizedExt);

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    const p = (window as any).platform;
    if (p?.openFile) p.openFile(filePath);
  };

  const handleCardClick = useCallback(async () => {
    if (!isImageFile) {
      await openFilePreview(filePath, label, ext);
      return;
    }

    if (lightboxSrc) {
      setLightboxOpen(true);
      return;
    }

    setLoadingLightbox(true);
    try {
      const base64 = await readFileForPreview(filePath, normalizedExt);
      if (!base64) {
        await openFilePreview(filePath, label, ext);
        return;
      }
      const mime = resolveLightboxMime(normalizedExt);
      setLightboxSrc(`data:${mime};base64,${base64}`);
      setLightboxOpen(true);
    } finally {
      setLoadingLightbox(false);
    }
  }, [isImageFile, filePath, label, ext, lightboxSrc, normalizedExt]);

  const displayName = label || filePath.split('/').pop() || filePath;
  const typeLabel = EXT_LABELS[ext] || ext.toUpperCase();

  return (
    <>
      <div
        className="file-output-card file-output-previewable"
        onClick={() => { void handleCardClick(); }}
        style={{ cursor: isImageFile ? 'zoom-in' : 'pointer' }}
      >
        <div className="file-output-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </div>
        <div className="file-output-info">
          <div className="file-output-name">
            {displayName}
            {loadingLightbox ? ' …' : ''}
          </div>
          <div className="file-output-type">{typeLabel}{ext ? ` \u00b7 ${ext.toUpperCase()}` : ''}</div>
        </div>
        <button className="file-output-open" onClick={handleOpen} title={(window as any).t('desk.openWithDefault')}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </button>
      </div>
      <ImageLightbox
        open={lightboxOpen}
        src={lightboxSrc}
        alt={displayName}
        onClose={() => setLightboxOpen(false)}
      />
    </>
  );
});

const ArtifactCard = memo(function ArtifactCard({ title, artifactType, artifactId, content, language }: {
  title: string; artifactType: string; artifactId: string; content: string; language?: string;
}) {
  const handleClick = () => {
    const artifact = { id: artifactId, type: artifactType, title, content, language };
    const s = useStore.getState();
    const arts = [...s.artifacts];
    const idx = arts.findIndex(a => a.id === artifactId);
    if (idx >= 0) arts[idx] = artifact;
    else arts.push(artifact);
    s.setArtifacts(arts);
    openPreview(artifact);
  };

  return (
    <div className="artifact-inline-card" onClick={handleClick} style={{ cursor: 'pointer' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
      </svg>
      <span>{title || artifactType}</span>
    </div>
  );
});

const SkillCard = memo(function SkillCard({ skillName, skillFilePath }: { skillName: string; skillFilePath: string }) {
  return (
    <div className="skill-card" onClick={() => openSkillPreview(skillName, skillFilePath)} style={{ cursor: 'pointer' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
      <span>{skillName}</span>
    </div>
  );
});

const BrowserScreenshot = memo(function BrowserScreenshot({ base64, mimeType }: { base64: string; mimeType: string }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const openLightbox = useCallback(() => setLightboxOpen(true), [setLightboxOpen]);
  const closeLightbox = useCallback(() => setLightboxOpen(false), [setLightboxOpen]);
  const src = `data:${mimeType};base64,${base64}`;

  return (
    <>
      <div className="browser-screenshot" onClick={openLightbox} style={{ cursor: 'zoom-in' }}>
        <img src={src} alt={(window as any).t('chat.browserScreenshot')} />
      </div>
      <ImageLightbox
        open={lightboxOpen}
        src={src}
        alt={(window as any).t('chat.browserScreenshot')}
        onClose={closeLightbox}
      />
    </>
  );
});

const ImageLightbox = memo(function ImageLightbox({
  open,
  src,
  alt,
  onClose,
}: {
  open: boolean;
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    if (!open) return;
    setScale(1);
  }, [open, src]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const handleWheelZoom = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const speed = e.ctrlKey ? LIGHTBOX_PINCH_WHEEL_SPEED : LIGHTBOX_WHEEL_SPEED;
    const factor = Math.exp(-e.deltaY * speed);
    setScale(prev => clampLightboxScale(prev * factor));
  }, []);

  if (!open || !src) return null;

  return (
    <div
      className="chat-image-lightbox"
      onWheel={handleWheelZoom}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
    >
      <button
        className="chat-image-lightbox-close"
        type="button"
        onClick={onClose}
        aria-label={(window as any).t('common.close')}
        title={(window as any).t('common.close')}
      >
        ×
      </button>
      <img
        className="chat-image-lightbox-img"
        src={src}
        alt={alt}
        style={{ transform: `scale(${scale})` }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
});

type AskUserQuestionCardItem = {
  id: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
};

const AskUserConfirmCard = memo(function AskUserConfirmCard({
  confirmId,
  questions,
  status: initialStatus,
}: {
  confirmId: string;
  questions: AskUserQuestionCardItem[];
  status: 'pending' | 'confirmed' | 'rejected' | 'timeout';
}) {
  const [status, setStatus] = useState(initialStatus);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const isZh = String((window as any).i18n?.locale || '').startsWith('zh');

  useEffect(() => {
    setStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    const init: Record<string, string> = {};
    for (const item of questions || []) {
      const id = String(item?.id || '').trim();
      if (!id) continue;
      const firstOption = item.options?.[0]?.label;
      if (firstOption) init[id] = String(firstOption);
    }
    setSelectedOptions(init);
    setAnswers({});
  }, [questions]);

  const doneText = useMemo(() => {
    if (status === 'confirmed') return (isZh ? '已提交' : 'Submitted');
    if (status === 'timeout') return (isZh ? '已超时' : 'Timed out');
    return (isZh ? '已拒绝' : 'Rejected');
  }, [status, isZh]);

  const handleApprove = useCallback(async () => {
    const finalAnswers: Record<string, string> = {};
    for (let i = 0; i < (questions || []).length; i += 1) {
      const q = questions[i];
      const id = String(q?.id || '').trim() || `q_${i + 1}`;
      const freeText = String(answers[id] || '').trim();
      const selected = String(selectedOptions[id] || '').trim();
      const fallback = String(q?.options?.[0]?.label || '').trim();
      const value = freeText || selected || fallback;
      if (value) finalAnswers[id] = value;
    }

    try {
      await hanaFetch(`/api/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirmed', value: finalAnswers }),
      });
      setStatus('confirmed');
    } catch { /* silent */ }
  }, [confirmId, questions, answers, selectedOptions]);

  const handleReject = useCallback(async () => {
    try {
      await hanaFetch(`/api/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rejected' }),
      });
      setStatus('rejected');
    } catch { /* silent */ }
  }, [confirmId]);

  if (status !== 'pending') {
    return (
      <div className={`cron-confirm-card done ${status === 'confirmed' ? 'approved' : 'rejected'}`}>
        <div className="cron-confirm-head">
          <div className={`cron-confirm-status ${status === 'confirmed' ? 'approved' : 'rejected'}`}>{doneText}</div>
        </div>
        <div className="cron-confirm-title">{isZh ? 'Agent 需要你的输入' : 'Agent Needs Your Input'}</div>
      </div>
    );
  }

  return (
    <div className="cron-confirm-card pending">
      <div className="cron-confirm-head">
        <div className="cron-confirm-status pending">{(window as any).t('automation.cardPending')}</div>
      </div>
      <div className="cron-confirm-title">{isZh ? 'Agent 需要你的输入' : 'Agent Needs Your Input'}</div>
      {(questions || []).map((q, idx) => {
        const id = String(q?.id || '').trim() || `q_${idx + 1}`;
        const qTitle = String(q?.question || '').trim();
        const qHeader = String(q?.header || '').trim();
        const qOptions = Array.isArray(q?.options) ? q.options.filter((item) => item?.label) : [];
        return (
          <div key={id} className="cron-confirm-meta" style={{ marginTop: 8 }}>
            <div style={{ fontWeight: 600 }}>{qHeader || qTitle || `Question ${idx + 1}`}</div>
            {qHeader && qTitle ? <div style={{ marginTop: 4 }}>{qTitle}</div> : null}
            {qOptions.length > 0 ? (
              <div className="cron-confirm-actions" style={{ marginTop: 6 }}>
                {qOptions.map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    className={`cron-confirm-btn ${selectedOptions[id] === opt.label ? 'approve' : 'reject'}`}
                    onClick={() => setSelectedOptions((prev) => ({ ...prev, [id]: opt.label }))}
                    title={opt.description || opt.label}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            ) : null}
            <input
              type="text"
              value={answers[id] || ''}
              placeholder={isZh ? '可选：输入补充说明（留空则使用已选项）' : 'Optional: add details (blank = selected option)'}
              onChange={(e) => setAnswers((prev) => ({ ...prev, [id]: e.target.value }))}
              style={{
                marginTop: 6,
                width: '100%',
                boxSizing: 'border-box',
                borderRadius: 8,
                border: '1px solid var(--line)',
                background: 'var(--panel)',
                color: 'var(--text)',
                padding: '8px 10px',
              }}
            />
          </div>
        );
      })}
      <div className="cron-confirm-actions">
        <button className="cron-confirm-btn approve" onClick={handleApprove}>{(window as any).t('common.approve')}</button>
        <button className="cron-confirm-btn reject" onClick={handleReject}>{(window as any).t('common.reject')}</button>
      </div>
    </div>
  );
});

const PlanModeConfirmCard = memo(function PlanModeConfirmCard({
  confirmId,
  phase,
  prompt,
  allowedPrompts,
  status: initialStatus,
}: {
  confirmId: string;
  phase: 'enter' | 'exit';
  prompt?: string;
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
  status: 'pending' | 'confirmed' | 'rejected' | 'timeout';
}) {
  const [status, setStatus] = useState(initialStatus);
  const isEnter = phase === 'enter';
  const isZh = String((window as any).i18n?.locale || '').startsWith('zh');

  useEffect(() => {
    setStatus(initialStatus);
  }, [initialStatus]);

  const title = isEnter
    ? (isZh ? '请求进入计划模式' : 'Request To Enter Plan Mode')
    : (isZh ? '请求退出计划模式' : 'Request To Exit Plan Mode');

  const subtitle = isEnter
    ? (isZh ? 'Agent 想先给出计划，再执行操作。' : 'Agent wants to plan before execution.')
    : (isZh ? 'Agent 已完成计划，请确认是否结束计划模式。' : 'Agent finished planning, confirm whether to exit plan mode.');

  const doneText = useMemo(() => {
    if (status === 'confirmed') return (isZh ? '已确认' : 'Confirmed');
    if (status === 'timeout') return (isZh ? '已超时' : 'Timed out');
    return (isZh ? '已拒绝' : 'Rejected');
  }, [status, isZh]);

  const handleApprove = useCallback(async () => {
    try {
      await hanaFetch(`/api/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirmed' }),
      });
      setStatus('confirmed');
    } catch { /* silent */ }
  }, [confirmId]);

  const handleReject = useCallback(async () => {
    try {
      await hanaFetch(`/api/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rejected' }),
      });
      setStatus('rejected');
    } catch { /* silent */ }
  }, [confirmId]);

  const planItems = Array.isArray(allowedPrompts) ? allowedPrompts.filter((item) => item?.prompt) : [];

  if (status !== 'pending') {
    return (
      <div className={`cron-confirm-card done ${status === 'confirmed' ? 'approved' : 'rejected'}`}>
        <div className="cron-confirm-head">
          <div className={`cron-confirm-status ${status === 'confirmed' ? 'approved' : 'rejected'}`}>{doneText}</div>
        </div>
        <div className="cron-confirm-title">{title}</div>
      </div>
    );
  }

  return (
    <div className="cron-confirm-card pending">
      <div className="cron-confirm-head">
        <div className="cron-confirm-status pending">{(window as any).t('automation.cardPending')}</div>
      </div>
      <div className="cron-confirm-title">{title}</div>
      <div className="cron-confirm-meta">{subtitle}</div>
      {prompt ? (
        <div className="cron-confirm-meta">{prompt}</div>
      ) : null}
      {planItems.length > 0 ? (
        <div className="cron-confirm-meta" style={{ whiteSpace: 'pre-wrap' }}>
          {planItems.map((item, idx) => `${idx + 1}. [${item.tool || 'Bash'}] ${item.prompt}`).join('\n')}
        </div>
      ) : null}
      <div className="cron-confirm-actions">
        <button className="cron-confirm-btn approve" onClick={handleApprove}>{(window as any).t('common.approve')}</button>
        <button className="cron-confirm-btn reject" onClick={handleReject}>{(window as any).t('common.reject')}</button>
      </div>
    </div>
  );
});

const CronConfirmCard = memo(function CronConfirmCard({ confirmId, jobData, status: initialStatus }: { confirmId?: string; jobData: Record<string, unknown>; status: string }) {
  const [status, setStatus] = useState(initialStatus);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const label = (jobData.label as string) || (jobData.prompt as string)?.slice(0, 40) || '';
  const scheduleType = String(jobData.type || '');
  const schedule = String(jobData.schedule || '');

  useEffect(() => {
    setStatus(initialStatus);
  }, [initialStatus]);

  const scheduleText = useMemo(() => {
    const wt = (key: string, vars?: Record<string, string>) => (window as any).t?.(key, vars) || '';
    if (scheduleType === 'at') return wt('automation.cardScheduleAt', { schedule });

    // every / cron 统一走人类可读格式，避免展示 */1 * * * * 这种原始表达式
    const human = cronToHuman(schedule, scheduleType);
    if (human) return human;

    if (scheduleType === 'every') return wt('automation.cardScheduleEvery', { schedule });
    if (scheduleType === 'cron') return wt('automation.cardScheduleCron', { schedule });
    return '';
  }, [scheduleType, schedule]);

  const handleApprove = async () => {
    try {
      if (confirmId) {
        // 新的阻塞式确认：通过 ConfirmStore resolve
        await hanaFetch(`/api/confirm/${confirmId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'confirmed' }),
        });
      } else {
        // 旧的非阻塞模式 fallback
        await hanaFetch('/api/desk/cron', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add', ...jobData, sessionPath: currentSessionPath }),
        });
      }
      setStatus('approved');
    } catch { /* silent */ }
  };

  const handleReject = async () => {
    if (confirmId) {
      try {
        await hanaFetch(`/api/confirm/${confirmId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rejected' }),
        });
      } catch { /* silent */ }
    }
    setStatus('rejected');
  };

  if (status !== 'pending') {
    return (
      <div className={`cron-confirm-card done ${status}`}>
        <div className="cron-confirm-head">
          <div className={`cron-confirm-status ${status}`}>
            {status === 'approved' ? ((window as any).t?.('automation.cardCreated') || '已创建') : (window as any).t('common.rejected')}
          </div>
          {scheduleText ? <div className="cron-confirm-meta">{scheduleText}</div> : null}
        </div>
        <div className="cron-confirm-title">{label}</div>
      </div>
    );
  }

  return (
    <div className="cron-confirm-card pending">
      <div className="cron-confirm-head">
        <div className="cron-confirm-status pending">{(window as any).t('automation.cardPending')}</div>
        {scheduleText ? <div className="cron-confirm-meta">{scheduleText}</div> : null}
      </div>
      <div className="cron-confirm-title">{label}</div>
      <div className="cron-confirm-actions">
        <button className="cron-confirm-btn approve" onClick={handleApprove}>{(window as any).t('common.approve')}</button>
        <button className="cron-confirm-btn reject" onClick={handleReject}>{(window as any).t('common.reject')}</button>
      </div>
    </div>
  );
});
