/**
 * AssistantMessage — 助手消息，遍历 ContentBlock 按类型渲染
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { MoodBlock } from './MoodBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolGroupBlock } from './ToolGroupBlock';
import { XingCard } from './XingCard';
import { SettingsConfirmCard } from './SettingsConfirmCard';
import type { ChatMessage, ContentBlock } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { openFilePreview, openSkillPreview, readFileForPreview } from '../../utils/file-preview';
import { openPreview } from '../../stores/artifact-actions';
import { normalizeAgentDisplayName } from '../../utils/agent-helpers';
import { cronToHuman } from '../../utils/format';

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
  const hasFileCard = blocks.some((block) => block.type === 'file_output');
  const hasArtifactCard = blocks.some((block) => block.type === 'artifact');
  const hasImageCard = blocks.some((block) => block.type === 'browser_screenshot');

  const shouldHideToolLine = (toolName: string): boolean => {
    const name = normalizeToolName(toolName);
    if (name === 'cron') return hasCronCard;
    if (name === 'present_files') return hasFileCard;
    if (name === 'create_artifact') return hasArtifactCard;
    if (name === 'generate_images') return hasImageCard;
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

function isAutoCollapsibleChainBlock(block: ContentBlock): boolean {
  return block.type === 'thinking' || block.type === 'tool_group';
}

function formatRunningDuration(ms: number): string {
  const sec = Math.max(0, ms) / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const minutes = Math.floor(sec / 60);
  const seconds = sec - minutes * 60;
  return `${minutes}m ${seconds.toFixed(1)}s`;
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
  const displayBlocks = useMemo(() => removeRedundantOutputToolLines(blocks), [blocks]);
  const hasPrimaryText = useMemo(
    () => displayBlocks.some((block) => block.type === 'text'),
    [displayBlocks],
  );
  const chainBlocks = useMemo(() => displayBlocks.filter(isAutoCollapsibleChainBlock), [displayBlocks]);
  const hasCollapsibleChain = hasPrimaryText && chainBlocks.length > 0;
  const [chainExpanded, setChainExpanded] = useState(true);

  useEffect(() => {
    if (!hasCollapsibleChain) {
      setChainExpanded(false);
      return;
    }
    setChainExpanded(true);
  }, [message.id, hasCollapsibleChain]);

  const chainThinkingCount = useMemo(
    () => chainBlocks.filter((block) => block.type === 'thinking').length,
    [chainBlocks],
  );
  const chainToolCount = useMemo(
    () => chainBlocks.reduce((sum, block) => (
      block.type === 'tool_group' ? sum + block.tools.length : sum
    ), 0),
    [chainBlocks],
  );
  const chainSummaryText = useMemo(() => {
    const parts: string[] = [];
    if (chainThinkingCount > 0) parts.push(`${chainThinkingCount}次思考`);
    if (chainToolCount > 0) parts.push(`${chainToolCount}次工具执行`);
    const detail = parts.length ? parts.join(' · ') : '详情';
    return `思考和执行链（${detail}）`;
  }, [chainThinkingCount, chainToolCount]);

  const finalTextIndex = useMemo(() => {
    for (let i = displayBlocks.length - 1; i >= 0; i--) {
      if (displayBlocks[i].type === 'text') return i;
    }
    return -1;
  }, [displayBlocks]);
  const finalTextHtml = finalTextIndex >= 0 && displayBlocks[finalTextIndex].type === 'text'
    ? displayBlocks[finalTextIndex].html
    : '';
  const [smoothedFinalTextHtml, setSmoothedFinalTextHtml] = useState(finalTextHtml);

  useEffect(() => {
    if (!isStreaming) {
      setSmoothedFinalTextHtml(finalTextHtml);
      return;
    }
    const timer = window.setTimeout(() => {
      setSmoothedFinalTextHtml(finalTextHtml);
    }, 34);
    return () => window.clearTimeout(timer);
  }, [finalTextHtml, isStreaming]);

  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const runningLabel = useMemo(() => {
    const key = 'chat.agentRunning';
    const text = t(key);
    return text && text !== key ? text : 'Agent Running';
  }, [t]);

  const handleCopy = useCallback(() => {
    if (!finalTextHtml) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = finalTextHtml;
    const text = tmp.innerText.trim();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [finalTextHtml]);

  return (
    <div className="message-group assistant">
      {showAvatar && (
        <div className="avatar-row assistant">
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
          {typeof runningMs === 'number' && runningMs >= 0 && (
            <span className="agent-running-inline">
              <span className="agent-running-inline-icon" aria-hidden>⋮</span>
              <span>{runningLabel} {formatRunningDuration(runningMs)}</span>
            </span>
          )}
        </div>
      )}
      <div className="message assistant">
        {hasCollapsibleChain && (
          <button
            type="button"
            className="chain-summary"
            onClick={() => setChainExpanded((prev) => !prev)}
            aria-expanded={chainExpanded}
          >
            <span className="chain-summary-arrow">{chainExpanded ? '▾' : '▸'}</span>
            <span className="chain-summary-text">{chainSummaryText}</span>
            <span className="chain-summary-status">{chainExpanded ? '已展开' : '已折叠'}</span>
          </button>
        )}
        {displayBlocks.map((block, i) => {
          if (isAutoCollapsibleChainBlock(block)) {
            const chainVisible = !hasCollapsibleChain || chainExpanded;
            return (
              <div
                key={i}
                className={`chain-collapsible${chainVisible ? ' expanded' : ' collapsed'}`}
                aria-hidden={hasCollapsibleChain ? !chainExpanded : undefined}
              >
                <div className="chain-collapsible-inner">
                  <ContentBlockView
                    block={block}
                    agentName={displayName}
                    yuan={displayYuan}
                    dimmed={hasPrimaryText && block.type !== 'text'}
                  />
                </div>
              </div>
            );
          }

          const isFinalTextBlock = block.type === 'text' && i === finalTextIndex;
          if (isFinalTextBlock) {
            return (
              <div key={i} className={`assistant-final-reply${isStreaming ? ' streaming' : ''}`}>
                <MarkdownContent html={isStreaming ? smoothedFinalTextHtml : block.html} className={isStreaming ? 'md-content stream-live' : 'md-content'} />
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
            />
          );
        })}
      </div>
    </div>
  );
});

// ── ContentBlock 分发 ──

const ContentBlockView = memo(function ContentBlockView({ block, agentName, yuan, dimmed }: {
  block: ContentBlock;
  agentName: string;
  yuan: string;
  dimmed?: boolean;
}) {
  switch (block.type) {
    case 'thinking':
      return <ThinkingBlock content={block.content} sealed={block.sealed} dimmed={!!dimmed} />;
    case 'mood':
      return <MoodBlock yuan={block.yuan} text={block.text} />;
    case 'tool_group':
      return <ToolGroupBlock tools={block.tools} agentName={agentName} dimmed={!!dimmed} />;
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
